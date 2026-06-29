import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';

import type { EmbedderConfig } from '../embedders/index.js';
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '../chunk.js';
import type { MetaLLM } from '../meta-extract.js';
import { loadConfig, applyConfigToEnv } from '../../config.js';
import { DEFAULT_KS } from './metrics.js';
import { buildFixture, fixturePath, embedderName, chunkHashOf, EMBEDDINGS_DIR } from './harness.js';
import { loadCorpus, loadCases, goldQueriesOf } from './dataset.js';
import { executeEvalRun, answerModelFromSquirl, judgeFromSquirl } from './run.js';
import { compareResults } from './compare.js';
import { HISTORY_PATH } from './history.js';
import type { EvalLayer, EvalMode, JudgeSummary, Metrics, RunConfig, RunResult } from './types.js';

const RESULTS_DIR = join(process.cwd(), 'results');

interface RunOpts {
  mode: EvalMode;
  layer: string;
  embedder: string;
  embedderModel?: string;
  embedderUrl?: string;
  ollama?: boolean;
  metaProvider: 'openai' | 'anthropic' | 'local';
  metaModel: string;
  maxChars: string;
  toolSummary: boolean;       // commander --no-tool-summary => false
  template: 'user-assistant' | 'user-only';
  recallK: string;
  perQueryK: string;
  filterConversation: boolean; // commander --no-filter-conversation => false
  ks?: string;
  label: string;
  out?: string;
  // Layer 3 (answer quality)
  answerProvider?: 'openai' | 'anthropic' | 'local';
  answerModel?: string;
  answerUrl?: string;
  judgeProvider?: 'openai' | 'anthropic' | 'local';
  judgeModel?: string;
  judgeUrl?: string;
}

function embedderConfig(o: RunOpts): EmbedderConfig {
  return {
    type: o.embedder === 'local' ? 'local' : 'openai',
    ...(o.embedderModel ? { model: o.embedderModel } : {}),
    ...(o.embedderUrl ? { baseUrl: o.embedderUrl } : {}),
    ...(o.ollama ? { detectedBackend: 'ollama' as const } : {}),
  };
}

function chunkConfig(o: RunOpts): ChunkOptions {
  return {
    includeToolSummary: o.toolSummary,
    maxChars: parseInt(o.maxChars, 10),
    template: o.template,
  };
}

function buildConfig(o: RunOpts, mode: EvalMode): RunConfig {
  return {
    mode,
    layer: parseInt(o.layer, 10) as EvalLayer,
    embedder: embedderConfig(o),
    // A local meta-LLM shares the local gateway URL; a remote one (openai/anthropic) must not.
    meta: { provider: o.metaProvider, model: o.metaModel, ...(o.metaProvider === 'local' && o.embedderUrl ? { baseUrl: o.embedderUrl } : {}) },
    chunk: chunkConfig(o),
    rank: {
      perQueryK: parseInt(o.perQueryK, 10),
      recallK: parseInt(o.recallK, 10),
      filterConversation: o.filterConversation,
    },
    ks: o.ks ? o.ks.split(',').map((s) => parseInt(s.trim(), 10)) : DEFAULT_KS,
    label: o.label,
  };
}

function fmt(n: number): string {
  return Number.isNaN(n) ? '  n/a' : n.toFixed(3);
}

function printMetrics(metrics: Metrics, ks: number[]): void {
  console.log(`\ncases: ${metrics.numCases}   mrr: ${fmt(metrics.mrr)}`);
  console.log('  k    recall  precision   ndcg    hit');
  for (const k of ks) {
    console.log(
      `  ${String(k).padStart(2)}   ${fmt(metrics.recallAtK[k] ?? NaN)}     ${fmt(metrics.precisionAtK[k] ?? NaN)}   ` +
      `${fmt(metrics.ndcgAtK[k] ?? NaN)}  ${fmt(metrics.hitRateAtK[k] ?? NaN)}`,
    );
  }
}

function printJudge(judge: JudgeSummary): void {
  const total = judge.wins + judge.losses + judge.ties;
  const pct = total ? ((judge.wins / total) * 100).toFixed(0) : '0';
  console.log(`\nanswer quality (memory on vs off): ${judge.wins}W / ${judge.losses}L / ${judge.ties}T  (memory win-rate ${pct}%)`);
  console.log(`  mean correctness  with memory: ${fmt(judge.meanScoreWithMemory)}   without: ${fmt(judge.meanScoreWithoutMemory)}  (1-5)`);
}

async function runCmd(o: RunOpts): Promise<void> {
  const config = buildConfig(o, o.mode);
  console.log(`Running layer ${config.layer} (${config.mode}) "${config.label}"`);

  const deps: { answerModel?: ReturnType<typeof answerModelFromSquirl>; judgeLLM?: MetaLLM; judgeLabel?: string } = {};
  if (config.layer === 3) {
    const cfg = loadConfig();
    applyConfigToEnv(cfg); // ensure API keys are set for the answer + judge calls
    const answerModel = answerModelFromSquirl(cfg, { provider: o.answerProvider, model: o.answerModel, baseUrl: o.answerUrl });
    const judge = judgeFromSquirl(cfg, { provider: o.judgeProvider, model: o.judgeModel, baseUrl: o.judgeUrl });
    console.log(`  answer model: ${answerModel.provider}:${answerModel.id}   judge: ${judge.provider}:${judge.model}`);
    deps.answerModel = answerModel;
    deps.judgeLLM = judge.llm;
    deps.judgeLabel = `${judge.provider}:${judge.model}`;
  }

  const result = await executeEvalRun(config, deps, (e) => {
    if (e.stage === 'harness') console.log(`  ${e.detail}`);
    else if (e.stage === 'case' && e.detail) console.log(`  ${e.detail}`);
  });

  printMetrics(result.metrics, config.ks);
  if (result.judge) printJudge(result.judge);

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = result.timestamp.replace(/[:.]/g, '-');
  const out = o.out ?? join(RESULTS_DIR, `${config.label}-layer${config.layer}-${config.mode}-${stamp}.json`);
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
  console.log(`appended to ${HISTORY_PATH}`);
}

