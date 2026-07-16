import type { MemoryVectorHit, MemoryVectorIndex, MemoryVectorRecord } from '../memory-chunks.js';
import { DEFAULT_VECTOR_STORE_TIMEOUT_MS, withVectorStoreTimeout } from './chroma.js';

interface ChromaMemoryCollection {
  upsert(p: { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Record<string, string | number>[] }): Promise<void>;
  query(p: { queryEmbeddings: number[][]; nResults: number; where: Record<string, string | number> }): Promise<{
    ids: string[][]; distances: number[][]; metadatas: (Record<string, string | number> | null)[][];
  }>;
  get(p: { ids: string[] }): Promise<{ ids: string[] }>;
  delete(p: { ids: string[] }): Promise<unknown>;
}

export class ChromaMemoryIndex implements MemoryVectorIndex {
  constructor(private readonly collection: ChromaMemoryCollection, private readonly timeoutMs = DEFAULT_VECTOR_STORE_TIMEOUT_MS) {}

  async upsert(records: MemoryVectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await withVectorStoreTimeout(this.collection.upsert({
      ids: records.map((record) => record.chunk.id),
      embeddings: records.map((record) => record.embedding),
      documents: records.map((record) => record.preview),
      metadatas: records.map(({ chunk }) => ({
        chunkId: chunk.id,
        roomId: chunk.roomId,
        role: chunk.role,
        participantId: chunk.participantId ?? '',
        indexVersion: chunk.indexVersion,
        contentHash: chunk.contentHash,
      })),
    }), this.timeoutMs);
  }

  async query(embedding: number[], k: number, roomId: string): Promise<MemoryVectorHit[]> {
    const response = await withVectorStoreTimeout(this.collection.query({
      queryEmbeddings: [embedding], nResults: k, where: { roomId },
    }), this.timeoutMs);
    return (response.ids[0] ?? []).map((chunkId, index) => {
      const metadata = response.metadatas[0]?.[index] ?? {};
      return {
        chunkId,
        score: response.distances[0]?.[index] ?? 1,
        roomId: String(metadata.roomId ?? ''),
        role: metadata.role === 'user' ? 'user' : 'assistant',
        participantId: String(metadata.participantId ?? '') || undefined,
        indexVersion: Number(metadata.indexVersion ?? 0),
        contentHash: String(metadata.contentHash ?? ''),
      };
    });
  }

  async has(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const response = await withVectorStoreTimeout(this.collection.get({ ids }), this.timeoutMs);
    return new Set(response.ids);
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await withVectorStoreTimeout(this.collection.delete({ ids }), this.timeoutMs);
  }

  async close(): Promise<void> {}
}
