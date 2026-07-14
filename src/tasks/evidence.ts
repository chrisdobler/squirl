import type { LogEntry } from '../history.js';
import type { TaskActivityEvidence } from './types.js';

export const TASK_ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Build timestamp-preserving activity records, including a trailing unanswered request. */
export function buildTaskEvidence(entries: LogEntry[]): TaskActivityEvidence[] {
  const ordered = entries
    .filter((entry) => validTimestamp(entry.timestamp) != null)
    .slice()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const evidence: TaskActivityEvidence[] = [];

  for (let index = 0; index < ordered.length;) {
    const entry = ordered[index]!;
    if (entry.message.role !== 'user') {
      index += 1;
      continue;
    }

    const user = entry;
    const assistant: string[] = [];
    const tools: string[] = [];
    const participants = new Set<string>();
    if (user.message.participantId) participants.add(user.message.participantId);
    let activeTimestamp = user.timestamp;
    index += 1;

    while (index < ordered.length && ordered[index]!.message.role !== 'user') {
      const current = ordered[index]!;
      if (current.message.participantId) participants.add(current.message.participantId);
      if (current.message.role === 'assistant' && current.message.proactiveKind !== 'task-clarification' && current.message.content.trim()) {
        assistant.push(current.message.content.trim());
        if (current.message.participantId && current.message.participantId !== 'squirl') activeTimestamp = current.timestamp;
      } else if (current.message.role === 'tool') {
        const content = current.message.content.replace(/\s+/g, ' ').trim().slice(0, 500);
        tools.push(`${current.message.toolName}: ${content}`);
      }
      index += 1;
    }

    // User messages and explicit background-agent responses are activity.
    // Local Squirl replies, tool chatter, and refreshes can enrich the evidence
    // but must not move the task clock forward while everyone is idle.
    evidence.push({
      id: user.message.id,
      timestamp: activeTimestamp,
      userText: user.message.content,
      ...(assistant.length ? { assistantText: assistant.join('\n') } : {}),
      ...(tools.length ? { toolSummary: tools.join('\n') } : {}),
      participantIds: [...participants],
    });
  }

  return evidence;
}

/** Select task evidence whose activity timestamp falls in [start, end). */
export function buildTaskEvidenceForRange(
  entries: LogEntry[],
  start: Date | number,
  end: Date | number,
): TaskActivityEvidence[] {
  const startMs = typeof start === 'number' ? start : start.getTime();
  const endMs = typeof end === 'number' ? end : end.getTime();
  return buildTaskEvidence(entries).filter((item) => {
    const timestamp = validTimestamp(item.timestamp)!;
    return timestamp >= startMs && timestamp < endMs;
  });
}

export function buildRecentTaskEvidence(
  entries: LogEntry[],
  now = Date.now(),
  windowMs = TASK_ACTIVITY_WINDOW_MS,
): TaskActivityEvidence[] {
  return buildTaskEvidenceForRange(entries, now - windowMs, now + 60_000);
}

export function taskEvidenceWatermark(evidence: TaskActivityEvidence[]): string {
  const newest = evidence[evidence.length - 1];
  return newest ? `${newest.timestamp}:${newest.id}:${evidence.length}` : 'empty';
}
