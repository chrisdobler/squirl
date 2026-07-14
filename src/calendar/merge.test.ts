import { describe, expect, it } from 'vitest';
import { mergeTaskAndCalendarActivity } from './merge.js';

describe('mergeTaskAndCalendarActivity', () => {
  it('uses calendar rows for semantic matches, preserves duplicates, and orders current work first', () => {
    const now = Date.parse('2026-07-13T18:00:00Z');
    const task = { id: 'task-1', title: 'Work on Squirl', summary: 'The current Squirl integration is under active development.', lastActiveAt: '2026-07-13T17:58:00Z', participantIds: ['codex'], evidenceIds: ['u1'], calendarEventIds: ['calendar:primary:event-a', 'calendar:primary:event-b'] };
    const events = [
      { calendarId: 'primary', eventId: 'event-a', title: 'squirl', startAt: '2026-07-13T17:30:00Z', endAt: '2026-07-13T18:30:00Z', allDay: false },
      { calendarId: 'primary', eventId: 'event-b', title: 'Squirl booking copy', startAt: '2026-07-13T19:00:00Z', endAt: '2026-07-13T19:30:00Z', allDay: false },
    ];
    const result = mergeTaskAndCalendarActivity([task], events, now);
    expect(result.map((item) => item.title)).toEqual(['squirl', 'Squirl booking copy']);
    expect(result[0]).toMatchObject({ source: 'calendar', summary: 'The current Squirl integration is under active development.', participantIds: ['codex'], evidenceIds: ['u1'] });
  });

  it('orders ongoing events, upcoming events, inferred work, then recently ended events', () => {
    const now = Date.parse('2026-07-13T18:00:00Z');
    const inferred = { id: 'task', title: 'active', lastActiveAt: '2026-07-13T17:59:00Z', participantIds: [], evidenceIds: [] };
    const event = (eventId: string, title: string, startAt: string, endAt: string) => ({ calendarId: 'p', eventId, title, startAt, endAt, allDay: false });
    const result = mergeTaskAndCalendarActivity([inferred], [
      event('up', 'upcoming', '2026-07-13T19:00:00Z', '2026-07-13T19:30:00Z'),
      event('ended', 'ended', '2026-07-13T17:00:00Z', '2026-07-13T17:30:00Z'),
      event('now', 'ongoing', '2026-07-13T17:45:00Z', '2026-07-13T18:15:00Z'),
    ], now);
    expect(result.map((item) => item.title)).toEqual(['ongoing', 'upcoming', 'active', 'ended']);
  });

  it('keeps a Squirl-managed task below upcoming meetings after it becomes a calendar event', () => {
    const now = Date.parse('2026-07-13T18:00:00Z');
    const inferred = { id: 'task', title: 'active', lastActiveAt: '2026-07-13T17:59:00Z', participantIds: [], evidenceIds: [] };
    const result = mergeTaskAndCalendarActivity([inferred], [
      { calendarId: 'p', eventId: 'managed', title: 'active', startAt: '2026-07-13T17:45:00Z', endAt: '2026-07-13T18:05:00Z', allDay: false, squirlTaskId: 'task' },
      { calendarId: 'p', eventId: 'up', title: 'upcoming', startAt: '2026-07-13T19:00:00Z', endAt: '2026-07-13T19:30:00Z', allDay: false },
    ], now);
    expect(result.map((item) => item.title)).toEqual(['upcoming', 'active']);
    expect(result[1]).toMatchObject({ source: 'calendar', calendar: { eventId: 'managed', managedBySquirl: true } });
  });
});
