import type { Message } from '../types.js';
import type { Embedder, VectorStore, SearchResult } from './types.js';
import { extractSearchQueries } from './meta-extract.js';
import type { MetaLLM } from './meta-extract.js';
import { formatMemorySystemMessage, formatMemoryInline } from './memory-format.js';

export interface MemoryPipelineConfig {
  recallK: number;
}

export interface MemoryResult {
  results: SearchResult[];
  systemMessage: string;
  inlineDisplay: string;
}

const PER_QUERY_K = 8;

export class MemoryPipeline {
  constructor(
    private readonly llm: MetaLLM,
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly config: MemoryPipelineConfig,
  ) {}

  async retrieve(conversation: Message[], userMessage: string): Promise<MemoryResult> {
    const empty: MemoryResult = { results: [], systemMessage: '', inlineDisplay: '' };

    const queries = await extractSearchQueries(conversation, userMessage, this.llm);
    if (queries.length === 0) return empty;

    const embeddings = await this.embedder.embed(queries);

    const allResults: SearchResult[] = [];
    for (const embedding of embeddings) {
      const results = await this.store.query(embedding, PER_QUERY_K);
      allResults.push(...results);
    }

    const deduped = new Map<string, SearchResult>();
    for (const r of allResults) {
      const existing = deduped.get(r.id);
      if (!existing || r.score < existing.score) {
        deduped.set(r.id, r);
      }
    }

    const conversationTexts = new Set(
      conversation.filter((m) => m.role === 'user').map((m) => m.content),
    );
    const filtered = [...deduped.values()].filter(
      (r) => !conversationTexts.has(r.turnPair.userText),
    );

    filtered.sort((a, b) => a.score - b.score);
    const topK = filtered.slice(0, this.config.recallK);

    if (topK.length === 0) return empty;

    return {
      results: topK,
      systemMessage: formatMemorySystemMessage(topK),
      inlineDisplay: formatMemoryInline(topK),
    };
  }
}
