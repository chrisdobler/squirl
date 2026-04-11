import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatCompletionMessageParam, ChatCompletionFunctionTool } from 'openai/resources/chat/completions.js';
import type { MessageParam, ContentBlockParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { SelectedModel } from './components/ModelPicker.js';
import type { ToolCall } from './types.js';

// --- Debug Logging ---

const DEBUG = !!process.env.SQUIRL_DEBUG;
const DEBUG_LOG = join(homedir(), '.squirl', 'debug.log');

function debugLog(label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    mkdirSync(join(homedir(), '.squirl'), { recursive: true });
    const ts = new Date().toISOString();
    const entry = `\n[${ts}] ${label}\n${JSON.stringify(data, null, 2)}\n`;
    appendFileSync(DEBUG_LOG, entry);
  } catch { /* best effort */ }
}

export interface StreamOptions {
  messages: ChatCompletionMessageParam[];
  model: SelectedModel;
  tools?: ChatCompletionFunctionTool[];
  onToken: (token: string) => void;
  onToolCalls?: (toolCalls: ToolCall[]) => void;
  onDone: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

export async function streamChatCompletion(options: StreamOptions): Promise<void> {
  if (options.model.provider === 'anthropic') {
    return streamAnthropic(options);
  }
  return streamOpenAI(options);
}

// --- OpenAI / Local ---

async function streamOpenAI(options: StreamOptions): Promise<void> {
  const { messages, model, tools, onToken, onToolCalls, onDone, onError, signal } = options;

  try {
    let client: OpenAI;
    if (model.provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        onError(new Error('OPENAI_API_KEY environment variable is not set'));
        return;
      }
      client = new OpenAI({ apiKey });
    } else {
      client = new OpenAI({ baseURL: model.baseUrl, apiKey: 'not-needed' });
    }

    let doneCalled = false;
    const baseParams = {
      model: model.id,
      messages,
      stream: true as const,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    debugLog('OpenAI REQUEST', { baseUrl: model.baseUrl, ...baseParams, stream: undefined });

    let stream;
    try {
      stream = await client.chat.completions.create({
        ...baseParams,
        stream_options: { include_usage: true },
      }, { signal });
    } catch {
      stream = await client.chat.completions.create(baseParams, { signal });
    }

    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let completionChars = 0;
    let fullResponse = '';

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta?.content;
      if (delta) {
        completionChars += delta.length;
        fullResponse += delta;
        onToken(delta);
      }

      const tcDeltas = choice.delta?.tool_calls;
      if (tcDeltas) {
        for (const tc of tcDeltas) {
          const existing = pendingToolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          pendingToolCalls.set(tc.index, existing);
        }
      }

      if (chunk.usage) {
        doneCalled = true;
        onDone({
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
        });
      }
    }

    debugLog('OpenAI RESPONSE', {
      content: fullResponse,
      toolCalls: pendingToolCalls.size > 0 ? [...pendingToolCalls.values()] : undefined,
    });

    if (pendingToolCalls.size > 0 && onToolCalls) {
      onToolCalls([...pendingToolCalls.values()]);
    }

    if (!doneCalled) {
      // Estimate tokens if provider doesn't support stream usage reporting
      const estimatedPrompt = messages.reduce((sum, m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(content.length / 4);
      }, 0);
      const toolChars = pendingToolCalls.size > 0
        ? JSON.stringify([...pendingToolCalls.values()]).length : 0;
      const estimatedCompletion = Math.ceil((completionChars + toolChars) / 4);
      onDone({ promptTokens: estimatedPrompt, completionTokens: estimatedCompletion, totalTokens: estimatedPrompt + estimatedCompletion });
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

// --- Anthropic ---

function toAnthropicMessages(messages: ChatCompletionMessageParam[]): {
  system: string;
  anthropicMessages: MessageParam[];
} {
  let system = '';
  const anthropicMessages: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Concatenate system messages
      const text = typeof msg.content === 'string' ? msg.content : '';
      system += (system ? '\n\n' : '') + text;
      continue;
    }

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      anthropicMessages.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const contentBlocks: ContentBlockParam[] = [];
      const textContent = typeof msg.content === 'string' ? msg.content : '';
      if (textContent) {
        contentBlocks.push({ type: 'text', text: textContent });
      }
      // Convert tool_calls to tool_use content blocks
      const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as Array<{
        id: string;
        function: { name: string; arguments: string };
      }> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      if (contentBlocks.length > 0) {
        anthropicMessages.push({ role: 'assistant', content: contentBlocks });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Anthropic expects tool results as user messages with tool_result content blocks
      const toolMsg = msg as { tool_call_id: string; content: string };
      const toolResult: ContentBlockParam = {
        type: 'tool_result',
        tool_use_id: toolMsg.tool_call_id,
        content: toolMsg.content,
      };
      // Merge with previous user message if it's also a tool_result, or create new
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as ContentBlockParam[]).push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }
  }

  return { system, anthropicMessages };
}

