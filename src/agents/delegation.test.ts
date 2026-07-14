import { describe, expect, it } from 'vitest';
import { delegationConfirmationResponse, parseDelegationIntent, recoverPendingDelegation, resolveDelegationIntent, type DelegationAgent } from './delegation.js';
import type { MetaLLM } from '../search/meta-extract.js';

const agents: DelegationAgent[] = [
  { id: 'cc', label: 'Claude Planner', kind: 'claude-code', connected: true },
  { id: 'codex', label: 'Codex', kind: 'codex', connected: true },
  { id: 'pi', label: 'PI Reviewer', kind: 'pi', connected: true },
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
    expect(parseDelegationIntent('ask PI Agent to review this', agents)?.targetIds).toEqual(['pi']);
  });

  it('recognizes assigning or resuming work with put/get phrasing', () => {
    expect(parseDelegationIntent('put codex back on the task it was doing before', agents)).toMatchObject({
      targetIds: ['codex'], task: 'the task it was doing before', trigger: 'natural-language',
    });
    expect(parseDelegationIntent('get codex working on the overview page', agents)).toMatchObject({
      targetIds: ['codex'], task: 'the overview page', trigger: 'natural-language',
    });
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

const llmReturning = (value: string): MetaLLM => ({ complete: async () => value });

describe('resolveDelegationIntent', () => {
  it('semantically dispatches the reported put-back request', async () => {
    const result = await resolveDelegationIntent(
      'Can you put codex squirrel back on the task it was doing before? The read/write situation should be squared away now.',
      agents,
      llmReturning('{"decision":"delegate","confidence":"high","targetIds":["codex"],"task":"Resume the previous task now that workspace writes are available."}'),
    );
    expect(result).toEqual({ kind: 'dispatch', delegation: {
      targetIds: ['codex'], unavailableTargetIds: [],
      originalRequest: 'Can you put codex squirrel back on the task it was doing before? The read/write situation should be squared away now.',
      task: 'the task it was doing before? The read/write situation should be squared away now.',
      trigger: 'natural-language',
    } });
  });

  it.each(['resume the task', 'continue the work', 'reassign the issue', 'put codex back on it'])('supports semantic delegation wording: %s', async (request) => {
    const result = await resolveDelegationIntent(
      `${request}, codex`, agents,
      llmReturning('{"decision":"delegate","confidence":"high","targetIds":["codex"],"task":"Continue the assigned work."}'),
    );
    expect(result.kind).toBe('dispatch');
  });

  it('keeps discussion about an agent as ordinary chat', async () => {
    const result = await resolveDelegationIntent(
      'What was Codex doing?', agents,
      llmReturning('{"decision":"not_delegate","confidence":"high","targetIds":["codex"],"task":""}'),
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['unknown target', '{"decision":"delegate","confidence":"high","targetIds":["invented"],"task":"work"}'],
    ['low confidence', '{"decision":"delegate","confidence":"low","targetIds":["codex"],"task":"work"}'],
  ])('asks for confirmation on %s', async (_label, raw) => {
    const result = await resolveDelegationIntent('Maybe have codex handle this', agents, llmReturning(raw), new Date('2026-07-13T20:00:00Z'));
    expect(result.kind).toBe('confirm');
    if (result.kind === 'confirm') expect(result.pending.targetIds).toEqual(['codex']);
  });

  it('asks for confirmation when the classifier is unavailable', async () => {
    const failing: MetaLLM = { complete: async () => { throw new Error('offline'); } };
    await expect(resolveDelegationIntent('Maybe codex should handle this', agents, failing)).resolves.toMatchObject({ kind: 'confirm' });
    await expect(resolveDelegationIntent('Maybe codex should handle this', agents, null)).resolves.toMatchObject({ kind: 'confirm' });
  });

  it('does not call the classifier for deterministic syntax or ordinary chat', async () => {
    let calls = 0;
    const llm: MetaLLM = { complete: async () => { calls += 1; return '{}'; } };
    await expect(resolveDelegationIntent('@codex do this', agents, llm)).resolves.toMatchObject({ kind: 'dispatch' });
    await expect(resolveDelegationIntent('How are you?', agents, llm)).resolves.toEqual({ kind: 'none' });
    expect(calls).toBe(0);
  });
});

describe('delegation confirmation state', () => {
  const pending = {
    id: 'confirmation-1', targetIds: ['codex'], task: 'resume work', originalRequest: 'put codex back on it',
    createdAt: '2026-07-13T20:00:00.000Z', expiresAt: '2026-07-13T20:10:00.000Z',
  };

  it('recognizes affirmative, negative, and unrelated replies', () => {
    expect(delegationConfirmationResponse('Yes.')).toBe('confirm');
    expect(delegationConfirmationResponse('no')).toBe('cancel');
    expect(delegationConfirmationResponse('What task?')).toBe('unrelated');
  });

  it('recovers only an unanswered, unexpired confirmation', () => {
    const message = { role: 'assistant', proactiveKind: 'delegation-confirmation', delegationConfirmation: pending };
    expect(recoverPendingDelegation([message], new Date('2026-07-13T20:05:00Z'))).toEqual(pending);
    expect(recoverPendingDelegation([message], new Date('2026-07-13T20:11:00Z'))).toBeNull();
    expect(recoverPendingDelegation([message, { role: 'user' }], new Date('2026-07-13T20:05:00Z'))).toBeNull();
  });
});
