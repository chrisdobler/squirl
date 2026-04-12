import type { Importer } from '../types.js';
import { ChatGPTImporter } from './chatgpt.js';

const importers: Record<string, () => Importer> = {
  chatgpt: () => new ChatGPTImporter(),
};

export function getImporter(name: string): Importer {
  const factory = importers[name];
  if (!factory) throw new Error(`Unknown importer: ${name}. Available: ${Object.keys(importers).join(', ')}`);
  return factory();
}
