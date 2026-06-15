import type { Message } from '../types.js';
import { searchLog } from './debug.js';

const SYSTEM_PROMPT = `/no_think
You are a JSON-only search query extraction tool. You MUST respond with ONLY a raw JSON array of 2-3 search query strings. No prose, no markdown, no explanation.

Your input is a conversation. Extract key topics the user might have discussed before.

CORRECT output format: ["search term one", "search term two", "search term three"]
WRONG output: Any text that is not a JSON array.`;

export interface MetaLLM {
  complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<string>;
}

export async function extractSearchQueries(
  conversation: Message[],
  userMessage: string,
  llm: MetaLLM,
): Promise<string[]> {
  try {
    let recent = conversation
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 500) }));

    // Ensure messages start with a user turn (required by some chat templates)
    while (recent.length > 0 && recent[0]!.role !== 'user') {
      recent = recent.slice(1);
    }

    const messages = [...recent, { role: 'user' as const, content: userMessage }];

    searchLog('META-LLM REQUEST', { messageCount: messages.length, userMessage: userMessage.slice(0, 100) });
    const response = await llm.complete({ systemPrompt: SYSTEM_PROMPT, messages });
    searchLog('META-LLM RESPONSE', response);

    const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === 'string');
  } catch (err) {
    searchLog('META-LLM ERROR', err instanceof Error ? err.message : String(err));
    return [];
  }
}
