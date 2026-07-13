import { describe, expect, it } from 'vitest';

import type { LogEntry } from '../history.js';
import { buildRecentTaskEvidence } from './evidence.js';

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
});
