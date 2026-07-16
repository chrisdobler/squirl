import type { MetaLLM } from './meta-extract.js';
import type { SquirlConfig } from '../config.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { searchLog } from './debug.js';

export const META_LLM_TIMEOUT_MS = 5_000;
export const TASK_META_LLM_TIMEOUT_MS = 60_000;

type OpenAICreateFn = (params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
}, options?: { signal?: AbortSignal }) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;

interface OpenAIMetaLLMOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  createFn?: OpenAICreateFn;
}

export class OpenAIMetaLLM implements MetaLLM {
  private readonly model: string;
  private readonly create: OpenAICreateFn;
  // chat_template_kwargs is a vLLM extension; real OpenAI rejects it. Only send it to local servers.
  private readonly isLocal: boolean;

  constructor(opts: OpenAIMetaLLMOptions) {
    this.model = opts.model;
    this.isLocal = Boolean(opts.baseUrl);
    if (opts.createFn) {
      this.create = opts.createFn;
    } else {
      const client = new OpenAI({
        // Newer SDK releases reject an empty key during construction. Local
        // OpenAI-compatible servers do not require one, and hosted requests
        // should fail at request time with their normal authentication error.
        apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-configured',
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
        timeout: opts.timeoutMs ?? META_LLM_TIMEOUT_MS,
        maxRetries: 0,
      });
      this.create = (params, options) => client.chat.completions.create(params as any, options) as any;
    }
  }

  async complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
  }): Promise<string> {
    const request = {
      model: this.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        ...params.messages,
      ],
      max_tokens: 1024,
      temperature: 0.1,
      ...(this.isLocal ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
    searchLog('META-LLM RAW REQUEST', { model: this.model, messageCount: request.messages.length });
    const response = params.signal ? await this.create(request, { signal: params.signal }) : await this.create(request);
    searchLog('META-LLM RAW RESPONSE', { content: response.choices[0]?.message?.content, finishReason: (response.choices[0] as any)?.finish_reason });
    return response.choices[0]?.message?.content ?? '';
  }
}

type AnthropicCreateFn = (params: {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  max_tokens: number;
  temperature?: number;
}, options?: { signal?: AbortSignal }) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface AnthropicMetaLLMOptions {
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  createFn?: AnthropicCreateFn;
}

export class AnthropicMetaLLM implements MetaLLM {
  private readonly model: string;
  private readonly create: AnthropicCreateFn;

  constructor(opts: AnthropicMetaLLMOptions) {
    this.model = opts.model;
    if (opts.createFn) {
      this.create = opts.createFn;
    } else {
      const client = new Anthropic({
        apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
        timeout: opts.timeoutMs ?? META_LLM_TIMEOUT_MS,
        maxRetries: 0,
      });
      this.create = (params, options) => client.messages.create(params as any, options) as any;
    }
  }

  async complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
  }): Promise<string> {
    const request = {
      model: this.model,
      system: params.systemPrompt,
      messages: params.messages,
      max_tokens: 1024,
      temperature: 0,
    };
    const response = params.signal ? await this.create(request, { signal: params.signal }) : await this.create(request);
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }
}

export interface MetaLLMSpec {
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  /** OpenAI-compatible base URL (used for local providers). */
  baseUrl?: string;
  apiKey?: string;
  /** Request timeout; defaults to 5s (fine for query extraction; the judge sets it higher). */
  timeoutMs?: number;
}

/**
 * Construct a MetaLLM from a provider spec. Anthropic uses the Messages API; openai and local both
 * use the OpenAI-compatible chat API, differing only by baseUrl. Shared by the runtime memory
 * pipeline and the eval harness/judge so provider wiring lives in one place.
 */
export function createMetaLLM(spec: MetaLLMSpec): MetaLLM {
  if (spec.provider === 'anthropic') {
    return new AnthropicMetaLLM({ model: spec.model, ...(spec.apiKey ? { apiKey: spec.apiKey } : {}), ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) });
  }
  return new OpenAIMetaLLM({
    model: spec.model,
    ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
  });
}

/** Build the small configured model used by JSON-only runtime classifiers. */
export function createConfiguredMetaLLM(config: SquirlConfig, timeoutMs?: number): MetaLLM {
  const provider = config.index?.metaProvider ?? config.defaultProvider ?? 'openai';
  const model = config.index?.metaModel ?? (provider === 'local'
    ? (config.defaultModel ?? 'default')
    : provider === 'anthropic'
      ? 'claude-haiku-4-5-20251001'
      : 'gpt-4o-mini');
  return createMetaLLM({
    provider,
    model,
    ...(provider === 'local' && config.localBaseUrl ? { baseUrl: config.localBaseUrl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

/** Build the slower JSON model used by current-task and Scrum classification. */
export function createConfiguredTaskMetaLLM(config: SquirlConfig): MetaLLM {
  return createConfiguredMetaLLM(config, TASK_META_LLM_TIMEOUT_MS);
}
