import { describe, expect, it } from 'vitest';

import {
  TASK_CLARIFICATION_DELAY_MS,
  hasCurrentTask,
  lastTaskClarificationAt,
  recoverTaskClarificationState,
  shouldAskTaskClarification,
  taskUncertaintyStart,
  taskClarificationQuestion,
} from './clarification.js';

describe('task clarification fallback', () => {
  const now = Date.parse('2026-07-13T18:00:00.000Z');

  it('waits five uncertain minutes and asks only once per no-task period', () => {
    expect(shouldAskTaskClarification({ now, state: { phase: 'unknown-unasked', unknownSince: now - TASK_CLARIFICATION_DELAY_MS + 1 }, isBusy: false })).toBe(false);
    expect(shouldAskTaskClarification({ now, state: { phase: 'unknown-unasked', unknownSince: now - TASK_CLARIFICATION_DELAY_MS }, isBusy: false })).toBe(true);
    expect(shouldAskTaskClarification({ now, state: { phase: 'unknown-asked', unknownSince: now - 60 * 60_000 }, isBusy: false })).toBe(false);
    expect(shouldAskTaskClarification({ now, state: { phase: 'known', unknownSince: null }, isBusy: false })).toBe(false);
    expect(shouldAskTaskClarification({ now, state: { phase: 'unknown-unasked', unknownSince: now - TASK_CLARIFICATION_DELAY_MS }, isBusy: true })).toBe(false);
  });

  it('recovers conservatively and does not infer a new period from historical boundaries', () => {
    const askedAt = now - 30 * 60_000;
    expect(recoverTaskClarificationState({ known: false, unknownSince: askedAt, lastAskedAt: askedAt })).toEqual({
      phase: 'unknown-asked', unknownSince: askedAt,
    });
    expect(recoverTaskClarificationState({ known: false, unknownSince: now - 10 * 60_000, lastAskedAt: askedAt })).toEqual({
      phase: 'unknown-asked', unknownSince: askedAt,
    });
    expect(recoverTaskClarificationState({ known: true, unknownSince: askedAt, lastAskedAt: askedAt })).toEqual({
      phase: 'known', unknownSince: null,
    });
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
    expect(taskUncertaintyStart({ snapshot, calendarEvents: [], now, taskWindowMs: 20 * 60_000 })).toBe(Date.parse('2026-07-13T17:55:00.000Z'));
  });

  it('treats a calendar-backed task as confirmed awareness before opening a later period', () => {
    const askedAt = now - 30 * 60_000;
    const event = { calendarId: 'c', eventId: 'e', title: 'Focus', startAt: new Date(now - 5 * 60_000).toISOString(), endAt: new Date(now + 5 * 60_000).toISOString(), allDay: false };
    expect(hasCurrentTask({ snapshot: null, calendarEvents: [event], now, taskWindowMs: 60_000 })).toBe(true);
    expect(recoverTaskClarificationState({ known: true, unknownSince: askedAt, lastAskedAt: askedAt }).phase).toBe('known');

    const afterEvent = now + 5 * 60_000 + 1;
    const unknownSince = taskUncertaintyStart({ snapshot: null, calendarEvents: [event], now: afterEvent, lastAskedAt: askedAt })!;
    const recovered = recoverTaskClarificationState({ known: false, unknownSince, lastAskedAt: askedAt });
    expect(recovered).toEqual({ phase: 'unknown-asked', unknownSince: askedAt });

    // Once the running state machine has positively observed the event, its
    // later end opens the next period at the actual end boundary.
    const state = { phase: 'unknown-unasked' as const, unknownSince: Date.parse(event.endAt) };
    expect(shouldAskTaskClarification({ now: Date.parse(event.endAt) + TASK_CLARIFICATION_DELAY_MS - 1, state, isBusy: false })).toBe(false);
    expect(shouldAskTaskClarification({ now: Date.parse(event.endAt) + TASK_CLARIFICATION_DELAY_MS, state, isBusy: false })).toBe(true);
  });
});
