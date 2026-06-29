import { describe, it, expect } from 'vitest';
import { probeChat, probeEmbedder, probeVectorStore, buildHealthTargets } from './health.js';
import type { Embedder, VectorStore } from '../search/types.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { SquirlConfig } from '../config.js';

const fakeEmbedder = (impl: () => Promise<number[][]>): Embedder => ({ name: 'e', dimensions: 3, embed: impl });
const fakeStore = (has: (ids: string[]) => Promise<Set<string>>): VectorStore => ({
  upsert: async () => {}, query: async () => [], has, delete: async () => {}, close: async () => {},
});

describe('probeChat', () => {
  const target = { id: 'model', label: 'model', modelId: 'llama-70b' };

  it('is ok when the configured model is in the list', async () => {
    const entry = await probeChat(target, async () => ['llama-70b', 'other']);
    expect(entry.state).toBe('ok');
  });

  it('is degraded when the endpoint responds but the model is absent', async () => {
    const entry = await probeChat(target, async () => ['bge-large']);
    expect(entry.state).toBe('degraded');
    expect(entry.detail).toMatch(/not loaded|not found|absent/i);
  });

  it('is down when the listing call throws', async () => {
    const entry = await probeChat(target, async () => { throw new Error('ECONNREFUSED'); });
    expect(entry.state).toBe('down');
    expect(entry.detail).toMatch(/ECONNREFUSED/);
  });

  it('is down when the endpoint returns an empty list', async () => {
    const entry = await probeChat(target, async () => []);
    expect(entry.state).toBe('down');
  });
});

describe('probeEmbedder', () => {
  it('is ok when embed resolves', async () => {
    const entry = await probeEmbedder(fakeEmbedder(async () => [[0.1, 0.2, 0.3]]), 'embedder');
    expect(entry.state).toBe('ok');
  });

  it('is down when embed throws', async () => {
    const entry = await probeEmbedder(fakeEmbedder(async () => { throw new Error('timeout'); }), 'embedder');
    expect(entry.state).toBe('down');
    expect(entry.detail).toMatch(/timeout/);
  });
});

describe('probeVectorStore', () => {
  it('is ok when has resolves', async () => {
    const entry = await probeVectorStore(fakeStore(async () => new Set()), 'vector db');
    expect(entry.state).toBe('ok');
  });

  it('is down when has throws', async () => {
    const entry = await probeVectorStore(fakeStore(async () => { throw new Error('failed to connect to chromadb'); }), 'vector db');
    expect(entry.state).toBe('down');
    expect(entry.detail).toMatch(/chromadb/i);
  });
});

describe('buildHealthTargets', () => {
  const localModel: SelectedModel = { id: 'llama-70b', label: 'llama-70b', provider: 'local', baseUrl: 'http://gpu1:8000/v1' };

  it('always includes the main model, even with memory off', () => {
    const targets = buildHealthTargets({ defaultProvider: 'local', defaultModel: 'llama-70b', localBaseUrl: 'http://gpu1:8000/v1' }, localModel);
    expect(targets.map((t) => t.id)).toEqual(['model']);
  });

  it('adds embedder + vector db when memory is enabled (meta folded when it matches main)', () => {
    const cfg: SquirlConfig = {
      defaultProvider: 'local', defaultModel: 'llama-70b', localBaseUrl: 'http://gpu1:8000/v1',
      index: { enabled: true, store: 'local-chroma', embedder: 'local', embedderModel: 'bge', chromaUrl: 'http://chroma:8000' },
    };
    expect(buildHealthTargets(cfg, localModel).map((t) => t.id)).toEqual(['model', 'embedder', 'vectordb']);
  });

  it('omits the vector db light when the store is null', () => {
    const cfg: SquirlConfig = {
      defaultProvider: 'local', defaultModel: 'llama-70b', localBaseUrl: 'http://gpu1:8000/v1',
      index: { enabled: true, store: 'null', embedder: 'local' },
    };
    expect(buildHealthTargets(cfg, localModel).map((t) => t.id)).toEqual(['model', 'embedder']);
  });

  it('adds a distinct meta-LLM light when it differs from the main model', () => {
    const cfg: SquirlConfig = {
      defaultProvider: 'local', defaultModel: 'llama-70b', localBaseUrl: 'http://gpu1:8000/v1',
      index: { enabled: true, store: 'local-chroma', embedder: 'local', metaProvider: 'openai', metaModel: 'gpt-4o-mini' },
    };
    const ids = buildHealthTargets(cfg, localModel).map((t) => t.id);
    expect(ids).toContain('meta');
    const meta = buildHealthTargets(cfg, localModel).find((t) => t.id === 'meta')!;
    expect(meta.kind).toBe('chat');
    expect(meta.modelId).toBe('gpt-4o-mini');
  });
});
