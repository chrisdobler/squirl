import type { Embedder } from '../types.js';
import { OpenAIEmbedder } from './openai.js';
import { OllamaEmbedder } from './ollama.js';
import type { LocalBackend } from '../../api.js';

export interface EmbedderConfig {
  type: 'openai' | 'local';
  apiKey?: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  detectedBackend?: LocalBackend;
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  if (config.type === 'openai' && !config.detectedBackend) {
    return new OpenAIEmbedder({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      model: config.model,
      dimensions: config.dimensions,
    });
  }

  // Local server — use Ollama embedder for Ollama, OpenAI-compat for everything else
  if (config.detectedBackend === 'ollama') {
    return new OllamaEmbedder({ model: config.model, dimensions: config.dimensions, baseUrl: config.baseUrl });
  }

  return new OpenAIEmbedder({
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-needed',
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl,
  });
}
