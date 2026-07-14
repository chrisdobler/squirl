import { describe, expect, it } from 'vitest';
import {
  AGENT_COLOR_PALETTE,
  PARTICIPANT_COLOR_VALUE,
  buildRegistry,
  participantFromDescriptor,
  pickAgentColor,
  resolveParticipant,
  roomMembers,
  SQUIRL_PARTICIPANT,
  USER_PARTICIPANT,
} from './participants.js';
import type { AgentDescriptor } from './types.js';

const ccDescriptor: AgentDescriptor = { id: 'cc', kind: 'claude-code', label: 'claude-code', transport: 'local', cwd: '/repo' };
const codexDescriptor: AgentDescriptor = { id: 'codex', kind: 'codex', label: 'codex', transport: 'local', cwd: '/repo', sandbox: 'workspace-write' };

describe('participants', () => {
  it('uses the intended identity palette and avoids status-like colors for the first three agents', () => {
    expect(AGENT_COLOR_PALETTE).toEqual([
      'magenta', 'blue', 'gray', 'green', 'red', 'yellow', 'teal', 'violet', 'brown',
    ]);
    expect(AGENT_COLOR_PALETTE.slice(0, 3)).not.toContain('green');
    expect(AGENT_COLOR_PALETTE.slice(0, 3)).not.toContain('yellow');
    expect(AGENT_COLOR_PALETTE.slice(0, 3)).not.toContain('red');

    const cc = participantFromDescriptor(ccDescriptor, 'magenta');
    const codex = participantFromDescriptor(codexDescriptor, 'orange');
    expect(cc.color).not.toBe(codex.color);
    expect(cc.color).not.toBe(USER_PARTICIPANT.color);
    expect(cc.color).toBe('magenta');
    expect(cc.mode).toBe('permission: acceptEdits');
    expect(codex.mode).toBe('sandbox: workspace-write');
  });

  it('maps every participant identity to the shared RGB value used by both UIs', () => {
    expect(PARTICIPANT_COLOR_VALUE).toEqual({
      cyan: '#22d3ee',
      magenta: '#e879f9',
      orange: '#fb923c',
      blue: '#60a5fa',
      green: '#4ade80',
      red: '#f87171',
      yellow: '#facc15',
      gray: '#9ca3af',
      teal: '#2dd4bf',
      violet: '#a78bfa',
      brown: '#b08968',
    });
  });

  it('chooses the first unused agent color and rejects an exhausted palette', () => {
    expect(pickAgentColor(['magenta', 'green'])).toBe('blue');
    expect(() => pickAgentColor(AGENT_COLOR_PALETTE)).toThrow('all 9 identity colors are in use');
  });

  it('resolves user, local squirl, and agent messages to the right participant', () => {
    const registry = buildRegistry([USER_PARTICIPANT, SQUIRL_PARTICIPANT, participantFromDescriptor(ccDescriptor, 'magenta')]);
    expect(resolveParticipant({ role: 'user' }, registry).label).toBe('you');
    expect(resolveParticipant({ role: 'assistant' }, registry).label).toBe('squirl');
    expect(resolveParticipant({ role: 'assistant', participantId: 'cc' }, registry).label).toBe('claude-code');
  });

  it('roomMembers keeps squirl and agents but excludes the user', () => {
    const cc = participantFromDescriptor(ccDescriptor, 'magenta');
    const members = roomMembers([USER_PARTICIPANT, SQUIRL_PARTICIPANT, cc]);
    expect(members.map((p) => p.id)).toEqual(['squirl', 'cc']);
    expect(roomMembers([USER_PARTICIPANT, SQUIRL_PARTICIPANT])).toHaveLength(1);
  });

  it('falls back gracefully for an unknown participantId', () => {
    const registry = buildRegistry([USER_PARTICIPANT, SQUIRL_PARTICIPANT]);
    const resolved = resolveParticipant({ role: 'assistant', participantId: 'ghost' }, registry);
    expect(resolved.label).toBe('ghost');
    expect(resolved.color).toBe('gray');
  });
});
