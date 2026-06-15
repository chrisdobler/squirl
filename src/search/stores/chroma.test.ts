import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChromaStore, VECTOR_DB_TIMEOUT_MESSAGE } from './chroma.js';
import type { TurnPair, EmbeddedChunk } from '../types.js';

const tp = (id: string): TurnPair => ({ id, source: 'squirl', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z', userText: 'q', assistantText: 'a' });

const mockCollection = {
  upsert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({
    ids: [['id-1', 'id-2']], distances: [[0.1, 0.5]],
    metadatas: [[{ turnPair: JSON.stringify(tp('id-1')) }, { turnPair: JSON.stringify(tp('id-2')) }]],
  }),
  get: vi.fn().mockResolvedValue({ ids: ['id-1'] }),
};

describe('ChromaStore', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('upserts chunks', async () => {
    const store = new ChromaStore(mockCollection as any);
    const chunks: EmbeddedChunk[] = [{ turnPair: tp('c1'), embedding: [0.1], text: 'q\na' }];
    await store.upsert(chunks);
    expect(mockCollection.upsert).toHaveBeenCalledWith(expect.objectContaining({ ids: ['c1'] }));
  });

  it('queries and returns sorted results', async () => {
    const results = await new ChromaStore(mockCollection as any).query([0.1], 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.score).toBe(0.1);
  });

  it('checks existing IDs', async () => {
    const existing = await new ChromaStore(mockCollection as any).has(['id-1', 'id-2']);
    expect(existing).toEqual(new Set(['id-1']));
  });

  it('normalizes query request timeouts', async () => {
    const collection = {
      ...mockCollection,
      query: vi.fn().mockRejectedValue(new Error('Request timed out.')),
    };

    await expect(new ChromaStore(collection as any).query([0.1], 2))
      .rejects.toThrow(VECTOR_DB_TIMEOUT_MESSAGE);
  });

  it('times out slow query requests', async () => {
    vi.useFakeTimers();
    const collection = {
      ...mockCollection,
      query: vi.fn(() => new Promise(() => {})),
    };
    const promise = new ChromaStore(collection as any, 25).query([0.1], 2);
    const expectation = expect(promise).rejects.toThrow(VECTOR_DB_TIMEOUT_MESSAGE);

    await vi.advanceTimersByTimeAsync(25);

    await expectation;
  });

  it('normalizes upsert request timeouts', async () => {
    const collection = {
      ...mockCollection,
      upsert: vi.fn().mockRejectedValue(new Error('Request timed out.')),
    };
    const chunks: EmbeddedChunk[] = [{ turnPair: tp('c1'), embedding: [0.1], text: 'q\na' }];

    await expect(new ChromaStore(collection as any).upsert(chunks))
      .rejects.toThrow(VECTOR_DB_TIMEOUT_MESSAGE);
  });

  it('normalizes has request timeouts', async () => {
    const collection = {
      ...mockCollection,
      get: vi.fn().mockRejectedValue(new Error('Request timed out.')),
    };

    await expect(new ChromaStore(collection as any).has(['id-1']))
      .rejects.toThrow(VECTOR_DB_TIMEOUT_MESSAGE);
  });
});
