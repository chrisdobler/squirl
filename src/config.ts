import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { LocalBackend } from './api.js';

export interface SquirlConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  defaultProvider?: 'anthropic' | 'openai' | 'local';
  defaultModel?: string;
  localBaseUrl?: string;
  localBackend?: LocalBackend;
  index?: {
    enabled: boolean;
    store: 'local-chroma' | 'remote-chroma' | 'null';
    chromaUrl?: string;
    chromaAuthToken?: string;
    collection?: string;
    embedder: 'openai' | 'local';
    embedderModel?: string;
    embedderUrl?: string;
    metaModel?: string;
    metaProvider?: 'openai' | 'anthropic' | 'local';
    recallK?: number;
  };
}

const CONFIG_DIR = join(homedir(), '.squirl');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): SquirlConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as SquirlConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: SquirlConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Apply config API keys to process.env as fallbacks
 * (env vars still take priority).
 */
export function applyConfigToEnv(config: SquirlConfig): void {
  if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.openaiApiKey && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = config.openaiApiKey;
  }
}
