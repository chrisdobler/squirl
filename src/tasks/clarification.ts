import type { Message } from '../types.js';
import type { CalendarEventRecord } from '../calendar/types.js';
import type { TaskActivitySnapshot } from './types.js';

export const TASK_CLARIFICATION_DELAY_MS = 5 * 60 * 1000;
export const TASK_CLARIFICATION_CHECK_MS = 60 * 1000;

export function hasCurrentTask(options: {
  snapshot: TaskActivitySnapshot | null;
  calendarEvents: CalendarEventRecord[];
  now: number;
  taskWindowMs: number;
}): boolean {
  const { snapshot, calendarEvents, now, taskWindowMs } = options;
  const hasFreshInference = snapshot?.tasks.some((task) => Date.parse(task.lastActiveAt) >= now - taskWindowMs) ?? false;
  if (hasFreshInference) return true;

  return calendarEvents.some((event) => Date.parse(event.startAt) <= now && Date.parse(event.endAt) > now);
}

/** Recover when Squirl first lost a current-task signal, including across restarts. */
export function taskUncertaintyStart(options: {
  snapshot: TaskActivitySnapshot | null;
  calendarEvents: CalendarEventRecord[];
  now: number;
  lastAskedAt?: number | null;
}): number | null {
  const { snapshot, calendarEvents, now, lastAskedAt = null } = options;
  const activityBoundaries = [
    ...(snapshot?.tasks.map((task) => task.lastActiveAt) ?? []),
    ...calendarEvents.map((event) => event.endAt),
  ]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now);
  const latestActivityBoundary = activityBoundaries.length > 0 ? Math.max(...activityBoundaries) : null;

  // A persisted question belongs to the current no-task period unless a real
  // task or calendar event became active after it. Snapshot generation alone
  // is not a new period: an empty classifier can refresh repeatedly.
  if (lastAskedAt != null && (latestActivityBoundary == null || lastAskedAt >= latestActivityBoundary)) {
    return lastAskedAt;
  }
  if (latestActivityBoundary != null) return latestActivityBoundary;

  const generatedAt = snapshot?.generatedAt ? Date.parse(snapshot.generatedAt) : Number.NaN;
  return Number.isFinite(generatedAt) && generatedAt <= now ? generatedAt : null;
}

export function lastTaskClarificationAt(messages: Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant' || message.proactiveKind !== 'task-clarification' || !message.createdAt) continue;
    const timestamp = Date.parse(message.createdAt);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export function shouldAskTaskClarification(options: {
  now: number;
  unknownSince: number | null;
  lastAskedAt: number | null;
  isBusy: boolean;
}): boolean {
  const { now, unknownSince, lastAskedAt, isBusy } = options;
  if (isBusy || unknownSince == null || now - unknownSince < TASK_CLARIFICATION_DELAY_MS) return false;
  return lastAskedAt == null || lastAskedAt < unknownSince;
}

export function taskClarificationQuestion(displayName?: string): string {
  const name = displayName?.trim();
  return name
    ? `Hey ${name}, I can't figure out what you're working on right now. Can you tell me about the current task?`
    : `I can't figure out what you're working on right now. Can you tell me about the current task?`;
}
