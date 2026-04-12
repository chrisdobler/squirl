import { describe, it, expect } from 'vitest';
import { createEmbedder } from './index.js';

describe('createEmbedder', () => {
  it('creates OpenAI embedder', () => {
    expect(createEmbedder({ type: 'openai', apiKey: 'k' }).name).toMatch(/^openai:/);
  });
  it('creates Ollama embedder', () => {
    expect(createEmbedder({ type: 'ollama' }).name).toMatch(/^ollama:/);
  });
  it('throws for unknown type', () => {
    // @ts-expect-error testing invalid
    expect(() => createEmbedder({ type: 'x' })).toThrow('Unknown embedder');
  });
});
