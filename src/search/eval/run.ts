import type { SquirlConfig } from '../../config.js';
import type { EmbedderConfig } from '../embedders/index.js';
import type { SelectedModel } from '../../components/ModelPicker.js';
import type { MetaLLM } from '../meta-extract.js';
import { createMetaLLM } from '../meta-llm.js';
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '../chunk.js';
import { DEFAULT_KS } from './metrics.js';
import { buildHarness } from './harness.js';
import { loadCorpus, loadCases } from './dataset.js';
import { runLayer1 } from './layers/layer1-retrieval.js';
import { runLayer2 } from './layers/layer2-end-to-end.js';
import { runLayer3, type Layer3Progress } from './layers/layer3-answer-quality.js';
import { appendHistory, toHistoryEntry } from './history.js';
import type { EvalLayer, EvalMode, LayerOutput, RunConfig, RunResult } from './types.js';

export type { Layer3Progress };

export interface RunDeps {
  answerModel?: SelectedModel;
  judgeLLM?: MetaLLM;
  /** provider:model label of the judge, for error messages. */
  judgeLabel?: string;
}

export interface ProgressEvent {
  stage: 'load' | 'harness' | 'running' | 'case' | 'done';
  detail?: string;
  /** Present when stage === 'case': structured per-case Layer 3 progress. */
  case?: Layer3Progress;
}

/** Render a Layer 3 per-case progress event as a one-line human-readable string. */
export function formatCaseProgress(p: Layer3Progress): string {
  const head = `[${p.index}/${p.total}] ${p.caseId}`;
  if (p.phase === 'answering') return `${head} · generating answers…`;
  if (p.phase === 'judging') return `${head} · judging…`;
  const v = p.verdict;
  const secs = p.elapsedMs != null ? `  ${(p.elapsedMs / 1000).toFixed(1)}s` : '';
  if (!v) return `${head} · done${secs}`;
  const mark = v.winner === 'with-memory' ? '✓' : v.winner === 'without-memory' ? '✗' : '=';
  return `${head} · ${mark} ${v.winner} (${v.scoreWithMemory} vs ${v.scoreWithoutMemory})${secs}`;
}

/**
 * Core eval execution shared by the CLI runner and the in-app runtime: load the golden set, build the
 * harness, run the requested layer, append a history entry, and return the full result. Layer 3
 * requires answerModel + judgeLLM in deps.
 */
export async function executeEvalRun(
  config: RunConfig,
  deps: RunDeps = {},
  onProgress?: (e: ProgressEvent) => void,
): Promise<RunResult> {
  onProgress?.({ stage: 'load', detail: 'loading golden set…' });
  const [corpus, cases] = await Promise.all([loadCorpus(), loadCases()]);

  onProgress?.({ stage: 'harness', detail: `${corpus.length} corpus, ${cases.length} cases` });
  const harness = await buildHarness(corpus, config);

  onProgress?.({ stage: 'running', detail: `layer ${config.layer} (${config.mode})` });
  let output: LayerOutput;
  if (config.layer === 3) {
    if (!deps.answerModel || !deps.judgeLLM) throw new Error('Layer 3 requires an answer model and a judge LLM.');
    output = await runLayer3(cases, harness, {
      answerModel: deps.answerModel,
      judgeLLM: deps.judgeLLM,
      ...(deps.judgeLabel ? { judgeLabel: deps.judgeLabel } : {}),
      onProgress: (p) => onProgress?.({ stage: 'case', case: p, detail: formatCaseProgress(p) }),
    });
  } else if (config.layer === 1) {
    output = await runLayer1(cases, harness);
  } else if (config.layer === 2) {
    output = await runLayer2(cases, harness);
  } else {
    throw new Error(`Layer ${config.layer} is not available (use 1, 2, or 3).`);
  }

  const result: RunResult = {
    config,
    timestamp: new Date().toISOString(),
    perCase: output.perCase,
    metrics: output.metrics,
    ...(output.judge ? { judge: output.judge } : {}),
  };

  appendHistory(toHistoryEntry(result));
  onProgress?.({ stage: 'done' });
  return result;
}

