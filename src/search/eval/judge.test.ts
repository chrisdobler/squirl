import { describe, it, expect, vi } from 'vitest';
import { judgeCase, aggregateVerdicts, parseVerdict, withMemoryIsA } from './judge.js';
import type { MetaLLM } from '../meta-extract.js';
import type { CaseVerdict } from './types.js';

const llmReturning = (raw: string): MetaLLM => ({ complete: vi.fn().mockResolvedValue(raw) });

describe('withMemoryIsA', () => {
  it('is deterministic per caseId', () => {
    expect(withMemoryIsA('case-001')).toBe(withMemoryIsA('case-001'));
  });
  it('varies across caseIds (not all same slot)', () => {
    const flags = ['a', 'b', 'c', 'd', 'e', 'f'].map(withMemoryIsA);
    expect(new Set(flags).size).toBe(2); // both true and false appear
  });
});

describe('parseVerdict', () => {
  it('parses a clean JSON object', () => {
    expect(parseVerdict('{"winner":"A","scoreA":5,"scoreB":2,"reason":"x"}'))
      .toEqual({ winner: 'A', scoreA: 5, scoreB: 2, reason: 'x' });
  });
  it('strips ```json fences', () => {
    expect(parseVerdict('```json\n{"winner":"tie","scoreA":3,"scoreB":3}\n```')!.winner).toBe('tie');
  });
  it('clamps scores to 1..5', () => {
    const v = parseVerdict('{"winner":"B","scoreA":9,"scoreB":-4}')!;
    expect(v.scoreA).toBe(5);
    expect(v.scoreB).toBe(1);
  });
  it('returns null for invalid winner or garbage', () => {
    expect(parseVerdict('{"winner":"C","scoreA":1,"scoreB":1}')).toBeNull();
    expect(parseVerdict('not json')).toBeNull();
  });
});

describe('judgeCase', () => {
  const base = {
    caseId: 'case-001',
    userMessage: 'what volume did I use?',
    expectedAnswerNotes: 'pgdata at /var/lib/postgresql/data',
    answerWithMemory: 'You used named volume pgdata at /var/lib/postgresql/data.',
    answerWithoutMemory: "I don't have that information.",
  };

  it('maps an A-win back to whichever side memory occupies for this case', async () => {
    const isA = withMemoryIsA(base.caseId);
    const llm = llmReturning('{"winner":"A","scoreA":5,"scoreB":1}');
    const v = await judgeCase({ ...base, llm });
    // A always scores 5 here; memory should win iff memory is in slot A.
    expect(v.winner).toBe(isA ? 'with-memory' : 'without-memory');
    expect(v.scoreWithMemory).toBe(isA ? 5 : 1);
    expect(v.scoreWithoutMemory).toBe(isA ? 1 : 5);
  });

  it('passes a JSON-only system prompt and both answers to the judge', async () => {
    const llm = llmReturning('{"winner":"tie","scoreA":3,"scoreB":3}');
    await judgeCase({ ...base, llm });
    const call = (llm.complete as any).mock.calls[0][0];
    expect(call.systemPrompt).toMatch(/json/i);
    expect(call.messages[0].content).toContain('pgdata'); // expectedAnswerNotes included
    expect(call.messages[0].content).toContain(base.answerWithMemory);
    expect(call.messages[0].content).toContain(base.answerWithoutMemory);
  });

  it('falls back to a tie when the judge response is unparseable', async () => {
    const v = await judgeCase({ ...base, llm: llmReturning('I think A is better, honestly') });
    expect(v.winner).toBe('tie');
  });
});

describe('aggregateVerdicts', () => {
  it('counts wins/losses/ties and means each side score', () => {
    const verdicts: CaseVerdict[] = [
      { winner: 'with-memory', scoreWithMemory: 5, scoreWithoutMemory: 2 },
      { winner: 'with-memory', scoreWithMemory: 4, scoreWithoutMemory: 3 },
      { winner: 'without-memory', scoreWithMemory: 2, scoreWithoutMemory: 4 },
      { winner: 'tie', scoreWithMemory: 3, scoreWithoutMemory: 3 },
    ];
    const s = aggregateVerdicts(verdicts);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.ties).toBe(1);
    expect(s.meanScoreWithMemory).toBeCloseTo((5 + 4 + 2 + 3) / 4, 6);
    expect(s.meanScoreWithoutMemory).toBeCloseTo((2 + 3 + 4 + 3) / 4, 6);
  });

  it('returns zeros for no verdicts', () => {
    expect(aggregateVerdicts([])).toEqual({ wins: 0, losses: 0, ties: 0, meanScoreWithMemory: 0, meanScoreWithoutMemory: 0 });
  });
});
