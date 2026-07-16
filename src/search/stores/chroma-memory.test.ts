import { describe, expect, it, vi } from 'vitest';
import { ChromaMemoryIndex } from './chroma-memory.js';
import { chunksForMessage } from '../memory-chunks.js';

describe('ChromaMemoryIndex', () => {
  it('stores only a preview and reference metadata, then applies a room filter', async () => {
    const collection = {
      upsert: vi.fn(async (_input: unknown) => undefined),
      query: vi.fn(async () => ({ ids: [['chunk']], distances: [[0.2]], metadatas: [[{
        roomId: 'room', role: 'assistant', participantId: 'cc', indexVersion: 2, contentHash: 'hash',
      }]] })),
      get: vi.fn(async () => ({ ids: [] })), delete: vi.fn(async () => undefined),
    };
    const chunk = chunksForMessage({ roomId: 'room', timestamp: '2026-01-01T00:00:00Z', message: { id: 'a', role: 'assistant', content: 'full canonical content' } })[0]!;
    await new ChromaMemoryIndex(collection).upsert([{ chunk, embedding: [1], preview: 'short preview' }]);
    expect(collection.upsert).toHaveBeenCalledWith(expect.objectContaining({ documents: ['short preview'] }));
    expect(JSON.stringify(collection.upsert.mock.calls[0]?.[0])).not.toContain('full canonical content');
    await new ChromaMemoryIndex(collection).query([1], 5, 'room');
    expect(collection.query).toHaveBeenCalledWith(expect.objectContaining({ where: { roomId: 'room' } }));
  });
});
