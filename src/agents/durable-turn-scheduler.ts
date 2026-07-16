import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import type { DurableTurn, RoomStore } from '../persistence/types.js';
import type { EnqueueResult, ParticipantActivity, ParticipantTurn, ParticipantWorkState, TurnExecutionContext } from './turn-scheduler.js';

type Runner = (turn: ParticipantTurn, context: TurnExecutionContext) => Promise<void>;

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const POLL_MS = 1_000;

function participantTurn(turn: DurableTurn): ParticipantTurn {
  return {
    id: turn.id, participantId: turn.participantId, input: turn.input, enqueuedAt: turn.enqueuedAt,
    metadata: { ...(turn.metadata ?? {}), durableSourceMessageId: turn.sourceMessageId, durableHandoffMessageId: turn.handoffMessageId },
    status: turn.status, attempt: turn.attempt, lastError: turn.lastError,
  };
}

export class DurableParticipantTurnScheduler {
  private readonly workerId = `squirl-${process.pid}-${randomUUID()}`;
  private readonly listeners = new Set<(state: ParticipantWorkState) => void>();
  private readonly active = new Map<string, { turn: DurableTurn; controller: AbortController; phase: ParticipantActivity['phase']; detail?: string }>();
  private work: ParticipantWorkState = { active: [], queued: [], interrupted: [], failed: [] };
  private polling: ReturnType<typeof setInterval> | null = null;
  private readonly settled = new Map<string, Array<() => void>>();
  private readonly cancelling = new Set<string>();
  private pumping = false;
  private stopped = false;
  private initialized = false;

  constructor(
    private readonly store: RoomStore,
    private readonly runner: Runner,
    private readonly canCancel: (participantId: string) => boolean = () => true,
    private readonly onError: (error: unknown, turn: ParticipantTurn) => void = () => undefined,
    private readonly onStorageError: (error: unknown) => void = () => undefined,
    private readonly onStorageHealthy: () => void = () => undefined,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.interruptExpired();
    await this.refresh();
    await this.pump();
    this.polling = setInterval(() => { void this.tick().catch((error) => this.onStorageError(error)); }, POLL_MS);
    this.polling.unref?.();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.polling) clearInterval(this.polling);
    for (const active of this.active.values()) active.controller.abort();
  }

  onChange(listener: (state: ParticipantWorkState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ParticipantWorkState { return this.work; }
  isActive(participantId: string): boolean { return this.active.has(participantId); }
  setPhase(participantId: string, phase: ParticipantActivity['phase'], detail?: string): boolean {
    const active = this.active.get(participantId);
    if (!active) return false;
    active.phase = phase;
    active.detail = detail;
    void this.refresh();
    return true;
  }

  waitForTurn(turnId: string): Promise<void> {
    const exists = this.work.active.some((turn) => turn.turnId === turnId)
      || this.work.queued.some((turn) => turn.id === turnId);
    if (!exists) return Promise.resolve();
    return new Promise((resolve) => this.settled.set(turnId, [...(this.settled.get(turnId) ?? []), resolve]));
  }

  async enqueue(participantId: string, input: string, requestId: string, message?: Message, metadata?: Record<string, unknown>): Promise<EnqueueResult & { created: boolean }> {
    const result = await this.store.enqueue({ participantId, input, requestId, message, metadata });
    await this.refresh();
    const timer = setTimeout(() => { void this.pump(); }, 0);
    timer.unref?.();
    const queue = this.work.queued.filter((turn) => turn.participantId === participantId);
    const queuePosition = Math.max(0, queue.findIndex((turn) => turn.id === result.turn.id));
    return { turn: participantTurn(result.turn), created: result.created, started: result.turn.status === 'running', queuePosition };
  }

  async retry(turnId: string): Promise<boolean> {
    const turn = await this.store.retry(turnId);
    await this.refresh();
    if (turn) void this.pump();
    return Boolean(turn);
  }

  async commitHandoff(input: Parameters<RoomStore['commitHandoff']>[0]): Promise<{ turn: ParticipantTurn; created: boolean }> {
    const result = await this.store.commitHandoff(input);
    await this.refresh();
    void this.pump();
    return { turn: participantTurn(result.turn), created: result.created };
  }

  async removeQueued(turnId: string): Promise<boolean> {
    const removed = await this.store.cancel(turnId);
    await this.refresh();
    return removed;
  }

  async cancel(participantId: string): Promise<boolean> {
    const current = this.active.get(participantId);
    if (!current || !this.canCancel(participantId)) return false;
    current.phase = 'cancelling';
    this.cancelling.add(current.turn.id);
    current.controller.abort();
    await this.refresh();
    return true;
  }

  async refresh(): Promise<void> {
    const stored = await this.store.workState();
    const active: ParticipantActivity[] = stored.active.map((turn) => {
      const local = this.active.get(turn.participantId);
      return {
        participantId: turn.participantId, turnId: turn.id, phase: local?.phase ?? 'working', detail: local?.detail,
        queueDepth: stored.queued.filter((item) => item.participantId === turn.participantId).length,
        cancellable: this.canCancel(turn.participantId),
      };
    });
    this.work = {
      active,
      queued: stored.queued.map(participantTurn),
      interrupted: stored.interrupted.map(participantTurn),
      failed: stored.failed.map(participantTurn),
    };
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.store.interruptExpired();
    await this.refresh();
    await this.pump();
    this.onStorageHealthy();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        const turn = await this.store.claim(this.workerId, LEASE_MS);
        if (!turn) break;
        const controller = new AbortController();
        this.active.set(turn.participantId, { turn, controller, phase: 'preparing' });
        void this.run(turn, controller);
      }
      await this.refresh();
    } finally { this.pumping = false; }
  }

  private async run(turn: DurableTurn, controller: AbortController): Promise<void> {
    const heartbeat = setInterval(() => { void this.store.renew(turn.id, this.workerId, LEASE_MS).catch((error) => this.onStorageError(error)); }, HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      await this.runner(participantTurn(turn), {
        signal: controller.signal,
        setPhase: (phase, detail) => {
          const active = this.active.get(turn.participantId);
          if (!active || active.turn.id !== turn.id) return;
          active.phase = phase; active.detail = detail;
          void this.refresh();
        },
      });
      if (this.cancelling.has(turn.id)) await this.store.finish(turn.id, this.workerId, 'cancelled');
      else if (!controller.signal.aborted) await this.store.finish(turn.id, this.workerId, 'succeeded');
    } catch (error) {
      if (this.cancelling.has(turn.id)) await this.store.finish(turn.id, this.workerId, 'cancelled');
      else {
        this.onError(error, participantTurn(turn));
        if (!controller.signal.aborted) await this.store.finish(turn.id, this.workerId, 'failed', error instanceof Error ? error.message : String(error));
      }
    } finally {
      clearInterval(heartbeat);
      this.cancelling.delete(turn.id);
      const active = this.active.get(turn.participantId);
      if (active?.turn.id === turn.id) this.active.delete(turn.participantId);
      for (const resolve of this.settled.get(turn.id) ?? []) resolve();
      this.settled.delete(turn.id);
      await this.refresh().catch((error) => this.onStorageError(error));
      void this.pump();
    }
  }
}
