import type { Message } from '../types.js';
import { searchLog } from './debug.js';

export type ResearchReason = 'explicit' | 'freshness' | 'high-stakes' | 'uncertain' | 'none';
export type WorkspaceToolName = 'read_file' | 'write_file' | 'run_command' | 'list_files';
export type WorkspaceToolReason = 'none' | 'explicit-read' | 'explicit-write' | 'explicit-command' | 'explicit-mixed';

export interface WorkspaceToolDecision {
  allowed: WorkspaceToolName[];
  reason: WorkspaceToolReason;
}

export interface TurnIntentClassification {
  memoryQueries: string[];
  research: { needed: boolean; reason: ResearchReason; query?: string };
  workspaceTools: WorkspaceToolDecision;
}

export interface TurnIntentObservation {
  input: { messages: Array<{ role: 'user' | 'assistant'; content: string }> };
  raw?: string;
  parsed: TurnIntentClassification;
  error?: string;
}

const SYSTEM_PROMPT = `/no_think
You are Squirl's JSON-only turn intent classifier. Return exactly one JSON object and no prose.

Create 2-3 concise memory search queries in memoryQueries describing past conversations that could help answer the newest request.
Also decide whether current external web evidence is needed. Research changing facts, consequential medical/legal/financial/public-benefit guidance, material uncertainty, and explicit requests to search, verify, cite, or check current information. Do not research stable explanations unless explicitly requested.

Only the newest user request may grant workspace tools. Allow read_file/list_files only for an explicit request to inspect, read, show, find, or list workspace content; add write_file for an explicit request to edit, create, implement, or fix it; allow run_command only for an explicit request to run, execute, test, build, lint, typecheck, or compile. Knowledge and explanatory questions get no workspace tools.

Required shape:
{"memoryQueries":["query"],"research":{"needed":false,"reason":"none","query":""},"workspaceTools":{"allowed":[],"reason":"none"}}

research reason must be one of: explicit, freshness, high-stakes, uncertain, none.
workspaceTools reason must be one of: none, explicit-read, explicit-write, explicit-command, explicit-mixed.`;

export interface MetaLLM {
  complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
  }): Promise<string>;
}

function boundedMessages(conversation: Message[], userMessage: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  let recent = conversation
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 500) }));
  while (recent.length > 0 && recent[0]!.role !== 'user') recent = recent.slice(1);
  return [...recent, { role: 'user', content: userMessage.slice(0, 2_000) }];
}

function cleanedJson(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function parseClassification(raw: string): TurnIntentClassification | null {
  let value: unknown;
  try { value = JSON.parse(cleanedJson(raw)); } catch { return null; }
  if (Array.isArray(value)) {
    return {
      memoryQueries: value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 300)).slice(0, 3),
      research: { needed: false, reason: 'none' },
      workspaceTools: { allowed: [], reason: 'none' },
    };
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as { memoryQueries?: unknown; research?: unknown };
  const memoryQueries = Array.isArray(record.memoryQueries)
    ? record.memoryQueries.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 300)).slice(0, 3)
    : [];
  const research = record.research && typeof record.research === 'object' ? record.research as Record<string, unknown> : {};
  const reasons: ResearchReason[] = ['explicit', 'freshness', 'high-stakes', 'uncertain', 'none'];
  const reason = reasons.includes(research.reason as ResearchReason) ? research.reason as ResearchReason : 'none';
  const needed = research.needed === true;
  const query = typeof research.query === 'string' ? research.query.trim().slice(0, 500) : '';
  return {
    memoryQueries,
    research: { needed, reason: needed && reason === 'none' ? 'uncertain' : reason, ...(needed && query ? { query } : {}) },
    workspaceTools: { allowed: [], reason: 'none' },
  };
}

