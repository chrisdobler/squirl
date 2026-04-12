import type { Embedder } from '../types.js';
import { OpenAIEmbedder } from './openai.js';
import { OllamaEmbedder } from './ollama.js';

export interface EmbedderConfig {
  type: 'openai' | 'ollama';
  apiKey?: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  switch (config.type) {
    case 'openai': return new OpenAIEmbedder({ apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? '', model: config.model, dimensions: config.dimensions });
    case 'ollama': return new OllamaEmbedder({ model: config.model, dimensions: config.dimensions, baseUrl: config.baseUrl });
    default: throw new Error(`Unknown embedder type: ${(config as any).type}`);
  }
}
