import { MemoryPipeline } from '../../memory-pipeline.js';
import type { MetaLLM } from '../../meta-extract.js';
import type { SelectedModel } from '../../../components/ModelPicker.js';
import type { Harness } from '../harness.js';
import { aggregate, relevantIds, type MetricInput } from '../metrics.js';
import { generateAnswer, type GenerateAnswerParams } from '../answer.js';
import { judgeCase, aggregateVerdicts } from '../judge.js';
import type { CaseRetrieval, CaseVerdict, EvalCase, LayerOutput } from '../types.js';
import { toMessages } from './shared.js';

export const DEFAULT_ANSWER_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer the user concisely, using any provided context.';

/** Per-case progress emitted during a Layer 3 run so callers can show live, step-by-step status. */
export interface Layer3Progress {
  index: number;   // 1-based, over judged cases only
  total: number;   // number of judged cases (those with expectedAnswerNotes)
  caseId: string;
  phase: 'answering' | 'judging' | 'done';
  elapsedMs?: number;      // set on 'done': wall time for this case
  verdict?: CaseVerdict;   // set on 'done'
}

export interface Layer3Deps {
  answerModel: SelectedModel;
  judgeLLM: MetaLLM;
  /** Injectable for tests; defaults to the real streaming answer generator. */
  generate?: (params: GenerateAnswerParams) => Promise<string>;
  /** Base system prompt for the answer model (the memory message is layered on top). */
  baseSystemPrompt?: string;
  /** Human label (provider:model) of the judge, for error messages. */
  judgeLabel?: string;
  /** Live per-case progress (each slow step), so the CLI / UI can show what's running. */
  onProgress?: (p: Layer3Progress) => void;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Layer 3 — answer correctness. For each case with expectedAnswerNotes: retrieve memory (frozen or
 * live, via the real MemoryPipeline), generate an answer WITH and WITHOUT the memory system message,
 * and have the judge score which is more correct. Reports retrieval metrics plus a JudgeSummary.
 */
export async function runLayer3(cases: EvalCase[], harness: Harness, deps: Layer3Deps): Promise<LayerOutput> {
  const generate = deps.generate ?? generateAnswer;
  const baseSystemPrompt = deps.baseSystemPrompt ?? DEFAULT_ANSWER_SYSTEM_PROMPT;

  const perCase: CaseRetrieval[] = [];
  const items: MetricInput[] = [];
  const verdicts: CaseVerdict[] = [];

  // Only cases with a correctness reference are judged; knowing the count up front lets us report N/total.
  const judged = cases.filter((c) => c.expectedAnswerNotes);
  const total = judged.length;

  for (let i = 0; i < judged.length; i++) {
    const c = judged[i]!;
    const index = i + 1;
    const caseStart = Date.now();

    const metaLLM: MetaLLM = harness.mode === 'frozen'
      ? { complete: async () => JSON.stringify(c.goldQueries ?? []) }
      : harness.metaLLM;

    const pipeline = new MemoryPipeline(metaLLM, harness.embedder, harness.store, {
      recallK: harness.config.rank.recallK,
      perQueryK: harness.config.rank.perQueryK,
      filterConversation: harness.config.rank.filterConversation,
    });

    const conversation = toMessages(c.conversation);
    const retrieval = await pipeline.retrieve(conversation, c.userMessage);
    const retrievedIds = retrieval.results.map((r) => r.id);

    const answerLabel = `${deps.answerModel.provider}:${deps.answerModel.id}`;
    deps.onProgress?.({ index, total, caseId: c.id, phase: 'answering' });
    let answerWithMemory: string;
    let answerWithoutMemory: string;
    try {
      [answerWithMemory, answerWithoutMemory] = await Promise.all([
        generate({ model: deps.answerModel, systemMessages: [baseSystemPrompt, retrieval.systemMessage], conversation: c.conversation, userMessage: c.userMessage }),
        generate({ model: deps.answerModel, systemMessages: [baseSystemPrompt], conversation: c.conversation, userMessage: c.userMessage }),
      ]);
    } catch (err) {
      throw new Error(
        `Layer 3 answer model ${answerLabel} failed on case "${c.id}": ${describeError(err)}. ` +
        `Is the chat model served${deps.answerModel.baseUrl ? ` at ${deps.answerModel.baseUrl}` : ''}? (Layer 3 needs a chat model, not just the embedder.)`,
      );
    }

    let verdict;
    try {
      deps.onProgress?.({ index, total, caseId: c.id, phase: 'judging' });
      verdict = await judgeCase({
        caseId: c.id,
        userMessage: c.userMessage,
        expectedAnswerNotes: c.expectedAnswerNotes!,
        answerWithMemory,
        answerWithoutMemory,
        llm: deps.judgeLLM,
      });
    } catch (err) {
      throw new Error(
        `Layer 3 judge ${deps.judgeLabel ?? '(meta provider)'} failed on case "${c.id}": ${describeError(err)}. ` +
        'Is the judge chat model reachable?',
      );
    }

    perCase.push({ caseId: c.id, retrievedIds, relevantIds: relevantIds(c.qrels), answerWithMemory, answerWithoutMemory, verdict });
    items.push({ retrievedIds, qrels: c.qrels });
    verdicts.push(verdict);
    deps.onProgress?.({ index, total, caseId: c.id, phase: 'done', elapsedMs: Date.now() - caseStart, verdict });
  }

  return { perCase, metrics: aggregate(items, harness.config.ks), judge: aggregateVerdicts(verdicts) };
}
