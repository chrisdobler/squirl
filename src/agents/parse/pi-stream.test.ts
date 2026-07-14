import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../types.js';
import { createPiParser } from './pi-stream.js';

function fixture(name: string): string[] {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8').trim().split('\n');
}

describe('PI RPC parser', () => {
  it('maps state, streamed text, tools, authoritative stats, and settled completion', () => {
    const settled = vi.fn();
    let id = 0;
    const parser = createPiParser({ participantId: 'pi', newMessageId: () => `pi-${++id}`, onSettled: settled });
    const events = fixture('pi-turn.jsonl').flatMap((line) => parser.push(line));

    expect(events).toContainEqual({ type: 'session-status', participantId: 'pi', status: 'ready', sessionId: 'pi-session-1', model: 'anthropic/claude-sonnet' });
    expect(events.filter((event) => event.type === 'message-start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'token').map((event) => event.token).join('')).toBe('I will inspect it.Done.');
    expect(events).toContainEqual({ type: 'tool-start', participantId: 'pi', toolId: 'tool-1', toolName: 'read', input: { path: 'README.md' } });
    expect(events).toContainEqual({ type: 'tool-end', participantId: 'pi', toolId: 'tool-1', toolName: 'read', result: 'hello', ok: true });
    expect(events).toContainEqual({ type: 'usage', participantId: 'pi', usage: { inputTokens: 120, outputTokens: 20, cachedInputTokens: 40, cacheCreationInputTokens: 5, costUsd: 0.02, contextWindow: 200000 } });
    expect(events.at(-1)).toEqual({ type: 'turn-end', participantId: 'pi' });
    expect(settled).toHaveBeenCalledOnce();
  });

  it('bridges supported extension UI requests and ignores malformed JSON', () => {
    const parser = createPiParser({ participantId: 'pi', newMessageId: () => 'm1', onSettled: vi.fn() });
    expect(parser.push('not json')).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'extension_ui_request', id: 'ask-1', method: 'confirm', title: 'Proceed?', message: 'Run it?' }))).toEqual([
      { type: 'interaction-request', participantId: 'pi', request: { id: 'ask-1', method: 'confirm', title: 'Proceed?', message: 'Run it?' } },
    ]);
    expect(parser.push(JSON.stringify({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Heads up', notifyType: 'warning' }))).toEqual([
      { type: 'interaction-notify', participantId: 'pi', message: 'Heads up', level: 'warning' },
    ]);
  });

  it('falls back to completed assistant text when no deltas were emitted', () => {
    const parser = createPiParser({ participantId: 'pi', newMessageId: () => 'm1', onSettled: vi.fn() });
    const events = parser.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'complete text' }] } }));
    expect(events).toEqual([
      { type: 'message-start', participantId: 'pi', messageId: 'm1' },
      { type: 'token', participantId: 'pi', messageId: 'm1', token: 'complete text' },
    ]);
  });

  it('delays a terminal retry error until the stats response, then ends the turn', () => {
    const parser = createPiParser({ participantId: 'pi', newMessageId: () => 'm1', onSettled: vi.fn() });
    expect(parser.push(JSON.stringify({ type: 'auto_retry_end', success: false, finalError: 'rate limited' }))).toEqual([]);
    parser.push(JSON.stringify({ type: 'agent_settled' }));
    const events = parser.push(JSON.stringify({ type: 'response', command: 'get_session_stats', success: false }));
    expect(events).toEqual([
      { type: 'error', participantId: 'pi', message: 'rate limited' },
      { type: 'turn-end', participantId: 'pi' },
    ] satisfies AgentEvent[]);
  });
});
