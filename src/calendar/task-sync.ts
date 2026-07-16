import type { GoogleCalendarClient } from './google.js';
import type { TaskCalendarSyncSnapshot } from './types.js';
import type { TaskActivitySnapshot } from '../tasks/types.js';
import { normalizeTaskTitle, TASK_CONTINUITY_GAP_MS } from '../tasks/continuity.js';

const MIN_EVENT_MS = 60_000;
const DEFAULT_MISSING_GRACE_MS = 10 * 60_000;

function eventEnd(startAt: string, now: number, horizonMs = 0): string {
  return new Date(Math.max(now + horizonMs, Date.parse(startAt) + MIN_EVENT_MS)).toISOString();
}

export async function syncInferredTaskEvents(options: {
  snapshot: TaskActivitySnapshot;
  state: TaskCalendarSyncSnapshot;
  calendarId: string;
  client: Pick<GoogleCalendarClient, 'createTaskEvent' | 'updateTaskEvent'>;
  save: (state: TaskCalendarSyncSnapshot) => void;
  now?: number;
  activeHorizonMs?: number;
  missingGraceMs?: number;
  continuityWindowMs?: number;
}): Promise<TaskCalendarSyncSnapshot> {
  const now = options.now ?? Date.now();
  const nowAt = new Date(now).toISOString();
  const missingGraceMs = options.missingGraceMs ?? DEFAULT_MISSING_GRACE_MS;
  const continuityWindowMs = options.continuityWindowMs ?? TASK_CONTINUITY_GAP_MS;
  const state: TaskCalendarSyncSnapshot = { version: 1, entries: options.state.entries.map((entry) => ({ ...entry })) };
  const matched = new Set<number>();
  const snapshotTitleCounts = new Map<string, number>();
  for (const task of options.snapshot.tasks) snapshotTitleCounts.set(normalizeTaskTitle(task.title), (snapshotTitleCounts.get(normalizeTaskTitle(task.title)) ?? 0) + 1);

  for (const task of options.snapshot.tasks) {
    const summary = task.summary?.trim() || undefined;
    const titleIsUnique = snapshotTitleCounts.get(normalizeTaskTitle(task.title)) === 1;
    let index = state.entries.findIndex((entry) => entry.status === 'active' && entry.calendarId === options.calendarId && entry.taskId === task.id);
    if (index < 0 && titleIsUnique) {
      const activeTitleMatches = state.entries
        .map((entry, candidate) => ({ entry, candidate }))
        .filter(({ entry }) => entry.status === 'active' && entry.calendarId === options.calendarId && normalizeTaskTitle(entry.title) === normalizeTaskTitle(task.title));
      if (activeTitleMatches.length === 1) index = activeTitleMatches[0]!.candidate;
    }
    if (index < 0) {
      const recentEnded = state.entries
        .map((entry, candidate) => ({ entry, candidate }))
        .filter(({ entry }) => entry.status === 'ended' && entry.calendarId === options.calendarId
          && now - Date.parse(entry.endAt) <= continuityWindowMs
          && (entry.taskId === task.id || (titleIsUnique && normalizeTaskTitle(entry.title) === normalizeTaskTitle(task.title))))
        .sort((a, b) => Date.parse(b.entry.endAt) - Date.parse(a.entry.endAt));
      const exactId = recentEnded.find(({ entry }) => entry.taskId === task.id);
      if (exactId) index = exactId.candidate;
      else if (recentEnded.length > 0) index = recentEnded[0]!.candidate;
    }
    if (index < 0) {
      const startAt = options.snapshot.generatedAt;
      const endAt = eventEnd(startAt, now, options.activeHorizonMs);
      const eventId = await options.client.createTaskEvent(options.calendarId, { taskId: task.id, title: task.title, summary, startAt, endAt });
      state.entries.push({ taskId: task.id, title: task.title, summary, calendarId: options.calendarId, eventId, startAt, endAt, lastSeenAt: nowAt, lastActiveAt: task.lastActiveAt, status: 'active' });
      matched.add(state.entries.length - 1);
      options.save(state);
      continue;
    }
    const entry = state.entries[index]!;
    const previousActivity = Date.parse(entry.lastActiveAt ?? entry.lastSeenAt);
    const nextActivity = Date.parse(task.lastActiveAt);
    const activityAdvanced = nextActivity > previousActivity;
    const reactivating = entry.status === 'ended';
    const detailsChanged = entry.taskId !== task.id || entry.title !== task.title || entry.summary !== summary;
    if (!activityAdvanced && !detailsChanged && !reactivating) {
      if (entry.missingSince) {
        state.entries[index] = { ...entry, lastSeenAt: nowAt };
        delete state.entries[index]!.missingSince;
        options.save(state);
      }
      matched.add(index);
      continue;
    }
    const endAt = activityAdvanced || reactivating ? eventEnd(entry.startAt, now, options.activeHorizonMs) : entry.endAt;
    await options.client.updateTaskEvent(entry.calendarId, entry.eventId, { taskId: task.id, title: task.title, summary, startAt: entry.startAt, endAt });
    state.entries[index] = { ...entry, taskId: task.id, title: task.title, summary, endAt, lastSeenAt: nowAt, lastActiveAt: task.lastActiveAt, status: 'active' };
    delete state.entries[index]!.missingSince;
    matched.add(index);
    options.save(state);
  }

  for (let index = 0; index < state.entries.length; index++) {
    const entry = state.entries[index]!;
    if (entry.status !== 'active' || entry.calendarId !== options.calendarId || matched.has(index)) continue;
    if (!entry.missingSince) {
      state.entries[index] = { ...entry, missingSince: nowAt };
      options.save(state);
      continue;
    }
    if (now - Date.parse(entry.missingSince) < missingGraceMs) continue;
    const endAt = eventEnd(entry.startAt, now);
    await options.client.updateTaskEvent(entry.calendarId, entry.eventId, { taskId: entry.taskId, title: entry.title, summary: entry.summary, startAt: entry.startAt, endAt });
    state.entries[index] = { ...entry, endAt, lastSeenAt: nowAt, status: 'ended' };
    delete state.entries[index]!.missingSince;
    options.save(state);
  }
  return state;
}
