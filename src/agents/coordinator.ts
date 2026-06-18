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
}

export class GroupChatCoordinator {
  private sessions = new Map<string, AgentSession>();
  private agentParticipants = new Map<string, Participant>();
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
    for (const handler of this.listeners) handler(event);
  }

  listParticipants(): Participant[] {
    return [USER_PARTICIPANT, SQUIRL_PARTICIPANT, ...this.agentParticipants.values()];
  }

  hasAgent(id: string): boolean {
    return this.sessions.has(id);
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
    return participant;
  }

  async removeAgent(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.stop();
    this.sessions.delete(id);
    this.agentParticipants.delete(id);
    this.emit({ type: 'session-status', participantId: id, status: 'stopped' });
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

  /** Route a user submission to the addressed participant(s), with optional bounded handoff. */
  async dispatch(rawInput: string, signal: AbortSignal): Promise<void> {
    const known = this.knownIds();
    const parsed = parseMentions(rawInput, known);
    const initialTargets = parsed.targets.length > 0 ? parsed.targets : [this.localId];
    const initialText = parsed.targets.length > 0 ? parsed.cleaned : rawInput;

    const autoHandoff = this.options.config?.autoHandoff ?? false;
    const maxHops = this.options.config?.maxHops ?? 3;

    const queue: Array<{ participantId: string; text: string }> = initialTargets.map((id) => ({ participantId: id, text: initialText }));
    let hops = 0;

    while (queue.length > 0) {
      if (signal.aborted) return;
      const job = queue.shift()!;
      const output = await this.runTurn(job.participantId, job.text, signal);

      if (autoHandoff && hops < maxHops && output.trim()) {
        const handoffTargets = parseMentions(output, this.knownIds()).targets.filter((id) => id !== job.participantId);
        if (handoffTargets.length > 0) {
          hops += 1;
          for (const id of handoffTargets) queue.push({ participantId: id, text: output });
        }
      }
    }
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
