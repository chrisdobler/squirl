import { createHash } from 'node:crypto';
import type { MetaLLM } from '../meta-extract.js';
import type { CaseVerdict, JudgeSummary } from './types.js';

export const JUDGE_SYSTEM_PROMPT = `You are a strict evaluation judge scoring answer correctness.
You are given a user question, the EXPECTED FACTS a correct answer must contain, and two candidate
answers labeled A and B. Judge which answer better satisfies the expected facts.

Respond with ONLY a raw JSON object, no prose, no markdown:
{"winner": "A" | "B" | "tie", "scoreA": <1-5>, "scoreB": <1-5>, "reason": "<one sentence>"}

scoreA/scoreB rate each answer's correctness vs the expected facts (5 = fully correct, 1 = wrong or
missing). Use "tie" only when both answers are equally correct.`;

interface RawVerdict {
  winner: 'A' | 'B' | 'tie';
  scoreA: number;
  scoreB: number;
  reason?: string;
}

/** Deterministic per-case A/B assignment: does the with-memory answer occupy slot A? Cancels positional bias. */
export function withMemoryIsA(caseId: string): boolean {
  return createHash('sha1').update(caseId).digest()[0]! % 2 === 0;
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1;
  return Math.max(1, Math.min(5, Math.round(v)));
}

export function parseVerdict(raw: string): RawVerdict | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || (parsed.winner !== 'A' && parsed.winner !== 'B' && parsed.winner !== 'tie')) return null;
  return {
    winner: parsed.winner,
    scoreA: clampScore(parsed.scoreA),
    scoreB: clampScore(parsed.scoreB),
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
  };
}

export function buildJudgeUserMessage(
  userMessage: string,
  expectedAnswerNotes: string,
  answerA: string,
  answerB: string,
): string {
  return [
    `USER QUESTION:\n${userMessage}`,
    `EXPECTED FACTS:\n${expectedAnswerNotes}`,
    `ANSWER A:\n${answerA}`,
    `ANSWER B:\n${answerB}`,
  ].join('\n\n');
}

export interface JudgeCaseParams {
  caseId: string;
  userMessage: string;
  expectedAnswerNotes: string;
  answerWithMemory: string;
  answerWithoutMemory: string;
  llm: MetaLLM;
}

/** Judge one case; positions memory in slot A or B deterministically and maps the verdict back. */
export async function judgeCase(params: JudgeCaseParams): Promise<CaseVerdict> {
  const isA = withMemoryIsA(params.caseId);
  const answerA = isA ? params.answerWithMemory : params.answerWithoutMemory;
  const answerB = isA ? params.answerWithoutMemory : params.answerWithMemory;

  const raw = await params.llm.complete({
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildJudgeUserMessage(params.userMessage, params.expectedAnswerNotes, answerA, answerB) }],
  });

  const verdict = parseVerdict(raw);
  if (!verdict) {
    return { winner: 'tie', scoreWithMemory: 0, scoreWithoutMemory: 0, reason: 'judge response unparseable' };
  }

  const scoreWithMemory = isA ? verdict.scoreA : verdict.scoreB;
  const scoreWithoutMemory = isA ? verdict.scoreB : verdict.scoreA;

  let winner: CaseVerdict['winner'];
  if (verdict.winner === 'tie') {
    winner = 'tie';
  } else {
    const winnerIsA = verdict.winner === 'A';
    winner = winnerIsA === isA ? 'with-memory' : 'without-memory';
  }

  return { winner, scoreWithMemory, scoreWithoutMemory, ...(verdict.reason ? { reason: verdict.reason } : {}) };
}

export function aggregateVerdicts(verdicts: CaseVerdict[]): JudgeSummary {
  if (verdicts.length === 0) {
    return { wins: 0, losses: 0, ties: 0, meanScoreWithMemory: 0, meanScoreWithoutMemory: 0 };
  }
  const mean = (sel: (v: CaseVerdict) => number) => verdicts.reduce((s, v) => s + sel(v), 0) / verdicts.length;
  return {
    wins: verdicts.filter((v) => v.winner === 'with-memory').length,
    losses: verdicts.filter((v) => v.winner === 'without-memory').length,
    ties: verdicts.filter((v) => v.winner === 'tie').length,
    meanScoreWithMemory: mean((v) => v.scoreWithMemory),
    meanScoreWithoutMemory: mean((v) => v.scoreWithoutMemory),
  };
}
