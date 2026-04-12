import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IngestQueue } from './ingest-queue.js';
import type { Embedder, VectorStore, TurnPair, EmbeddedChunk } from './types.js';
import { StatusEmitter } from './status.js';

const tp = (id: string): TurnPair => ({
  id, source: 'squirl', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText: 'q ' + id, assistantText: 'a ' + id,
});

const mockEmbedder = (): Embedder & { embed: ReturnType<typeof vi.fn> } => ({
  name: 'test', dimensions: 3,
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
});

const mockStore = (): VectorStore & { upsert: ReturnType<typeof vi.fn> } => ({
  upsert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  has: vi.fn().mockResolvedValue(new Set()),
  close: vi.fn().mockResolvedValue(undefined),
});

describe('IngestQueue', () => {
  let embedder: ReturnType<typeof mockEmbedder>;
  let store: ReturnType<typeof mockStore>;
  let status: StatusEmitter;
  let queue: IngestQueue;

  beforeEach(() => {
    embedder = mockEmbedder();
    store = mockStore();
    status = new StatusEmitter();
    queue = new IngestQueue(embedder, store, status);
  });

  it('embeds and upserts enqueued turn-pairs', async () => {
    queue.enqueue(tp('p1'));
    await queue.flush();
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    const chunks = store.upsert.mock.calls[0]![0] as EmbeddedChunk[];
    expect(chunks[0]!.turnPair.id).toBe('p1');
  });

  it('batches up to 16', async () => {
    for (let i = 0; i < 20; i++) queue.enqueue(tp(`p${i}`));
    await queue.flush();
    expect(embedder.embed).toHaveBeenCalledTimes(2);
    expect(embedder.embed.mock.calls[0]![0]).toHaveLength(16);
    expect(embedder.embed.mock.calls[1]![0]).toHaveLength(4);
  });

  it('emits status: embedding → indexing → idle', async () => {
    const phases: string[] = [];
    status.on((s) => phases.push(s.phase));
    queue.enqueue(tp('p1'));
    await queue.flush();
    expect(phases).toEqual(['embedding', 'indexing', 'idle']);
  });

  it('emits error and retains items on failure', async () => {
    embedder.embed.mockRejectedValueOnce(new Error('network down'));
    queue.enqueue(tp('p1'));
    await queue.flush();
    expect(status.current.phase).toBe('error');
    expect(status.current.pending).toBe(1);
  });
});
