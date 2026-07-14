import { describe, expect, it, vi } from 'vitest';
import { ParticipantTurnScheduler } from './turn-scheduler.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ParticipantTurnScheduler', () => {
  it('runs different participants concurrently and one participant FIFO', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const starts: string[] = [];
    let index = 0;
    const scheduler = new ParticipantTurnScheduler(async (turn) => {
      starts.push(`${turn.participantId}:${turn.input}`);
      await gates[index++]!.promise;
    });

    scheduler.enqueue('cc', 'first');
    scheduler.enqueue('cc', 'second');
    scheduler.enqueue('squirl', 'hello');
    await vi.waitFor(() => expect(starts).toEqual(['cc:first', 'squirl:hello']));
    expect(scheduler.snapshot().queued.map((turn) => turn.input)).toEqual(['second']);

    gates[0]!.resolve();
    await vi.waitFor(() => expect(starts).toContain('cc:second'));
    gates[1]!.resolve();
    gates[2]!.resolve();
    await vi.waitFor(() => expect(scheduler.snapshot().active).toEqual([]));
  });

  it('removes queued turns without disturbing the active turn', async () => {
    const gate = deferred();
    const scheduler = new ParticipantTurnScheduler(async () => gate.promise);
    scheduler.enqueue('cc', 'active');
    const queued = scheduler.enqueue('cc', 'queued').turn;
    expect(scheduler.removeQueued(queued.id)).toBe(true);
    expect(scheduler.snapshot().queued).toEqual([]);
    gate.resolve();
  });

  it('cancels only the selected active turn and preserves its queue', async () => {
    const completed: string[] = [];
    const scheduler = new ParticipantTurnScheduler(async (turn, { signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      completed.push(turn.input);
    });
    scheduler.enqueue('cc', 'active');
    scheduler.enqueue('cc', 'next');
    await vi.waitFor(() => expect(scheduler.snapshot().active).toHaveLength(1));
    expect(scheduler.cancel('cc')).toBe(true);
    await vi.waitFor(() => expect(completed).toEqual(['active']));
    await vi.waitFor(() => expect(scheduler.snapshot().active[0]?.turnId).toBeDefined());
    expect(scheduler.snapshot().queued).toEqual([]);
    scheduler.cancel('cc');
  });
});
