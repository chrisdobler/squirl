import { describe, it, expect } from 'vitest';
import { formatMemorySystemMessage, formatMemoryInline } from './memory-format.js';
import type { SearchResult } from './types.js';

function sr(id: string, userText: string, assistantText: string, source: string, timestamp: string, score: number): SearchResult {
  return { id, score, turnPair: { id, source, conversationId: 'c1', timestamp, userText, assistantText } };
}

describe('formatMemorySystemMessage', () => {
  it('formats results into a system message with header', () => {
    const results = [
      sr('r1', 'How to set up Docker?', 'Use docker compose up -d', 'squirl', '2026-04-10T12:00:00Z', 0.1),
      sr('r2', 'Best embedding model?', 'nomic-embed-text works well', 'chatgpt', '2026-04-09T12:00:00Z', 0.2),
    ];
    const msg = formatMemorySystemMessage(results);
    expect(msg).toContain('relevant excerpts from prior conversations');
    expect(msg).toContain('2026-04-10');
    expect(msg).toContain('squirl');
    expect(msg).toContain('How to set up Docker?');
    expect(msg).toContain('Use docker compose up -d');
    expect(msg).toContain('chatgpt');
  });

  it('returns empty string for empty results', () => {
    expect(formatMemorySystemMessage([])).toBe('');
  });
});

describe('formatMemoryInline', () => {
  it('formats compact one-line-per-memory display', () => {
    const results = [
      sr('r1', 'How to set up Docker?', 'answer', 'squirl', '2026-04-10T12:00:00Z', 0.1),
      sr('r2', 'Best embedding model?', 'answer', 'chatgpt', '2026-04-09T12:00:00Z', 0.2),
    ];
    const display = formatMemoryInline(results);
    expect(display).toContain('recalled 2 memories');
    expect(display).toContain('Apr 10');
    expect(display).toContain('How to set up Docker?');
  });

  it('returns empty string for empty results', () => {
    expect(formatMemoryInline([])).toBe('');
  });

  it('truncates long user text', () => {
    const results = [sr('r1', 'A'.repeat(100), 'answer', 'squirl', '2026-04-10T12:00:00Z', 0.1)];
    const display = formatMemoryInline(results);
    expect(display).toContain('...');
  });
});
