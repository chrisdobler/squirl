import { describe, it, expect, vi } from 'vitest';
import { extractSearchQueries } from './meta-extract.js';
import type { Message } from '../types.js';

const user = (content: string): Message => ({ id: 'u1', role: 'user', content });
const asst = (content: string): Message => ({ id: 'a1', role: 'assistant', content });

describe('extractSearchQueries', () => {
  it('calls the LLM and parses JSON array of queries', async () => {
    const mockComplete = vi.fn().mockResolvedValue('["docker setup", "chroma config"]');

    const queries = await extractSearchQueries(
      [user('How do I set up Chroma?'), asst('Use docker compose...')],
      'Can I change the port?',
      { complete: mockComplete },
    );

    expect(queries).toEqual(['docker setup', 'chroma config']);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0]![0];
    expect(callArgs.systemPrompt).toContain('search quer');
  });

  it('returns empty array if LLM returns invalid JSON', async () => {
    const mockComplete = vi.fn().mockResolvedValue('not json at all');
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual([]);
  });

  it('returns empty array if LLM call throws', async () => {
    const mockComplete = vi.fn().mockRejectedValue(new Error('network error'));
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual([]);
  });

  it('filters out non-string entries from the array', async () => {
    const mockComplete = vi.fn().mockResolvedValue('["valid", 123, null, "also valid"]');
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual(['valid', 'also valid']);
  });
});
