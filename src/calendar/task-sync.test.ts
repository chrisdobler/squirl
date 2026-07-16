import { describe, expect, it, vi } from 'vitest';
import { syncInferredTaskEvents } from './task-sync.js';

describe('syncInferredTaskEvents', () => {
  it('extends only for newly classified activity and survives one transient omission', async () => {
    const createTaskEvent = vi.fn(async () => 'event-1');
    const updateTaskEvent = vi.fn(async () => undefined);
    const save = vi.fn();
    const first = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:00:00Z', sourceWatermark: 'a', tasks: [{ id: 'task-1', title: 'Build Squirl', summary: 'Wire active tasks into the calendar.', lastActiveAt: '2026-07-13T18:00:00Z', participantIds: [], evidenceIds: [] }] },
      state: { version: 1, entries: [] }, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:05:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(createTaskEvent).toHaveBeenCalledWith('primary', expect.objectContaining({ summary: 'Wire active tasks into the calendar.', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:06:00.000Z' }));
    const idle = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:07:00Z', sourceWatermark: 'a', tasks: [{ id: 'task-1', title: 'Build Squirl', summary: 'Wire active tasks into the calendar.', lastActiveAt: '2026-07-13T18:00:00Z', participantIds: [], evidenceIds: [] }] },
      state: first, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:07:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(idle.entries[0]).toMatchObject({ endAt: '2026-07-13T18:06:00.000Z', lastActiveAt: '2026-07-13T18:00:00Z' });
    expect(updateTaskEvent).not.toHaveBeenCalled();
    const summarized = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:08:00Z', sourceWatermark: 'a', tasks: [{ id: 'task-1', title: 'Build Squirl', summary: 'Sync the current task summary into calendar notes.', lastActiveAt: '2026-07-13T18:00:00Z', participantIds: [], evidenceIds: [] }] },
      state: idle, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:08:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(updateTaskEvent).toHaveBeenLastCalledWith('primary', 'event-1', expect.objectContaining({ summary: 'Sync the current task summary into calendar notes.', endAt: '2026-07-13T18:06:00.000Z' }));
    const rolling = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:10:00Z', sourceWatermark: 'b', tasks: [{ id: 'task-1', title: 'Improve Squirl task visibility', lastActiveAt: '2026-07-13T18:09:00Z', participantIds: [], evidenceIds: [] }] },
      state: summarized, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:10:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(rolling.entries[0]).toMatchObject({ taskId: 'task-1', title: 'Improve Squirl task visibility', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:11:00.000Z', status: 'active' });
    expect(createTaskEvent).toHaveBeenCalledOnce();
    const missing = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:12:00Z', sourceWatermark: 'c', tasks: [] },
      state: rolling, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:12:00Z'),
      missingGraceMs: 60_000,
    });
    expect(missing.entries[0]).toMatchObject({ status: 'active', missingSince: '2026-07-13T18:12:00.000Z' });

    const recovered = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:12:30Z', sourceWatermark: 'd', tasks: [{ id: 'task-1', title: 'Improve Squirl task visibility', lastActiveAt: '2026-07-13T18:09:00Z', participantIds: [], evidenceIds: [] }] },
      state: missing, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:12:30Z'),
      missingGraceMs: 60_000,
    });
    expect(recovered.entries[0]).toMatchObject({ status: 'active' });
    expect(recovered.entries[0]?.missingSince).toBeUndefined();
    expect(createTaskEvent).toHaveBeenCalledOnce();
  });

  it('ends after the grace period, reactivates recent continuity, and starts anew after the window', async () => {
    const createTaskEvent = vi.fn(async () => `event-${createTaskEvent.mock.calls.length}`);
    const updateTaskEvent = vi.fn(async () => undefined);
    const save = vi.fn();
    const task = { id: 'task-1', title: 'Research open-source voice options', lastActiveAt: '2026-07-13T18:00:00Z', participantIds: [], evidenceIds: [] };
    const first = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:00:00Z', sourceWatermark: 'a', tasks: [task] },
      state: { version: 1, entries: [] }, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:00:00Z'), activeHorizonMs: 60_000,
    });
    const missing = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:01:00Z', sourceWatermark: 'b', tasks: [] },
      state: first, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:01:00Z'), missingGraceMs: 60_000,
    });
    const ended = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:02:00Z', sourceWatermark: 'c', tasks: [] },
      state: missing, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:02:00Z'), missingGraceMs: 60_000,
    });
    expect(ended.entries[0]).toMatchObject({ status: 'ended', endAt: '2026-07-13T18:02:00.000Z' });

    const reactivated = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T18:03:00Z', sourceWatermark: 'd', tasks: [{ ...task, id: 'task-renamed' }] },
      state: ended, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:03:00Z'), activeHorizonMs: 60_000, continuityWindowMs: 5 * 60_000,
    });
    expect(reactivated.entries[0]).toMatchObject({ taskId: 'task-renamed', eventId: 'event-1', status: 'active', endAt: '2026-07-13T18:04:00.000Z' });
    expect(createTaskEvent).toHaveBeenCalledOnce();

    const historical = { ...reactivated, entries: reactivated.entries.map((entry) => ({ ...entry, status: 'ended' as const, endAt: '2026-07-13T18:04:00Z' })) };
    const restarted = await syncInferredTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-13T19:00:00Z', sourceWatermark: 'e', tasks: [{ ...task, id: 'task-later' }] },
      state: historical, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T19:00:00Z'), activeHorizonMs: 60_000, continuityWindowMs: 5 * 60_000,
    });
    expect(restarted.entries).toHaveLength(2);
    expect(restarted.entries[1]).toMatchObject({ taskId: 'task-later', eventId: 'event-2', status: 'active' });
  });

  it('does not merge distinct concurrent tasks that share an exact title', async () => {
    const createTaskEvent = vi.fn(async () => `event-${createTaskEvent.mock.calls.length}`);
    const updateTaskEvent = vi.fn(async () => undefined);
    const title = 'Research open-source voice options';
    const result = await syncInferredTaskEvents({
      snapshot: {
        version: 3, generatedAt: '2026-07-13T18:00:00Z', sourceWatermark: 'a',
        tasks: [
          { id: 'task-a', title, lastActiveAt: '2026-07-13T18:00:00Z', participantIds: ['agent-a'], evidenceIds: ['a'] },
          { id: 'task-b', title, lastActiveAt: '2026-07-13T18:00:00Z', participantIds: ['agent-b'], evidenceIds: ['b'] },
        ],
      },
      state: { version: 1, entries: [] }, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save: vi.fn(),
      now: Date.parse('2026-07-13T18:00:00Z'),
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.taskId)).toEqual(['task-a', 'task-b']);
    expect(createTaskEvent).toHaveBeenCalledTimes(2);
    expect(updateTaskEvent).not.toHaveBeenCalled();
  });
});
