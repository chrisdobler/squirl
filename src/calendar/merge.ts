import type { CalendarEventRecord } from './types.js';
import type { TaskActivityItem } from '../tasks/types.js';

export const CALENDAR_LOOKBACK_MS = 60 * 60 * 1000;
export const CALENDAR_LOOKAHEAD_MS = 4 * 60 * 60 * 1000;

export function mergeTaskAndCalendarActivity(tasks: TaskActivityItem[], events: CalendarEventRecord[], now = Date.now()): TaskActivityItem[] {
  const linked = new Set<string>();
  const calendarRows = events.map((event) => {
    const evidenceId = `calendar:${event.calendarId}:${event.eventId}`;
    const match = tasks.find((task) => task.id === event.squirlTaskId || task.calendarEventIds?.includes(evidenceId));
    if (match) linked.add(match.id);
    return {
      id: `calendar-${encodeURIComponent(event.calendarId)}-${encodeURIComponent(event.eventId)}`,
      title: event.title,
      ...(match?.summary ? { summary: match.summary } : {}),
      lastActiveAt: match?.lastActiveAt ?? event.startAt,
      participantIds: match?.participantIds ?? [],
      evidenceIds: match?.evidenceIds ?? [],
      source: 'calendar' as const,
      calendarEventIds: [evidenceId],
      calendar: { calendarId: event.calendarId, eventId: event.eventId, startAt: event.startAt, endAt: event.endAt, allDay: event.allDay, ...(event.squirlTaskId ? { managedBySquirl: true } : {}) },
    };
  });
  const inferred = tasks.filter((task) => !linked.has(task.id)).map((task) => ({ ...task, source: 'inferred' as const }));
  const rank = (task: TaskActivityItem): [number, number] => {
    if (!task.calendar) return [2, -Date.parse(task.lastActiveAt)];
    if (task.calendar.managedBySquirl) return [2, -Date.parse(task.lastActiveAt)];
    const start = Date.parse(task.calendar.startAt); const end = Date.parse(task.calendar.endAt);
    if (start <= now && end > now) return [0, start];
    if (start > now) return [1, start];
    return [3, -end];
  };
  return [...calendarRows, ...inferred].sort((a, b) => { const ra = rank(a); const rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1]; });
}
