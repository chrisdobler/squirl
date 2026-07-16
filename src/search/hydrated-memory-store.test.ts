import { describe, expect, it } from 'vitest';
import { HydratedMemoryStore } from './hydrated-memory-store.js';
import { MemoryRoomStore } from '../persistence/memory-room-store.js';
import { chunksForMessage } from './memory-chunks.js';

describe('HydratedMemoryStore', () => {
  it('hydrates canonical Postgres content and drops stale or hash-mismatched hits', async () => {
    const repository = new MemoryRoomStore();
    const [chunk] = chunksForMessage({ roomId: repository.roomId, timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', participantId: 'cc', content: 'canonical answer' } });
    await repository.replaceMemoryChunks('a', [chunk!]);
    const index = {
      upsert: async () => undefined, has: async () => new Set<string>(), delete: async () => undefined, close: async () => undefined,
      query: async () => [
        { chunkId: chunk!.id, score: 0.1, roomId: repository.roomId, role: 'assistant' as const, participantId: 'cc', indexVersion: 2, contentHash: chunk!.contentHash },
        { chunkId: 'missing', score: 0.2, roomId: repository.roomId, role: 'assistant' as const, indexVersion: 2, contentHash: 'x' },
        { chunkId: chunk!.id, score: 0.3, roomId: repository.roomId, role: 'assistant' as const, indexVersion: 2, contentHash: 'wrong' },
      ],
    };
    const results = await new HydratedMemoryStore(repository.roomId, repository, index).query([1], 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.turnPair.assistantText).toBe('canonical answer');
    expect(results[0]?.turnPair.participantIds).toEqual(['cc']);
  });
});
