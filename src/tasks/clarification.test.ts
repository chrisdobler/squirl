import { describe, expect, it } from 'vitest';

import {
  TASK_CLARIFICATION_DELAY_MS,
  hasCurrentTask,
  lastTaskClarificationAt,
  shouldAskTaskClarification,
  taskUncertaintyStart,
  taskClarificationQuestion,
} from './clarification.js';

describe('task clarification fallback', () => {
  const now = Date.parse('2026-07-13T18:00:00.000Z');

  it('waits five uncertain minutes and asks only once per no-task period', () => {
    expect(shouldAskTaskClarification({ now, unknownSince: now - TASK_CLARIFICATION_DELAY_MS + 1, lastAskedAt: null, isBusy: false })).toBe(false);
    expect(shouldAskTaskClarification({ now, unknownSince: now - TASK_CLARIFICATION_DELAY_MS, lastAskedAt: null, isBusy: false })).toBe(true);
    expect(shouldAskTaskClarification({ now, unknownSince: now - 60 * 60_000, lastAskedAt: now - 55 * 60_000, isBusy: false })).toBe(false);
    expect(shouldAskTaskClarification({ now, unknownSince: now - 10 * 60_000, lastAskedAt: now - 60 * 60_000, isBusy: false })).toBe(true);
    expect(shouldAskTaskClarification({ now, unknownSince: now - TASK_CLARIFICATION_DELAY_MS, lastAskedAt: null, isBusy: true })).toBe(false);
  });

  it('accepts a fresh inferred task or an event happening now as current work', () => {
    const snapshot = {
      version: 2 as const,
      generatedAt: new Date(now).toISOString(),
      sourceWatermark: 'test',
      tasks: [{ id: 't1', title: 'Current work', lastActiveAt: new Date(now - 1_000).toISOString(), participantIds: [], evidenceIds: [] }],
    };
    expect(hasCurrentTask({ snapshot, calendarEvents: [], now, taskWindowMs: 60_000 })).toBe(true);
    expect(hasCurrentTask({ snapshot: null, calendarEvents: [{ calendarId: 'c', eventId: 'e', title: 'Focus', startAt: new Date(now - 1_000).toISOString(), endAt: new Date(now + 1_000).toISOString(), allDay: false }], now, taskWindowMs: 60_000 })).toBe(true);
    expect(hasCurrentTask({ snapshot: null, calendarEvents: [{ calendarId: 'c', eventId: 'e', title: 'Later', startAt: new Date(now + 1_000).toISOString(), endAt: new Date(now + 2_000).toISOString(), allDay: false }], now, taskWindowMs: 60_000 })).toBe(false);
  });

  it('recognizes persisted clarification prompts and addresses a configured user', () => {
    const createdAt = '2026-07-13T17:55:00.000Z';
    expect(lastTaskClarificationAt([{ id: 'a1', role: 'assistant', content: 'question', proactiveKind: 'task-clarification', createdAt }])).toBe(Date.parse(createdAt));
    expect(taskClarificationQuestion(' Chris ')).toContain('Hey Chris,');
    expect(taskClarificationQuestion()).not.toContain('Hey');
  });

  it('recovers the uncertainty start from persisted task and calendar boundaries', () => {
    const snapshot = {
      version: 2 as const,
      generatedAt: '2026-07-13T17:40:00.000Z',
      sourceWatermark: 'test',
      tasks: [{ id: 't1', title: 'Earlier work', lastActiveAt: '2026-07-13T17:35:00.000Z', participantIds: [], evidenceIds: [] }],
    };
    const calendarEvents = [{ calendarId: 'c', eventId: 'e', title: 'Focus', startAt: '2026-07-13T17:30:00.000Z', endAt: '2026-07-13T17:55:00.000Z', allDay: false }];
    expect(taskUncertaintyStart({ snapshot, calendarEvents, now })).toBe(Date.parse('2026-07-13T17:55:00.000Z'));
    expect(taskUncertaintyStart({ snapshot: null, calendarEvents: [], now })).toBeNull();
    expect(taskUncertaintyStart({ snapshot: { ...snapshot, tasks: [] }, calendarEvents: [], now, lastAskedAt: Date.parse('2026-07-13T17:50:00.000Z') })).toBe(Date.parse('2026-07-13T17:50:00.000Z'));
    expect(taskUncertaintyStart({ snapshot, calendarEvents, now, lastAskedAt: Date.parse('2026-07-13T17:45:00.000Z') })).toBe(Date.parse('2026-07-13T17:55:00.000Z'));
  });
});
