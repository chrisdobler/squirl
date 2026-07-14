import { describe, expect, it } from 'vitest';

import type { LogEntry } from '../history.js';
import { buildRecentTaskEvidence, buildTaskEvidenceForRange, taskEvidenceWatermark } from './evidence.js';

const now = Date.parse('2026-07-13T18:00:00.000Z');

function entry(timestamp: string, message: LogEntry['message']): LogEntry {
  return { timestamp, message };
}

describe('task activity evidence', () => {
  it('preserves durable timestamps, includes trailing requests, and excludes old activity', () => {
    const evidence = buildRecentTaskEvidence([
      entry('2026-07-13T16:30:00.000Z', { id: 'old-u', role: 'user', content: 'old task' }),
      entry('2026-07-13T16:31:00.000Z', { id: 'old-a', role: 'assistant', content: 'old result' }),
      entry('2026-07-13T17:20:00.000Z', { id: 'u1', role: 'user', content: 'build the task list', participantId: 'codex' }),
      entry('2026-07-13T17:24:00.000Z', { id: 'a1', role: 'assistant', content: 'working on it', participantId: 'codex' }),
      entry('2026-07-13T17:59:00.000Z', { id: 'u2', role: 'user', content: 'refine the sidebar', participantId: 'squirl' }),
    ], now);

    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ id: 'u1', timestamp: '2026-07-13T17:24:00.000Z', assistantText: 'working on it', participantIds: ['codex'] });
    expect(evidence[1]).toMatchObject({ id: 'u2', timestamp: '2026-07-13T17:59:00.000Z', userText: 'refine the sidebar', participantIds: ['squirl'] });
    expect(evidence[1]?.assistantText).toBeUndefined();
  });

  it('does not treat proactive clarification prompts as task evidence', () => {
    const evidence = buildRecentTaskEvidence([
      entry('2026-07-13T17:55:00.000Z', { id: 'u1', role: 'user', content: 'hello' }),
      entry('2026-07-13T17:56:00.000Z', {
        id: 'a1',
        role: 'assistant',
        content: `I can't figure out what you're working on right now.`,
        proactiveKind: 'task-clarification',
        createdAt: '2026-07-13T17:56:00.000Z',
      }),
    ], now);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.assistantText).toBeUndefined();
  });

  it('keeps the activity watermark stable for tool chatter but advances it for a final agent response', () => {
    const user = entry('2026-07-13T17:20:00.000Z', { id: 'u1', role: 'user', content: 'improve task titles', participantId: 'codex' });
    const baseline = taskEvidenceWatermark(buildRecentTaskEvidence([user], Date.parse('2026-07-13T17:30:00.000Z')));
    const withTool = taskEvidenceWatermark(buildRecentTaskEvidence([
      user,
      entry('2026-07-13T17:21:00.000Z', { id: 'tool-1', role: 'tool', content: 'command output', toolCallId: 'call-1', toolName: 'shell' }),
    ], Date.parse('2026-07-13T17:30:00.000Z')));
    const withAgent = taskEvidenceWatermark(buildRecentTaskEvidence([
      user,
      entry('2026-07-13T17:22:00.000Z', { id: 'a1', role: 'assistant', content: 'Updated the classifier.', participantId: 'codex' }),
    ], Date.parse('2026-07-13T17:30:00.000Z')));

    expect(withTool).toBe(baseline);
    expect(withAgent).not.toBe(baseline);
  });

  it('advances for explicit agent responses but not local assistant output', () => {
    const evidence = buildRecentTaskEvidence([
      entry('2026-07-13T17:20:00.000Z', { id: 'u1', role: 'user', content: 'work on Squirl', participantId: 'squirl' }),
      entry('2026-07-13T17:40:00.000Z', { id: 'a1', role: 'assistant', content: 'local acknowledgement' }),
      entry('2026-07-13T17:55:00.000Z', { id: 'a2', role: 'assistant', content: 'background update', participantId: 'claude' }),
    ], now);

    expect(evidence).toEqual([expect.objectContaining({
      id: 'u1',
      timestamp: '2026-07-13T17:55:00.000Z',
      assistantText: 'local acknowledgement\nbackground update',
    })]);
  });

  it('does not advance for a local assistant reply or tool chatter alone', () => {
    const evidence = buildRecentTaskEvidence([
      entry('2026-07-13T17:20:00.000Z', { id: 'u1', role: 'user', content: 'work on Squirl', participantId: 'squirl' }),
      entry('2026-07-13T17:50:00.000Z', { id: 'a1', role: 'assistant', content: 'local acknowledgement' }),
      entry('2026-07-13T17:55:00.000Z', { id: 't1', role: 'tool', content: 'background command output', toolCallId: 'tool-1', toolName: 'shell', participantId: 'codex' }),
    ], now);

    expect(evidence[0]?.timestamp).toBe('2026-07-13T17:20:00.000Z');
  });

  it('selects calendar-range evidence with inclusive start and exclusive end boundaries', () => {
    const evidence = buildTaskEvidenceForRange([
      entry('2026-07-12T07:00:00.000Z', { id: 'start', role: 'user', content: 'at local midnight' }),
      entry('2026-07-13T06:59:59.999Z', { id: 'inside', role: 'user', content: 'before next midnight' }),
      entry('2026-07-13T07:00:00.000Z', { id: 'end', role: 'user', content: 'at next midnight' }),
    ], Date.parse('2026-07-12T07:00:00.000Z'), Date.parse('2026-07-13T07:00:00.000Z'));

    expect(evidence.map((item) => item.id)).toEqual(['start', 'inside']);
  });
});
