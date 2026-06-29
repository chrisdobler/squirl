import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Embedder, SearchResult, TurnPair, VectorStore } from '../types.js';
import type { Message } from '../../types.js';
import type { MetaLLM } from '../meta-extract.js';
import type { ChunkOptions } from '../chunk.js';
import { buildChunkText } from '../chunk.js';
import { rankResults } from '../ranker.js';
import { createEmbedder, type EmbedderConfig } from '../embedders/index.js';
import { createMetaLLM } from '../meta-llm.js';
import { InMemoryVectorStore } from './memory-store.js';
import type { RunConfig } from './types.js';

export { createMetaLLM };

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, 'fixtures');
export const EMBEDDINGS_DIR = join(FIXTURES_DIR, 'embeddings');

export interface EmbeddingFixture {
  embedder: string;
  dimensions: number;
  chunkOptions: ChunkOptions;
  chunkHash: string;
  corpus: Record<string, number[]>;
  queries: Record<string, number[]>;
}

export interface Harness {
  mode: 'frozen' | 'live';
  config: RunConfig;
  embedder: Embedder;
  store: VectorStore;
  metaLLM: MetaLLM;
  chunkText: (pair: TurnPair) => string;
  rank: (allResults: SearchResult[], conversation: Message[]) => SearchResult[];
}

// Stable hash over the chunk options that affect embedded text. Keys listed explicitly for order-stability.
export function chunkHashOf(c: ChunkOptions): string {
  const canonical = { includeToolSummary: c.includeToolSummary, maxChars: c.maxChars, template: c.template };
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 8);
}

// Mirrors OpenAIEmbedder/OllamaEmbedder `name` so frozen lookups match refresh-time filenames.
export function embedderName(cfg: EmbedderConfig): string {
  if (cfg.detectedBackend === 'ollama') return `ollama:${cfg.model ?? 'nomic-embed-text'}`;
  return `openai:${cfg.model ?? 'text-embedding-3-small'}`;
}

export function fixturePath(name: string, chunkHash: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(EMBEDDINGS_DIR, `${safe}__${chunkHash}.json`);
}

/** Embedder backed entirely by cached query vectors; throws on a cache miss so stale fixtures can't slip through. */
class CachedEmbedder implements Embedder {
  constructor(
    readonly name: string,
    readonly dimensions: number,
    private readonly vectors: Record<string, number[]>,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = this.vectors[t];
      if (!v) {
        throw new Error(
          `Frozen embedder has no cached vector for query ${JSON.stringify(t.slice(0, 80))}. ` +
          'Run `refresh` to rebuild the embedding fixture.',
        );
      }
      return v;
    });
  }
}

function bind(config: RunConfig) {
  return {
    chunkText: (pair: TurnPair) => buildChunkText(pair, config.chunk),
    rank: (allResults: SearchResult[], conversation: Message[]) =>
      rankResults(allResults, conversation, { recallK: config.rank.recallK, filterConversation: config.rank.filterConversation }),
  };
}

/** Build a deterministic harness from an already-loaded fixture (pure; no I/O). */
export function frozenHarness(corpus: TurnPair[], fixture: EmbeddingFixture, config: RunConfig): Harness {
  const embedder = new CachedEmbedder(fixture.embedder, fixture.dimensions, fixture.queries);
  const store = new InMemoryVectorStore();
  const chunks = corpus.map((pair) => {
    const embedding = fixture.corpus[pair.id];
    if (!embedding) {
      throw new Error(`Fixture ${fixture.embedder} is missing a vector for corpus id "${pair.id}". Run \`refresh\`.`);
    }
    return { turnPair: pair, embedding, text: buildChunkText(pair, config.chunk) };
  });
  void store.upsert(chunks);
  // Frozen mode never calls the meta-LLM via the harness; Layer 2 injects a per-case canned LLM.
  const metaLLM: MetaLLM = { complete: async () => '[]' };
  return { mode: 'frozen', config, embedder, store, metaLLM, ...bind(config) };
}

const BATCH = 16;
async function embedBatched(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await embedder.embed(texts.slice(i, i + BATCH))));
  }
  return out;
}

/** Build a live harness: real embedder over a freshly-embedded corpus, real meta-LLM. */
export async function liveHarness(corpus: TurnPair[], config: RunConfig): Promise<Harness> {
  const embedder = createEmbedder(config.embedder);
  const store = new InMemoryVectorStore();
  const texts = corpus.map((pair) => buildChunkText(pair, config.chunk));
  const embeddings = await embedBatched(embedder, texts);
  await store.upsert(corpus.map((pair, i) => ({ turnPair: pair, embedding: embeddings[i]!, text: texts[i]! })));
  return { mode: 'live', config, embedder, store, metaLLM: createMetaLLM(config.meta), ...bind(config) };
}

export async function loadFixture(config: RunConfig): Promise<EmbeddingFixture> {
  const name = embedderName(config.embedder);
  const hash = chunkHashOf(config.chunk);
  const path = fixturePath(name, hash);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `No frozen embedding fixture for embedder "${name}" + chunk ${hash} at:\n  ${path}\n` +
      'Run: npm run eval:refresh (or the runner `refresh` command) to generate it.',
    );
  }
  const fixture = JSON.parse(raw) as EmbeddingFixture;
  if (fixture.embedder !== name) {
    throw new Error(`Fixture embedder mismatch: file has "${fixture.embedder}", config expects "${name}".`);
  }
  return fixture;
}

/** Build a frozen or live harness per the run config. */
export async function buildHarness(corpus: TurnPair[], config: RunConfig): Promise<Harness> {
  if (config.mode === 'frozen') return frozenHarness(corpus, await loadFixture(config), config);
  return liveHarness(corpus, config);
}

/** Embed the corpus + all gold queries with the real embedder to produce a committable fixture. */
export async function buildFixture(corpus: TurnPair[], goldQueries: string[], config: RunConfig): Promise<EmbeddingFixture> {
  const embedder = createEmbedder(config.embedder);
  const corpusTexts = corpus.map((pair) => buildChunkText(pair, config.chunk));
  const corpusVecs = await embedBatched(embedder, corpusTexts);
  const uniqueQueries = [...new Set(goldQueries)];
  const queryVecs = await embedBatched(embedder, uniqueQueries);
  return {
    embedder: embedder.name,
    dimensions: corpusVecs[0]?.length ?? embedder.dimensions,
    chunkOptions: config.chunk,
    chunkHash: chunkHashOf(config.chunk),
    corpus: Object.fromEntries(corpus.map((pair, i) => [pair.id, corpusVecs[i]!])),
    queries: Object.fromEntries(uniqueQueries.map((q, i) => [q, queryVecs[i]!])),
  };
}
