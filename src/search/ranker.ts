import type { Message } from '../types.js';
import type { SearchResult } from './types.js';

export interface RankOptions {
  /** Final number of results to keep after ranking. */
  recallK: number;
  /** Drop results whose userText exactly matches a user turn already in the conversation. */
  filterConversation: boolean;
}

/**
 * Collapse per-query search results into a ranked top-K:
 * dedup by id (best score wins) → optionally filter current-conversation pairs →
 * sort ascending by score (lower = more similar) → take recallK.
 */
export function rankResults(
  allResults: SearchResult[],
  conversation: Message[],
  opts: RankOptions,
): SearchResult[] {
  const deduped = new Map<string, SearchResult>();
  for (const r of allResults) {
    const existing = deduped.get(r.id);
    if (!existing || r.score < existing.score) deduped.set(r.id, r);
  }

  let values = [...deduped.values()];
  if (opts.filterConversation) {
    const conversationIds = new Set(conversation.map((message) => message.id));
    const conversationTexts = new Set(
      conversation.filter((m) => m.role === 'user').map((m) => m.content),
    );
    values = values.filter((r) => r.turnPair.sourceMessageId
      ? !conversationIds.has(r.turnPair.sourceMessageId)
      : !conversationTexts.has(r.turnPair.userText));
  }

  values.sort((a, b) => a.score - b.score);
  return values.slice(0, opts.recallK);
}
