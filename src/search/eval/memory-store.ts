import type { EmbeddedChunk, SearchResult, VectorStore } from '../types.js';

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine distance: 0 (identical) → 1 (orthogonal) → 2 (opposite). Matches "lower = more similar". */
export function cosineDistance(a: number[], b: number[]): number {
  const denom = norm(a) * norm(b);
  if (denom === 0) return 1;
  return 1 - dot(a, b) / denom;
}

/**
 * Brute-force in-memory VectorStore for the eval harness. Deterministic, no network.
 * Scores by cosine distance so frozen-mode rankings are stable and CI-friendly.
 */
export class InMemoryVectorStore implements VectorStore {
  private chunks = new Map<string, EmbeddedChunk>();

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    for (const c of chunks) this.chunks.set(c.turnPair.id, c);
  }

  async query(embedding: number[], k: number): Promise<SearchResult[]> {
    const scored: SearchResult[] = [...this.chunks.values()].map((c) => ({
      id: c.turnPair.id,
      score: cosineDistance(embedding, c.embedding),
      turnPair: c.turnPair,
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, k);
  }

  async has(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.chunks.has(id)));
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.chunks.delete(id);
  }

  async close(): Promise<void> {}
}
