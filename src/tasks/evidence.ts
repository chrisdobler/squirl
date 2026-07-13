import type { LogEntry } from '../history.js';
import type { TaskActivityEvidence } from './types.js';

export const TASK_ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Build timestamp-preserving activity records, including a trailing unanswered request. */
export function buildRecentTaskEvidence(
  entries: LogEntry[],
  now = Date.now(),
  windowMs = TASK_ACTIVITY_WINDOW_MS,
): TaskActivityEvidence[] {
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
    let lastTimestamp = user.timestamp;
    index += 1;

    while (index < ordered.length && ordered[index]!.message.role !== 'user') {
      const current = ordered[index]!;
      lastTimestamp = current.timestamp;
      if (current.message.participantId) participants.add(current.message.participantId);
      if (current.message.role === 'assistant' && current.message.content.trim()) {
        assistant.push(current.message.content.trim());
      } else if (current.message.role === 'tool') {
        const content = current.message.content.replace(/\s+/g, ' ').trim().slice(0, 500);
        tools.push(`${current.message.toolName}: ${content}`);
      }
      index += 1;
    }

    const activeAt = validTimestamp(lastTimestamp)!;
    if (activeAt < now - windowMs || activeAt > now + 60_000) continue;
    evidence.push({
      id: user.message.id,
      timestamp: lastTimestamp,
      userText: user.message.content,
      ...(assistant.length ? { assistantText: assistant.join('\n') } : {}),
      ...(tools.length ? { toolSummary: tools.join('\n') } : {}),
      participantIds: [...participants],
    });
  }

  return evidence;
}

export function taskEvidenceWatermark(evidence: TaskActivityEvidence[]): string {
  const newest = evidence[evidence.length - 1];
  return newest ? `${newest.timestamp}:${newest.id}:${evidence.length}` : 'empty';
}
