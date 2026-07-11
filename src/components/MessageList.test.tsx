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

function activityLines(messages: Message[], expandedToolIds = new Set<string>()) {
  return buildMessageLines({
    messages, showThinking: false, dimmed: false, isRewindMode: false,
    rewindCandidateIds: new Set(), rewindTargetMessageId: null,
    participants: [USER_PARTICIPANT, SQUIRL_PARTICIPANT, cc],
    expandedToolIds, selectedToolId: 't1', isToolMode: true,
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

  it('adds snapshotted model and effort metadata to assistant headers', () => {
    const rows = lines([{ id: 'm3', role: 'assistant', content: 'hi', responseMeta: { model: 'claude-fable-5', effort: 'medium' } }]);
    const label = rows.find((r) => r.messageId === 'm3' && r.text === 'squirl');
    expect(label?.suffix).toBe('claude-fable-5 · medium');
  });

  it('leaves legacy assistant headers unchanged', () => {
    const rows = lines([{ id: 'm4', role: 'assistant', content: 'old reply' }]);
    expect(rows.find((r) => r.messageId === 'm4' && r.text === 'squirl')?.suffix).toBeUndefined();
  });

  it('shows that user messages address Squirl', () => {
    const rows = lines([{ id: 'u1', role: 'user', content: 'hello' }]);
    expect(rows.some((r) => r.messageId === 'u1' && r.text.includes('❯ @squirl hello'))).toBe(true);
  });

  it('shows the selected recipient on user messages', () => {
    const rows = lines([{ id: 'u2', role: 'user', content: 'inspect this', participantId: 'cc' }]);
    expect(rows.some((r) => r.messageId === 'u2' && r.text.includes('❯ @cc inspect this'))).toBe(true);
  });
});

describe('buildMessageLines tool activity rendering', () => {
  const tool: Message = { id: 't1', role: 'tool', toolCallId: 'call', toolName: 'cc:Read', content: 'file contents', toolInput: { file_path: 'src/app.tsx' }, toolStatus: 'success', participantId: 'cc' };

  it('renders a compact selected collapsed activity row', () => {
    const rows = activityLines([tool]);
    expect(rows.some((row) => row.text === '› ▶ ✓ Read src/app.tsx' && row.bold)).toBe(true);
    expect(rows.some((row) => row.text.includes('file contents'))).toBe(false);
  });

  it('adds structured input and output only when expanded', () => {
    const rows = activityLines([tool], new Set(['t1']));
    expect(rows.some((row) => row.text.includes('▼ ✓ Read src/app.tsx'))).toBe(true);
    expect(rows.some((row) => row.text.includes('file contents'))).toBe(true);
  });

  it('shows one participant header across narrative, activity, and resumed narrative', () => {
    const rows = activityLines([
      { id: 'a1', role: 'assistant', content: 'Looking.', participantId: 'cc' }, tool,
      { id: 'a2', role: 'assistant', content: 'Done.', participantId: 'cc' },
    ]);
    expect(rows.filter((row) => row.text === 'claude-code')).toHaveLength(1);
  });
});
