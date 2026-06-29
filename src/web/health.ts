import type { Embedder, VectorStore } from '../search/types.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { SquirlConfig } from '../config.js';
import { withVectorStoreTimeout, isVectorStoreError, DEFAULT_VECTOR_STORE_TIMEOUT_MS } from '../search/stores/chroma.js';

export type HealthState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface HealthEntry {
  id: string;
  label: string;
  state: HealthState;
  detail?: string;
  latencyMs?: number;
}

export interface HealthReport {
  entries: HealthEntry[];
  checkedAt: string | null;
}

/** What to health-check; the runtime turns each target into a probe using its live instances. */
export interface HealthTarget {
  id: 'model' | 'embedder' | 'vectordb' | 'meta';
  label: string;
  kind: 'chat' | 'embedder' | 'vectorstore';
  /** chat targets: the configured model id + how to reach it (for the probe + detail text). */
  modelId?: string;
  provider?: string;
  baseUrl?: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe a chat/meta LLM by listing the endpoint's models and checking the configured model is present.
 * `listModels` is injected so the runtime supplies provider-specific fetching (local vs hosted) and
 * tests can fake it. ok = model present; degraded = endpoint up but model absent; down = unreachable.
 */
export async function probeChat(
  target: { id: string; label: string; modelId?: string },
  listModels: () => Promise<string[]>,
): Promise<HealthEntry> {
  const start = Date.now();
  try {
    const ids = await listModels();
    const latencyMs = Date.now() - start;
    if (ids.length === 0) {
      return { id: target.id, label: target.label, state: 'down', detail: 'no models returned', latencyMs };
    }
    if (target.modelId && !ids.includes(target.modelId)) {
      return { id: target.id, label: target.label, state: 'degraded', detail: `endpoint up, model "${target.modelId}" not loaded`, latencyMs };
    }
    return { id: target.id, label: target.label, state: 'ok', latencyMs };
  } catch (err) {
    return { id: target.id, label: target.label, state: 'down', detail: errText(err), latencyMs: Date.now() - start };
  }
}

/** Probe the embedder by embedding a tiny string. ok = resolves; down = throws. */
export async function probeEmbedder(embedder: Embedder, label: string): Promise<HealthEntry> {
  const start = Date.now();
  try {
    await embedder.embed(['ping']);
    return { id: 'embedder', label, state: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { id: 'embedder', label, state: 'down', detail: errText(err), latencyMs: Date.now() - start };
  }
}

/** Probe the vector store with a cheap keyed lookup, bounded by the store timeout. */
export async function probeVectorStore(store: VectorStore, label: string): Promise<HealthEntry> {
  const start = Date.now();
  try {
    await withVectorStoreTimeout(store.has(['__healthcheck__']), DEFAULT_VECTOR_STORE_TIMEOUT_MS);
    return { id: 'vectordb', label, state: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const detail = isVectorStoreError(err) ? err.message : errText(err);
    return { id: 'vectordb', label, state: 'down', detail, latencyMs: Date.now() - start };
  }
}

function metaSpec(config: SquirlConfig): { provider: string; model: string; baseUrl?: string } {
  const provider = config.index?.metaProvider ?? config.defaultProvider ?? 'openai';
  const model = config.index?.metaModel
    ?? (provider === 'local' ? (config.defaultModel ?? 'default') : 'gpt-4o-mini');
  const baseUrl = provider === 'local' ? config.localBaseUrl : undefined;
  return { provider, model, ...(baseUrl ? { baseUrl } : {}) };
}

/**
 * Derive the set of dependency lights from config: the main model is always shown; the embedder and
 * vector store appear when memory is enabled (vector store only when not 'null'); the meta-LLM gets
 * its own light only when it resolves to a different endpoint/model than the main model.
 */
export function buildHealthTargets(config: SquirlConfig, selectedModel: SelectedModel): HealthTarget[] {
  const targets: HealthTarget[] = [{
    id: 'model',
    label: 'model',
    kind: 'chat',
    modelId: selectedModel.id,
    provider: selectedModel.provider,
    ...(selectedModel.baseUrl ? { baseUrl: selectedModel.baseUrl } : {}),
  }];

  if (config.index?.enabled) {
    targets.push({ id: 'embedder', label: 'embedder', kind: 'embedder' });
    if (config.index.store !== 'null') {
      targets.push({ id: 'vectordb', label: 'vector db', kind: 'vectorstore' });
    }

    const meta = metaSpec(config);
    const sameAsMain = meta.provider === selectedModel.provider
      && meta.model === selectedModel.id
      && (meta.baseUrl ?? undefined) === (selectedModel.baseUrl ?? undefined);
    if (!sameAsMain) {
      targets.push({ id: 'meta', label: 'query model', kind: 'chat', modelId: meta.model, provider: meta.provider, ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}) });
    }
  }

  return targets;
}

export function unknownReport(config: SquirlConfig, selectedModel: SelectedModel): HealthReport {
  return {
    entries: buildHealthTargets(config, selectedModel).map((t) => ({ id: t.id, label: t.label, state: 'unknown' as const })),
    checkedAt: null,
  };
}
