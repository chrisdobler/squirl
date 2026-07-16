import type { CalendarEventRecord } from './types.js';
import type { TaskActivityItem } from '../tasks/types.js';
import { normalizeTaskTitle, taskIdentityMatches, taskSegmentsAreContinuous } from '../tasks/continuity.js';

export const CALENDAR_LOOKBACK_MS = 60 * 60 * 1000;
export const CALENDAR_LOOKAHEAD_MS = 4 * 60 * 60 * 1000;
interface CalendarEventGroup {
  events: CalendarEventRecord[];
  managed: boolean;
}

function groupCalendarEvents(events: CalendarEventRecord[]): CalendarEventGroup[] {
  const groups: CalendarEventGroup[] = [];
  for (const event of [...events].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
    if (!event.squirlTaskId) {
      groups.push({ events: [event], managed: false });
      continue;
    }
    const eventStart = Date.parse(event.startAt);
    const candidate = groups.find((group) => {
      if (!group.managed) return false;
      const latest = [...group.events].sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0]!;
      const sameIdentity = taskIdentityMatches(
        { taskId: latest.squirlTaskId, title: latest.title },
        { taskId: event.squirlTaskId, title: event.title },
      );
      if (!sameIdentity) return false;
      if (latest.squirlTaskId !== event.squirlTaskId && eventStart < Date.parse(latest.endAt)) return false;
      return eventStart < Date.parse(latest.endAt) || taskSegmentsAreContinuous(latest.endAt, event.startAt);
    });
    if (candidate) candidate.events.push(event);
    else groups.push({ events: [event], managed: true });
  }
  return groups;
}

function preferredEvent(events: CalendarEventRecord[], now: number): CalendarEventRecord {
  const active = events.filter((event) => Date.parse(event.startAt) <= now && Date.parse(event.endAt) > now);
  return [...(active.length ? active : events)].sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0]!;
}

export function mergeTaskAndCalendarActivity(tasks: TaskActivityItem[], events: CalendarEventRecord[], now = Date.now()): TaskActivityItem[] {
  const linked = new Set<string>();
  const groups = groupCalendarEvents(events);
  const managedTitleGroupCounts = new Map<string, number>();
  for (const group of groups) {
    if (!group.managed) continue;
    const key = normalizeTaskTitle(preferredEvent(group.events, now).title);
    managedTitleGroupCounts.set(key, (managedTitleGroupCounts.get(key) ?? 0) + 1);
  }
  const calendarRows = groups.map((group) => {
    const event = preferredEvent(group.events, now);
    const evidenceIds = group.events.map((item) => `calendar:${item.calendarId}:${item.eventId}`);
    const directMatches = tasks.filter((task) => group.events.some((item, index) => task.id === item.squirlTaskId
      || (task.calendarEventIds?.includes(evidenceIds[index]!) && (!item.squirlTaskId || normalizeTaskTitle(task.title) === normalizeTaskTitle(item.title)))));
    const exactTitleMatches = group.managed && managedTitleGroupCounts.get(normalizeTaskTitle(event.title)) === 1
      ? tasks.filter((task) => normalizeTaskTitle(task.title) === normalizeTaskTitle(event.title))
      : [];
    const matches = directMatches.length > 0 ? directMatches : exactTitleMatches.length === 1 ? exactTitleMatches : [];
    matches.forEach((match) => linked.add(match.id));
    const summary = matches.find((match) => match.summary)?.summary;
    const lastActiveAt = matches.map((match) => match.lastActiveAt).sort().at(-1) ?? event.startAt;
    const participantIds = [...new Set(matches.flatMap((match) => match.participantIds))];
    const taskEvidenceIds = [...new Set(matches.flatMap((match) => match.evidenceIds))];
    return {
      id: `calendar-${encodeURIComponent(event.calendarId)}-${encodeURIComponent(event.eventId)}`,
      title: event.title,
      ...(summary ? { summary } : {}),
      lastActiveAt,
      participantIds,
      evidenceIds: taskEvidenceIds,
      source: 'calendar' as const,
      calendarEventIds: evidenceIds,
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
