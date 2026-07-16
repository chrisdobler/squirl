import { describe, expect, it, vi } from 'vitest';
import { MemoryIndexWorker } from './memory-index-worker.js';
import { MemoryRoomStore } from '../persistence/memory-room-store.js';
import { chunksForMessage } from './memory-chunks.js';

describe('MemoryIndexWorker', () => {
  it('indexes pending chunks and marks them durable', async () => {
    const repository = new MemoryRoomStore();
    const chunks = chunksForMessage({ roomId: repository.roomId, timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', content: 'voice recommendation' } });
    await repository.replaceMemoryChunks('a', chunks);
    const index = { upsert: vi.fn(async () => undefined), query: vi.fn(), has: vi.fn(), delete: vi.fn(), close: vi.fn() };
    const worker = new MemoryIndexWorker(repository, { name: 'fake', dimensions: 1, embed: async (texts) => texts.map(() => [1]) }, index);
    await worker.drain();
    expect(index.upsert).toHaveBeenCalledOnce();
    expect((await repository.hydrateMemoryChunks([chunks[0]!.id]))[0]?.state).toBe('indexed');
  });

  it('retains failed chunks for a later retry', async () => {
    const repository = new MemoryRoomStore();
    const chunks = chunksForMessage({ roomId: repository.roomId, timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', content: 'retry me' } });
    await repository.replaceMemoryChunks('a', chunks);
    const index = { upsert: vi.fn(async () => { throw new Error('offline'); }), query: vi.fn(), has: vi.fn(), delete: vi.fn(), close: vi.fn() };
    const worker = new MemoryIndexWorker(repository, { name: 'fake', dimensions: 1, embed: async () => [[1]] }, index);
    await worker.drain();
    expect((await repository.hydrateMemoryChunks([chunks[0]!.id]))[0]?.state).toBe('failed');
  });

  it('contains a claim timeout and succeeds on a later drain', async () => {
    const repository = new MemoryRoomStore();
    const chunks = chunksForMessage({ roomId: repository.roomId, timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', content: 'retry after postgres returns' } });
    await repository.replaceMemoryChunks('a', chunks);
    const claim = vi.spyOn(repository, 'claimMemoryChunks')
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'));
    const onError = vi.fn();
    const index = { upsert: vi.fn(async () => undefined), query: vi.fn(), has: vi.fn(), delete: vi.fn(), close: vi.fn() };
    const worker = new MemoryIndexWorker(repository, { name: 'fake', dimensions: 1, embed: async (texts) => texts.map(() => [1]) }, index, onError);

    await expect(worker.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Connection terminated due to connection timeout' }), 'claim');

    await expect(worker.drain()).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(3);
    expect(index.upsert).toHaveBeenCalledOnce();
    expect((await repository.hydrateMemoryChunks([chunks[0]!.id]))[0]?.state).toBe('indexed');
  });

  it('contains a database failure while recording an indexing result', async () => {
    const repository = new MemoryRoomStore();
    const chunks = chunksForMessage({ roomId: repository.roomId, timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', content: 'result state retry' } });
    await repository.replaceMemoryChunks('a', chunks);
    vi.spyOn(repository, 'markMemoryChunksIndexed').mockRejectedValueOnce(new Error('postgres offline'));
    const onError = vi.fn();
    const index = { upsert: vi.fn(async () => undefined), query: vi.fn(), has: vi.fn(), delete: vi.fn(), close: vi.fn() };
    const worker = new MemoryIndexWorker(repository, { name: 'fake', dimensions: 1, embed: async (texts) => texts.map(() => [1]) }, index, onError);

    await expect(worker.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'postgres offline' }), 'persist-result');
    expect((await repository.hydrateMemoryChunks([chunks[0]!.id]))[0]?.state).toBe('indexing');
  });

  it('contains a database failure while recording a processing failure', async () => {
    const repository = new MemoryRoomStore();
    const chunks = chunksForMessage({ roomId: repository.roomId, timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', content: 'failed result state retry' } });
    await repository.replaceMemoryChunks('a', chunks);
    vi.spyOn(repository, 'markMemoryChunksFailed').mockRejectedValueOnce(new Error('postgres offline'));
    const processingError = new Error('embedder offline');
    const onError = vi.fn();
    const worker = new MemoryIndexWorker(
      repository,
      { name: 'fake', dimensions: 1, embed: async () => { throw processingError; } },
      { upsert: vi.fn(), query: vi.fn(), has: vi.fn(), delete: vi.fn(), close: vi.fn() },
      onError,
    );

    await expect(worker.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenNthCalledWith(1, processingError, 'process');
    expect(onError).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'postgres offline' }), 'persist-result');
    expect((await repository.hydrateMemoryChunks([chunks[0]!.id]))[0]?.state).toBe('indexing');
  });

  it('contains failure reporting errors at timer-triggered invocation boundaries', async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemoryRoomStore();
      vi.spyOn(repository, 'claimMemoryChunks').mockRejectedValue(new Error('postgres offline'));
      const worker = new MemoryIndexWorker(
        repository,
        { name: 'fake', dimensions: 1, embed: async () => [] },
        { upsert: vi.fn(), query: vi.fn(), has: vi.fn(), delete: vi.fn(), close: vi.fn() },
        () => { throw new Error('reporter failed'); },
      );

      expect(() => worker.start()).not.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