// ---- squirl-config derivation (shared by CLI overrides and the in-app dashboard) ----

export interface AnswerModelOverrides { provider?: 'openai' | 'anthropic' | 'local'; model?: string; baseUrl?: string; }
export interface JudgeOverrides { provider?: 'openai' | 'anthropic' | 'local'; model?: string; baseUrl?: string; }

/** Answer model for Layer 3 from squirl config (mirrors defaultModelFromConfig), with optional overrides. */
export function answerModelFromSquirl(cfg: SquirlConfig, o: AnswerModelOverrides = {}): SelectedModel {
  const provider = o.provider ?? cfg.defaultProvider ?? 'anthropic';
  const model = o.model ?? cfg.defaultModel
    ?? (provider === 'anthropic' ? 'claude-sonnet-4-6' : provider === 'openai' ? 'gpt-4o' : 'default');
  const baseUrl = o.baseUrl ?? (provider === 'local' ? (cfg.localBaseUrl ?? 'http://localhost:8000/v1') : undefined);
  return { id: model, label: model, provider, ...(baseUrl ? { baseUrl } : {}) };
}

// The judge digests a question + two full answers, so it needs more time than query extraction's 5s.
const JUDGE_TIMEOUT_MS = 60_000;

/** Judge LLM for Layer 3: configured meta provider by default, with optional overrides. */
export function judgeFromSquirl(cfg: SquirlConfig, o: JudgeOverrides = {}): { llm: MetaLLM; provider: string; model: string } {
  const provider = o.provider ?? cfg.index?.metaProvider ?? cfg.defaultProvider ?? 'openai';
  const model = o.model ?? cfg.index?.metaModel
    ?? (provider === 'local' ? (cfg.defaultModel ?? 'default') : 'gpt-4o-mini');
  const baseUrl = o.baseUrl ?? (provider === 'local' ? cfg.localBaseUrl : undefined);
  return { llm: createMetaLLM({ provider, model, timeoutMs: JUDGE_TIMEOUT_MS, ...(baseUrl ? { baseUrl } : {}) }), provider, model };
}

/** Embedder config for the eval from squirl's index settings (so the eval mirrors the live system). */
export function embedderFromSquirl(cfg: SquirlConfig): EmbedderConfig {
  const idx = cfg.index;
  if (idx?.embedder === 'local') {
    return {
      type: 'local',
      ...(idx.embedderModel ? { model: idx.embedderModel } : {}),
      ...(idx.embedderUrl ? { baseUrl: idx.embedderUrl } : {}),
    };
  }
  return { type: 'openai', ...(idx?.embedderModel ? { model: idx.embedderModel } : {}) };
}

export interface EvalRunRequest {
  layer: EvalLayer;
  mode: EvalMode;
  recallK?: number;
  perQueryK?: number;
  filterConversation?: boolean;
  chunk?: Partial<ChunkOptions>;
  ks?: number[];
  label?: string;
}

/** Build a full RunConfig from squirl config + a dashboard request. */
export function evalConfigFromSquirl(cfg: SquirlConfig, req: EvalRunRequest): RunConfig {
  const metaProvider = cfg.index?.metaProvider ?? cfg.defaultProvider ?? 'openai';
  const metaModel = cfg.index?.metaModel ?? (metaProvider === 'local' ? (cfg.defaultModel ?? 'default') : 'gpt-4o-mini');
  return {
    mode: req.mode,
    layer: req.layer,
    embedder: embedderFromSquirl(cfg),
    meta: { provider: metaProvider, model: metaModel, ...(metaProvider === 'local' && cfg.localBaseUrl ? { baseUrl: cfg.localBaseUrl } : {}) },
    chunk: { ...DEFAULT_CHUNK_OPTIONS, ...req.chunk },
    rank: {
      perQueryK: req.perQueryK ?? 8,
      recallK: req.recallK ?? cfg.index?.recallK ?? 10,
      filterConversation: req.filterConversation ?? true,
    },
    ks: req.ks ?? DEFAULT_KS,
    label: req.label ?? `${req.mode}-l${req.layer}`,
  };
}
