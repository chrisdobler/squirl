import { describe, it, expect, vi } from 'vitest';
import { runLayer3 } from './layer3-answer-quality.js';
import { frozenHarness, chunkHashOf, type EmbeddingFixture } from '../harness.js';
import { DEFAULT_CHUNK_OPTIONS } from '../../chunk.js';
import type { EvalCase, RunConfig } from '../types.js';
import type { MetaLLM } from '../../meta-extract.js';
import type { TurnPair } from '../../types.js';
import type { SelectedModel } from '../../../components/ModelPicker.js';

const tp = (id: string): TurnPair => ({
  id, source: 'golden', conversationId: 'c1', timestamp: '2026-01-01T00:00:00Z',
  userText: 'user ' + id, assistantText: 'assistant ' + id,
});

const corpus = [tp('doc-a'), tp('doc-b')];

const fixture: EmbeddingFixture = {
  embedder: 'openai:bge', dimensions: 2, chunkOptions: DEFAULT_CHUNK_OPTIONS,
  chunkHash: chunkHashOf(DEFAULT_CHUNK_OPTIONS),
  corpus: { 'doc-a': [1, 0], 'doc-b': [0, 1] },
  queries: { qa: [1, 0] },
};

const config: RunConfig = {
  mode: 'frozen', layer: 3,
  embedder: { type: 'openai', model: 'bge' }, meta: { provider: 'openai', model: 'm' },
  chunk: DEFAULT_CHUNK_OPTIONS, rank: { perQueryK: 8, recallK: 10, filterConversation: true },
  ks: [1, 5], label: 'judge',
};

const cases: EvalCase[] = [
  { id: 'case-a', conversation: [], userMessage: 'where is doc a', qrels: { 'doc-a': 2 }, goldQueries: ['qa'], expectedAnswerNotes: 'doc a facts' },
  { id: 'no-notes', conversation: [], userMessage: 'x', qrels: { 'doc-a': 1 }, goldQueries: ['qa'] }, // skipped: no expectedAnswerNotes
];

// Fake answer generator: distinguishes by whether the memory system message is injected.
// Tokens are chosen so neither is a substring of the other.
const fakeGenerate = vi.fn(async (p: { systemMessages: string[] }) =>
  p.systemMessages.some((s) => s.includes('relevant excerpts')) ? 'MEM_ANSWER' : 'PLAIN_ANSWER');

// Content-aware judge: always favors whichever slot holds the memory answer, so memory wins
// regardless of the deterministic A/B positioning.
const fakeJudge: MetaLLM = {
  complete: async ({ messages }) => {
    const content = messages[0]!.content;
    const aSection = content.slice(content.indexOf('ANSWER A:'), content.indexOf('ANSWER B:'));
    const memoryIsA = aSection.includes('MEM_ANSWER');
    return JSON.stringify({ winner: memoryIsA ? 'A' : 'B', scoreA: memoryIsA ? 5 : 1, scoreB: memoryIsA ? 1 : 5 });
  },
};

const answerModel: SelectedModel = { id: 'ans', label: 'ans', provider: 'local', baseUrl: 'x' };

