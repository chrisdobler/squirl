import type { VectorStore, EmbeddedChunk, SearchResult, TurnPair } from '../types.js';

interface ChromaCollection {
  upsert(p: { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Record<string, string>[] }): Promise<void>;
  query(p: { queryEmbeddings: number[][]; nResults: number }): Promise<{ ids: string[][]; distances: number[][]; metadatas: (Record<string, string> | null)[][] }>;
  get(p: { ids: string[] }): Promise<{ ids: string[] }>;
}

export class ChromaStore implements VectorStore {
  constructor(private readonly collection: ChromaCollection) {}

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.collection.upsert({
      ids: chunks.map((c) => c.turnPair.id),
      embeddings: chunks.map((c) => c.embedding),
      documents: chunks.map((c) => c.text),
      metadatas: chunks.map((c) => ({ turnPair: JSON.stringify(c.turnPair) })),
    });
  }

  async query(embedding: number[], k: number): Promise<SearchResult[]> {
    const res = await this.collection.query({ queryEmbeddings: [embedding], nResults: k });
    const ids = res.ids[0] ?? [];
    const distances = res.distances[0] ?? [];
    const metadatas = res.metadatas[0] ?? [];
    return ids.map((id, i) => ({
      id, score: distances[i] ?? 1,
      turnPair: JSON.parse((metadatas[i] as Record<string, string>)?.turnPair ?? '{}') as TurnPair,
    }));
  }

  async has(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const res = await this.collection.get({ ids });
    return new Set(res.ids);
  }

  async close(): Promise<void> {}
}
