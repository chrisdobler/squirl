import type { Message } from '../types.js';

const SYSTEM_PROMPT = `You are a search query generator. Given the conversation below, generate 2-3 short search queries that would find relevant prior conversations from the user's history. Focus on topics, tools, concepts, or patterns the user might have discussed before. Output a JSON array of strings, nothing else.`;

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
    const messages = conversation
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    messages.push({ role: 'user', content: userMessage });

    const response = await llm.complete({ systemPrompt: SYSTEM_PROMPT, messages });

    const parsed = JSON.parse(response);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === 'string');
  } catch {
    return [];
  }
}
