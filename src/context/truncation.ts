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

  const result: ChatCompletionMessageParam[] = [
    ...systemMessages,
  ];

  if (includedFileContext) {
    result.push(includedFileContext);
  }

  if (droppedMessageCount > 0) {
    result.push({
      role: 'system',
      content: `[${droppedMessageCount} earlier message(s) were omitted to fit the context window]`,
    });
  }

  result.push(...included);

  return { messages: result, droppedFileCount, droppedMessageCount };
}
