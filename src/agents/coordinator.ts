// GroupChatCoordinator: the single thing the UIs talk to for multi-agent turns. It owns the
// agent sessions, routes a dispatch to the addressed participant(s), and forwards every
// AgentEvent to subscribers. squirl's own local LLM is modeled as a participant too, so there
// is one routing code path.
//
// Safety: auto-handoff (an agent's output addressing another participant) is OFF by default.
// When enabled it is bounded by maxHops and a no-self-handoff rule, to prevent runaway loops.

import { createAgentSession } from './adapters/index.js';
import { parseMentions } from './mentions.js';
import { SQUIRL_PARTICIPANT, USER_PARTICIPANT, participantFromDescriptor } from './participants.js';
import type { AgentDescriptor, AgentEvent, AgentSession, AgentTransport, Participant } from './types.js';

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

  async addAgent(descriptor: AgentDescriptor): Promise<Participant> {
    if (this.sessions.has(descriptor.id)) throw new Error(`Agent "${descriptor.id}" already exists`);
    const participant = participantFromDescriptor(descriptor, this.agentParticipants.size);
    const session = this.createSession(descriptor, this.options.transport);
    // Permanent forwarder: surface lifecycle/status events and keep participant status in sync.
    session.onEvent((event) => {
      this.applyStatus(descriptor.id, event);
      this.emit(event);
    });
    this.sessions.set(descriptor.id, session);
    this.agentParticipants.set(descriptor.id, participant);
    await session.start();
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
    this.emit({ type: 'session-status', participantId: id, status: 'stopped' });
  }

  async renameAgent(currentId: string, nextId: string, label = nextId): Promise<Participant> {
    const session = this.sessions.get(currentId);
    if (!session) throw new Error(`No agent "@${currentId}".`);
    if (currentId !== nextId && this.sessions.has(nextId)) throw new Error(`Agent "@${nextId}" already exists.`);

    const old = session.descriptor;
    const replacement: AgentDescriptor = { ...old, id: nextId, label };
    await this.removeAgent(currentId);
    try {
      return await this.addAgent(replacement);
    } catch (error) {
      try { await this.addAgent(old); } catch { /* Preserve the original startup error. */ }
      throw error;
    }
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

    return new Promise<string>((resolve) => {
      let text = '';
      // Completion listener only: the permanent forwarder (addAgent) already emits these events.
      const off = session.onEvent((event) => {
        if (event.participantId !== participantId) return;
        if (event.type === 'token') text += event.token;
        if (event.type === 'turn-end' || event.type === 'exit' || event.type === 'error') {
          off();
          resolve(text);
        }
      });
      void session.send(input);
    });
  }
}
