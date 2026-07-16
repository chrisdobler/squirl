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

  it('collapses continuous managed calendar segments across changed task ids', () => {
    const now = Date.parse('2026-07-14T21:20:00Z');
    const inferred = {
      id: 'task-new', title: 'Research open-source voice options for Squirrel Project', summary: 'The research is continuing with current web access.',
      lastActiveAt: '2026-07-14T20:47:48Z', participantIds: ['squirl', 'cc-squirl-fable'], evidenceIds: ['voice-request'],
    };
    const result = mergeTaskAndCalendarActivity([inferred], [
      { calendarId: 'p', eventId: 'voice-1', title: inferred.title, startAt: '2026-07-14T21:04:32Z', endAt: '2026-07-14T21:13:07Z', allDay: false, squirlTaskId: 'task-old' },
      { calendarId: 'p', eventId: 'voice-2', title: inferred.title, startAt: '2026-07-14T21:13:15Z', endAt: '2026-07-14T21:18:40Z', allDay: false, squirlTaskId: 'task-old' },
      { calendarId: 'p', eventId: 'voice-3', title: inferred.title, startAt: '2026-07-14T21:18:49Z', endAt: '2026-07-14T21:24:19Z', allDay: false, squirlTaskId: 'task-new' },
    ], now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'calendar-p-voice-3', summary: inferred.summary, participantIds: inferred.participantIds, evidenceIds: inferred.evidenceIds,
      calendarEventIds: ['calendar:p:voice-1', 'calendar:p:voice-2', 'calendar:p:voice-3'],
      calendar: { eventId: 'voice-3', managedBySquirl: true },
    });
  });

  it('keeps overlapping managed tasks and merely similar titles separate', () => {
    const now = Date.parse('2026-07-14T21:20:00Z');
    const result = mergeTaskAndCalendarActivity([], [
      { calendarId: 'p', eventId: 'voice-a', title: 'Research open-source voice options', startAt: '2026-07-14T21:00:00Z', endAt: '2026-07-14T21:30:00Z', allDay: false, squirlTaskId: 'task-a' },
      { calendarId: 'p', eventId: 'voice-b', title: 'Research open source voice options', startAt: '2026-07-14T21:10:00Z', endAt: '2026-07-14T21:40:00Z', allDay: false, squirlTaskId: 'task-b' },
      { calendarId: 'p', eventId: 'speech', title: 'Research commercial voice options', startAt: '2026-07-14T21:41:00Z', endAt: '2026-07-14T21:50:00Z', allDay: false, squirlTaskId: 'task-c' },
    ], now);
    expect(result).toHaveLength(3);
  });

  it('uses an inclusive fifteen-minute boundary and preserves later sessions', () => {
    const events = [
      { calendarId: 'p', eventId: 'a', title: 'Research voice options', startAt: '2026-07-14T20:00:00Z', endAt: '2026-07-14T20:05:00Z', allDay: false, squirlTaskId: 'old' },
      { calendarId: 'p', eventId: 'b', title: 'Research voice options', startAt: '2026-07-14T20:20:00Z', endAt: '2026-07-14T20:25:00Z', allDay: false, squirlTaskId: 'new' },
      { calendarId: 'p', eventId: 'c', title: 'Research voice options', startAt: '2026-07-14T20:40:00.001Z', endAt: '2026-07-14T20:45:00Z', allDay: false, squirlTaskId: 'later' },
    ];
    const result = mergeTaskAndCalendarActivity([], events, Date.parse('2026-07-14T20:30:00Z'));
    expect(result).toHaveLength(2);
    expect(result.find((task) => task.calendar?.eventId === 'b')?.calendarEventIds).toEqual(['calendar:p:a', 'calendar:p:b']);
    expect(result.find((task) => task.calendar?.eventId === 'c')?.calendarEventIds).toEqual(['calendar:p:c']);
  });
});
