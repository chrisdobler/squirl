import { parseMentions } from './mentions.js';
import type { MetaLLM } from '../search/meta-extract.js';
import type { Message } from '../types.js';
import type { HandoffAction, SquirlAction } from './actions.js';

export interface DelegationAgent {
  id: string;
  label?: string;
  kind?: 'claude-code' | 'codex' | 'pi';
  connected: boolean;
  cwd?: string;
  specialty?: string;
  status?: string;
  currentAssignment?: string;
}

export interface DelegationIntent {
  targetIds: string[];
  unavailableTargetIds: string[];
  originalRequest: string;
  task: string;
  trigger: 'mention' | 'natural-language';
  /** Validated proactive action, present only after the user confirmed it. */
  action?: HandoffAction;
}

export interface PendingDelegationConfirmation {
  id: string;
  targetIds: string[];
  task: string;
  originalRequest: string;
  createdAt: string;
  expiresAt: string;
  /** Structured proposal that produced this confirmation, when available. */
  action?: SquirlAction;
}

export type DelegationResolution =
  | { kind: 'dispatch'; delegation: DelegationIntent }
  | { kind: 'confirm'; pending: PendingDelegationConfirmation }
  | { kind: 'clarify'; task: string; candidateTargetIds: string[] }
  | { kind: 'none' };

export const DELEGATION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

const CLASSIFIER_PROMPT = `/no_think
You are a JSON-only delegation intent classifier. Decide whether the user is explicitly asking Squirl to send work to one or more known agents. Discussion about an agent, questions about prior work, and hypothetical suggestions are not delegation. Requests to resume, continue, reassign, put an agent back on work, or otherwise direct an agent to act are delegation.

The request may be a short contextual approval such as "yeah, let's do it". In that case, use recentContext to recover the actionable task and choose the best connected agent using cwd, specialty, status, and currentAssignment. Only choose delegate/high when both the authorization, task, and target are unambiguous. Otherwise choose uncertain or not_delegate.

Respond with exactly this JSON shape and no markdown:
{"decision":"delegate|not_delegate|uncertain","confidence":"high|low","targetIds":["known-agent-id"],"task":"the work to send"}

Use only agent ids supplied in the input. Never invent a target. Use high confidence only when the user clearly authorized immediate dispatch.`;

interface RawDelegationClassification {
  decision?: unknown;
  confidence?: unknown;
  targetIds?: unknown;
  task?: unknown;
}

function aliasesFor(agent: DelegationAgent): string[] {
  const aliases = new Set([agent.id.toLowerCase(), agent.label?.toLowerCase()].filter(Boolean) as string[]);
  if (agent.kind === 'claude-code') {
    aliases.add('cc');
    aliases.add('claude');
    aliases.add('claude code');
    aliases.add('claudecode');
    aliases.add('clod');
    aliases.add('clod code');
    aliases.add('clodcode');
    aliases.add('cloud code');
    aliases.add('cloudcode');
  } else if (agent.kind === 'codex') {
    aliases.add('codex');
    aliases.add('codex cli');
  } else if (agent.kind === 'pi') {
    aliases.add('pi');
    aliases.add('pi agent');
    aliases.add('pi coding agent');
  }
  return [...aliases];
}

