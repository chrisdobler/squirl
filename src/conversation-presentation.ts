import type { Message } from './types.js';

/**
 * Keep the latest model generation visible. Pre-tool prose acts as a planning
 * preview until the follow-up generation starts, when the final answer replaces it.
 * Protocol messages remain in storage and prompt history.
 */
export function presentedConversation(messages: Message[]): Message[] {
  const superseded = new Set<number>();
  let pendingToolAssistantIndexes: number[] = [];

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      pendingToolAssistantIndexes = [];
      return;
    }
    if (message.role !== 'assistant') return;

    for (const pendingIndex of pendingToolAssistantIndexes) superseded.add(pendingIndex);
    pendingToolAssistantIndexes = message.toolCalls?.length ? [index] : [];
  });

  return messages.filter((_message, index) => !superseded.has(index));
}
