import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatCompletionMessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // role + metadata overhead
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part) total += estimateTokens(part.text);
      }
    }
  }
  return total;
}
