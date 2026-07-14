export type ParticipantTurnPhase = 'preparing' | 'working' | 'tool' | 'cancelling';

export interface ParticipantTurn {
  id: string;
  participantId: string;
  input: string;
  enqueuedAt: string;
  /** Optional caller-owned data used while executing the turn. */
  metadata?: unknown;
}

export interface ParticipantActivity {
  participantId: string;
  turnId: string;
  phase: ParticipantTurnPhase;
  detail?: string;
  queueDepth: number;
  cancellable: boolean;
}

export interface ParticipantWorkState {
  active: ParticipantActivity[];
  queued: ParticipantTurn[];
}

export interface TurnExecutionContext {
  signal: AbortSignal;
  setPhase: (phase: ParticipantTurnPhase, detail?: string) => void;
}

export interface EnqueueResult {
  turn: ParticipantTurn;
  started: boolean;
  queuePosition: number;
}

type Runner = (turn: ParticipantTurn, context: TurnExecutionContext) => Promise<void>;

interface ActiveTurn {
  turn: ParticipantTurn;
  controller: AbortController;
  phase: ParticipantTurnPhase;
  detail?: string;
}

/**
 * Runs at most one turn per participant while allowing different participants to
 * work concurrently. Queues are deliberately in-memory and disappear on restart.
 */
export class ParticipantTurnScheduler {
  private readonly queues = new Map<string, ParticipantTurn[]>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly listeners = new Set<(state: ParticipantWorkState) => void>();
  private readonly settled = new Map<string, Array<() => void>>();

  constructor(
    private readonly runner: Runner,
    private readonly canCancel: (participantId: string) => boolean = () => true,
    private readonly onError: (error: unknown, turn: ParticipantTurn) => void = () => undefined,
  ) {}

  onChange(listener: (state: ParticipantWorkState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  enqueue(participantId: string, input: string, metadata?: unknown): EnqueueResult {
    const turn: ParticipantTurn = {
      id: crypto.randomUUID(),
      participantId,
      input,
      enqueuedAt: new Date().toISOString(),
      metadata,
    };
    const queue = this.queues.get(participantId) ?? [];
    queue.push(turn);
    this.queues.set(participantId, queue);
    const started = !this.active.has(participantId) && queue.length === 1;
    const queuePosition = started ? 0 : queue.length - (this.active.has(participantId) ? 0 : 1);
    this.emit();
    if (started) void this.drain(participantId);
    return { turn, started, queuePosition };
  }

  removeQueued(turnId: string): boolean {
    for (const [participantId, queue] of this.queues) {
      const index = queue.findIndex((turn) => turn.id === turnId);
      if (index < 0) continue;
      queue.splice(index, 1);
      if (queue.length === 0) this.queues.delete(participantId);
      this.resolveTurn(turnId);
      this.emit();
      return true;
    }
    return false;
  }

  cancel(participantId: string): boolean {
    const active = this.active.get(participantId);
    if (!active || !this.canCancel(participantId)) return false;
    active.phase = 'cancelling';
    active.detail = undefined;
    active.controller.abort();
    this.emit();
    return true;
  }

  isActive(participantId: string): boolean {
    return this.active.has(participantId);
  }

  waitForTurn(turnId: string): Promise<void> {
    const exists = [...this.active.values()].some((active) => active.turn.id === turnId)
      || [...this.queues.values()].some((queue) => queue.some((turn) => turn.id === turnId));
    if (!exists) return Promise.resolve();
    return new Promise((resolve) => {
      const listeners = this.settled.get(turnId) ?? [];
      listeners.push(resolve);
      this.settled.set(turnId, listeners);
    });
  }

  setPhase(participantId: string, phase: ParticipantTurnPhase, detail?: string): boolean {
    const active = this.active.get(participantId);
    if (!active) return false;
    active.phase = phase;
    active.detail = detail;
    this.emit();
    return true;
  }

  snapshot(): ParticipantWorkState {
    const active = [...this.active.values()].map(({ turn, phase, detail }) => ({
      participantId: turn.participantId,
      turnId: turn.id,
      phase,
      ...(detail ? { detail } : {}),
      queueDepth: this.queues.get(turn.participantId)?.length ?? 0,
      cancellable: this.canCancel(turn.participantId),
    }));
    const queued = [...this.queues.values()].flat().map((turn) => ({ ...turn }));
    return { active, queued };
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  private async drain(participantId: string): Promise<void> {
    if (this.active.has(participantId)) return;
    const queue = this.queues.get(participantId);
    const turn = queue?.shift();
    if (!turn) {
      this.queues.delete(participantId);
      this.emit();
      return;
    }
    if (queue?.length === 0) this.queues.delete(participantId);

    const active: ActiveTurn = {
      turn,
      controller: new AbortController(),
      phase: 'preparing',
    };
    this.active.set(participantId, active);
    this.emit();

    try {
      await this.runner(turn, {
        signal: active.controller.signal,
        setPhase: (phase, detail) => {
          if (this.active.get(participantId) !== active) return;
          active.phase = phase;
          active.detail = detail;
          this.emit();
        },
      });
    } catch (error) {
      this.onError(error, turn);
    } finally {
      if (this.active.get(participantId) === active) this.active.delete(participantId);
      this.resolveTurn(turn.id);
      this.emit();
      if ((this.queues.get(participantId)?.length ?? 0) > 0) void this.drain(participantId);
    }
  }


  private resolveTurn(turnId: string): void {
    for (const resolve of this.settled.get(turnId) ?? []) resolve();
    this.settled.delete(turnId);
  }
}
