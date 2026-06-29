import type { SearchResult } from '../../types.js';
import type { Harness } from '../harness.js';
import { aggregate, relevantIds, type MetricInput } from '../metrics.js';
import type { CaseRetrieval, EvalCase, LayerOutput } from '../types.js';
import { toMessages } from './shared.js';

/**
 * Layer 1 — retrieval given gold queries. Isolates embedder + chunking + ranking
 * (no meta-LLM). Deterministic in frozen mode. Cases without gold queries are skipped.
 */
export async function runLayer1(cases: EvalCase[], harness: Harness): Promise<LayerOutput> {
  const perCase: CaseRetrieval[] = [];
  const items: MetricInput[] = [];

  for (const c of cases) {
    if (!c.goldQueries || c.goldQueries.length === 0) continue;

    const embeddings = await harness.embedder.embed(c.goldQueries);
    const all: SearchResult[] = [];
    for (const embedding of embeddings) {
      all.push(...(await harness.store.query(embedding, harness.config.rank.perQueryK)));
    }
    const ranked = harness.rank(all, toMessages(c.conversation));
    const retrievedIds = ranked.map((r) => r.id);

    perCase.push({ caseId: c.id, retrievedIds, relevantIds: relevantIds(c.qrels), queries: c.goldQueries });
    items.push({ retrievedIds, qrels: c.qrels });
  }

  return { perCase, metrics: aggregate(items, harness.config.ks) };
}
