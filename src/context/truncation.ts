import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { estimateMessagesTokens } from './token-estimator.js';

export interface TruncationResult {
  messages: ChatCompletionMessageParam[];
  droppedEvidenceCount: number;
  droppedMessageCount: number;
}

export function truncateToFit(
  baseMessages: ChatCompletionMessageParam[],
  evidenceMessages: ChatCompletionMessageParam[],
  conversationMessages: ChatCompletionMessageParam[],
  maxTokens: number,
  reserveForCompletion: number = 4096,
): TruncationResult {
  const budget = Math.max(0, maxTokens - reserveForCompletion);
  let used = estimateMessagesTokens(baseMessages);
  let droppedEvidenceCount = 0;
  let droppedMessageCount = 0;

  // The newest conversation message is the current user request. It is mandatory:
  // sending an over-budget request is preferable to silently asking the model a
  // different question. Older conversation is then included newest-first.
  const includedConversation: ChatCompletionMessageParam[] = [];
  const latestMessage = conversationMessages.at(-1);
  if (latestMessage) {
    includedConversation.unshift(latestMessage);
    used += estimateMessagesTokens([latestMessage]);
  }

  for (let i = conversationMessages.length - 2; i >= 0; i--) {
    const msg = conversationMessages[i]!;
    const cost = estimateMessagesTokens([msg]);
    if (used + cost > budget) {
      droppedMessageCount = i + 1;
      break;
    }
    includedConversation.unshift(msg);
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

  // Evidence is ordered from highest to lowest priority by the caller. Select it
  // only after recent conversation, while preserving its role as untrusted user data.
  const includedEvidence: ChatCompletionMessageParam[] = [];
  for (const message of evidenceMessages) {
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
  messages.push(...includedConversation);

  return { messages, droppedEvidenceCount, droppedMessageCount };
}
