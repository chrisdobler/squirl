import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { LocalBackend } from './api.js';
import type { AgentKind, ClaudePermissionMode, CodexSandbox } from './agents/types.js';
import type { EffortLevel } from './types.js';

export interface AgentProfile {
  /** Stable profile identity; unlike id, this does not change when the agent is renamed. */
  profileId?: string;
  kind: AgentKind;
  /** @handle used for routing. */
  id?: string;
  label?: string;
  /** Human-readable role used by Squirl when coordinating the room. */
  specialty?: string;
  model?: string;
  effort?: EffortLevel;
  bin?: string;
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
  /** Auto-connect this profile when Squirl starts. Defaults to true for compatibility. */
  reconnect?: boolean;
}

export interface AgentsConfig {
  /** When true, an agent's @mention of another participant auto-routes the turn. Default false. */
  autoHandoff?: boolean;
  /** Max consecutive auto-handoffs per dispatch. Default 3. */
  maxHops?: number;
  /** Path/name of the claude binary. Default 'claude' (on PATH). */
  claudeBin?: string;
  /** Path/name of the codex binary. Default 'codex' (on PATH). */
  codexBin?: string;
  /** Default Claude permission mode for new agents. Default 'default' (asks before edits/commands). */
  defaultClaudePermissionMode?: ClaudePermissionMode;
  /** Default Codex sandbox for new agents. Default 'read-only'. */
  defaultCodexSandbox?: CodexSandbox;
  /** Agents to auto-start when squirl launches. */
  defaults?: AgentProfile[];
}

export interface SquirlConfig {
  userProfile?: {
    /** The form of address the user explicitly supplied. Never inferred from the machine. */
    displayName?: string;
    /** Records that the optional profile question was answered or skipped. */
    onboardingComplete?: boolean;
  };
  anthropicApiKey?: string;
  openaiApiKey?: string;
  defaultProvider?: 'anthropic' | 'openai' | 'local';
  defaultModel?: string;
  localBaseUrl?: string;
  localBackend?: LocalBackend;
  /** Per-model context window sizes, captured when a model is first configured. Keyed by model id. */
  modelContextWindows?: Record<string, number>;
  mouseScrollLines?: number;
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
  eval?: {
    /** Automatic self-monitoring: periodically run an eval so the app tracks its own memory quality. */
    monitor?: {
      enabled?: boolean;
      intervalHours?: number;       // default 24
      layer?: 1 | 2 | 3;            // default 1
      mode?: 'frozen' | 'live';     // default 'frozen'
    };
  };
  agents?: AgentsConfig;
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
 * Return a config with `modelId`'s context window recorded, so it survives restarts.
 * Returns the same config unchanged when there's nothing new to store (callers can
 * skip persisting in that case). Does not write to disk — the caller decides when.
 */
export function rememberContextWindow(config: SquirlConfig, modelId: string, window: number): SquirlConfig {
  if (!window || config.modelContextWindows?.[modelId] === window) return config;
  return { ...config, modelContextWindows: { ...config.modelContextWindows, [modelId]: window } };
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
