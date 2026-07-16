export const TASK_CONTINUITY_GAP_MS = 15 * 60_000;

export function calendarEventEvidenceId(calendarId: string, eventId: string): string {
  return `calendar:${calendarId}:${eventId}`;
}

export function normalizeTaskTitle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function taskSegmentsAreContinuous(previousEndAt: string, nextStartAt: string, gapMs = TASK_CONTINUITY_GAP_MS): boolean {
  const previousEnd = Date.parse(previousEndAt);
  const nextStart = Date.parse(nextStartAt);
  return Number.isFinite(previousEnd) && Number.isFinite(nextStart) && nextStart >= previousEnd && nextStart - previousEnd <= gapMs;
}

export function taskIdentityMatches(
  left: { taskId?: string; title: string },
  right: { taskId?: string; title: string },
): boolean {
  return Boolean(left.taskId && right.taskId && left.taskId === right.taskId)
    || normalizeTaskTitle(left.title) === normalizeTaskTitle(right.title);
}
