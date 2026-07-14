import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectClaudeSession, inspectCodexSession, inspectParticipantContext } from './context-preview.js';

const tempRoots: string[] = [];
afterEach(() => tempRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n{incomplete';
}

describe('Claude context artifact inspection', () => {
  it('reconstructs the active branch, excludes sidechains, and classifies file tool results', () => {
    const content = jsonl([
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'old request' }, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'secret.ts' } }], usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body' }] } },
      { type: 'assistant', uuid: 'side', parentUuid: 'u1', isSidechain: true, message: { role: 'assistant', content: 'ignore me' } },
      { type: 'last-prompt', leafUuid: 'u2', sessionId: 'session' },
    ]);
    const result = inspectClaudeSession(content)!;
    expect(result.modelId).toBe('claude-test');
    expect(result.inputTokens).toBe(35);
    expect(result.buckets.files).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('file body');
    expect(JSON.stringify(result)).not.toContain('ignore me');
  });

  it('uses the compacted portion of the active chain and tolerates malformed rows', () => {
    const result = inspectClaudeSession(jsonl([
      { type: 'user', uuid: 'old', message: { role: 'user', content: 'discarded history' } },
      { type: 'compact_boundary', uuid: 'compact', parentUuid: 'old', content: 'conversation summary' },
      { type: 'user', uuid: 'new', parentUuid: 'compact', message: { role: 'user', content: 'current request' } },
      { type: 'last-prompt', leafUuid: 'new' },
    ]))!;
    expect(result.buckets.messages).toBeGreaterThan(0);
    expect(result.buckets.messages).toBeLessThan(20);
  });

  it('measures the input to the completed turn without counting its final response', () => {
    const result = inspectClaudeSession(jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'injected request' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-test', content: 'x'.repeat(20_000), usage: { input_tokens: 50 } } },
      { type: 'last-prompt', leafUuid: 'a1' },
    ]))!;
    expect(result.inputTokens).toBe(50);
    expect(result.buckets.messages).toBeLessThan(20);
  });
});

describe('Codex context artifact inspection', () => {
  it('uses the latest summary, token count, and model window while classifying system and files', () => {
    const result = inspectCodexSession(jsonl([
      { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { base_instructions: 'base rules', dynamic_tools: [{ name: 'read_file' }], context_window: 1000 } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'developer rules' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'old request that was compacted' } },
      { type: 'turn_context', payload: { model: 'gpt-test', sandbox_policy: 'read-only', summary: 'compact conversation summary' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'read_file', input: '{"path":"a.ts"}' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'source body' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 320 }, model_context_window: 950 } } },
    ]))!;
    expect(result).toMatchObject({ modelId: 'gpt-test', inputTokens: 320, contextWindow: 950 });
    expect(result.buckets.system).toBeGreaterThan(0);
    expect(result.buckets.files).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('source body');
  });

  it('excludes the completed assistant response from the inspected turn input', () => {
    const result = inspectCodexSession(jsonl([
      { type: 'session_meta', payload: { base_instructions: 'rules', context_window: 1000 } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'injected request' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x'.repeat(20_000) } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50 }, model_context_window: 1000 } } },
    ]))!;
    expect(result.inputTokens).toBe(50);
    expect(result.buckets.messages).toBeLessThan(20);
  });
});

describe('participant context preview lookup', () => {
  it('finds a Claude session by id, scales categories to live usage, and returns sanitized data', () => {
    const root = mkdtempSync(join(tmpdir(), 'squirl-context-preview-'));
    tempRoots.push(root);
    const claudeProjects = join(root, 'claude', 'project');
    const codexSessions = join(root, 'codex');
    mkdirSync(claudeProjects, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    writeFileSync(join(claudeProjects, 'session-1.jsonl'), jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'private prompt' } },
      { type: 'last-prompt', leafUuid: 'u1' },
    ]));
    const preview = inspectParticipantContext('claude-code', {
      participantId: 'cc', sessionId: 'session-1', modelId: 'claude-test', inputTokens: 400, contextWindow: 1000,
    }, { claudeProjects: join(root, 'claude'), codexSessions });
    expect(preview).toMatchObject({ participantId: 'cc', fidelity: 'inspected', matrixMode: 'categorized', usedTokens: 400, contextWindow: 1000 });
    expect(preview.discs).toHaveLength(100);
    expect(preview.discs.filter((kind) => kind !== 'available')).toHaveLength(40);
    expect(JSON.stringify(preview)).not.toContain('private prompt');
    expect(JSON.stringify(preview)).not.toContain(root);
  });

  it('returns a stable unavailable preview for unused and missing sessions', () => {
    const roots = { claudeProjects: '/missing', codexSessions: '/missing' };
    expect(inspectParticipantContext('codex', { participantId: 'codex' }, roots)).toMatchObject({ fidelity: 'unavailable', usedTokens: null });
    expect(inspectParticipantContext('codex', { participantId: 'codex', sessionId: 'missing' }, roots)).toMatchObject({ fidelity: 'unavailable' });
  });

  it('keeps Codex usage visible as a neutral matrix when its artifact is unavailable', () => {
    const preview = inspectParticipantContext('codex', {
      participantId: 'codex', modelId: 'gpt-test', inputTokens: 250, contextWindow: 1000,
    }, { claudeProjects: '/missing', codexSessions: '/missing' });
    expect(preview).toMatchObject({ fidelity: 'preview', matrixMode: 'usage', usedTokens: 250, contextWindow: 1000 });
    expect(preview.discs.filter((kind) => kind !== 'available')).toHaveLength(25);
  });

  it('shows PI RPC context statistics without reading its session transcript', () => {
    const preview = inspectParticipantContext('pi', {
      participantId: 'pi', sessionId: 'pi-session', modelId: 'openai/gpt-test', inputTokens: 500, contextWindow: 2000,
    }, { claudeProjects: '/missing', codexSessions: '/missing' });
    expect(preview).toMatchObject({ source: 'pi-session', fidelity: 'preview', matrixMode: 'usage', usedTokens: 500, contextWindow: 2000 });
    expect(preview.discs.filter((kind) => kind !== 'available')).toHaveLength(25);
  });
});
