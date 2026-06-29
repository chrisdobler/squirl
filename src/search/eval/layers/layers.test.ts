import { describe, it, expect } from 'vitest';
import { runLayer1 } from './layer1-retrieval.js';
import { runLayer2 } from './layer2-end-to-end.js';
import { frozenHarness, chunkHashOf, type EmbeddingFixture } from '../harness.js';
import { DEFAULT_CHUNK_OPTIONS } from '../../chunk.js';
import type { EvalCase, RunConfig } from '../types.js';
import type { TurnPair } from '../../types.js';

const tp = (id: string): TurnPair => ({
  id, source: 'golden', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText: 'user ' + id, assistantText: 'assistant ' + id,
});

const corpus = [tp('doc-a'), tp('doc-b'), tp('doc-c')];

const fixture: EmbeddingFixture = {
  embedder: 'openai:text-embedding-3-small',
  dimensions: 2,
  chunkOptions: DEFAULT_CHUNK_OPTIONS,
  chunkHash: chunkHashOf(DEFAULT_CHUNK_OPTIONS),
  corpus: { 'doc-a': [1, 0], 'doc-b': [1, 1], 'doc-c': [0, 1] },
  // qa points straight at doc-a; qb leans toward doc-a but doc-b is the relevant answer (lands at rank 2).
  queries: { qa: [1, 0], qb: [1, 0.3] },
};

const config: RunConfig = {
  mode: 'frozen', layer: 1,
  embedder: { type: 'openai', model: 'text-embedding-3-small' },
  meta: { provider: 'openai', model: 'gpt-4o-mini' },
  chunk: DEFAULT_CHUNK_OPTIONS,
  rank: { perQueryK: 8, recallK: 10, filterConversation: true },
  ks: [1, 2, 3],
  label: 'test',
};

const cases: EvalCase[] = [
  { id: 'case-easy', conversation: [], userMessage: 'where is doc a', qrels: { 'doc-a': 2 }, goldQueries: ['qa'] },
  { id: 'case-hard', conversation: [], userMessage: 'where is doc b', qrels: { 'doc-b': 2 }, goldQueries: ['qb'] },
];

describe('runLayer1', () => {
  it('retrieves with gold queries and ranks by cosine distance', async () => {
    const h = frozenHarness(corpus, fixture, config);
    const { perCase } = await runLayer1(cases, h);

    expect(perCase.find((p) => p.caseId === 'case-easy')!.retrievedIds[0]).toBe('doc-a');
    expect(perCase.find((p) => p.caseId === 'case-hard')!.retrievedIds).toEqual(['doc-a', 'doc-b', 'doc-c']);
  });

  it('computes aggregate metrics over the cases', async () => {
    const h = frozenHarness(corpus, fixture, config);
    const { metrics } = await runLayer1(cases, h);

    expect(metrics.recallAtK[1]).toBeCloseTo(0.5, 6); // easy hits @1, hard misses @1
    expect(metrics.recallAtK[2]).toBeCloseTo(1.0, 6); // both hit by @2
    expect(metrics.mrr).toBeCloseTo(0.75, 6);          // (1 + 0.5) / 2
  });

  it('skips cases without gold queries', async () => {
    const h = frozenHarness(corpus, fixture, config);
    const { perCase } = await runLayer1(
      [...cases, { id: 'no-gold', conversation: [], userMessage: 'x', qrels: { 'doc-a': 1 } }],
      h,
    );
    expect(perCase.map((p) => p.caseId)).not.toContain('no-gold');
  });
});

describe('runLayer2', () => {
  it('frozen mode runs the real pipeline via a per-case canned LLM and matches Layer 1', async () => {
    const h = frozenHarness(corpus, fixture, { ...config, layer: 2 });
    const { perCase } = await runLayer2(cases, h);

    expect(perCase.find((p) => p.caseId === 'case-hard')!.retrievedIds).toEqual(['doc-a', 'doc-b', 'doc-c']);
    expect(perCase.find((p) => p.caseId === 'case-easy')!.retrievedIds[0]).toBe('doc-a');
  });
});
