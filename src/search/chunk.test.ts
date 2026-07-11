import { describe, it, expect } from 'vitest';
import { buildChunkText, DEFAULT_CHUNK_OPTIONS } from './chunk.js';
import type { TurnPair } from './types.js';

const tp = (over: Partial<TurnPair> = {}): TurnPair => ({
  id: 'p1', source: 'squirl', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText: 'q', assistantText: 'a', ...over,
});

// Reference copy of the original inline IngestQueue.drain logic (maxChars = floor(512 * 1.5) = 768,
// tool summary always included). buildChunkText must reproduce this exactly.
function oldChunkText(p: TurnPair, maxChars = 768): string {
  let t = `${p.userText}\n${p.assistantText}`;
  if (p.toolSummary) t += `\n${p.toolSummary}`;
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]|[\uD800-\uDFFF]/g, '');
  if (t.length > maxChars) t = t.slice(0, maxChars);
  return t || ' ';
}

describe('buildChunkText', () => {
  it('embeds participant handles for agent-aware recall', () => {
    const pair = tp({ userText: 'fix the header', assistantText: 'done', participantIds: ['cc'] });
    expect(buildChunkText(pair, DEFAULT_CHUNK_OPTIONS)).toContain('Agents: @cc');
  });
  it('joins user and assistant text with a newline', () => {
    expect(buildChunkText(tp({ userText: 'hello', assistantText: 'world' }), DEFAULT_CHUNK_OPTIONS))
      .toBe('hello\nworld');
  });

  it('appends tool summary when present and enabled', () => {
    expect(buildChunkText(tp({ userText: 'u', assistantText: 'a', toolSummary: 'read -> x' }), DEFAULT_CHUNK_OPTIONS))
      .toBe('u\na\nread -> x');
  });

  it('omits tool summary when includeToolSummary is false', () => {
    expect(buildChunkText(tp({ toolSummary: 'read -> x' }), { ...DEFAULT_CHUNK_OPTIONS, includeToolSummary: false }))
      .toBe('q\na');
  });

  it('user-only template drops assistant text', () => {
    expect(buildChunkText(tp({ userText: 'u', assistantText: 'a' }), { ...DEFAULT_CHUNK_OPTIONS, template: 'user-only' }))
      .toBe('u');
  });

  it('strips control chars and unpaired surrogates', () => {
    expect(buildChunkText(tp({ userText: 'a\x00b\x07', assistantText: 'c\x1fd' }), DEFAULT_CHUNK_OPTIONS))
      .toBe('ab\ncd');
  });

  it('truncates to maxChars', () => {
    const long = 'x'.repeat(2000);
    expect(buildChunkText(tp({ userText: long, assistantText: '' }), { ...DEFAULT_CHUNK_OPTIONS, maxChars: 10 }))
      .toBe('x'.repeat(10));
  });

  it('keeps the newline separator for empty user-assistant content', () => {
    expect(buildChunkText(tp({ userText: '', assistantText: '' }), DEFAULT_CHUNK_OPTIONS)).toBe('\n');
  });

  it('falls back to a single space when output is fully empty', () => {
    expect(buildChunkText(tp({ userText: '' }), { ...DEFAULT_CHUNK_OPTIONS, template: 'user-only' })).toBe(' ');
  });

  it('default options use maxChars 768 and include tool summary', () => {
    expect(DEFAULT_CHUNK_OPTIONS).toEqual({ includeToolSummary: true, maxChars: 768, template: 'user-assistant' });
  });

  it('matches the original inline logic (byte-for-byte parity)', () => {
    const cases: TurnPair[] = [
      tp({ userText: 'hello', assistantText: 'world' }),
      tp({ userText: 'u', assistantText: 'a', toolSummary: 'read_file -> docker-compose.yml' }),
      tp({ userText: 'a\x00b', assistantText: 'c\x1f', toolSummary: 'tool\x08' }),
      tp({ userText: 'x'.repeat(1000), assistantText: 'y'.repeat(1000) }),
      tp({ userText: '', assistantText: '' }),
      tp({ userText: 'emoji 😀 \uD800 lone', assistantText: 'end' }),
    ];
    for (const c of cases) {
      expect(buildChunkText(c, DEFAULT_CHUNK_OPTIONS)).toBe(oldChunkText(c));
    }
  });
});