async function refreshCmd(o: RunOpts): Promise<void> {
  const config = buildConfig(o, 'live');
  const [corpus, cases] = await Promise.all([loadCorpus(), loadCases()]);
  console.log(`Refreshing fixture: embedder ${o.embedder}, ${corpus.length} corpus, ${goldQueriesOf(cases).length} gold queries`);

  const fixture = await buildFixture(corpus, goldQueriesOf(cases), config);
  await mkdir(EMBEDDINGS_DIR, { recursive: true });
  const path = fixturePath(embedderName(config.embedder), chunkHashOf(config.chunk));
  await writeFile(path, JSON.stringify(fixture));
  console.log(`wrote ${path}\n  embedder=${fixture.embedder} dims=${fixture.dimensions} chunkHash=${fixture.chunkHash}`);
  console.log(`  corpus vectors=${Object.keys(fixture.corpus).length} query vectors=${Object.keys(fixture.queries).length}`);
}

async function compareCmd(beforePath: string, afterPath: string, o: { ks?: string }): Promise<void> {
  const before = JSON.parse(await readFile(beforePath, 'utf8')) as RunResult;
  const after = JSON.parse(await readFile(afterPath, 'utf8')) as RunResult;
  const ks = o.ks ? o.ks.split(',').map((s) => parseInt(s.trim(), 10)) : after.config.ks;

  const { deltas, regressions } = compareResults(before, after, { ks });

  console.log(`\n${before.config.label} → ${after.config.label}\n`);
  console.log('metric        before    after      Δ      verdict');
  for (const d of deltas) {
    const sign = d.delta >= 0 ? '+' : '';
    console.log(
      `${d.metric.padEnd(12)}  ${fmt(d.before)}    ${fmt(d.after)}   ${(sign + d.delta.toFixed(3)).padStart(7)}   ${d.verdict}`,
    );
  }

  if (regressions.length === 0) {
    console.log('\nno per-case recall regressions');
  } else {
    console.log(`\nper-case regressions (${regressions[0]!.metric}):`);
    for (const r of regressions) console.log(`  ${r.caseId}: ${fmt(r.before)} → ${fmt(r.after)}`);
  }
}

const program = new Command();
program.name('eval').description('squirl memory-system evaluation harness');

program.command('run')
  .description('Run an eval layer and write a result file')
  .option('--mode <mode>', 'frozen | live', 'frozen')
  .option('--layer <n>', 'eval layer (1 = retrieval, 2 = end-to-end, 3 = answer quality)', '1')
  .option('--embedder <kind>', 'openai | local', 'openai')
  .option('--embedder-model <model>')
  .option('--embedder-url <url>')
  .option('--ollama', 'treat the local embedder as Ollama')
  .option('--meta-provider <p>', 'openai | anthropic | local', 'openai')
  .option('--meta-model <m>', 'meta-LLM model (query extraction)', 'gpt-4o-mini')
  .option('--max-chars <n>', 'chunk truncation', String(DEFAULT_CHUNK_OPTIONS.maxChars))
  .option('--no-tool-summary', 'exclude tool summary from embedded text')
  .option('--template <t>', 'user-assistant | user-only', 'user-assistant')
  .option('--recallK <n>', 'final top-K', '10')
  .option('--perQueryK <n>', 'results per query before ranking', '8')
  .option('--no-filter-conversation', 'keep current-conversation pairs')
  .option('--ks <list>', 'comma-separated @k cutoffs')
  .option('--label <label>', 'run label', 'baseline')
  .option('--out <path>', 'result output path')
  // Layer 3 (answer quality) — default to squirl config; judge defaults to the configured meta provider
  .option('--answer-provider <p>', 'layer 3 answer model provider (openai|anthropic|local)')
  .option('--answer-model <m>', 'layer 3 answer model')
  .option('--answer-url <url>', 'layer 3 answer model base URL (local)')
  .option('--judge-provider <p>', 'layer 3 judge provider (default: configured meta provider)')
  .option('--judge-model <m>', 'layer 3 judge model (overrides config meta model)')
  .option('--judge-url <url>', 'layer 3 judge base URL (local)')
  .action(runCmd);

program.command('refresh')
  .description('Live-embed the corpus + gold queries into a committable frozen fixture')
  .option('--embedder <kind>', 'openai | local', 'openai')
  .option('--embedder-model <model>')
  .option('--embedder-url <url>')
  .option('--ollama', 'treat the local embedder as Ollama')
  .option('--max-chars <n>', 'chunk truncation', String(DEFAULT_CHUNK_OPTIONS.maxChars))
  .option('--no-tool-summary', 'exclude tool summary from embedded text')
  .option('--template <t>', 'user-assistant | user-only', 'user-assistant')
  // unused-by-refresh defaults so buildConfig is happy:
  .option('--layer <n>', '', '1').option('--meta-provider <p>', '', 'openai').option('--meta-model <m>', '', 'gpt-4o-mini')
  .option('--recallK <n>', '', '10').option('--perQueryK <n>', '', '8').option('--label <l>', '', 'refresh')
  .action(refreshCmd);

program.command('compare')
  .description('Diff two result files: metric deltas + per-case regressions')
  .argument('<before>', 'baseline result JSON')
  .argument('<after>', 'changed result JSON')
  .option('--ks <list>', 'comma-separated @k cutoffs')
  .action(compareCmd);

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
