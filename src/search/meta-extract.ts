import type { Message } from '../types.js';
import { searchLog } from './debug.js';

const SYSTEM_PROMPT = `/no_think
Generate 2-3 short search queries to find relevant prior conversations. Output ONLY a JSON array. Example: ["query one", "query two"]`;

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
    const recent = conversation
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 500) }));

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
