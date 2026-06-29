import { describe, it, expect } from 'vitest';
import { frozenHarness, chunkHashOf, embedderName, type EmbeddingFixture } from './harness.js';
import { DEFAULT_CHUNK_OPTIONS, buildChunkText } from '../chunk.js';
import { DEFAULT_KS } from './metrics.js';
import type { RunConfig } from './types.js';
import type { TurnPair } from '../types.js';

const tp = (id: string, userText: string): TurnPair => ({
  id, source: 'golden', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText, assistantText: 'answer for ' + id,
});

const corpus = [tp('c1', 'docker postgres volume'), tp('c2', 'chroma default url')];

const fixture: EmbeddingFixture = {
  embedder: 'openai:text-embedding-3-small',
  dimensions: 2,
  chunkOptions: DEFAULT_CHUNK_OPTIONS,
  chunkHash: chunkHashOf(DEFAULT_CHUNK_OPTIONS),
  corpus: { c1: [1, 0], c2: [0, 1] },
  queries: { docker: [1, 0], chroma: [0, 1] },
};

const config: RunConfig = {
  mode: 'frozen', layer: 1,
  embedder: { type: 'openai', model: 'text-embedding-3-small' },
  meta: { provider: 'openai', model: 'gpt-4o-mini' },
  chunk: DEFAULT_CHUNK_OPTIONS,
  rank: { perQueryK: 8, recallK: 10, filterConversation: true },
  ks: DEFAULT_KS,
  label: 'test',
};

describe('chunkHashOf', () => {
  it('is an 8-char hex string, stable for equal options', () => {
    const h = chunkHashOf(DEFAULT_CHUNK_OPTIONS);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(chunkHashOf({ ...DEFAULT_CHUNK_OPTIONS })).toBe(h);
  });

  it('changes when chunk options change', () => {
    expect(chunkHashOf({ ...DEFAULT_CHUNK_OPTIONS, maxChars: 256 })).not.toBe(chunkHashOf(DEFAULT_CHUNK_OPTIONS));
  });
});

describe('embedderName', () => {
  it('mirrors the real embedder name format', () => {
    expect(embedderName({ type: 'openai', model: 'text-embedding-3-small' })).toBe('openai:text-embedding-3-small');
    expect(embedderName({ type: 'local', model: 'nomic-embed-text', detectedBackend: 'ollama' })).toBe('ollama:nomic-embed-text');
    expect(embedderName({ type: 'openai' })).toBe('openai:text-embedding-3-small');
  });
});

describe('frozenHarness', () => {
  it('serves cached query vectors and seeds the store from corpus vectors', async () => {
    const h = frozenHarness(corpus, fixture, config);

    expect(await h.embedder.embed(['docker'])).toEqual([[1, 0]]);

    const results = await h.store.query([1, 0], 8);
    expect(results[0]!.id).toBe('c1'); // nearest to the docker vector
    expect(results[0]!.score).toBeCloseTo(0, 6);
  });

  it('exposes chunkText and rank bound to the run config', () => {
    const h = frozenHarness(corpus, fixture, config);
    expect(h.chunkText(corpus[0]!)).toBe(buildChunkText(corpus[0]!, DEFAULT_CHUNK_OPTIONS));
  });

  it('throws a helpful error when a query vector is not cached', async () => {
    const h = frozenHarness(corpus, fixture, config);
    await expect(h.embedder.embed(['never-cached'])).rejects.toThrow(/refresh/i);
  });
});
