import { describe, expect, it, vi } from 'vitest';
import { syncInferredTaskEvents } from './task-sync.js';

describe('syncInferredTaskEvents', () => {
  it('extends only for newly classified user activity and freezes when absent', async () => {
    const createTaskEvent = vi.fn(async () => 'event-1');
    const updateTaskEvent = vi.fn(async () => undefined);
    const save = vi.fn();
    const first = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:00:00Z', sourceWatermark: 'a', tasks: [{ id: 'task-1', title: 'Build Squirl', lastActiveAt: '2026-07-13T18:00:00Z', participantIds: [], evidenceIds: [] }] },
      state: { version: 1, entries: [] }, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:05:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(createTaskEvent).toHaveBeenCalledWith('primary', expect.objectContaining({ startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:06:00.000Z' }));
    const idle = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:07:00Z', sourceWatermark: 'a', tasks: [{ id: 'task-1', title: 'Build Squirl', lastActiveAt: '2026-07-13T18:00:00Z', participantIds: [], evidenceIds: [] }] },
      state: first, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:07:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(idle.entries[0]).toMatchObject({ endAt: '2026-07-13T18:06:00.000Z', lastActiveAt: '2026-07-13T18:00:00Z' });
    expect(updateTaskEvent).not.toHaveBeenCalled();
    const rolling = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:10:00Z', sourceWatermark: 'b', tasks: [{ id: 'task-2', title: 'Build Squirl', lastActiveAt: '2026-07-13T18:09:00Z', participantIds: [], evidenceIds: [] }] },
      state: idle, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:10:00Z'),
      activeHorizonMs: 60_000,
    });
    expect(rolling.entries[0]).toMatchObject({ taskId: 'task-2', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:11:00.000Z', status: 'active' });
    const ended = await syncInferredTaskEvents({
      snapshot: { version: 2, generatedAt: '2026-07-13T18:12:00Z', sourceWatermark: 'c', tasks: [] },
      state: rolling, calendarId: 'primary', client: { createTaskEvent, updateTaskEvent }, save,
      now: Date.parse('2026-07-13T18:12:00Z'),
    });
    expect(ended.entries[0]).toMatchObject({ startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:12:00.000Z', status: 'ended' });
  });
});
