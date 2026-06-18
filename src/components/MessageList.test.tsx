import { describe, expect, it } from 'vitest';
import { buildMessageLines } from './MessageList.js';
import { SQUIRL_PARTICIPANT, USER_PARTICIPANT, participantFromDescriptor } from '../agents/participants.js';
import type { Message } from '../types.js';

const cc = participantFromDescriptor({ id: 'cc', kind: 'claude-code', label: 'claude-code', transport: 'local', cwd: '/repo' }, 0);

function lines(messages: Message[]) {
  return buildMessageLines({
    messages,
    showThinking: false,
    dimmed: false,
    isRewindMode: false,
    rewindCandidateIds: new Set(),
    rewindTargetMessageId: null,
    participants: [USER_PARTICIPANT, SQUIRL_PARTICIPANT, cc],
  });
}

describe('buildMessageLines participant rendering', () => {
  it('labels a remote agent message with its name and color', () => {
    const rows = lines([{ id: 'm1', role: 'assistant', content: 'done', participantId: 'cc' }]);
    const label = rows.find((r) => r.messageId === 'm1' && r.text === 'claude-code');
    expect(label).toBeDefined();
    expect(label!.color).toBe(cc.color);
    expect(label!.bold).toBe(true);
  });

  it('labels the local LLM message as squirl (understated, no color)', () => {
    const rows = lines([{ id: 'm2', role: 'assistant', content: 'hi' }]);
    const label = rows.find((r) => r.messageId === 'm2' && r.text === 'squirl');
    expect(label).toBeDefined();
    expect(label!.color).toBeUndefined();
    expect(label!.dim).toBe(true);
  });

  it('still renders user messages with the cyan prefix', () => {
    const rows = lines([{ id: 'u1', role: 'user', content: 'hello' }]);
    expect(rows.some((r) => r.messageId === 'u1' && r.text.includes('❯ hello'))).toBe(true);
  });
});
