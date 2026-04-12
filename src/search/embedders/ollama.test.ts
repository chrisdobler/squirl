import { describe, it, expect, vi } from 'vitest';
import { OllamaEmbedder } from './ollama.js';

describe('OllamaEmbedder', () => {
  it('calls Ollama /api/embed and returns vectors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ embeddings: [[0.1], [0.2]] }),
    });
    const e = new OllamaEmbedder({ model: 'nomic-embed-text', dimensions: 768, fetchFn: mockFetch });
    const result = await e.embed(['a', 'b']);
    expect(result).toEqual([[0.1], [0.2]]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/embed', expect.objectContaining({ method: 'POST' }));
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
    const e = new OllamaEmbedder({ fetchFn: mockFetch });
    await expect(e.embed(['a'])).rejects.toThrow('Ollama embed failed (500)');
  });
});
