import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import type { MemoryChunk } from '../search/memory-chunks.js';
import type { TurnPipelineTrace } from '../pipeline-trace.js';
import type { DurableTurn, DurableWorkState, EnqueueTurnInput, HandoffInput, RoomStore, StoredMessage } from './types.js';

/** Test-only repository. Production runtime construction never selects this store. */
export class MemoryRoomStore implements RoomStore {
  readonly roomId = '00000000-0000-4000-8000-000000000001';
  private messages: StoredMessage[] = [];
  private turns: DurableTurn[] = [];
  private memoryChunks = new Map<string, MemoryChunk>();
  private pipelineTraces = new Map<string, TurnPipelineTrace>();
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
  async loadMessages(limit = 50_000): Promise<StoredMessage[]> {
    return [...this.messages].sort((a, b) => a.timelineOrder - b.timelineOrder || a.sequence - b.sequence).slice(-limit);
  }
  async insertMessage(message: Message, turnId?: string, timestamp = new Date().toISOString()): Promise<void> {
    if (this.messages.some((entry) => entry.message.id === message.id)) throw new Error(`Message id collision: ${message.id}`);
    const sequence = this.messages.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0) + 1;
    this.messages.push({ sequence, timelineOrder: sequence, timestamp, turnId, message });
  }
  async updateMessage(message: Message, turnId?: string): Promise<void> {
    const index = this.messages.findIndex((entry) => entry.message.id === message.id);
    if (index < 0) throw new Error(`Cannot update missing message: ${message.id}`);
    const existing = this.messages[index]!;
    const sameParticipant = (existing.message.participantId ?? null) === (message.participantId ?? null);
    const compatibleTurn = !existing.turnId || !turnId || existing.turnId === turnId;
    if (existing.message.role !== message.role || !sameParticipant || !compatibleTurn) {
      throw new Error(`Message identity mismatch: ${message.id}`);
    }
    this.messages[index] = { ...existing, turnId: existing.turnId ?? turnId, message };
  }
  async auditMessageOrder(): Promise<{ ambiguousLegacyIds: string[] }> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return { ambiguousLegacyIds: this.messages.filter((entry) => /-[0-9]+$/.test(entry.message.id) && !uuid.test(entry.message.id) && entry.timelineOrder === entry.sequence).map((entry) => entry.message.id) };
  }
  async enqueue(input: EnqueueTurnInput): Promise<{ turn: DurableTurn; created: boolean }> {
    const existing = this.turns.find((turn) => turn.requestId === input.requestId);
    if (existing) return { turn: existing, created: false };
    const turn: DurableTurn = { id: randomUUID(), roomId: this.roomId, requestId: input.requestId, participantId: input.participantId, input: input.input, metadata: input.metadata, status: 'queued', attempt: 1, enqueuedAt: input.timestamp ?? new Date().toISOString(), sourceMessageId: input.message?.id };
    this.turns.push(turn);
    if (input.message) await this.insertMessage(input.message, turn.id, input.timestamp);
    return { turn, created: true };
  }
  async commitHandoff(input: HandoffInput): Promise<{ turn: DurableTurn; created: boolean }> {
    const existing = this.turns.find((turn) => turn.requestId === input.requestId);
    if (existing) return { turn: existing, created: false };
    await this.insertMessage(input.handoffMessage, input.parentTurnId);
    const turn: DurableTurn = { id: randomUUID(), roomId: this.roomId, requestId: input.requestId, participantId: input.participantId, input: input.input, metadata: { ...input.metadata, ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}) }, status: 'queued', attempt: 1, enqueuedAt: new Date().toISOString(), handoffMessageId: input.handoffMessage.id };
    this.turns.push(turn);
    return { turn, created: true };
  }
  async claim(workerId: string, leaseMs: number): Promise<DurableTurn | null> {
    const turn = this.turns.find((item) => item.status === 'queued' && !this.turns.some((active) => active.status === 'running' && active.participantId === item.participantId));
    if (!turn) return null;
    Object.assign(turn, { status: 'running', startedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(), metadata: { ...turn.metadata, leaseOwner: workerId } });
    return turn;
  }
  async renew(turnId: string, _workerId: string, leaseMs: number): Promise<boolean> { const turn = this.turns.find((item) => item.id === turnId && item.status === 'running'); if (!turn) return false; turn.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); return true; }
  async finish(turnId: string, _workerId: string, status: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<void> { const turn = this.turns.find((item) => item.id === turnId); if (turn) Object.assign(turn, { status, finishedAt: new Date().toISOString(), lastError: error, leaseExpiresAt: undefined }); }
  async interruptExpired(): Promise<number> { let count = 0; for (const turn of this.turns) if (turn.status === 'running' && Date.parse(turn.leaseExpiresAt ?? '') < Date.now()) { turn.status = 'interrupted'; count++; } return count; }
  async retry(turnId: string): Promise<DurableTurn | null> { const turn = this.turns.find((item) => item.id === turnId && ['interrupted','failed'].includes(item.status)); if (!turn) return null; Object.assign(turn, { status: 'queued', attempt: turn.attempt + 1, enqueuedAt: new Date().toISOString(), lastError: undefined }); return turn; }
  async cancel(turnId: string): Promise<boolean> { const turn = this.turns.find((item) => item.id === turnId && ['queued','interrupted','failed'].includes(item.status)); if (!turn) return false; turn.status = 'cancelled'; return true; }
  async workState(): Promise<DurableWorkState> { return { active: this.turns.filter((turn) => turn.status === 'running'), queued: this.turns.filter((turn) => turn.status === 'queued'), interrupted: this.turns.filter((turn) => turn.status === 'interrupted'), failed: this.turns.filter((turn) => turn.status === 'failed') }; }
  async latestHandoff(): Promise<DurableTurn | null> { return [...this.turns].reverse().find((turn) => Boolean(turn.handoffMessageId)) ?? null; }
  async savePipelineTrace(trace: TurnPipelineTrace, retain: number): Promise<void> {
    this.pipelineTraces.set(trace.turnId, structuredClone(trace));
    const retained = [...this.pipelineTraces.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.turnId.localeCompare(left.turnId))
      .slice(0, Math.max(0, retain));
    this.pipelineTraces = new Map(retained.map((item) => [item.turnId, item]));
  }
  async loadRecentPipelineTraces(limit: number): Promise<TurnPipelineTrace[]> {
    return [...this.pipelineTraces.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.turnId.localeCompare(left.turnId))
      .slice(0, Math.max(0, limit))
      .map((trace) => structuredClone(trace));
  }
  async rewindAfter(messageId: string | null): Promise<{ found: boolean; removed: Message[]; memoryChunkIds?: string[] }> { const index = messageId === null ? -1 : this.messages.findIndex((entry) => entry.message.id === messageId); if (messageId !== null && index < 0) return { found: false, removed: [] }; const removed = this.messages.splice(index + 1).map((entry) => entry.message); const removedIds = new Set(removed.map((message) => message.id)); for (const [turnId, trace] of this.pipelineTraces) if (trace.assistantMessageId && removedIds.has(trace.assistantMessageId)) this.pipelineTraces.delete(turnId); const memoryChunkIds = await this.memoryChunkIdsForMessages([...removedIds]); for (const id of memoryChunkIds) this.memoryChunks.delete(id); return { found: true, removed, memoryChunkIds }; }
  async replaceMemoryChunks(sourceMessageId: string, chunks: MemoryChunk[]): Promise<void> { for (const [id, chunk] of this.memoryChunks) if (chunk.sourceMessageId === sourceMessageId) this.memoryChunks.delete(id); for (const chunk of chunks) this.memoryChunks.set(chunk.id, chunk); }
  async claimMemoryChunks(limit: number): Promise<MemoryChunk[]> { const chunks = [...this.memoryChunks.values()].filter((chunk) => chunk.state === 'pending' || chunk.state === 'failed').slice(0, limit); for (const chunk of chunks) { chunk.state = 'indexing'; chunk.attempts++; } return chunks.map((chunk) => ({ ...chunk })); }
  async markMemoryChunksIndexed(ids: string[]): Promise<void> { for (const id of ids) { const chunk = this.memoryChunks.get(id); if (chunk) chunk.state = 'indexed'; } }
  async markMemoryChunksFailed(ids: string[], _error: string): Promise<void> { for (const id of ids) { const chunk = this.memoryChunks.get(id); if (chunk) chunk.state = 'failed'; } }
  async hydrateMemoryChunks(ids: string[]): Promise<MemoryChunk[]> { return ids.map((id) => this.memoryChunks.get(id)).filter((chunk): chunk is MemoryChunk => Boolean(chunk)).map((chunk) => ({ ...chunk })); }
  async memoryChunkIdsForMessages(messageIds: string[]): Promise<string[]> { const sources = new Set(messageIds); return [...this.memoryChunks.values()].filter((chunk) => sources.has(chunk.sourceMessageId)).map((chunk) => chunk.id); }
}
