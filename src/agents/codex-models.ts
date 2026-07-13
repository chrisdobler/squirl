import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexModelOption {
  id: string;
  label: string;
  contextWindow?: number;
}

export interface CodexModelDiscovery {
  models: CodexModelOption[];
  defaultModel?: string;
}

interface CodexModelsCache {
  models?: Array<{
    slug?: string;
    display_name?: string;
    visibility?: string;
    priority?: number;
    context_window?: number;
    effective_context_window_percent?: number;
  }>;
}

function configuredModel(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  const match = readFileSync(configPath, 'utf-8').match(/^model\s*=\s*["']([^"']+)["']/m);
  return match?.[1]?.trim() || undefined;
}

/** Read the model list maintained by the installed Codex CLI. */
export function discoverCodexModels(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): CodexModelDiscovery {
  const defaultModel = configuredModel(join(codexHome, 'config.toml'));
  const cachePath = join(codexHome, 'models_cache.json');
  let models: CodexModelOption[] = [];

  if (existsSync(cachePath)) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as CodexModelsCache;
      models = (cache.models ?? [])
        .filter((model) => model.slug && model.visibility !== 'hide')
        .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
        .map((model) => {
          const contextWindow = model.context_window && model.context_window > 0
            ? Math.floor(model.context_window * ((model.effective_context_window_percent ?? 100) / 100))
            : undefined;
          return {
            id: model.slug!,
            label: model.display_name?.trim() || model.slug!,
            ...(contextWindow ? { contextWindow } : {}),
          };
        });
    } catch {
      // The CLI may be replacing this cache while Squirl reads it. Keep chat/runtime paths usable.
    }
  }

  if (defaultModel && !models.some((model) => model.id === defaultModel)) {
    models.unshift({ id: defaultModel, label: defaultModel });
  }

  return { models, ...(defaultModel ? { defaultModel } : {}) };
}
