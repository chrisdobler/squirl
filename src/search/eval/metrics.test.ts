import { describe, it, expect } from 'vitest';
import {
  recallAtK, precisionAtK, hitRateAtK, reciprocalRank, ndcgAtK, aggregate, DEFAULT_KS,
  type MetricInput,
} from './metrics.js';
import type { Qrels } from './types.js';

const qrels: Qrels = { a: 2, c: 1, d: 1 }; // 3 relevant docs

describe('recallAtK', () => {
  it('is fraction of all relevant docs found within top-k', () => {
    const retrieved = ['a', 'b', 'c', 'e'];
    expect(recallAtK(retrieved, qrels, 2)).toBeCloseTo(1 / 3, 6); // only a
    expect(recallAtK(retrieved, qrels, 3)).toBeCloseTo(2 / 3, 6); // a, c
    expect(recallAtK(retrieved, qrels, 10)).toBeCloseTo(2 / 3, 6); // d never retrieved
  });

  it('returns NaN when the case has no relevant docs', () => {
    expect(Number.isNaN(recallAtK(['a', 'b'], {}, 5))).toBe(true);
  });
});

describe('precisionAtK', () => {
  it('is fraction of top-k that is relevant', () => {
    const retrieved = ['a', 'b', 'c'];
    expect(precisionAtK(retrieved, qrels, 2)).toBeCloseTo(1 / 2, 6);
    expect(precisionAtK(retrieved, qrels, 3)).toBeCloseTo(2 / 3, 6);
  });

  it('divides by k even when fewer than k retrieved', () => {
    expect(precisionAtK(['a'], qrels, 5)).toBeCloseTo(1 / 5, 6);
  });
});

describe('hitRateAtK', () => {
  it('is 1 if any relevant doc is in top-k, else 0', () => {
    expect(hitRateAtK(['a', 'b'], qrels, 1)).toBe(1);
    expect(hitRateAtK(['b', 'a'], qrels, 1)).toBe(0);
    expect(hitRateAtK(['b', 'a'], qrels, 2)).toBe(1);
  });

  it('returns NaN when the case has no relevant docs', () => {
    expect(Number.isNaN(hitRateAtK(['a'], {}, 5))).toBe(true);
  });
});

describe('reciprocalRank', () => {
  it('is 1 / rank of the first relevant doc', () => {
    expect(reciprocalRank(['b', 'a', 'c'], qrels)).toBeCloseTo(1 / 2, 6);
    expect(reciprocalRank(['a', 'b'], qrels)).toBe(1);
  });

  it('is 0 when no relevant doc is retrieved', () => {
    expect(reciprocalRank(['x', 'y'], qrels)).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('uses graded relevance with log2(rank+1) discount', () => {
    // qrels {a:2, c:1}; retrieved [a,b,c]
    // DCG@3 = 2/log2(2) + 0 + 1/log2(4) = 2 + 0.5 = 2.5
    // IDCG@3 = 2/log2(2) + 1/log2(3) = 2 + 0.630930 = 2.630930
    // nDCG = 2.5 / 2.630930 = 0.950235
    expect(ndcgAtK(['a', 'b', 'c'], { a: 2, c: 1 }, 3)).toBeCloseTo(0.950235, 5);
  });

  it('is 1.0 for an ideal ranking', () => {
    expect(ndcgAtK(['a', 'c', 'd'], qrels, 3)).toBeCloseTo(1, 6);
  });

  it('returns NaN when the case has no relevant docs', () => {
    expect(Number.isNaN(ndcgAtK(['a'], {}, 5))).toBe(true);
  });
});

describe('aggregate', () => {
  it('means each metric over cases, ignoring NaN (no-relevant) cases', () => {
    const items: MetricInput[] = [
      { retrievedIds: ['a', 'b', 'c'], qrels: { a: 2, c: 1 } }, // recall@3 = 1
      { retrievedIds: ['x', 'y', 'z'], qrels: { a: 1 } },        // recall@3 = 0
      { retrievedIds: ['x'], qrels: {} },                        // NaN → excluded
    ];
    const m = aggregate(items, [3]);
    expect(m.numCases).toBe(3);
    expect(m.recallAtK[3]).toBeCloseTo((1 + 0) / 2, 6); // averaged over 2 defined cases
    expect(m.mrr).toBeCloseTo((1 + 0) / 2, 6);
  });

  it('exposes default k cutoffs', () => {
    expect(DEFAULT_KS).toEqual([1, 3, 5, 8, 10]);
  });
});
