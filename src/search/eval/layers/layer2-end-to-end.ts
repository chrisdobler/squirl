import { MemoryPipeline } from '../../memory-pipeline.js';
import type { MetaLLM } from '../../meta-extract.js';
import type { Harness } from '../harness.js';
import { aggregate, relevantIds, type MetricInput } from '../metrics.js';
import type { CaseRetrieval, EvalCase, LayerOutput } from '../types.js';
import { toMessages } from './shared.js';

/**
 * Layer 2 — end-to-end retrieval through the real MemoryPipeline (query extraction + retrieval).
 * In frozen mode the meta-LLM is replaced per-case with a canned LLM returning the gold queries,
 * so the production pipeline runs deterministically. In live mode the real meta-LLM is used.
 */
export async function runLayer2(cases: EvalCase[], harness: Harness): Promise<LayerOutput> {
  const perCase: CaseRetrieval[] = [];
  const items: MetricInput[] = [];

  for (const c of cases) {
    const metaLLM: MetaLLM = harness.mode === 'frozen'
      ? { complete: async () => JSON.stringify(c.goldQueries ?? []) }
      : harness.metaLLM;

    const pipeline = new MemoryPipeline(metaLLM, harness.embedder, harness.store, {
      recallK: harness.config.rank.recallK,
      perQueryK: harness.config.rank.perQueryK,
      filterConversation: harness.config.rank.filterConversation,
    });

    const result = await pipeline.retrieve(toMessages(c.conversation), c.userMessage);
    const retrievedIds = result.results.map((r) => r.id);

    perCase.push({
      caseId: c.id,
      retrievedIds,
      relevantIds: relevantIds(c.qrels),
      queries: harness.mode === 'frozen' ? c.goldQueries : undefined,
    });
    items.push({ retrievedIds, qrels: c.qrels });
  }

  return { perCase, metrics: aggregate(items, harness.config.ks) };
}
