import type { Qrels, Metrics } from './types.js';

export const DEFAULT_KS = [1, 3, 5, 8, 10];

/** A doc is relevant if its graded relevance is >= 1. */
export function relevantIds(qrels: Qrels): string[] {
  return Object.keys(qrels).filter((id) => (qrels[id] ?? 0) >= 1);
}

/** Fraction of all relevant docs that appear within the top-k. NaN if the case has no relevant docs. */
export function recallAtK(retrieved: string[], qrels: Qrels, k: number): number {
  const relevant = relevantIds(qrels);
  if (relevant.length === 0) return NaN;
  const topK = new Set(retrieved.slice(0, k));
  const found = relevant.filter((id) => topK.has(id)).length;
  return found / relevant.length;
}

/** Fraction of the top-k that is relevant (always divided by k). */
export function precisionAtK(retrieved: string[], qrels: Qrels, k: number): number {
  const relevant = new Set(relevantIds(qrels));
  const found = retrieved.slice(0, k).filter((id) => relevant.has(id)).length;
  return found / k;
}

/** 1 if any relevant doc is in the top-k, else 0. NaN if the case has no relevant docs. */
export function hitRateAtK(retrieved: string[], qrels: Qrels, k: number): number {
  const relevant = new Set(relevantIds(qrels));
  if (relevant.size === 0) return NaN;
  return retrieved.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

/** 1 / rank of the first relevant doc; 0 if relevant docs exist but none retrieved; NaN if none exist. */
export function reciprocalRank(retrieved: string[], qrels: Qrels): number {
  const relevant = new Set(relevantIds(qrels));
  if (relevant.size === 0) return NaN;
  const idx = retrieved.findIndex((id) => relevant.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
}

/** Graded nDCG@k with log2(rank+1) discount. NaN if the case has no relevant docs (IDCG = 0). */
export function ndcgAtK(retrieved: string[], qrels: Qrels, k: number): number {
  const gradeOf = (id: string) => qrels[id] ?? 0;
  const actual = dcg(retrieved.slice(0, k).map(gradeOf));
  const idealGrades = Object.values(qrels).filter((g) => g >= 1).sort((a, b) => b - a).slice(0, k);
  const ideal = dcg(idealGrades);
  if (ideal === 0) return NaN;
  return actual / ideal;
}

export interface MetricInput {
  retrievedIds: string[];
  qrels: Qrels;
}

function meanIgnoringNaN(values: number[]): number {
  const defined = values.filter((v) => !Number.isNaN(v));
  if (defined.length === 0) return 0;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}

/** Mean each metric across cases at the given k cutoffs, ignoring cases with no relevant docs. */
export function aggregate(items: MetricInput[], ks: number[] = DEFAULT_KS): Metrics {
  const perK = (fn: (i: MetricInput, k: number) => number): Record<number, number> =>
    Object.fromEntries(ks.map((k) => [k, meanIgnoringNaN(items.map((i) => fn(i, k)))]));

  return {
    recallAtK: perK((i, k) => recallAtK(i.retrievedIds, i.qrels, k)),
    precisionAtK: perK((i, k) => precisionAtK(i.retrievedIds, i.qrels, k)),
    hitRateAtK: perK((i, k) => hitRateAtK(i.retrievedIds, i.qrels, k)),
    ndcgAtK: perK((i, k) => ndcgAtK(i.retrievedIds, i.qrels, k)),
    mrr: meanIgnoringNaN(items.map((i) => reciprocalRank(i.retrievedIds, i.qrels))),
    numCases: items.length,
  };
}
