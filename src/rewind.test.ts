import { describe, expect, it } from 'vitest';
import { buildRewindCandidates, rewindRequestFromCandidate } from './rewind.js';
import type { Message } from './types.js';

const user = (id: string, content: string): Message => ({ id, role: 'user', content });
const assistant = (id: string, content: string): Message => ({ id, role: 'assistant', content });
const tool = (id: string, content: string): Message => ({
  id,
  role: 'tool',
  toolCallId: id,
  toolName: 'run_command',
  content,
});

describe('rewind candidates', () => {
  it('builds candidates from user messages only when they have later context to remove', () => {
    const candidates = buildRewindCandidates([
      user('u1', 'one'),
      assistant('a1', 'two'),
      tool('t1', 'three'),
      user('u2', 'four'),
      assistant('a2', 'five'),
    ]);

    expect(candidates.map((c) => c.message.id)).toEqual(['u1']);
    expect(candidates.map((c) => c.messageIndex)).toEqual([0]);
  });

  it('excludes a final user turn because it would remove nothing', () => {
    const candidates = buildRewindCandidates([
      user('u1', 'one'),
      assistant('a1', 'two'),
      user('u2', 'latest draft'),
    ]);

    expect(candidates.map((c) => c.message.id)).toEqual(['u1']);
    expect(candidates[0]!.retainedCount).toBe(2);
    expect(candidates[0]!.removedCount).toBe(1);
  });

  it('keeps the selected user turn pair when building a rewind request', () => {
    const candidates = buildRewindCandidates([
      user('u1', 'keep'),
      assistant('a1', 'keep reply'),
      user('u2', 'dirty'),
      assistant('a2', 'dirty reply'),
    ]);

    const request = rewindRequestFromCandidate(candidates[0]!);

    expect(request).toEqual(expect.objectContaining({
      targetMessageId: 'u1',
      retainedCount: 2,
      removedCount: 2,
    }));
  });

  it('keeps tool messages that belong to the selected turn', () => {
    const candidates = buildRewindCandidates([
      user('u1', 'keep'),
      assistant('a1', 'tool call'),
      tool('t1', 'tool result'),
      assistant('a2', 'final reply'),
      user('u2', 'dirty'),
    ]);

    expect(candidates[0]).toEqual(expect.objectContaining({
      retainedCount: 4,
      removedCount: 1,
    }));
  });
});
