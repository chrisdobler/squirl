import type { RoomStore } from '../persistence/types.js';
import type { EmbeddedChunk, SearchResult, VectorStore } from './types.js';
import { MEMORY_INDEX_VERSION, type MemoryVectorIndex } from './memory-chunks.js';

/** Compatibility boundary: vector hits are hydrated from Postgres before legacy recall consumers see text. */
export class HydratedMemoryStore implements VectorStore {
  constructor(private readonly roomId: string, private readonly repository: RoomStore, private readonly index: MemoryVectorIndex) {}

  async query(embedding: number[], k: number): Promise<SearchResult[]> {
    const hits = await this.index.query(embedding, k, this.roomId);
    const chunks = await this.repository.hydrateMemoryChunks(hits.map((hit) => hit.chunkId));
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    return hits.flatMap((hit): SearchResult[] => {
      const chunk = byId.get(hit.chunkId);
      if (!chunk || chunk.roomId !== this.roomId || chunk.indexVersion !== MEMORY_INDEX_VERSION || chunk.contentHash !== hit.contentHash) return [];
      return [{
        id: chunk.id,
        score: hit.score,
        turnPair: {
          id: chunk.id,
          source: 'squirl-postgres',
          conversationId: chunk.roomId,
          timestamp: chunk.createdAt,
          userText: chunk.contextText ?? (chunk.role === 'user' ? chunk.content : ''),
          assistantText: chunk.role === 'assistant' ? chunk.content : '',
          participantIds: chunk.participantId ? [chunk.participantId] : undefined,
          sourceMessageId: chunk.sourceMessageId,
        },
      }];
    });
  }

  async upsert(_chunks: EmbeddedChunk[]): Promise<void> { throw new Error('Use MemoryIndexWorker for v2 indexing.'); }
  async has(ids: string[]): Promise<Set<string>> { return this.index.has(ids); }
  async delete(ids: string[]): Promise<void> { await this.index.delete(ids); }
  async close(): Promise<void> { await this.index.close(); }
}
