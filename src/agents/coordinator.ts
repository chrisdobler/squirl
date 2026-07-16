// GroupChatCoordinator: the single thing the UIs talk to for multi-agent turns. It owns the
// agent sessions, routes a dispatch to the addressed participant(s), and forwards every
// AgentEvent to subscribers. squirl's own local LLM is modeled as a participant too, so there
// is one routing code path.
//
// Safety: auto-handoff (an agent's output addressing another participant) is OFF by default.
// When enabled it is bounded by maxHops and a no-self-handoff rule, to prevent runaway loops.

import { createAgentSession } from './adapters/index.js';
import { parseMentions } from './mentions.js';
import { SQUIRL_PARTICIPANT, USER_PARTICIPANT, participantFromDescriptor, pickAgentColor } from './participants.js';
import type { AgentDescriptor, AgentEvent, AgentInteractionResponse, AgentSession, AgentTransport, Participant, ParticipantColor } from './types.js';
import type { AgentContextTelemetry } from './context-preview.js';
import { discoverCodexModels } from './codex-models.js';

export interface CoordinatorConfig {
  autoHandoff?: boolean;
  maxHops?: number;
}

export interface CoordinatorOptions {
  /** Runs a turn on squirl's local LLM. Must emit AgentEvents and resolve when the turn ends. */
  localTurn: (input: string, emit: (event: AgentEvent) => void, signal: AbortSignal) => Promise<void>;
  config?: CoordinatorConfig;
  /** Injection seam for tests; defaults to the real adapter factory. */
  createSession?: (descriptor: AgentDescriptor, transport?: AgentTransport) => AgentSession;
  transport?: AgentTransport;
  localParticipantId?: string;
  /** Optional bounded observer pass after a non-local participant completes. */
  facilitateTurn?: (participantId: string, output: string, signal: AbortSignal) => Promise<string | null>;
}

export class GroupChatCoordinator {
  private sessions = new Map<string, AgentSession>();
  private agentParticipants = new Map<string, Participant>();
  private resolvedModels = new Map<string, string>();
  private contextTelemetry = new Map<string, AgentContextTelemetry>();
  private listeners = new Set<(event: AgentEvent) => void>();
  private readonly localId: string;
  private readonly createSession: NonNullable<CoordinatorOptions['createSession']>;