export function mentionedAgents(text: string, agents: DelegationAgent[]): DelegationAgent[] {
  const lower = text.toLowerCase();
  return agents.map((agent) => {
    let position = Number.POSITIVE_INFINITY;
    for (const alias of aliasesFor(agent)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`, 'i').exec(lower);
      if (match && match.index < position) position = match.index;
    }
    return { agent, position };
  }).filter((match) => Number.isFinite(match.position))
    .sort((a, b) => a.position - b.position)
    .map((match) => match.agent);
}

function intentFor(targetIds: string[], originalRequest: string, task: string, agents: DelegationAgent[]): DelegationIntent {
  const targets = targetIds.map((id) => agents.find((agent) => agent.id === id)!).filter(Boolean);
  return {
    targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
    unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
    originalRequest,
    task,
    trigger: 'natural-language',
  };
}

export function pendingConfirmation(targetIds: string[], originalRequest: string, task: string, now: Date, action?: SquirlAction): PendingDelegationConfirmation {
  return {
    id: crypto.randomUUID(),
    targetIds,
    task: task.trim() || originalRequest,
    originalRequest,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DELEGATION_CONFIRMATION_TTL_MS).toISOString(),
    ...(action ? { action } : {}),
  };
}

function parseClassification(raw: string): RawDelegationClassification | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as RawDelegationClassification;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Resolve explicit syntax first, then use a guarded semantic classifier for named-agent requests. */
export async function resolveDelegationIntent(
  input: string,
  agents: DelegationAgent[],
  llm: MetaLLM | null,
  now = new Date(),
  recentContext: Message[] = [],
): Promise<DelegationResolution> {
  const deterministic = parseDelegationIntent(input, agents);
  if (deterministic) return { kind: 'dispatch', delegation: deterministic };

  const originalRequest = input.trim();
  const referenced = mentionedAgents(originalRequest, agents);
  const contextualApproval = /^(?:y|yes|yeah|yep|sure|ok(?:ay)?|go ahead|do it|let'?s do it|yeah,? let'?s do it|please do|implement it|make it happen)[.!]?$/i.test(originalRequest);
  if (!originalRequest || (referenced.length === 0 && (!contextualApproval || recentContext.length === 0))) return { kind: 'none' };
  const fallbackTargetIds = referenced.map((agent) => agent.id);

  if (!llm) {
    if (fallbackTargetIds.length === 0) return { kind: 'clarify', task: originalRequest, candidateTargetIds: agents.filter((agent) => agent.connected).map((agent) => agent.id) };
    return { kind: 'confirm', pending: pendingConfirmation(fallbackTargetIds, originalRequest, originalRequest, now) };
  }

  try {
    const raw = await llm.complete({
      systemPrompt: CLASSIFIER_PROMPT,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          request: originalRequest,
          recentContext: recentContext.slice(-12).filter((message) => message.role !== 'tool' && message.role !== 'activity').map((message) => ({
            role: message.role,
            participantId: message.participantId,
            content: message.content.slice(0, 4_000),
          })),
          knownAgents: agents.map(({ id, label, kind, connected, cwd, specialty, status, currentAssignment }) => ({ id, label, kind, connected, cwd, specialty, status, currentAssignment })),
          referencedAgentIds: fallbackTargetIds,
        }),
      }],
    });
    const parsed = parseClassification(raw);
    const knownIds = new Set(agents.map((agent) => agent.id));
    const rawTargetIds = Array.isArray(parsed?.targetIds)
      ? parsed.targetIds.filter((id): id is string => typeof id === 'string')
      : [];
    const targetsValid = rawTargetIds.length > 0 && rawTargetIds.every((id) => knownIds.has(id));
    const targetIds = targetsValid ? [...new Set(rawTargetIds)] : fallbackTargetIds;
    const task = typeof parsed?.task === 'string' && parsed.task.trim() ? parsed.task.trim() : originalRequest;

    if (parsed?.decision === 'not_delegate' && parsed.confidence === 'high') return { kind: 'none' };
    if (parsed?.decision === 'delegate' && parsed.confidence === 'high' && targetsValid && task) {
      if (contextualApproval && referenced.length === 0 && targetIds.length !== 1) {
        return { kind: 'clarify', task, candidateTargetIds: targetIds };
      }
      return { kind: 'dispatch', delegation: intentFor(targetIds, originalRequest, task, agents) };
    }
    if (contextualApproval && referenced.length === 0 && targetIds.length !== 1) {
      return { kind: 'clarify', task, candidateTargetIds: targetIds.length ? targetIds : agents.filter((agent) => agent.connected).map((agent) => agent.id) };
    }
    if (targetIds.length === 0) return { kind: 'none' };
    return { kind: 'confirm', pending: pendingConfirmation(targetIds, originalRequest, task, now) };
  } catch {
    if (fallbackTargetIds.length === 0) return { kind: 'clarify', task: originalRequest, candidateTargetIds: agents.filter((agent) => agent.connected).map((agent) => agent.id) };
    return { kind: 'confirm', pending: pendingConfirmation(fallbackTargetIds, originalRequest, originalRequest, now) };
  }
}

export interface LegacyHandoffProposal {
  targetId: string;
  task: string;
  originalRequest: string;
}

/** Parse only Squirl's bounded handoff format; never treat arbitrary mentions as delivery. */
export function parseLegacyHandoffProposal(content: string, agents: DelegationAgent[]): LegacyHandoffProposal | null {
  const header = content.match(/^Handoff to @([a-zA-Z0-9_-]+)\s*(?:\n|$)/i);
  if (!header || !agents.some((agent) => agent.id.toLowerCase() === header[1]!.toLowerCase())) return null;
  const target = agents.find((agent) => agent.id.toLowerCase() === header[1]!.toLowerCase())!;
  const goal = content.match(/(?:^|\n)Goal:\s*([^\n]+(?:\n(?!\n|[A-Z][\w ]+:)[^\n]+)*)/i)?.[1]?.trim();
  const original = content.match(/(?:^|\n)Original request:\s*([\s\S]+)$/i)?.[1]?.trim();
  return { targetId: target.id, task: goal || original || content.trim(), originalRequest: original || goal || content.trim() };
}

export function pendingFromLegacyHandoff(proposal: LegacyHandoffProposal, now = new Date()): PendingDelegationConfirmation {
  return pendingConfirmation([proposal.targetId], proposal.originalRequest, proposal.task, now);
}

export function isRetryLastHandoff(input: string): boolean {
  return /^(?:please\s+)?retry\s+(?:that|the)\s+(?:last\s+)?handoff[.!?]?$/i.test(input.trim());
}

export function delegationConfirmationText(pending: PendingDelegationConfirmation): string {
  const targets = pending.targetIds.map((id) => `@${id}`).join(' and ');
  return `I think you want me to send this work to ${targets}, but I’m not fully certain. Should I dispatch it? Reply yes or no.`;
}

export function delegationConfirmationResponse(input: string): 'confirm' | 'cancel' | 'unrelated' {
  const normalized = input.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (/^(?:y|yes|yeah|yep|sure|do it|proceed|confirm)$/.test(normalized)) return 'confirm';
  if (/^(?:n|no|nope|cancel|don't|do not)$/.test(normalized)) return 'cancel';
  return 'unrelated';
}

interface ConfirmationHistoryMessage {
  role: string;
  proactiveKind?: string;
  delegationConfirmation?: PendingDelegationConfirmation;
}

/** Recover only the latest unanswered, unexpired confirmation from persisted history. */
export function recoverPendingDelegation(
  messages: ConfirmationHistoryMessage[],
  now = new Date(),
): PendingDelegationConfirmation | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') return null;
    if (message.role !== 'assistant' || message.proactiveKind !== 'delegation-confirmation') continue;
    const pending = message.delegationConfirmation;
    if (!pending || !pending.id || pending.targetIds.length === 0 || !pending.task.trim()) return null;
    return Date.parse(pending.expiresAt) > now.getTime() ? pending : null;
  }
  return null;
}

export function parseDelegationIntent(input: string, agents: DelegationAgent[]): DelegationIntent | null {
  const originalRequest = input.trim();
  if (!originalRequest) return null;

  const mentionIds = parseMentions(originalRequest, agents.map((agent) => agent.id)).targets;
  if (mentionIds.length > 0) {
    const leadingMentions = /^\s*(?:@[a-zA-Z0-9_-]+\s*)+/;
    const task = originalRequest.replace(leadingMentions, '').trim() || originalRequest;
    const targets = mentionIds.map((id) => agents.find((agent) => agent.id === id)!).filter(Boolean);
    return {
      targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
      unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
      originalRequest,
      task,
      trigger: 'mention',
    };
  }

  const tellMatch = originalRequest.match(/\b(?:tell|ask|have)\s+(.+?)\s+to\s+([\s\S]+)$/i);
  const sendMatch = originalRequest.match(/\bsend\s+([\s\S]+?)\s+to\s+(.+)$/i);
  const assignMatch = originalRequest.match(/\b(?:put|get)\s+(.+?)\s+(?:back\s+)?(?:working\s+)?on\s+([\s\S]+)$/i);
  const agentPhrase = tellMatch?.[1] ?? sendMatch?.[2] ?? assignMatch?.[1];
  const task = (tellMatch?.[2] ?? sendMatch?.[1] ?? assignMatch?.[2])?.trim();
  if (!agentPhrase || !task) return null;

  const targets = mentionedAgents(agentPhrase, agents);
  if (targets.length === 0) return null;
  return {
    targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
    unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
    originalRequest,
    task,
    trigger: 'natural-language',
  };
}
