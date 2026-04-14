import { describe, it, expect, vi } from 'vitest';
import { MemoryPipeline } from './memory-pipeline.js';
import type { Embedder, VectorStore, TurnPair, SearchResult } from './types.js';
import type { MetaLLM } from './meta-extract.js';
import type { Message } from '../types.js';

const tp = (id: string, userText: string): TurnPair => ({
  id, source: 'squirl', conversationId: 'c1', timestamp: '2026-04-10T12:00:00Z',
  userText, assistantText: 'answer for ' + id,
});

const sr = (id: string, userText: string, score: number): SearchResult => ({
  id, score, turnPair: tp(id, userText),
});

function mockLLM(): MetaLLM {
  return { complete: vi.fn().mockResolvedValue('["query1", "query2"]') };
}

function mockEmbedder(): Embedder & { embed: ReturnType<typeof vi.fn> } {
  return {
    name: 'test', dimensions: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
}

function mockStore(results: SearchResult[][]): VectorStore & { query: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  return {
    query: vi.fn(async () => results[callIndex++] ?? []),
    upsert: vi.fn(), has: vi.fn(), close: vi.fn(),
  };
}

describe('MemoryPipeline', () => {
  it('runs full pipeline: meta-extract → embed → search → format', async () => {
    const llm = mockLLM();
    const embedder = mockEmbedder();
    const store = mockStore([
      [sr('r1', 'docker setup', 0.1), sr('r2', 'chroma config', 0.3)],
      [sr('r2', 'chroma config', 0.2), sr('r3', 'embeddings', 0.4)],
    ]);

    const pipeline = new MemoryPipeline(llm, embedder, store, { recallK: 10 });
    const conversation: Message[] = [{ id: 'u1', role: 'user', content: 'hello' }];
    const result = await pipeline.retrieve(conversation, 'set up chroma');

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith(['query1', 'query2']);
    expect(store.query).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(3);
    expect(result.results.find((r) => r.id === 'r2')!.score).toBe(0.2);
    expect(result.systemMessage).toContain('relevant excerpts');
    expect(result.inlineDisplay).toContain('recalled 3 memories');
  });

  it('deduplicates and keeps best score', async () => {
    const store = mockStore([[sr('r1', 'q', 0.5)], [sr('r1', 'q', 0.1)]]);
    const pipeline = new MemoryPipeline(mockLLM(), mockEmbedder(), store, { recallK: 10 });
    const result = await pipeline.retrieve([], 'test');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.score).toBe(0.1);
  });

  it('respects recallK limit', async () => {
    const many = Array.from({ length: 10 }, (_, i) => sr(`r${i}`, `q${i}`, i * 0.1));
    const store = mockStore([many, []]);
    const pipeline = new MemoryPipeline(mockLLM(), mockEmbedder(), store, { recallK: 3 });
    const result = await pipeline.retrieve([], 'test');
    expect(result.results).toHaveLength(3);
  });

  it('filters out turn-pairs already in conversation', async () => {
    const store = mockStore([[sr('r1', 'hello', 0.1)], []]);
    const pipeline = new MemoryPipeline(mockLLM(), mockEmbedder(), store, { recallK: 10 });
    const conversation: Message[] = [{ id: 'x', role: 'user', content: 'hello' }];
    const result = await pipeline.retrieve(conversation, 'test');
    expect(result.results).toHaveLength(0);
  });

  it('returns empty result if meta-extraction fails', async () => {
    const llm: MetaLLM = { complete: vi.fn().mockRejectedValue(new Error('fail')) };
    const pipeline = new MemoryPipeline(llm, mockEmbedder(), mockStore([]), { recallK: 10 });
    const result = await pipeline.retrieve([], 'test');
    expect(result.results).toEqual([]);
    expect(result.systemMessage).toBe('');
    expect(result.inlineDisplay).toBe('');
  });
});
