import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChromaStore } from './chroma.js';
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
});
