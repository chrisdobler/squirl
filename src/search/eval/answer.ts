import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { streamChatCompletion } from '../../api.js';
import type { SelectedModel } from '../../components/ModelPicker.js';
import type { EvalConversationMessage } from './types.js';

export interface GenerateAnswerParams {
  model: SelectedModel;
  /** System messages (e.g. base prompt + the memory system message); empty ones are dropped. */
  systemMessages: string[];
  conversation: EvalConversationMessage[];
  userMessage: string;
  signal?: AbortSignal;
}

/**
 * Generate a single assistant answer for a conversation. The codebase has no non-streaming helper,
 * so we accumulate tokens from streamChatCompletion (same pattern as runtime.testModelConnection).
 */
export async function generateAnswer(params: GenerateAnswerParams): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    ...params.systemMessages.filter((s) => s.trim().length > 0).map((content) => ({ role: 'system' as const, content })),
    ...params.conversation.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: params.userMessage },
  ];

  let content = '';
  let error: Error | null = null;
  await streamChatCompletion({
    messages,
    model: params.model,
    onToken: (token) => { content += token; },
    onDone: () => {},
    onError: (err) => { error = err; },
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (error) throw error;
  return content;
}
