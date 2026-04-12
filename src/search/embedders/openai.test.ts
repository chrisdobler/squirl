import { describe, it, expect, vi } from 'vitest';
import { OpenAIEmbedder } from './openai.js';

describe('OpenAIEmbedder', () => {
  it('calls OpenAI and returns sorted embeddings', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ index: 1, embedding: [0.4, 0.5] }, { index: 0, embedding: [0.1, 0.2] }],
    });
    const e = new OpenAIEmbedder({ apiKey: 'k', model: 'text-embedding-3-small', dimensions: 1536, createFn: mockCreate });
    const result = await e.embed(['a', 'b']);
    expect(result).toEqual([[0.1, 0.2], [0.4, 0.5]]);
    expect(e.name).toBe('openai:text-embedding-3-small');
  });
});
