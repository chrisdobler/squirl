import { describe, it, expect } from 'vitest';
import { rankResults } from './ranker.js';
import type { SearchResult, TurnPair } from './types.js';
import type { Message } from '../types.js';

const tp = (id: string, userText: string): TurnPair => ({
  id, source: 'squirl', conversationId: 'c1', timestamp: '2026-04-10T12:00:00Z',
  userText, assistantText: 'answer for ' + id,
});

const sr = (id: string, userText: string, score: number): SearchResult => ({
  id, score, turnPair: tp(id, userText),
});

const userMsg = (content: string): Message => ({ id: 'm-' + content, role: 'user', content });

// Reference copy of the original inline MemoryPipeline.retrieve ranking (lines 51-67).
function oldRank(allResults: SearchResult[], conversation: Message[], recallK: number): SearchResult[] {
  const deduped = new Map<string, SearchResult>();
  for (const r of allResults) {
    const existing = deduped.get(r.id);
    if (!existing || r.score < existing.score) deduped.set(r.id, r);
  }
  const conversationTexts = new Set(conversation.filter((m) => m.role === 'user').map((m) => m.content));
  const filtered = [...deduped.values()].filter((r) => !conversationTexts.has(r.turnPair.userText));
  filtered.sort((a, b) => a.score - b.score);
  return filtered.slice(0, recallK);
}

describe('rankResults', () => {
  it('deduplicates by id keeping the best (lowest) score', () => {
    const out = rankResults([sr('r1', 'q', 0.5), sr('r1', 'q', 0.1)], [], { recallK: 10, filterConversation: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(0.1);
  });

  it('sorts ascending by score', () => {
    const out = rankResults([sr('a', 'qa', 0.3), sr('b', 'qb', 0.1), sr('c', 'qc', 0.2)], [], { recallK: 10, filterConversation: true });
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('limits to recallK', () => {
    const many = Array.from({ length: 10 }, (_, i) => sr(`r${i}`, `q${i}`, i * 0.1));
    const out = rankResults(many, [], { recallK: 3, filterConversation: true });
    expect(out).toHaveLength(3);
  });

  it('filters out turn-pairs whose userText matches a conversation user turn', () => {
    const out = rankResults([sr('r1', 'hello', 0.1), sr('r2', 'other', 0.2)], [userMsg('hello')], { recallK: 10, filterConversation: true });
    expect(out.map((r) => r.id)).toEqual(['r2']);
  });

  it('keeps conversation matches when filterConversation is false', () => {
    const out = rankResults([sr('r1', 'hello', 0.1), sr('r2', 'other', 0.2)], [userMsg('hello')], { recallK: 10, filterConversation: false });
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('filters hydrated chunks by canonical source message id instead of repeated text', () => {
    const result = sr('r1', 'same words', 0.1);
    result.turnPair.sourceMessageId = 'source-1';
    expect(rankResults([result], [userMsg('same words')], { recallK: 10, filterConversation: true })).toHaveLength(1);
    expect(rankResults([result], [{ id: 'source-1', role: 'assistant', content: 'different rendering' }], { recallK: 10, filterConversation: true })).toHaveLength(0);
  });

  it('matches the original inline ranking (parity)', () => {
    const allResults = [
      sr('r1', 'docker setup', 0.5), sr('r2', 'chroma config', 0.3),
      sr('r2', 'chroma config', 0.2), sr('r3', 'embeddings', 0.4),
      sr('r4', 'hello', 0.15),
    ];
    const conversation = [userMsg('hello'), userMsg('unrelated')];
    expect(rankResults(allResults, conversation, { recallK: 3, filterConversation: true }))
      .toEqual(oldRank(allResults, conversation, 3));
  });
});
