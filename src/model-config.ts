import type { ModelConfig } from './types.js';
import type { SquirlConfig } from './config.js';
import type { SelectedModel } from './components/ModelPicker.js';

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

/**
 * Context window for a model id only when we genuinely know it (curated constant).
 * Unlike `getModelConfig`, this returns `undefined` for unknown ids rather than the
 * 8192 default — so the UI can show "?" instead of a misleading number.
 */
export function getKnownContextWindow(modelId: string): number | undefined {
  return CONFIGS[modelId]?.contextWindow;
}

/**
 * Resolve the context window to display for a model, preferring real sources and
 * returning `undefined` when it's genuinely unknown:
 *   1. the live, just-discovered value on the selected model
 *   2. the value persisted when the model was first configured
 *   3. a curated constant for known cloud models
 */
export function resolveContextWindow(model: SelectedModel, config: SquirlConfig): number | undefined {
  return model.contextWindow
    ?? config.modelContextWindows?.[model.id]
    ?? getKnownContextWindow(model.id);
}
