import { describe, it, expect } from 'vitest';
import { createEmbedder } from './index.js';

describe('createEmbedder', () => {
  it('creates OpenAI embedder', () => {
    expect(createEmbedder({ type: 'openai', apiKey: 'k' }).name).toMatch(/^openai:/);
  });
  it('creates local embedder with Ollama backend', () => {
    expect(createEmbedder({ type: 'local', detectedBackend: 'ollama' }).name).toMatch(/^ollama:/);
  });
  it('creates local embedder with vLLM backend', () => {
    expect(createEmbedder({ type: 'local', detectedBackend: 'vllm', baseUrl: 'http://localhost:8000/v1' }).name).toMatch(/^openai:/);
  });
});
