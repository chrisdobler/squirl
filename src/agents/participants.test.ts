import { describe, expect, it } from 'vitest';
import { buildRegistry, participantFromDescriptor, resolveParticipant, SQUIRL_PARTICIPANT, USER_PARTICIPANT } from './participants.js';
import type { AgentDescriptor } from './types.js';

const ccDescriptor: AgentDescriptor = { id: 'cc', kind: 'claude-code', label: 'claude-code', transport: 'local', cwd: '/repo' };
const codexDescriptor: AgentDescriptor = { id: 'codex', kind: 'codex', label: 'codex', transport: 'local', cwd: '/repo', sandbox: 'workspace-write' };

describe('participants', () => {
  it('assigns distinct colors to joining agents and describes their mode', () => {
    const cc = participantFromDescriptor(ccDescriptor, 0);
    const codex = participantFromDescriptor(codexDescriptor, 1);
    expect(cc.color).not.toBe(codex.color);
    expect(cc.color).not.toBe(USER_PARTICIPANT.color);
    expect(cc.color).not.toBe(SQUIRL_PARTICIPANT.color);
    expect(cc.mode).toBe('permission: default');
    expect(codex.mode).toBe('sandbox: workspace-write');
  });

  it('resolves user, local squirl, and agent messages to the right participant', () => {
    const registry = buildRegistry([USER_PARTICIPANT, SQUIRL_PARTICIPANT, participantFromDescriptor(ccDescriptor, 0)]);
    expect(resolveParticipant({ role: 'user' }, registry).label).toBe('you');
    expect(resolveParticipant({ role: 'assistant' }, registry).label).toBe('squirl');
    expect(resolveParticipant({ role: 'assistant', participantId: 'cc' }, registry).label).toBe('claude-code');
  });

  it('falls back gracefully for an unknown participantId', () => {
    const registry = buildRegistry([USER_PARTICIPANT, SQUIRL_PARTICIPANT]);
    const resolved = resolveParticipant({ role: 'assistant', participantId: 'ghost' }, registry);
    expect(resolved.label).toBe('ghost');
    expect(resolved.color).toBe('gray');
  });
});
