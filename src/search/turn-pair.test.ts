import { describe, it, expect } from 'vitest';
import { messagesToTurnPairs } from './turn-pair.js';
import type { Message } from '../types.js';

const user = (id: string, content: string): Message => ({ id, role: 'user', content });
const asst = (id: string, content: string): Message => ({ id, role: 'assistant', content });
const tool = (id: string, callId: string, name: string, content: string): Message => ({
  id, role: 'tool', toolCallId: callId, toolName: name, content,
});

describe('messagesToTurnPairs', () => {
  it('pairs user + following assistant into one turn-pair', () => {
    const pairs = messagesToTurnPairs([user('u1', 'hello'), asst('a1', 'hi')], 'c1', 'squirl');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userText).toBe('hello');
    expect(pairs[0]!.assistantText).toBe('hi');
    expect(pairs[0]!.source).toBe('squirl');
  });

  it('includes tool messages in toolSummary', () => {
    const msgs = [user('u1', 'read'), asst('a1', 'ok'), tool('t1', 'tc1', 'read-file', 'contents'), asst('a2', 'done')];
    const pairs = messagesToTurnPairs(msgs, 'c1', 'squirl');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.assistantText).toContain('done');
    expect(pairs[0]!.toolSummary).toContain('read-file');
  });

  it('handles multiple turn-pairs', () => {
    const msgs = [user('u1', 'first'), asst('a1', 'r1'), user('u2', 'second'), asst('a2', 'r2')];
    const pairs = messagesToTurnPairs(msgs, 'c1', 'squirl');
    expect(pairs).toHaveLength(2);
  });

  it('skips orphan non-user messages at start', () => {
    const pairs = messagesToTurnPairs([asst('a0', 'orphan'), user('u1', 'hi'), asst('a1', 'hey')], 'c1', 'squirl');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userText).toBe('hi');
  });

  it('skips trailing user message with no assistant reply', () => {
    const pairs = messagesToTurnPairs([user('u1', 'hi'), asst('a1', 'hey'), user('u2', 'bye')], 'c1', 'squirl');
    expect(pairs).toHaveLength(1);
  });

  it('produces stable IDs across calls', () => {
    const msgs: Message[] = [user('u1', 'hi'), asst('a1', 'hey')];
    const a = messagesToTurnPairs(msgs, 'c1', 'squirl');
    const b = messagesToTurnPairs(msgs, 'c1', 'squirl');
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});
