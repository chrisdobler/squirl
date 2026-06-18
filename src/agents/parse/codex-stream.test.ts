import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCodexParser } from './codex-stream.js';
import type { AgentEvent, StreamParser } from '../types.js';

function fixtureLines(name: string): string[] {
  const raw = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

function runParser(parser: StreamParser, lines: string[], exitCode: number | null = 0): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of lines) events.push(...parser.push(line));
  events.push(...parser.end(exitCode));
  return events;
}

function makeParser(): StreamParser {
  let n = 0;
  return createCodexParser({ participantId: 'codex', newMessageId: () => `m${++n}` });
}

describe('createCodexParser', () => {
  it('parses a plain agent_message turn', () => {
    const events = runParser(makeParser(), fixtureLines('codex-message.jsonl'));

    expect(events).toEqual([
      { type: 'session-status', participantId: 'codex', status: 'ready', sessionId: '019ed6fe-480f-7b70-89c2-c6ad2c2a0fc7' },
      { type: 'message-start', participantId: 'codex', messageId: 'm1' },
      { type: 'token', participantId: 'codex', messageId: 'm1', token: 'hello from codex' },
      { type: 'message-end', participantId: 'codex', messageId: 'm1', content: 'hello from codex' },
      { type: 'usage', participantId: 'codex', usage: { inputTokens: 20782, outputTokens: 8 } },
      { type: 'turn-end', participantId: 'codex' },
    ]);
  });

  it('parses interleaved command execution and multiple agent messages', () => {
    const events = runParser(makeParser(), fixtureLines('codex-tool.jsonl'));

    expect(events).toEqual([
      { type: 'session-status', participantId: 'codex', status: 'ready', sessionId: '019ed6fe-efa8-7070-8691-b32583538e0a' },
      { type: 'message-start', participantId: 'codex', messageId: 'm1' },
      { type: 'token', participantId: 'codex', messageId: 'm1', token: 'I’ll check the requested file directly from the project root.' },
      { type: 'message-end', participantId: 'codex', messageId: 'm1', content: 'I’ll check the requested file directly from the project root.' },
      { type: 'tool-start', participantId: 'codex', toolId: 'item_1', toolName: 'command_execution', input: { command: "/bin/zsh -lc 'ls package.json'" } },
      { type: 'tool-end', participantId: 'codex', toolId: 'item_1', toolName: 'command_execution', result: 'package.json\n', ok: true },
      { type: 'message-start', participantId: 'codex', messageId: 'm2' },
      { type: 'token', participantId: 'codex', messageId: 'm2', token: 'done' },
      { type: 'message-end', participantId: 'codex', messageId: 'm2', content: 'done' },
      { type: 'usage', participantId: 'codex', usage: { inputTokens: 41225, outputTokens: 77 } },
      { type: 'turn-end', participantId: 'codex' },
    ]);
  });

  it('ignores blank and non-JSON lines without throwing', () => {
    const parser = makeParser();
    expect(parser.push('')).toEqual([]);
    expect(parser.push('Reading additional input from stdin...')).toEqual([]);
    expect(parser.push('not json {')).toEqual([]);
  });

  it('reports a nonzero exit code as an error', () => {
    const parser = makeParser();
    const events = parser.end(1);
    expect(events).toContainEqual({ type: 'exit', participantId: 'codex', code: 1 });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