describe('runLayer3', () => {
  it('judges only cases with expectedAnswerNotes and reports memory wins', async () => {
    const harness = frozenHarness(corpus, fixture, config);
    const out = await runLayer3(cases, harness, { answerModel, judgeLLM: fakeJudge, generate: fakeGenerate });

    expect(out.perCase.map((p) => p.caseId)).toEqual(['case-a']); // no-notes skipped
    expect(out.judge).toEqual({ wins: 1, losses: 0, ties: 0, meanScoreWithMemory: 5, meanScoreWithoutMemory: 1 });

    const c = out.perCase[0]!;
    expect(c.answerWithMemory).toBe('MEM_ANSWER');
    expect(c.answerWithoutMemory).toBe('PLAIN_ANSWER');
    expect(c.verdict!.winner).toBe('with-memory');
  });

  it('generates exactly two answers per judged case (with vs without memory)', async () => {
    fakeGenerate.mockClear();
    const harness = frozenHarness(corpus, fixture, config);
    await runLayer3(cases, harness, { answerModel, judgeLLM: fakeJudge, generate: fakeGenerate });
    expect(fakeGenerate).toHaveBeenCalledTimes(2);
  });

  it('still reports retrieval metrics alongside the judge summary', async () => {
    const harness = frozenHarness(corpus, fixture, config);
    const out = await runLayer3(cases, harness, { answerModel, judgeLLM: fakeJudge, generate: fakeGenerate });
    expect(out.metrics.recallAtK[1]).toBeCloseTo(1, 6); // doc-a retrieved at rank 1 for qa
  });

  it('wraps an answer-model failure with the model + role so a bare 500 is actionable', async () => {
    const harness = frozenHarness(corpus, fixture, config);
    const failing = vi.fn(async () => { throw new Error('500 Internal Server Error'); });
    await expect(runLayer3(cases, harness, { answerModel, judgeLLM: fakeJudge, generate: failing }))
      .rejects.toThrow(/answer model local:ans.*500 Internal Server Error/);
  });

  it('wraps a judge failure with context', async () => {
    const harness = frozenHarness(corpus, fixture, config);
    const failingJudge: MetaLLM = { complete: async () => { throw new Error('500 Internal Server Error'); } };
    await expect(runLayer3(cases, harness, { answerModel, judgeLLM: failingJudge, generate: fakeGenerate, judgeLabel: 'local:judgemodel' }))
      .rejects.toThrow(/judge .*local:judgemodel.*500/);
  });

  it('reports per-case progress: index/total over judged cases, answering → judging → done order', async () => {
    const twoCases: EvalCase[] = [
      { id: 'case-a', conversation: [], userMessage: 'q a', qrels: { 'doc-a': 2 }, goldQueries: ['qa'], expectedAnswerNotes: 'a facts' },
      { id: 'no-notes', conversation: [], userMessage: 'x', qrels: { 'doc-a': 1 }, goldQueries: ['qa'] }, // not judged
      { id: 'case-b', conversation: [], userMessage: 'q b', qrels: { 'doc-b': 2 }, goldQueries: ['qa'], expectedAnswerNotes: 'b facts' },
    ];
    const harness = frozenHarness(corpus, fixture, config);
    const events: Array<{ index: number; total: number; caseId: string; phase: string }> = [];
    await runLayer3(twoCases, harness, {
      answerModel, judgeLLM: fakeJudge, generate: fakeGenerate,
      onProgress: (p) => events.push({ index: p.index, total: p.total, caseId: p.caseId, phase: p.phase }),
    });

    // total counts only judged cases (no-notes excluded)
    expect(events.every((e) => e.total === 2)).toBe(true);
    // first judged case is index 1, phases in order
    const caseA = events.filter((e) => e.caseId === 'case-a');
    expect(caseA.map((e) => e.phase)).toEqual(['answering', 'judging', 'done']);
    expect(caseA.every((e) => e.index === 1)).toBe(true);
    // second judged case is index 2
    const caseB = events.filter((e) => e.caseId === 'case-b');
    expect(caseB.map((e) => e.phase)).toEqual(['answering', 'judging', 'done']);
    expect(caseB.every((e) => e.index === 2)).toBe(true);
    // the 'done' event carries the verdict
    const doneA = caseA.find((e) => e.phase === 'done')!;
    expect(events.find((e) => e.caseId === 'case-a' && e.phase === 'done')).toBeTruthy();
    expect(doneA).toBeTruthy();
  });

  it('the done progress event includes the verdict', async () => {
    const harness = frozenHarness(corpus, fixture, config);
    const dones: any[] = [];
    await runLayer3(cases, harness, {
      answerModel, judgeLLM: fakeJudge, generate: fakeGenerate,
      onProgress: (p) => { if (p.phase === 'done') dones.push(p); },
    });
    expect(dones).toHaveLength(1);
    expect(dones[0].verdict.winner).toBe('with-memory');
    expect(typeof dones[0].elapsedMs).toBe('number');
  });
});
