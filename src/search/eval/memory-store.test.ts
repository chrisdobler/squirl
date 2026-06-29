import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore } from './memory-store.js';
import type { EmbeddedChunk, TurnPair } from '../types.js';

const tp = (id: string): TurnPair => ({
  id, source: 'golden', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText: 'q ' + id, assistantText: 'a ' + id,
});

const chunk = (id: string, embedding: number[]): EmbeddedChunk => ({ turnPair: tp(id), embedding, text: id });

async function seed(): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore();
  await store.upsert([
    chunk('v1', [1, 0]),     // identical to query → distance 0
    chunk('v2', [0, 1]),     // orthogonal → distance 1
    chunk('v3', [1, 1]),     // 45° → distance ~0.2929
  ]);
  return store;
}

describe('InMemoryVectorStore', () => {
  it('ranks by ascending cosine distance with correct scores', async () => {
    const store = await seed();
    const results = await store.query([1, 0], 10);
    expect(results.map((r) => r.id)).toEqual(['v1', 'v3', 'v2']);
    expect(results[0]!.score).toBeCloseTo(0, 6);
    expect(results[1]!.score).toBeCloseTo(1 - 1 / Math.SQRT2, 6); // ~0.2929
    expect(results[2]!.score).toBeCloseTo(1, 6);
  });

  it('returns the turn-pair on each result', async () => {
    const store = await seed();
    const [top] = await store.query([1, 0], 1);
    expect(top!.turnPair.id).toBe('v1');
    expect(top!.turnPair.userText).toBe('q v1');
  });

  it('respects the k limit', async () => {
    const store = await seed();
    expect(await store.query([1, 0], 2)).toHaveLength(2);
  });

  it('upsert replaces an existing id rather than duplicating', async () => {
    const store = await seed();
    await store.upsert([chunk('v1', [0, 1])]); // move v1 onto the orthogonal axis
    const results = await store.query([1, 0], 10);
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.id === 'v1')!.score).toBeCloseTo(1, 6);
  });

  it('has() reports which ids are present', async () => {
    const store = await seed();
    expect(await store.has(['v1', 'v2', 'missing'])).toEqual(new Set(['v1', 'v2']));
  });

  it('delete() removes ids', async () => {
    const store = await seed();
    await store.delete(['v1']);
    const results = await store.query([1, 0], 10);
    expect(results.map((r) => r.id)).toEqual(['v3', 'v2']);
  });
});
