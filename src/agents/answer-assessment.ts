import type { MetaLLM } from '../search/meta-extract.js';
import type { HandoffAction } from './actions.js';
import type { ActionPlanningAgent } from './actions.js';
import type { ResearchProvenance } from '../types.js';

export const HANDOFF_CONFIDENCE_THRESHOLD = 80;

export interface AnswerAssessment {
  confidence: number | null;
  action?: HandoffAction;
}

interface RawAnswerAssessment {
  confidence?: unknown;
  targetId?: unknown;
  task?: unknown;
  context?: unknown;
  successCriteria?: unknown;
}

const ANSWER_ASSESSMENT_PROMPT = `/no_think
You are Squirl's JSON-only answer confidence assessor. Evaluate the completed answer against the user's request.

Estimate confidence in the answer's factual correctness, completeness, relevance, and freshness. The percentage is an informed model estimate, not a calibrated probability. Do not score based only on confident or hesitant wording.

When research evidence is supplied, judge whether authoritative fetched sources actually support the answer's material claims and whether citations cover those claims. Tool use alone earns no confidence increase. Search snippets, failed fetches, weak sources, or uncited claims remain unverified. Multiple independent authoritative sources can increase confidence when corroboration matters. Do not penalize stable knowledge answers merely because no research was needed.

When confidence is below 80 and exactly one connected specialist is likely to improve or verify the answer, select that specialist using only an exact id supplied in knownAgents. Otherwise leave targetId and all handoff fields empty. Never invent an agent.

Respond with exactly this JSON shape and no markdown:
{"confidence":0,"targetId":"","task":"","context":"","successCriteria":""}

confidence must be an integer from 0 through 100. If proposing a specialist, task must tell them what to verify or improve, context must explain the uncertainty, and successCriteria must describe a useful final answer.`;

function cleanJson(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

export function parseAnswerAssessment(raw: string, agents: ActionPlanningAgent[]): AnswerAssessment | null {
  let parsed: RawAnswerAssessment;
  try {
    parsed = JSON.parse(cleanJson(raw)) as RawAnswerAssessment;
  } catch {
    return null;
  }
  if (!Number.isInteger(parsed.confidence) || (parsed.confidence as number) < 0 || (parsed.confidence as number) > 100) return null;
  const confidence = parsed.confidence as number;
  const targetId = typeof parsed.targetId === 'string' ? parsed.targetId.trim() : '';
  if (!targetId) return { confidence };
  const target = agents.find((agent) => agent.id === targetId && agent.connected);
  const task = typeof parsed.task === 'string' ? parsed.task.trim() : '';
  if (!target || !task) return { confidence };
  const context = typeof parsed.context === 'string' ? parsed.context.trim() : '';
  const successCriteria = typeof parsed.successCriteria === 'string' ? parsed.successCriteria.trim() : '';
  return {
    confidence,
    action: {
      type: 'handoff', targetId: target.id, task,
      ...(context ? { context } : {}),
      ...(successCriteria ? { successCriteria } : {}),
    },
  };
}

function assessmentInput(request: string, answer: string, agents: ActionPlanningAgent[], research?: ResearchProvenance): string {
  return JSON.stringify({
    request,
    answer,
    research: research ?? null,
    knownAgents: agents.map(({ id, label, connected, specialty, status, cwd, currentAssignment }) => ({
      id, label, connected, specialty, status, cwd, currentAssignment,
    })),
  });
}

/** Assess a completed answer, retrying malformed JSON once without risking the answer itself. */
export async function assessSquirlAnswer(
  request: string,
  answer: string,
  agents: ActionPlanningAgent[],
  llm: MetaLLM,
  research?: ResearchProvenance,
  signal?: AbortSignal,
): Promise<AnswerAssessment> {
  if (!answer.trim()) return { confidence: null };
  const input = assessmentInput(request, answer, agents, research);
  try {
    const first = await llm.complete({ systemPrompt: ANSWER_ASSESSMENT_PROMPT, messages: [{ role: 'user', content: input }], signal });
    const parsed = parseAnswerAssessment(first, agents);
    if (parsed) return parsed;
    const repaired = await llm.complete({
      systemPrompt: ANSWER_ASSESSMENT_PROMPT,
      messages: [
        { role: 'user', content: input },
        { role: 'assistant', content: first.slice(0, 4_000) },
        { role: 'user', content: 'That response was invalid. Return only the required JSON object with an integer confidence from 0 through 100.' },
      ],
      signal,
    });
    return parseAnswerAssessment(repaired, agents) ?? { confidence: null };
  } catch {
    return { confidence: null };
  }
}
