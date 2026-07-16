import type { GoogleCalendarClient } from './google.js';
import type { CalendarEventRecord, TaskCalendarSyncEntry, TaskCalendarSyncSnapshot } from './types.js';
import { calendarEventEvidenceId, normalizeTaskTitle, TASK_CONTINUITY_GAP_MS, taskIdentityMatches, taskSegmentsAreContinuous } from '../tasks/continuity.js';
import type { TaskActivitySnapshot } from '../tasks/types.js';

export interface CalendarRepairAudit {
  version: 1;
  generatedAt: string;
  continuityGapMs: number;
  groups: Array<{ keeperEventId: string; entries: TaskCalendarSyncEntry[] }>;
}

function duplicateGroups(entries: TaskCalendarSyncEntry[]): TaskCalendarSyncEntry[][] {
  const groups: TaskCalendarSyncEntry[][] = [];
  for (const entry of [...entries].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
    const group = groups.find((candidate) => {
      if (candidate[0]?.calendarId !== entry.calendarId) return false;
      const latest = [...candidate].sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0]!;
      if (!taskIdentityMatches(latest, entry)) return false;
      if (latest.taskId !== entry.taskId && Date.parse(entry.startAt) < Date.parse(latest.endAt)) return false;
      return Date.parse(entry.startAt) < Date.parse(latest.endAt) || taskSegmentsAreContinuous(latest.endAt, entry.startAt);
    });
    if (group) group.push(entry);
    else groups.push([entry]);
  }
  return groups.filter((group) => group.length > 1);
}

function preferredEntry(entries: TaskCalendarSyncEntry[]): TaskCalendarSyncEntry {
  const active = entries.filter((entry) => entry.status === 'active');
  return [...(active.length ? active : entries)].sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0]!;
}

function canonicalTask(snapshot: TaskActivitySnapshot, entries: TaskCalendarSyncEntry[]) {
  const direct = snapshot.tasks.filter((task) => entries.some((entry) => entry.taskId === task.id));
  if (direct.length === 1) return direct[0]!;
  const titles = new Set(entries.map((entry) => normalizeTaskTitle(entry.title)));
  const byTitle = snapshot.tasks.filter((task) => titles.has(normalizeTaskTitle(task.title)));
  return byTitle.length === 1 ? byTitle[0]! : null;
}

export async function consolidateDuplicateTaskEvents(options: {
  snapshot: TaskActivitySnapshot;
  state: TaskCalendarSyncSnapshot;
  client: Pick<GoogleCalendarClient, 'updateTaskEvent' | 'deleteTaskEvent'>;
  save: (state: TaskCalendarSyncSnapshot) => void;
  audit?: (audit: CalendarRepairAudit) => void;
  now?: Date;
}): Promise<TaskCalendarSyncSnapshot> {
  let state: TaskCalendarSyncSnapshot = { version: 1, entries: options.state.entries.map((entry) => ({ ...entry })) };
  const groups = duplicateGroups(state.entries);
  if (groups.length === 0) return state;
  const generatedAt = (options.now ?? new Date()).toISOString();
  options.audit?.({
    version: 1,
    generatedAt,
    continuityGapMs: TASK_CONTINUITY_GAP_MS,
    groups: groups.map((entries) => ({ keeperEventId: preferredEntry(entries).eventId, entries: entries.map((entry) => ({ ...entry })) })),
  });

  for (const originalGroup of groups) {
    const eventIds = new Set(originalGroup.map((entry) => entry.eventId));
    const currentGroup = state.entries.filter((entry) => eventIds.has(entry.eventId));
    if (currentGroup.length < 2) continue;
    const keeper = preferredEntry(currentGroup);
    const task = canonicalTask(options.snapshot, currentGroup);
    const startAt = currentGroup.map((entry) => entry.startAt).sort()[0]!;
    const endAt = currentGroup.map((entry) => entry.endAt).sort().at(-1)!;
    const lastSeenAt = currentGroup.map((entry) => entry.lastSeenAt).sort().at(-1)!;
    const lastActiveAt = [task?.lastActiveAt, ...currentGroup.map((entry) => entry.lastActiveAt)].filter((value): value is string => Boolean(value)).sort().at(-1);
    const updated: TaskCalendarSyncEntry = {
      ...keeper,
      taskId: task?.id ?? keeper.taskId,
      title: task?.title ?? keeper.title,
      summary: task?.summary ?? keeper.summary,
      startAt,
      endAt,
      lastSeenAt,
      ...(lastActiveAt ? { lastActiveAt } : {}),
      status: currentGroup.some((entry) => entry.status === 'active') ? 'active' : 'ended',
    };
    await options.client.updateTaskEvent(updated.calendarId, updated.eventId, {
      taskId: updated.taskId,
      title: updated.title,
      summary: updated.summary,
      startAt: updated.startAt,
      endAt: updated.endAt,
    });

    for (const redundant of currentGroup.filter((entry) => entry.eventId !== keeper.eventId)) {
      await options.client.deleteTaskEvent(redundant.calendarId, redundant.eventId);
      state = { ...state, entries: state.entries.filter((entry) => entry.eventId !== redundant.eventId) };
      options.save(state);
    }
    state = { ...state, entries: state.entries.map((entry) => entry.eventId === keeper.eventId ? updated : entry) };
    options.save(state);
  }
  return state;
}

export function sanitizeTaskCalendarLinks(
  snapshot: TaskActivitySnapshot,
  state: TaskCalendarSyncSnapshot,
  events: CalendarEventRecord[],
): { snapshot: TaskActivitySnapshot; changed: boolean } {
  const entriesById = new Map(state.entries.map((entry) => [calendarEventEvidenceId(entry.calendarId, entry.eventId), entry]));
  const eventsById = new Map(events.map((event) => [calendarEventEvidenceId(event.calendarId, event.eventId), event]));
  let changed = false;
  const tasks = snapshot.tasks.map((task) => {
    const before = task.calendarEventIds ?? [];
    const after = before.filter((id) => {
      const event = eventsById.get(id);
      if (event && !event.squirlTaskId) return true;
      const entry = entriesById.get(id);
      if (!entry) return false;
      return entry.taskId === task.id || normalizeTaskTitle(entry.title) === normalizeTaskTitle(task.title);
    });
    if (before.length === after.length && before.every((id, index) => id === after[index])) return task;
    changed = true;
    const next = { ...task };
    if (after.length > 0) next.calendarEventIds = after;
    else delete next.calendarEventIds;
    return next;
  });
  return { snapshot: changed ? { ...snapshot, tasks } : snapshot, changed };
}
