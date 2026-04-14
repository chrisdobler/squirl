import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { estimateTokens, estimateMessagesTokens } from './token-estimator.js';

export interface TruncationResult {
  messages: ChatCompletionMessageParam[];
  droppedFileCount: number;
  droppedMessageCount: number;
}

export function truncateToFit(
  systemMessages: ChatCompletionMessageParam[],
  fileContextMessage: ChatCompletionMessageParam | null,
  conversationMessages: ChatCompletionMessageParam[],
  maxTokens: number,
  reserveForCompletion: number = 4096,
): TruncationResult {
  const budget = maxTokens - reserveForCompletion;
  let used = estimateMessagesTokens(systemMessages);
  let droppedFileCount = 0;
  let droppedMessageCount = 0;

  // Try to include file context
  let includedFileContext: ChatCompletionMessageParam | null = null;
  if (fileContextMessage) {
    const fileCost = estimateMessagesTokens([fileContextMessage]);
    if (used + fileCost < budget) {
      includedFileContext = fileContextMessage;
      used += fileCost;
    } else {
      droppedFileCount = 1; // simplified — dropped entire file context block
    }
  }

  // Include conversation messages from newest to oldest
  const included: ChatCompletionMessageParam[] = [];
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i]!;
    const cost = estimateMessagesTokens([msg]);
    if (used + cost > budget) {
      droppedMessageCount = i + 1;
      break;
    }
    included.unshift(msg);
    used += cost;
  }

  const systemParts: string[] = [];
  for (const msg of systemMessages) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text) systemParts.push(text);
  }
  if (includedFileContext) {
    const text = typeof includedFileContext.content === 'string' ? includedFileContext.content : '';
    if (text) systemParts.push(text);
  }
  if (droppedMessageCount > 0) {
    systemParts.push(`[${droppedMessageCount} earlier message(s) were omitted to fit the context window]`);
  }

  const result: ChatCompletionMessageParam[] = [];
  if (systemParts.length > 0) {
    const role = systemMessages[0]?.role === 'developer' ? 'developer' as const : 'system' as const;
    result.push({ role, content: systemParts.join('\n\n') });
  }
  result.push(...included);

  return { messages: result, droppedFileCount, droppedMessageCount };
}