/** Deterministic authorization derived exclusively from the newest user request. */
export function workspaceToolPolicyForRequest(userMessage: string): WorkspaceToolDecision {
  const value = userMessage.trim();
  if (!value) return { allowed: [], reason: 'none' };

  const politeAction = /^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i;
  const collaborativeAction = /^(?:please\s+)?(?:let(?:'s| us)\s+)/i;
  const imperative = /^(?:please\s+)?/i;
  const normalized = value.replace(politeAction, '').replace(collaborativeAction, '').replace(imperative, '');
  const beginsWith = (verbs: string) => new RegExp(`^(?:${verbs})\\b`, 'i').test(normalized);

  const workspaceSubject = /\b(?:workspace|repo(?:sitory)?|project|codebase|source|files?|folders?|director(?:y|ies)|paths?|tests?|build)\b/i.test(value)
    || /(?:^|\s)[./~][^\s]*/.test(value);
  const write = beginsWith('fix|implement|edit|modify|update|patch|rename|delete|remove|add')
    || (beginsWith('change|create|write') && workspaceSubject);
  const command = beginsWith('run|execute|test|build|lint|typecheck|type-check|compile')
    || /\b(?:run|execute)\s+(?:the\s+)?(?:tests?|build|linter|typecheck|type-check|compiler)\b/i.test(value);
  const read = beginsWith('read|inspect|open|show|list|find|review|check') && workspaceSubject;

  const allowed: WorkspaceToolName[] = [];
  if (read || write) allowed.push('read_file', 'list_files');
  if (write) allowed.push('write_file');
  if (command) allowed.push('run_command');
  const kinds = [read, write, command].filter(Boolean).length;
  const reason: WorkspaceToolReason = kinds > 1 ? 'explicit-mixed'
    : write ? 'explicit-write'
      : command ? 'explicit-command'
        : read ? 'explicit-read' : 'none';
  return { allowed, reason };
}

export function researchPolicyForRequest(userMessage: string): TurnIntentClassification['research'] | null {
  const value = userMessage.trim();
  const explicit = /\b(search|browse|look (?:it |this )?up|verify|check online|on the web|sources?|citations?|cite)\b/i.test(value);
  if (explicit) return { needed: true, reason: 'explicit', query: value.slice(0, 500) };
  const highStakes = /\b(medical|medicine|diagnos|symptom|treatment|dose|dosage|legal|lawyer|lawsuit|court|tax|investment|financial advice|benefits?|public benefits?|EBT|BIC|CalFresh|Medicaid|Medicare|Social Security|SNAP)\b/i.test(value);
  if (highStakes) return { needed: true, reason: 'high-stakes', query: value.slice(0, 500) };
  const stableExplanation = /\b(what is|explain|difference between|versus|vs\.?|how does)\b/i.test(value)
    && /\b(STT|TTS|speech[- ]to[- ]text|text[- ]to[- ]speech)\b/i.test(value);
  if (stableExplanation) return { needed: false, reason: 'none' };
  const freshness = /\b(?:right now|now|news|breaking|trending|hottest|latest|current(?:ly)?|today|recent(?:ly)?|upcoming|release date|rollout|general availability|available|availability|prices?|schedules?|scores?|standings|weather|forecast|when will)\b/i.test(value);
  return freshness ? { needed: true, reason: 'freshness', query: value.slice(0, 500) } : null;
}

/** Produce a useful query without waiting for semantic query rewriting. */
export function fallbackMemoryQueriesForRequest(userMessage: string): string[] {
  const query = userMessage.replace(/\s+/g, ' ').trim().slice(0, 300);
  return query ? [query] : [];
}

/** Foreground-safe intent derived synchronously from the newest request. */
export function deterministicTurnIntentForRequest(userMessage: string): TurnIntentClassification {
  return {
    memoryQueries: fallbackMemoryQueriesForRequest(userMessage),
    research: researchPolicyForRequest(userMessage) ?? { needed: false, reason: 'none' },
    workspaceTools: workspaceToolPolicyForRequest(userMessage),
  };
}

export async function classifyTurnIntent(
  conversation: Message[],
  userMessage: string,
  llm: MetaLLM,
  observe?: (observation: TurnIntentObservation) => void,
): Promise<TurnIntentClassification> {
  const messages = boundedMessages(conversation, userMessage);
  const deterministic = researchPolicyForRequest(userMessage);
  try {
    searchLog('TURN INTENT REQUEST', { messageCount: messages.length, userMessage: userMessage.slice(0, 100) });
    const raw = await llm.complete({ systemPrompt: SYSTEM_PROMPT, messages });
    searchLog('TURN INTENT RESPONSE', raw);
    const parsed = parseClassification(raw) ?? { memoryQueries: [], research: { needed: false, reason: 'none' as const }, workspaceTools: { allowed: [], reason: 'none' as const } };
    const result = { ...parsed, research: deterministic ?? parsed.research, workspaceTools: workspaceToolPolicyForRequest(userMessage) };
    observe?.({ input: { messages }, raw, parsed: result, ...(!parseClassification(raw) ? { error: 'Classifier returned invalid JSON.' } : {}) });
    return result;
  } catch (error) {
    const result: TurnIntentClassification = { memoryQueries: [], research: deterministic ?? { needed: false, reason: 'none' }, workspaceTools: workspaceToolPolicyForRequest(userMessage) };
    const message = error instanceof Error ? error.message : String(error);
    searchLog('TURN INTENT ERROR', message);
    observe?.({ input: { messages }, parsed: result, error: message });
    return result;
  }
}

/** Compatibility wrapper used by retrieval/eval callers that only need memory queries. */
export async function extractSearchQueries(conversation: Message[], userMessage: string, llm: MetaLLM): Promise<string[]> {
  return (await classifyTurnIntent(conversation, userMessage, llm)).memoryQueries;
}
