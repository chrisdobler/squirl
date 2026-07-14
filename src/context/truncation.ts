import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { estimateMessagesTokens } from './token-estimator.js';

export interface TruncationResult {
  messages: ChatCompletionMessageParam[];
  droppedEvidenceCount: number;
  droppedMessageCount: number;
}

export function truncateToFit(
  baseMessages: ChatCompletionMessageParam[],
  priorityEvidenceMessages: ChatCompletionMessageParam[],
  conversationMessages: ChatCompletionMessageParam[],
  supplementalEvidenceMessages: ChatCompletionMessageParam[],
  maxTokens: number,
  reserveForCompletion: number = 4096,
): TruncationResult {
  const budget = Math.max(0, maxTokens - reserveForCompletion);
  let used = estimateMessagesTokens(baseMessages);
  let droppedEvidenceCount = 0;
  let droppedMessageCount = 0;

  const turns = conversationTurns(conversationMessages);
  const includedTurns: ChatCompletionMessageParam[][] = [];

  // The newest turn contains the current user request and is mandatory: sending
  // an over-budget request is preferable to silently asking a different question.
  const latestTurn = turns.at(-1);
  if (latestTurn) {
    includedTurns.unshift(latestTurn);
    used += estimateMessagesTokens(latestTurn);
  }

  const includedEvidence: ChatCompletionMessageParam[] = [];
  for (const message of priorityEvidenceMessages) {
    const cost = estimateMessagesTokens([message]);
    if (used + cost <= budget) {
      includedEvidence.push(message);
      used += cost;
    } else {
      droppedEvidenceCount++;
    }
  }

  // Walk backward by complete user turns. Stopping at the first turn that does
  // not fit keeps the selected transcript contiguous and tool protocol intact.
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i]!;
    const cost = estimateMessagesTokens(turn);
    if (used + cost > budget) {
      droppedMessageCount = turns.slice(0, i + 1).reduce((sum, item) => sum + item.length, 0);
      break;
    }
    includedTurns.unshift(turn);
    used += cost;
  }

  let omissionMessage: ChatCompletionMessageParam | null = null;
  if (droppedMessageCount > 0) {
    const role = baseMessages[0]?.role === 'developer' ? 'developer' as const : 'system' as const;
    const candidate: ChatCompletionMessageParam = {
      role,
      content: `[${droppedMessageCount} earlier message(s) were omitted to fit the context window]`,
    };
    const cost = estimateMessagesTokens([candidate]);
    if (used + cost <= budget) {
      omissionMessage = candidate;
      used += cost;
    }
  }

  // Semantic recall and activity summaries are supplemental to direct turns.
  for (const message of supplementalEvidenceMessages) {
    const cost = estimateMessagesTokens([message]);
    if (used + cost <= budget) {
      includedEvidence.push(message);
      used += cost;
    } else {
      droppedEvidenceCount++;
    }
  }

  const messages = [...baseMessages, ...includedEvidence];
  if (omissionMessage) messages.push(omissionMessage);
  messages.push(...includedTurns.flat());

  return { messages, droppedEvidenceCount, droppedMessageCount };
}

/** Split API history into user-led turns and remove orphaned tool protocol rows. */
function conversationTurns(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[][] {
  const rawTurns: ChatCompletionMessageParam[][] = [];
  for (const message of messages) {
    if (message.role === 'user') rawTurns.push([message]);
    else if (rawTurns.length > 0) rawTurns.at(-1)!.push(message);
  }
  return rawTurns.map(sanitizeToolProtocol).filter((turn) => turn.length > 0);
}

function sanitizeToolProtocol(turn: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const resultIds = new Set(turn.flatMap((message) => message.role === 'tool' ? [message.tool_call_id] : []));
  const retainedCallIds = new Set<string>();
  const normalized = turn.flatMap((message): ChatCompletionMessageParam[] => {
    if (message.role !== 'assistant' || !('tool_calls' in message) || !message.tool_calls?.length) return [message];
    const toolCalls = message.tool_calls.filter((call) => resultIds.has(call.id));
    toolCalls.forEach((call) => retainedCallIds.add(call.id));
    if (toolCalls.length > 0) return [{ ...message, tool_calls: toolCalls }];
    return typeof message.content === 'string' && message.content ? [{ role: 'assistant', content: message.content }] : [];
  });
  return normalized.filter((message) => message.role !== 'tool' || retainedCallIds.has(message.tool_call_id));
}
