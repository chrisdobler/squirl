import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeModelOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClaudeModelDiscovery {
  models: ClaudeModelOption[];
  defaultModel?: string;
}

const CLAUDE_MODEL_ALIASES: ClaudeModelOption[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

interface ClaudeState {
  additionalModelOptionsCache?: Array<{
    value?: string;
    label?: string;
    description?: string;
  }>;
}

interface ClaudeSettings {
  model?: string;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    // Claude may update its state while Squirl reads it. The aliases remain usable.
    return undefined;
  }
}

/** Read account-specific choices maintained by Claude Code and add its stable model aliases. */
export function discoverClaudeModels(claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): ClaudeModelDiscovery {
  const settings = readJson<ClaudeSettings>(join(claudeHome, 'settings.json'));
  const statePath = claudeHome === join(homedir(), '.claude')
    ? join(homedir(), '.claude.json')
    : join(claudeHome, '.claude.json');
  const state = readJson<ClaudeState>(statePath);
  const models = [...CLAUDE_MODEL_ALIASES];

  for (const option of state?.additionalModelOptionsCache ?? []) {
    const id = option.value?.trim();
    if (!id || models.some((model) => model.id === id)) continue;
    models.push({
      id,
      label: option.label?.trim() || id,
      ...(option.description?.trim() ? { description: option.description.trim() } : {}),
    });
  }

  const defaultModel = settings?.model?.trim() || undefined;
  if (defaultModel && !models.some((model) => model.id === defaultModel)) {
    models.unshift({ id: defaultModel, label: defaultModel });
  }

  return { models, ...(defaultModel ? { defaultModel } : {}) };
}
