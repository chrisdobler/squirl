import type { Message } from '../types.js';
import type { MemoryChunk } from '../search/memory-chunks.js';
import type { TurnPipelineTrace } from '../pipeline-trace.js';

export type DurableTurnStatus = 'queued' | 'running' | 'interrupted' | 'succeeded' | 'failed' | 'cancelled';

export interface DurableTurn {
  id: string;
  roomId: string;
  requestId: string;
  participantId: string;
  input: string;
  metadata?: Record<string, unknown>;
  status: DurableTurnStatus;
  attempt: number;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  sourceMessageId?: string;
  handoffMessageId?: string;
}

export interface StoredMessage {
  sequence: number;
  timelineOrder: number;
  timestamp: string;
  turnId?: string;
  message: Message;
}

export interface DurableWorkState {
  active: DurableTurn[];
  queued: DurableTurn[];
  interrupted: DurableTurn[];
  failed: DurableTurn[];
}

export interface EnqueueTurnInput {
  requestId: string;
  participantId: string;
  input: string;
  metadata?: Record<string, unknown>;
  message?: Message;
  timestamp?: string;
}

export interface HandoffInput {
  parentTurnId?: string;
  requestId: string;
  participantId: string;
  input: string;
  metadata?: Record<string, unknown>;
  handoffMessage: Message;
}

export interface RoomStore {
  readonly roomId: string;
  initialize(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<boolean>;
  loadMessages(limit?: number): Promise<StoredMessage[]>;
  insertMessage(message: Message, turnId?: string, timestamp?: string): Promise<void>;
  updateMessage(message: Message, turnId?: string): Promise<void>;
  auditMessageOrder(): Promise<{ ambiguousLegacyIds: string[] }>;
  enqueue(input: EnqueueTurnInput): Promise<{ turn: DurableTurn; created: boolean }>;
  commitHandoff(input: HandoffInput): Promise<{ turn: DurableTurn; created: boolean }>;
  claim(workerId: string, leaseMs: number): Promise<DurableTurn | null>;
  renew(turnId: string, workerId: string, leaseMs: number): Promise<boolean>;
  finish(turnId: string, workerId: string, status: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<void>;
  interruptExpired(): Promise<number>;
  retry(turnId: string): Promise<DurableTurn | null>;
  cancel(turnId: string): Promise<boolean>;
  workState(): Promise<DurableWorkState>;
  latestHandoff(): Promise<DurableTurn | null>;
  savePipelineTrace(trace: TurnPipelineTrace, retain: number): Promise<void>;
  loadRecentPipelineTraces(limit: number): Promise<TurnPipelineTrace[]>;
  rewindAfter(messageId: string | null): Promise<{ found: boolean; removed: Message[]; memoryChunkIds?: string[] }>;
  replaceMemoryChunks(sourceMessageId: string, chunks: MemoryChunk[]): Promise<void>;
  claimMemoryChunks(limit: number): Promise<MemoryChunk[]>;
  markMemoryChunksIndexed(ids: string[]): Promise<void>;
  markMemoryChunksFailed(ids: string[], error: string): Promise<void>;
  hydrateMemoryChunks(ids: string[]): Promise<MemoryChunk[]>;
  memoryChunkIdsForMessages(messageIds: string[]): Promise<string[]>;
}
