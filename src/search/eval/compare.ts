import type { RunResult } from './types.js';

export type Verdict = 'improved' | 'regressed' | 'unchanged';

export interface MetricDelta {
  metric: string;
  before: number;
  after: number;
  delta: number;
  verdict: Verdict;
}

export interface CaseRegression {
  caseId: string;
  metric: string;
  before: number;
  after: number;
}

export interface Comparison {
  deltas: MetricDelta[];
  regressions: CaseRegression[];
}

const EPS = 1e-9;

function verdictOf(delta: number): Verdict {
  if (delta > EPS) return 'improved';
  if (delta < -EPS) return 'regressed';
  return 'unchanged';
}

function row(metric: string, before: number, after: number): MetricDelta {
  const delta = after - before;
  return { metric, before, after, delta, verdict: verdictOf(delta) };
}

/** Binary recall@k computed from retrieved ids + the relevant set (grade >= 1). NaN if no relevant. */
function caseRecall(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) return NaN;
  const topK = new Set(retrievedIds.slice(0, k));
  return relevantIds.filter((id) => topK.has(id)).length / relevantIds.length;
}

export interface CompareOptions {
  ks: number[];
  /** Per-case recall cutoff used for regression detection. Defaults to the largest k. */
  regressionK?: number;
}

/** Diff two runs: per-metric deltas (with verdicts) and a list of per-case recall regressions. */
export function compareResults(before: RunResult, after: RunResult, opts: CompareOptions): Comparison {
  const { ks } = opts;
  const regressionK = opts.regressionK ?? Math.max(...ks);

  const deltas: MetricDelta[] = [];
  for (const k of ks) deltas.push(row(`recall@${k}`, before.metrics.recallAtK[k] ?? 0, after.metrics.recallAtK[k] ?? 0));
  deltas.push(row('mrr', before.metrics.mrr, after.metrics.mrr));
  for (const k of ks) deltas.push(row(`ndcg@${k}`, before.metrics.ndcgAtK[k] ?? 0, after.metrics.ndcgAtK[k] ?? 0));
  for (const k of ks) deltas.push(row(`precision@${k}`, before.metrics.precisionAtK[k] ?? 0, after.metrics.precisionAtK[k] ?? 0));
  for (const k of ks) deltas.push(row(`hit@${k}`, before.metrics.hitRateAtK[k] ?? 0, after.metrics.hitRateAtK[k] ?? 0));

  const beforeByCase = new Map(before.perCase.map((p) => [p.caseId, p]));
  const regressions: CaseRegression[] = [];
  for (const a of after.perCase) {
    const b = beforeByCase.get(a.caseId);
    if (!b) continue;
    const rb = caseRecall(b.retrievedIds, b.relevantIds, regressionK);
    const ra = caseRecall(a.retrievedIds, a.relevantIds, regressionK);
    if (!Number.isNaN(rb) && !Number.isNaN(ra) && ra < rb - EPS) {
      regressions.push({ caseId: a.caseId, metric: `recall@${regressionK}`, before: rb, after: ra });
    }
  }

  return { deltas, regressions };
}
