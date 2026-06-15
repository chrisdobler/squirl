import type { VectorStore, EmbeddedChunk, SearchResult, TurnPair } from '../types.js';
import { searchLog } from '../debug.js';

interface ChromaCollection {
  upsert(p: { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Record<string, string>[] }): Promise<void>;
  query(p: { queryEmbeddings: number[][]; nResults: number }): Promise<{ ids: string[][]; distances: number[][]; metadatas: (Record<string, string> | null)[][] }>;
  get(p: { ids: string[] }): Promise<{ ids: string[] }>;
  delete(p: { ids: string[] }): Promise<unknown>;
}

export const DEFAULT_VECTOR_STORE_TIMEOUT_MS = 5_000;
export const VECTOR_DB_TIMEOUT_MESSAGE = 'VectorDB request timed out.';

export class VectorStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'VectorStoreError';
    this.cause = options?.cause;
  }
}

export function isVectorStoreError(err: unknown): err is VectorStoreError {
  return err instanceof VectorStoreError;
}

function isTimeoutLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError'
    || err.name === 'AbortError'
    || /request timed out/i.test(err.message)
    || /timed out/i.test(err.message)
    || /timeout/i.test(err.message);
}

function normalizeVectorStoreError(err: unknown): VectorStoreError {
  if (isVectorStoreError(err)) return err;
  if (isTimeoutLikeError(err)) {
    return new VectorStoreError(VECTOR_DB_TIMEOUT_MESSAGE, { cause: err });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new VectorStoreError(`VectorDB error: ${message}`, { cause: err });
}

export async function withVectorStoreTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new VectorStoreError(VECTOR_DB_TIMEOUT_MESSAGE)), timeoutMs);
      }),
    ]);
  } catch (err) {
    throw normalizeVectorStoreError(err);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ChromaStore implements VectorStore {
  constructor(
    private readonly collection: ChromaCollection,
    private readonly operationTimeoutMs = DEFAULT_VECTOR_STORE_TIMEOUT_MS,
  ) {}

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    searchLog('CHROMA UPSERT', { count: chunks.length, ids: chunks.map(c => c.turnPair.id) });
    await withVectorStoreTimeout(
      this.collection.upsert({
        ids: chunks.map((c) => c.turnPair.id),
        embeddings: chunks.map((c) => c.embedding),
        documents: chunks.map((c) => c.text),
        metadatas: chunks.map((c) => ({ turnPair: JSON.stringify(c.turnPair) })),
      }),
      this.operationTimeoutMs,
    );
    searchLog('CHROMA UPSERT OK');
  }

  async query(embedding: number[], k: number): Promise<SearchResult[]> {
    searchLog('CHROMA QUERY', { dims: embedding.length, k });
    const res = await withVectorStoreTimeout(
      this.collection.query({ queryEmbeddings: [embedding], nResults: k }),
      this.operationTimeoutMs,
    );
    const ids = res.ids[0] ?? [];
    const distances = res.distances[0] ?? [];
    const metadatas = res.metadatas[0] ?? [];
    const results = ids.map((id, i) => ({
      id, score: distances[i] ?? 1,
      turnPair: JSON.parse((metadatas[i] as Record<string, string>)?.turnPair ?? '{}') as TurnPair,
    }));
    searchLog('CHROMA QUERY RESULTS', results.map(r => ({ id: r.id, score: r.score.toFixed(4), user: r.turnPair.userText?.slice(0, 60) })));
    return results;
  }

  async has(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    searchLog('CHROMA HAS', { count: ids.length });
    const res = await withVectorStoreTimeout(
      this.collection.get({ ids }),
      this.operationTimeoutMs,
    );
    searchLog('CHROMA HAS RESULT', { found: res.ids.length });
    return new Set(res.ids);
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    searchLog('CHROMA DELETE', { count: ids.length });
    await withVectorStoreTimeout(
      this.collection.delete({ ids }),
      this.operationTimeoutMs,
    );
    searchLog('CHROMA DELETE OK');
  }

  async close(): Promise<void> {}
}
