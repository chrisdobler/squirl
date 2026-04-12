import type { VectorStore, EmbeddedChunk, SearchResult } from '../types.js';

export class NullStore implements VectorStore {
  async upsert(_chunks: EmbeddedChunk[]): Promise<void> {}
  async query(_embedding: number[], _k: number): Promise<SearchResult[]> { return []; }
  async has(_ids: string[]): Promise<Set<string>> { return new Set(); }
  async close(): Promise<void> {}
}
