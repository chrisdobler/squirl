import { describe, it, expect } from 'vitest';
import { compareResults } from './compare.js';
import type { RunResult, Metrics, CaseRetrieval } from './types.js';

function metrics(over: Partial<Metrics>): Metrics {
  return {
    recallAtK: {}, precisionAtK: {}, hitRateAtK: {}, ndcgAtK: {}, mrr: 0, numCases: 0, ...over,
  };
}

function result(m: Metrics, perCase: CaseRetrieval[] = []): RunResult {
  return {
    config: {
      mode: 'frozen', layer: 1, embedder: { type: 'openai' }, meta: { provider: 'openai', model: 'm' },
      chunk: { includeToolSummary: true, maxChars: 768, template: 'user-assistant' },
      rank: { perQueryK: 8, recallK: 10, filterConversation: true }, ks: [5], label: 'x',
    },
    timestamp: '2026-06-19T00:00:00Z', perCase, metrics: m,
  };
}

describe('compareResults', () => {
  it('reports per-metric deltas with a verdict', () => {
    const before = result(metrics({ recallAtK: { 5: 0.6 }, mrr: 0.5 }));
    const after = result(metrics({ recallAtK: { 5: 0.74 }, mrr: 0.5 }));

    const { deltas } = compareResults(before, after, { ks: [5] });
    const recall = deltas.find((d) => d.metric === 'recall@5')!;
    expect(recall.delta).toBeCloseTo(0.14, 6);
    expect(recall.verdict).toBe('improved');

    const mrr = deltas.find((d) => d.metric === 'mrr')!;
    expect(mrr.verdict).toBe('unchanged');
  });

  it('marks a decreased metric as regressed', () => {
    const before = result(metrics({ recallAtK: { 5: 0.8 } }));
    const after = result(metrics({ recallAtK: { 5: 0.7 } }));
    const { deltas } = compareResults(before, after, { ks: [5] });
    expect(deltas.find((d) => d.metric === 'recall@5')!.verdict).toBe('regressed');
  });

  it('flags per-case recall regressions at the regression cutoff', () => {
    const before = result(metrics({ recallAtK: { 5: 1 } }), [
      { caseId: 'case-x', retrievedIds: ['a', 'b'], relevantIds: ['a'] },
      { caseId: 'case-y', retrievedIds: ['c'], relevantIds: ['c'] },
    ]);
    const after = result(metrics({ recallAtK: { 5: 0.5 } }), [
      { caseId: 'case-x', retrievedIds: ['b', 'c'], relevantIds: ['a'] }, // dropped: a no longer retrieved
      { caseId: 'case-y', retrievedIds: ['c'], relevantIds: ['c'] },       // unchanged
    ]);

    const { regressions } = compareResults(before, after, { ks: [5], regressionK: 5 });
    expect(regressions.map((r) => r.caseId)).toEqual(['case-x']);
    expect(regressions[0]!.before).toBeCloseTo(1, 6);
    expect(regressions[0]!.after).toBeCloseTo(0, 6);
  });
});
