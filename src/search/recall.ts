import type { Embedder, VectorStore, SearchResult } from './types.js';

export async function recall(
  query: string,
  embedder: Embedder,
  store: VectorStore,
  k: number = 5,
): Promise<SearchResult[]> {
  const [embedding] = await embedder.embed([query]);
  return store.query(embedding!, k);
}
