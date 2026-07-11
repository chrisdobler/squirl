import { describe, expect, it } from 'vitest';
import { isJsonLanguage, parseJsonBlock, summarizeJsonEntry } from './json-block.js';

describe('json-block', () => {
  it('parses single JSON objects', () => {
    expect(parseJsonBlock('{"a":1,"b":true}', 'json')).toEqual({ a: 1, b: true });
  });

  it('parses JSONL line by line', () => {
    expect(parseJsonBlock('{"line":1}\n{"line":2}\n', 'jsonl')).toEqual([{ line: 1 }, { line: 2 }]);
  });

  it('returns null for invalid JSON', () => {
    expect(parseJsonBlock('{bad', 'json')).toBeNull();
    expect(parseJsonBlock('{"ok":true}\n{bad', 'jsonl')).toBeNull();
  });

  it('recognizes json language aliases', () => {
    expect(isJsonLanguage('json-l')).toBe(true);
    expect(isJsonLanguage('typescript')).toBe(false);
  });

  it('summarizes chat history rows', () => {
    const summary = summarizeJsonEntry({
      timestamp: '2026-07-10T22:53:43.112Z',
      message: { role: 'user', content: 'hello?' },
    }, 0);

    expect(summary).toContain('2026-07-10T22:53:43.112Z');
    expect(summary).toContain('user');
    expect(summary).toContain('hello?');
  });
});