  constructor(private readonly options: CoordinatorOptions) {
    this.localId = options.localParticipantId ?? SQUIRL_PARTICIPANT.id;
    this.createSession = options.createSession ?? createAgentSession;
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: AgentEvent): void {
    let emitted = event;
    if (event.type === 'session-status' && event.model) {
      this.resolvedModels.set(event.participantId, event.model);
    } else if (event.type === 'message-start') {
      const descriptor = this.sessions.get(event.participantId)?.descriptor;
      const model = event.responseMeta?.model ?? this.resolvedModels.get(event.participantId) ?? descriptor?.model;
      const effort = event.responseMeta?.effort ?? descriptor?.effort;
      if (model) emitted = {
        ...event,
        responseMeta: { model, ...(effort ? { effort } : {}) },
      };
    }
    if (event.type === 'session-status') {
      const previous = this.contextTelemetry.get(event.participantId) ?? { participantId: event.participantId };
      this.contextTelemetry.set(event.participantId, {
        ...previous,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.model ? { modelId: event.model } : {}),
        capturedAt: new Date().toISOString(),
      });
    } else if (event.type === 'usage') {
      const descriptor = this.sessions.get(event.participantId)?.descriptor;
      const previous = this.contextTelemetry.get(event.participantId) ?? { participantId: event.participantId };
      const modelId = this.resolvedModels.get(event.participantId) ?? descriptor?.model ?? previous.modelId;
      const codexWindow = descriptor?.kind === 'codex' && modelId
        ? discoverCodexModels().models.find((model) => model.id === modelId)?.contextWindow
        : undefined;
      this.contextTelemetry.set(event.participantId, {
        ...previous,
        sessionId: descriptor?.sessionId ?? previous.sessionId,
        modelId,
        inputTokens: event.usage.inputTokens ?? previous.inputTokens,
        contextWindow: event.usage.contextWindow ?? previous.contextWindow ?? codexWindow,
        capturedAt: new Date().toISOString(),
      });
    }
    for (const handler of this.listeners) handler(emitted);
  }

  listParticipants(): Participant[] {
    return [USER_PARTICIPANT, SQUIRL_PARTICIPANT, ...this.agentParticipants.values()];
  }

  hasAgent(id: string): boolean {
    return this.sessions.has(id);
  }

  getDescriptor(id: string): AgentDescriptor | undefined {
    return this.sessions.get(id)?.descriptor;
  }

  getContextTelemetry(id: string): AgentContextTelemetry | undefined {
    const descriptor = this.sessions.get(id)?.descriptor;
    if (!descriptor) return undefined;
    const current = this.contextTelemetry.get(id) ?? { participantId: id };
    return {
      ...current,
      sessionId: descriptor.sessionId ?? current.sessionId,
      modelId: this.resolvedModels.get(id) ?? descriptor.model ?? current.modelId,
    };
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  setControlMode(id: string, mode: NonNullable<Participant['controlMode']>): void {
    const participant = this.agentParticipants.get(id);
    if (!participant) throw new Error(`No agent "@${id}".`);
    participant.controlMode = mode;
    this.emit({ type: 'session-status', participantId: id, status: participant.status ?? 'ready' });
  }

  /** Stop headless ownership without removing the room participant or its durable profile. */
  async suspendAgent(id: string, controlMode: 'terminal' | 'compacting'): Promise<AgentDescriptor> {
    const session = this.sessions.get(id);
    const participant = this.agentParticipants.get(id);
    if (!session || !participant) throw new Error(`No agent "@${id}".`);
    if (session.status === 'busy') throw new Error(`Cannot switch @${id} while it is busy.`);
    const descriptor = session.descriptor;
    this.sessions.delete(id);
    await session.stop();
    participant.status = 'ready';
    participant.controlMode = controlMode;
    this.emit({ type: 'session-status', participantId: id, status: 'ready' });
    return descriptor;
  }

  /** Restore headless ownership after terminal/compaction work. */
  async resumeAgent(descriptor: AgentDescriptor): Promise<Participant> {
    const participant = this.agentParticipants.get(descriptor.id);
    if (!participant) throw new Error(`No suspended agent "@${descriptor.id}".`);
    if (this.sessions.has(descriptor.id)) throw new Error(`Agent "@${descriptor.id}" is already headless.`);
    const session = this.createSession(descriptor, this.options.transport);
    session.onEvent((event) => {
      if (this.sessions.get(descriptor.id) !== session) return;
      this.applyStatus(descriptor.id, event);
      this.emit(event);
    });
    this.sessions.set(descriptor.id, session);
    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(descriptor.id);
      participant.status = 'error';
      participant.controlMode = 'headless';
      throw error;
    }
    participant.status = session.status;
    participant.controlMode = 'headless';
    this.emit({ type: 'session-status', participantId: descriptor.id, status: session.status });
    return participant;
  }

  async respondToInteraction(participantId: string, id: string, response: AgentInteractionResponse): Promise<void> {
    const session = this.sessions.get(participantId);
    if (!session?.respondToInteraction) throw new Error(`Agent "@${participantId}" does not accept interactive responses.`);
    await session.respondToInteraction(id, response);
  }

  preapproveToolOnce(participantId: string, toolName: string, input: Record<string, unknown>): boolean {
    return this.sessions.get(participantId)?.preapproveToolOnce?.(toolName, input) ?? false;
  }

  async restartAgentSession(id: string, freshSession = false): Promise<Participant> {
    const descriptor = this.getDescriptor(id);
    if (!descriptor) throw new Error(`No agent "@${id}".`);
    const participant = this.agentParticipants.get(id);
    if (participant?.status === 'busy') throw new Error(`Cannot restart @${id} while it is busy.`);
    return this.replaceAgent(id, { ...descriptor, ...(freshSession ? { sessionId: undefined } : {}) });
  }

  async addAgent(descriptor: AgentDescriptor): Promise<Participant> {
    return this.addAgentWithColor(descriptor);
  }

  private async addAgentWithColor(descriptor: AgentDescriptor, preferredColor?: ParticipantColor): Promise<Participant> {
    if (this.sessions.has(descriptor.id)) throw new Error(`Agent "${descriptor.id}" already exists`);
    const colorsInUse = [...this.agentParticipants.values()].map((participant) => participant.color);
    const color = preferredColor && !colorsInUse.includes(preferredColor)
      ? preferredColor
      : pickAgentColor(colorsInUse);
    const participant = participantFromDescriptor(descriptor, color);
    participant.controlMode = 'headless';
    const session = this.createSession(descriptor, this.options.transport);
    // Permanent forwarder: surface lifecycle/status events and keep participant status in sync.
    session.onEvent((event) => {
      // A replaced process may report its asynchronous exit after a new session has claimed
      // the same participant id. Ignore events from that stale session.
      if (this.sessions.get(descriptor.id) !== session) return;
      this.applyStatus(descriptor.id, event);
      this.emit(event);
    });
    this.sessions.set(descriptor.id, session);
    this.agentParticipants.set(descriptor.id, participant);
    try {
      await session.start();
    } catch (error) {
      try { await session.stop(); } catch { /* Preserve the startup error. */ }
      this.sessions.delete(descriptor.id);
      this.agentParticipants.delete(descriptor.id);
      this.resolvedModels.delete(descriptor.id);
      this.contextTelemetry.delete(descriptor.id);
      throw error;
    }
    participant.status = session.status;
    this.emit({ type: 'session-status', participantId: descriptor.id, status: session.status });
    return participant;
  }

  async removeAgent(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.stop();
    this.sessions.delete(id);
    this.agentParticipants.delete(id);
    this.resolvedModels.delete(id);
    this.contextTelemetry.delete(id);
    this.emit({ type: 'session-status', participantId: id, status: 'stopped' });
  }

  /** Replace a live agent session while preserving its room color and restoring it on startup failure. */
  async replaceAgent(currentId: string, replacement: AgentDescriptor): Promise<Participant> {
    const session = this.sessions.get(currentId);
    if (!session) throw new Error(`No agent "@${currentId}".`);
    if (currentId !== replacement.id && this.sessions.has(replacement.id)) {
      throw new Error(`Agent "@${replacement.id}" already exists.`);
    }

    const original = session.descriptor;
    const originalColor = this.agentParticipants.get(currentId)?.color;
    await this.removeAgent(currentId);
    try {
      return await this.addAgentWithColor(replacement, originalColor);
    } catch (error) {
      try { await this.addAgentWithColor(original, originalColor); } catch { /* Preserve the replacement startup error. */ }
      throw error;
    }
  }

  async renameAgent(currentId: string, nextId: string, label = nextId): Promise<Participant> {
    const descriptor = this.getDescriptor(currentId);
    if (!descriptor) throw new Error(`No agent "@${currentId}".`);
    return this.replaceAgent(currentId, { ...descriptor, id: nextId, label });
  }

  async interrupt(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.descriptor.kind === 'claude-code') return false;
    await session.interrupt();
    return true;
  }

  private applyStatus(id: string, event: AgentEvent): void {
    const participant = this.agentParticipants.get(id);
    if (!participant) return;
    if (event.type === 'session-status') participant.status = event.status;
    else if (event.type === 'turn-end') participant.status = 'ready';
    else if (event.type === 'error') participant.status = 'error';
    else if (event.type === 'exit') participant.status = 'stopped';
  }

  private knownIds(): string[] {
    return [this.localId, ...this.sessions.keys()];
  }

  /** Route a user submission to exactly one explicitly selected participant. */
  async dispatchTo(recipientId: string, input: string, signal: AbortSignal): Promise<void> {
    const participant = this.agentParticipants.get(recipientId);
    if (participant?.controlMode === 'terminal') {
      throw new Error(`@${recipientId} is in terminal mode. Return it to headless mode before sending from Squirl.`);
    }
    if (participant?.controlMode === 'compacting') {
      throw new Error(`@${recipientId} is compacting its context. Try again when compaction finishes.`);
    }
    if (recipientId !== this.localId && !this.sessions.has(recipientId)) {
      throw new Error(`No such agent: ${recipientId}`);
    }
    const autoHandoff = this.options.config?.autoHandoff ?? false;
    const maxHops = this.options.config?.maxHops ?? 3;
    const queue: Array<{ participantId: string; text: string }> = [{ participantId: recipientId, text: input }];
    let hops = 0;

    while (queue.length > 0) {
      if (signal.aborted) return;
      const job = queue.shift()!;
      const output = await this.runTurn(job.participantId, job.text, signal);

      if (job.participantId !== this.localId && output.trim() && this.options.facilitateTurn && !signal.aborted) {
        const intervention = await this.options.facilitateTurn(job.participantId, output, signal);
        if (intervention?.trim()) {
          const messageId = crypto.randomUUID();
          this.emit({ type: 'message-start', participantId: this.localId, messageId });
          this.emit({ type: 'token', participantId: this.localId, messageId, token: intervention.trim() });
          this.emit({ type: 'message-end', participantId: this.localId, messageId, content: intervention.trim() });
          this.emit({ type: 'turn-end', participantId: this.localId });
        }
      }

      if (autoHandoff && hops < maxHops && output.trim()) {
        const handoffTargets = parseMentions(output, this.knownIds()).targets.filter((id) => id !== job.participantId);
        if (handoffTargets.length > 0) {
          hops += 1;
          for (const id of handoffTargets) queue.push({ participantId: id, text: output });
        }
      }
    }
  }

  /** Backward-compatible local dispatch for non-UI callers. */
  async dispatch(input: string, signal: AbortSignal): Promise<void> {
    return this.dispatchTo(this.localId, input, signal);
  }

  /** Run one participant's turn, forwarding events and returning its accumulated text. */
  private runTurn(participantId: string, input: string, signal: AbortSignal): Promise<string> {
    if (participantId === this.localId) {
      let text = '';
      return this.options.localTurn(input, (event) => {
        if (event.type === 'token') text += event.token;
        this.emit(event);
      }, signal).then(() => text);
    }

    const session = this.sessions.get(participantId);
    if (!session) {
      this.emit({ type: 'error', participantId, message: `No such agent: ${participantId}` });
      return Promise.resolve('');
    }

    return new Promise<string>((resolve, reject) => {
      let text = '';
      // Completion listener only: the permanent forwarder (addAgent) already emits these events.
      const off = session.onEvent((event) => {
        if (event.participantId !== participantId) return;
        if (event.type === 'token') text += event.token;
        if (event.type === 'error') {
          off();
          reject(new Error(event.message));
        } else if (event.type === 'turn-end' || event.type === 'exit') {
          off();
          resolve(text);
        }
      });
      void session.send(input).catch((error) => { off(); reject(error); });
    });
  }
}