function toAnthropicTools(tools: ChatCompletionFunctionTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Tool['input_schema'],
  }));
}

async function streamAnthropic(options: StreamOptions): Promise<void> {
  const { messages, model, tools, onToken, onToolCalls, onDone, onError, signal } = options;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      onError(new Error('ANTHROPIC_API_KEY environment variable is not set'));
      return;
    }

    const client = new Anthropic({ apiKey });
    const { system, anthropicMessages } = toAnthropicMessages(messages);

    const createParams: Record<string, unknown> = {
      model: model.id,
      max_tokens: 8192,
      stream: true,
      messages: anthropicMessages,
    };

    if (system) {
      createParams.system = system;
    }

    if (tools && tools.length > 0) {
      createParams.tools = toAnthropicTools(tools);
    }

    debugLog('Anthropic REQUEST', createParams);

    const stream = client.messages.stream(createParams as Parameters<typeof client.messages.stream>[0], { signal });

    const pendingToolCalls: ToolCall[] = [];
    let fullResponse = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          fullResponse += event.delta.text;
          onToken(event.delta.text);
        } else if (event.delta.type === 'input_json_delta') {
          // Accumulate tool call JSON arguments
          const tc = pendingToolCalls[pendingToolCalls.length - 1];
          if (tc) {
            tc.arguments += event.delta.partial_json;
          }
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          pendingToolCalls.push({
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: '',
          });
        }
      } else if (event.type === 'message_delta') {
        // Usage comes with message_delta or message_stop
        const usage = (event as unknown as Record<string, unknown>).usage as { output_tokens?: number } | undefined;
        if (usage) {
          // We'll emit in message_stop
        }
      } else if (event.type === 'message_stop') {
        // Done
      }
    }

    // Get final message for usage
    const finalMessage = await stream.finalMessage();
    const inputTokens = finalMessage.usage?.input_tokens ?? 0;
    const outputTokens = finalMessage.usage?.output_tokens ?? 0;

    debugLog('Anthropic RESPONSE', {
      content: fullResponse,
      toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      usage: { inputTokens, outputTokens },
    });

    if (pendingToolCalls.length > 0 && onToolCalls) {
      onToolCalls(pendingToolCalls);
    }

    onDone({
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

// --- Model Detection ---

export type LocalBackend = 'vllm' | 'ollama' | 'lmstudio' | 'llamacpp' | 'unknown';

export const BACKEND_DISPLAY_NAMES: Record<LocalBackend, string> = {
  vllm: 'vLLM',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  unknown: '',
};

export interface DetectedModel {
  id: string;
  contextWindow?: number;
}

/** Strip /v1 suffix to get the server root URL */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/**
 * Auto-detect what backend is serving at the given base URL.
 */
export async function detectLocalBackend(baseUrl: string): Promise<LocalBackend> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    // Check for Ollama via its native /api/tags endpoint
    const ollamaRes = await fetch(serverRoot(baseUrl) + '/api/tags', { signal: controller.signal });
    if (ollamaRes.ok) {
      clearTimeout(timeout);
      return 'ollama';
    }
  } catch { /* not ollama */ }

  try {
    // Check /v1/models for owned_by hints
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json() as { data?: Array<{ owned_by?: string }> };
      const ownedBy = json.data?.[0]?.owned_by?.toLowerCase() ?? '';
      if (ownedBy === 'vllm') return 'vllm';
      if (ownedBy.includes('lmstudio') || ownedBy.includes('lm-studio')) return 'lmstudio';
      if (ownedBy.includes('llamacpp') || ownedBy.includes('llama.cpp') || ownedBy.includes('llama-cpp')) return 'llamacpp';
    }
  } catch { /* detection failed */ }

  clearTimeout(timeout);
  return 'unknown';
}

/**
 * Fetch available models from the server. Context window extraction
 * depends on the detected backend type.
 */
export async function fetchAvailableModels(baseUrl: string, backend?: LocalBackend): Promise<DetectedModel[]> {
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return [];

    const json = await res.json() as { data?: Array<{ id: string; owned_by?: string; context_window?: number; context_length?: number; max_model_len?: number; max_context_length?: number }> };
    const models = (json.data ?? []).map((m) => ({
      id: m.id,
      contextWindow: m.context_window ?? m.context_length ?? m.max_model_len ?? m.max_context_length,
    }));

    // For Ollama, fetch context window from native /api/show endpoint
    if (backend === 'ollama') {
      await Promise.all(models.map(async (model) => {
        if (model.contextWindow) return;
        try {
          const showRes = await fetch(serverRoot(baseUrl) + '/api/show', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model.id }),
          });
          if (showRes.ok) {
            const info = await showRes.json() as { model_info?: Record<string, unknown> };
            const ctxLength = info.model_info?.['context_length'];
            if (typeof ctxLength === 'number') {
              model.contextWindow = ctxLength;
            }
          }
        } catch { /* skip */ }
      }));
    }

    return models;
  } catch {
    return [];
  }
}
