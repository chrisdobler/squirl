import { describe, expect, it, vi } from 'vitest';

import { consolidateDuplicateTaskEvents, sanitizeTaskCalendarLinks } from './repair.js';
import type { TaskCalendarSyncEntry } from './types.js';

function entry(overrides: Partial<TaskCalendarSyncEntry> & Pick<TaskCalendarSyncEntry, 'eventId' | 'taskId' | 'title' | 'startAt' | 'endAt'>): TaskCalendarSyncEntry {
  return {
    calendarId: 'primary', lastSeenAt: overrides.endAt, lastActiveAt: overrides.startAt, status: 'ended',
    ...overrides,
  };
}

describe('calendar task repair', () => {
  it('consolidates the observed voice and Prometheus chains into their latest keepers', async () => {
    const voiceTitle = 'Research open-source voice options for Squirrel Project';
    const entries = [
      entry({ eventId: 'voice-1', taskId: 'voice-old', title: voiceTitle, startAt: '2026-07-14T21:04:32Z', endAt: '2026-07-14T21:13:07Z' }),
      entry({ eventId: 'voice-2', taskId: 'voice-old', title: voiceTitle, startAt: '2026-07-14T21:13:15Z', endAt: '2026-07-14T21:18:40Z' }),
      entry({ eventId: 'voice-3', taskId: 'voice-middle', title: voiceTitle, startAt: '2026-07-14T21:18:49Z', endAt: '2026-07-14T21:22:44Z' }),
      entry({ eventId: 'voice-4', taskId: 'voice-current', title: voiceTitle, startAt: '2026-07-14T21:22:54Z', endAt: '2026-07-14T21:28:24Z', status: 'active' }),
      entry({ eventId: 'prom-1', taskId: 'prometheus', title: 'Determine cause of yellow Prometheus monitoring', startAt: '2026-07-14T17:31:47Z', endAt: '2026-07-14T17:55:44Z' }),
      entry({ eventId: 'prom-2', taskId: 'prometheus', title: 'Investigate why Prometheus monitoring is yellow', startAt: '2026-07-14T18:05:33Z', endAt: '2026-07-14T18:06:33Z' }),
      entry({ eventId: 'prom-3', taskId: 'prometheus', title: 'Determine cause of yellow Prometheus monitoring', startAt: '2026-07-14T18:16:04Z', endAt: '2026-07-14T18:31:02Z' }),
    ];
    const updateTaskEvent = vi.fn(async () => undefined);
    const deleteTaskEvent = vi.fn(async (_calendarId: string, _eventId: string) => undefined);
    const audit = vi.fn();
    const result = await consolidateDuplicateTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-14T21:26:34Z', sourceWatermark: 'x', tasks: [{ id: 'voice-current', title: voiceTitle, summary: 'Current voice research.', lastActiveAt: '2026-07-14T20:47:48Z', participantIds: [], evidenceIds: [] }] },
      state: { version: 1, entries }, client: { updateTaskEvent, deleteTaskEvent }, save: vi.fn(), audit,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries).toContainEqual(expect.objectContaining({ eventId: 'voice-4', taskId: 'voice-current', startAt: '2026-07-14T21:04:32Z', status: 'active' }));
    expect(result.entries).toContainEqual(expect.objectContaining({ eventId: 'prom-3', taskId: 'prometheus', startAt: '2026-07-14T17:31:47Z', status: 'ended' }));
    expect(new Set(deleteTaskEvent.mock.calls.map((call) => call[1]))).toEqual(new Set(['voice-1', 'voice-2', 'voice-3', 'prom-1', 'prom-2']));
    expect(audit).toHaveBeenCalledOnce();
  });

  it('keeps sessions beyond fifteen minutes separate and resumes safely after a partial delete failure', async () => {
    const title = 'Research open-source voice options';
    const entries = [
      entry({ eventId: 'a', taskId: 'old', title, startAt: '2026-07-14T18:00:00Z', endAt: '2026-07-14T18:05:00Z' }),
      entry({ eventId: 'b', taskId: 'old', title, startAt: '2026-07-14T18:20:00Z', endAt: '2026-07-14T18:25:00Z' }),
      entry({ eventId: 'd', taskId: 'new', title, startAt: '2026-07-14T18:40:00Z', endAt: '2026-07-14T18:45:00Z' }),
      entry({ eventId: 'c', taskId: 'later', title, startAt: '2026-07-14T19:25:01Z', endAt: '2026-07-14T19:30:00Z' }),
    ];
    let saved = { version: 1 as const, entries };
    const deleteTaskEvent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('temporary delete failure'));
    await expect(consolidateDuplicateTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-14T18:25:00Z', sourceWatermark: 'x', tasks: [] },
      state: saved, client: { updateTaskEvent: vi.fn(async () => undefined), deleteTaskEvent }, save: (state) => { saved = state; },
    })).rejects.toThrow('temporary delete failure');
    expect(saved.entries.map((item) => item.eventId)).toEqual(['b', 'd', 'c']);

    const recovered = await consolidateDuplicateTaskEvents({
      snapshot: { version: 3, generatedAt: '2026-07-14T18:25:00Z', sourceWatermark: 'x', tasks: [] },
      state: saved, client: { updateTaskEvent: vi.fn(async () => undefined), deleteTaskEvent: vi.fn(async () => undefined) }, save: (state) => { saved = state; },
    });
    expect(recovered.entries.map((item) => item.eventId)).toEqual(['d', 'c']);
  });

  it('prunes deleted and contradictory managed links while retaining valid unmanaged links', () => {
    const snapshot = {
      version: 3 as const, generatedAt: '2026-07-14T21:26:34Z', sourceWatermark: 'x',
      tasks: [{ id: 'voice', title: 'Research open-source voice options', lastActiveAt: '2026-07-14T20:47:48Z', participantIds: [], evidenceIds: [], calendarEventIds: ['calendar:p:voice', 'calendar:p:deleted', 'calendar:p:scrum', 'calendar:p:meeting'] }],
    };
    const state = { version: 1 as const, entries: [
      entry({ calendarId: 'p', eventId: 'voice', taskId: 'voice', title: 'Research open-source voice options', startAt: '2026-07-14T21:00:00Z', endAt: '2026-07-14T21:10:00Z' }),
      entry({ calendarId: 'p', eventId: 'scrum', taskId: 'scrum', title: 'Implement Scrum timeout fix', startAt: '2026-07-14T20:00:00Z', endAt: '2026-07-14T20:30:00Z' }),
    ] };
    const events = [{ calendarId: 'p', eventId: 'meeting', title: 'Team meeting', startAt: '2026-07-14T22:00:00Z', endAt: '2026-07-14T22:30:00Z', allDay: false }];
    const result = sanitizeTaskCalendarLinks(snapshot, state, events);
    expect(result.changed).toBe(true);
    expect(result.snapshot.tasks[0]?.calendarEventIds).toEqual(['calendar:p:voice', 'calendar:p:meeting']);
  });
});
