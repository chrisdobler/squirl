import type { ModelConfig } from './types.js';

const CONFIGS: Record<string, ModelConfig> = {
  // Anthropic
  'claude-sonnet-4-6':          { id: 'claude-sonnet-4-6',          contextWindow: 200_000, supportsTools: true, systemPromptStyle: 'system' },
  'claude-opus-4-6':            { id: 'claude-opus-4-6',            contextWindow: 200_000, supportsTools: true, systemPromptStyle: 'system' },
  'claude-haiku-4-5-20251001':  { id: 'claude-haiku-4-5-20251001',  contextWindow: 200_000, supportsTools: true, systemPromptStyle: 'system' },
  // OpenAI
  'gpt-4o':      { id: 'gpt-4o',      contextWindow: 128_000, supportsTools: true,  systemPromptStyle: 'system' },
  'gpt-4o-mini': { id: 'gpt-4o-mini', contextWindow: 128_000, supportsTools: true,  systemPromptStyle: 'system' },
  'o3-mini':     { id: 'o3-mini',      contextWindow: 200_000, supportsTools: true,  systemPromptStyle: 'developer' },
};

const DEFAULT_CONFIG: ModelConfig = {
  id: 'unknown',
  contextWindow: 8_192,
  supportsTools: false,
  systemPromptStyle: 'system',
};

export function getModelConfig(modelId: string): ModelConfig {
  return CONFIGS[modelId] ?? { ...DEFAULT_CONFIG, id: modelId };
}
