import type { GoogleCalendarClient } from './google.js';
import type { TaskCalendarSyncSnapshot } from './types.js';
import type { TaskActivitySnapshot } from '../tasks/types.js';

const MIN_EVENT_MS = 60_000;

function titleKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

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
}): Promise<TaskCalendarSyncSnapshot> {
  const now = options.now ?? Date.now();
  const nowAt = new Date(now).toISOString();
  const state: TaskCalendarSyncSnapshot = { version: 1, entries: options.state.entries.map((entry) => ({ ...entry })) };
  const matched = new Set<number>();

  for (const task of options.snapshot.tasks) {
    const summary = task.summary?.trim() || undefined;
    let index = state.entries.findIndex((entry) => entry.status === 'active' && entry.calendarId === options.calendarId && entry.taskId === task.id);
    if (index < 0) index = state.entries.findIndex((entry) => entry.status === 'active' && entry.calendarId === options.calendarId && titleKey(entry.title) === titleKey(task.title));
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
    const detailsChanged = entry.taskId !== task.id || entry.title !== task.title || entry.summary !== summary;
    if (!activityAdvanced && !detailsChanged) {
      matched.add(index);
      continue;
    }
    const endAt = activityAdvanced ? eventEnd(entry.startAt, now, options.activeHorizonMs) : entry.endAt;
    await options.client.updateTaskEvent(entry.calendarId, entry.eventId, { taskId: task.id, title: task.title, summary, startAt: entry.startAt, endAt });
    state.entries[index] = { ...entry, taskId: task.id, title: task.title, summary, endAt, lastSeenAt: nowAt, lastActiveAt: task.lastActiveAt };
    matched.add(index);
    options.save(state);
  }

  for (let index = 0; index < state.entries.length; index++) {
    const entry = state.entries[index]!;
    if (entry.status !== 'active' || entry.calendarId !== options.calendarId || matched.has(index)) continue;
    const endAt = eventEnd(entry.startAt, now);
    await options.client.updateTaskEvent(entry.calendarId, entry.eventId, { taskId: entry.taskId, title: entry.title, summary: entry.summary, startAt: entry.startAt, endAt });
    state.entries[index] = { ...entry, endAt, lastSeenAt: nowAt, status: 'ended' };
    options.save(state);
  }
  return state;
}
