import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClaudeParser } from './claude-stream.js';
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
  return createClaudeParser({ participantId: 'cc', newMessageId: () => `m${++n}` });
}

describe('createClaudeParser', () => {
  it('streams text via content_block_delta tokens (partial-message mode)', () => {
    const events = runParser(makeParser(), fixtureLines('claude-message.jsonl'));

    // System hook/status noise is skipped; init yields session-status with id+model.
    expect(events[0]).toEqual({
      type: 'session-status', participantId: 'cc', status: 'ready',
      sessionId: '3bdd7fde-35b6-4858-a6de-5598c110612c', model: 'claude-opus-4-8[1m]',
    });

    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { token: string }).token);
    expect(tokens.join('')).toBe('turn one ok.');

    const ends = events.filter((e) => e.type === 'message-end');
    expect(ends).toHaveLength(1);
    expect((ends[0] as { content: string }).content).toBe('turn one ok.');

    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 26925, cachedInputTokens: 15626, cacheCreationInputTokens: 4770, contextWindow: 1000000 },
    });
    // No duplicate text from the top-level `assistant` snapshot.
    expect(tokens.join('')).not.toContain('turn one ok.turn one ok.');
  });

  it('emits tool-start/tool-end and final text in non-partial mode', () => {
    const events = runParser(makeParser(), fixtureLines('claude-tool.jsonl'));

    const toolStart = events.find((e) => e.type === 'tool-start');
    expect(toolStart).toMatchObject({ type: 'tool-start', participantId: 'cc', toolName: 'Read' });
    expect((toolStart as { input: { file_path: string } }).input.file_path).toContain('package.json');

    const toolEnd = events.find((e) => e.type === 'tool-end');
    expect(toolEnd).toMatchObject({
      type: 'tool-end', participantId: 'cc', toolName: 'Read', ok: true,
      toolId: (toolStart as { toolId: string }).toolId,
    });
    expect((toolEnd as { result: string }).result).toContain('"version": "0.1.0"');

    // Final answer text is captured (no deltas in this capture — comes from the assistant block).
    const finalText = events
      .filter((e) => e.type === 'token').map((e) => (e as { token: string }).token).join('');
    expect(finalText).toContain('0.1.0');

    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
  });

  it('surfaces an errored result as an error event', () => {
    const parser = makeParser();
    const events = parser.push('{"type":"result","subtype":"error","is_error":true,"result":"Not logged in · Please run /login"}');
    expect(events).toContainEqual({ type: 'error', participantId: 'cc', message: 'Not logged in · Please run /login' });
  });

  it('ignores blank and non-JSON lines without throwing', () => {
    const parser = makeParser();
    expect(parser.push('')).toEqual([]);
    expect(parser.push('garbage')).toEqual([]);
  });
});
