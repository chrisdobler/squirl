import type { ChunkOptions } from '../chunk.js';
import type { EmbedderConfig } from '../embedders/index.js';

/** Graded relevance: corpus turn-pair id -> grade (2 = highly relevant, 1 = relevant; absent = irrelevant). */
export type Qrels = Record<string, number>;

export interface EvalConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One hand-curated evaluation case. */
export interface EvalCase {
  id: string;
  /** Prior conversation context leading up to the triggering turn. */
  conversation: EvalConversationMessage[];
  /** The user turn that should trigger memory retrieval. */
  userMessage: string;
  /** Which corpus turn-pairs are relevant, and how strongly. */
  qrels: Qrels;
  /** Reference search queries — feed Layer 1 deterministically (skip the meta-LLM). */
  goldQueries?: string[];
  /** Facts a correct answer must contain — feed the Layer 3 judge. */
  expectedAnswerNotes?: string;
}

/** Ranking/recall knobs (superset of ranker.RankOptions: also carries the per-query fan-out). */
export interface RankConfig {
  perQueryK: number;
  recallK: number;
  filterConversation: boolean;
}

/** Meta-LLM (query extraction / judge) selection. */
export interface MetaConfig {
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  baseUrl?: string;
}

export type EvalMode = 'frozen' | 'live';
export type EvalLayer = 0 | 1 | 2 | 3;

export interface RunConfig {
  mode: EvalMode;
  layer: EvalLayer;
  embedder: EmbedderConfig;
  meta: MetaConfig;
  chunk: ChunkOptions;
  rank: RankConfig;
  /** @k cutoffs to compute metrics at. */
  ks: number[];
  /** Human label for the report header / result filename. */
  label: string;
}

/** A judge's per-case verdict comparing the with-memory vs without-memory answer. */
export interface CaseVerdict {
  /** Which answer won, normalized back to memory-relative terms. */
  winner: 'with-memory' | 'without-memory' | 'tie';
  scoreWithMemory: number;     // 1-5 correctness vs expectedAnswerNotes
  scoreWithoutMemory: number;  // 1-5
  reason?: string;
}

/** Per-case retrieval outcome, kept in the result file for per-case regression diffing. */
export interface CaseRetrieval {
  caseId: string;
  /** Retrieved corpus ids, best-first. */
  retrievedIds: string[];
  /** Relevant ids (grade >= 1) for this case, for readability. */
  relevantIds: string[];
  /** Queries used (gold for Layer 1; extracted for Layers 0/2). */
  queries?: string[];
  /** Layer 3 only: generated answers and the judge verdict. */
  answerWithMemory?: string;
  answerWithoutMemory?: string;
  verdict?: CaseVerdict;
}

export interface Metrics {
  recallAtK: Record<number, number>;
  precisionAtK: Record<number, number>;
  hitRateAtK: Record<number, number>;
  ndcgAtK: Record<number, number>;
  mrr: number;
  numCases: number;
}

/** Layer 3 answer-quality aggregate (Phase 2). */
export interface JudgeSummary {
  wins: number;
  losses: number;
  ties: number;
  meanScoreWithMemory: number;
  meanScoreWithoutMemory: number;
}

export interface RunResult {
  config: RunConfig;
  timestamp: string;
  perCase: CaseRetrieval[];
  metrics: Metrics;
  judge?: JudgeSummary;
}

/** What a layer returns; the runner wraps it with config + timestamp into a RunResult. */
export interface LayerOutput {
  perCase: CaseRetrieval[];
  metrics: Metrics;
  judge?: JudgeSummary;
}
