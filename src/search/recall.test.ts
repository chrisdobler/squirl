import { describe, it, expect, vi } from 'vitest';
import { recall } from './recall.js';
import type { Embedder, VectorStore, TurnPair } from './types.js';

const tp = (id: string): TurnPair => ({
  id, source: 'squirl', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText: 'question', assistantText: 'answer',
});

describe('recall', () => {
  it('embeds query and returns store results', async () => {
    const embedder: Embedder = {
      name: 'test', dimensions: 3,
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
    const store: VectorStore = {
      upsert: vi.fn(), close: vi.fn(), has: vi.fn(),
      query: vi.fn().mockResolvedValue([{ id: 'r1', score: 0.1, turnPair: tp('r1') }]),
    };

    const results = await recall('test query', embedder, store, 5);
    expect(embedder.embed).toHaveBeenCalledWith(['test query']);
    expect(store.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.turnPair.userText).toBe('question');
  });
});
