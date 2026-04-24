import type { Embedder, VectorStore, SearchResult } from './types.js';
import { searchLog } from './debug.js';

export async function recall(
  query: string,
  embedder: Embedder,
  store: VectorStore,
  k: number = 5,
): Promise<SearchResult[]> {
  searchLog('RECALL', { query, k });
  const [embedding] = await embedder.embed([query]);
  const results = await store.query(embedding!, k);
  searchLog('RECALL RESULTS', results.map(r => ({ id: r.id, score: r.score.toFixed(4), user: r.turnPair.userText?.slice(0, 60) })));
  return results;
}
