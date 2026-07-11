import { describe, expect, it } from 'vitest';
import { parseDelegationIntent, type DelegationAgent } from './delegation.js';

const agents: DelegationAgent[] = [
  { id: 'cc', label: 'Claude Planner', kind: 'claude-code', connected: true },
  { id: 'codex', label: 'Codex', kind: 'codex', connected: true },
];

describe('parseDelegationIntent', () => {
  it('parses the reported natural-language planning request', () => {
    expect(parseDelegationIntent('tell cc to make a plan to change the agents so they default to users home folder', agents)).toEqual({
      targetIds: ['cc'], unavailableTargetIds: [],
      originalRequest: 'tell cc to make a plan to change the agents so they default to users home folder',
      task: 'make a plan to change the agents so they default to users home folder',
      trigger: 'natural-language',
    });
  });

  it('supports known mentions, aliases, case, and renamed labels', () => {
    expect(parseDelegationIntent('@CC make a plan', agents)?.targetIds).toEqual(['cc']);
    expect(parseDelegationIntent('ask Claude Code to review this', agents)?.targetIds).toEqual(['cc']);
    expect(parseDelegationIntent('tell CloudCode to review this', agents)?.targetIds).toEqual(['cc']);
    expect(parseDelegationIntent('have Claude Planner to investigate this', agents)?.targetIds).toEqual(['cc']);
  });

  it('preserves ordered multiple targets', () => {
    expect(parseDelegationIntent('ask cc and codex to review this', agents)?.targetIds).toEqual(['cc', 'codex']);
    expect(parseDelegationIntent('ask codex and cc to review this', agents)?.targetIds).toEqual(['codex', 'cc']);
  });

  it('reports recognized disconnected agents', () => {
    const unavailable = [{ ...agents[0]!, connected: false }];
    expect(parseDelegationIntent('tell cc to plan this', unavailable)?.unavailableTargetIds).toEqual(['cc']);
  });

  it('does not treat discussion about an agent as delegation', () => {
    expect(parseDelegationIntent('what did cc say earlier?', agents)).toBeNull();
  });
});
