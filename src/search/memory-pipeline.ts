import type { Message } from '../types.js';
import type { Embedder, VectorStore, SearchResult } from './types.js';
import { classifyTurnIntent } from './meta-extract.js';
import type { TurnIntentClassification, TurnIntentObservation } from './meta-extract.js';
import type { MetaLLM } from './meta-extract.js';
import { formatMemorySystemMessage, formatMemoryInline } from './memory-format.js';
import { rankResults } from './ranker.js';
import { searchLog } from './debug.js';
import type { QueryPipelineStage } from '../pipeline-status.js';

export interface MemoryPipelineConfig {
  recallK: number;
  /** Results requested per extracted query before dedup/ranking. Defaults to 8. */
  perQueryK?: number;
  /** Drop results already present in the current conversation. Defaults to true. */
  filterConversation?: boolean;
  /** Only recent direct messages can duplicate the live prompt in a rolling room. */
  filterRecentMessages?: number;
}

export interface MemoryResult {
  results: SearchResult[];
  systemMessage: string;
  inlineDisplay: string;
  queries: string[];
}

const PER_QUERY_K = 8;

export class MemoryPipeline {
  constructor(
    private readonly llm: MetaLLM,
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly config: MemoryPipelineConfig,
  ) {}

  async retrieve(
    conversation: Message[],
    userMessage: string,
    onStatus?: (stage: QueryPipelineStage) => void,
    intent?: TurnIntentClassification,
    observeIntent?: (observation: TurnIntentObservation) => void,
    explicitQueries?: string[],
  ): Promise<MemoryResult> {
    const empty: MemoryResult = { results: [], systemMessage: '', inlineDisplay: '', queries: [] };

    onStatus?.('memory-query');
    const queries = explicitQueries?.length
      ? explicitQueries
      : (intent ?? await classifyTurnIntent(conversation, userMessage, this.llm, observeIntent)).memoryQueries;
    searchLog('MEMORY QUERIES', queries);
    if (queries.length === 0) return empty;

    onStatus?.('memory-embed');
    const embeddings = await this.embedder.embed(queries);

    const allResults: SearchResult[] = [];
    onStatus?.('vectordb');
    const perQueryK = this.config.perQueryK ?? PER_QUERY_K;
    for (const embedding of embeddings) {
      const results = await this.store.query(embedding, perQueryK);
      allResults.push(...results);
    }

    const filterConversation = this.config.filterConversation ?? true;
    const filterMessages = filterConversation && this.config.filterRecentMessages
      ? conversation.slice(-this.config.filterRecentMessages)
      : conversation;
    const topK = rankResults(allResults, filterMessages, {
      recallK: this.config.recallK,
      filterConversation,
    });
    searchLog('MEMORY RESULTS', { total: allResults.length, topK: topK.length });

    if (topK.length === 0) return empty;

    return {
      results: topK,
      systemMessage: formatMemorySystemMessage(topK),
      inlineDisplay: formatMemoryInline(topK),
      queries,
    };
  }

  classify(conversation: Message[], userMessage: string, observe?: (observation: TurnIntentObservation) => void): Promise<TurnIntentClassification> {
    return classifyTurnIntent(conversation, userMessage, this.llm, observe);
  }
}
