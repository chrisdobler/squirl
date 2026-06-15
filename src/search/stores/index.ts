import type { VectorStore } from '../types.js';
import { NullStore } from './null-store.js';
import { ChromaStore, withVectorStoreTimeout, DEFAULT_VECTOR_STORE_TIMEOUT_MS, isVectorStoreError } from './chroma.js';

export interface StoreConfig {
  type: 'local-chroma' | 'remote-chroma' | 'null';
  chromaUrl?: string;
  chromaAuthToken?: string;
  collection?: string;
}

function configuredChromaUrl(config: Pick<StoreConfig, 'chromaUrl'>): string {
  return config.chromaUrl ?? 'http://localhost:8000';
}

export function isChromaConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'ChromaConnectionError'
    || /failed to connect to chromadb/i.test(err.message)
    || /fetch failed/i.test(err.message)
    || /ECONNREFUSED/i.test(err.message);
}

export function formatVectorStoreStartupError(err: unknown, config: StoreConfig): string {
  if (config.type === 'local-chroma' || config.type === 'remote-chroma') {
    if (isChromaConnectionError(err)) {
      return `ChromaDB down at ${configuredChromaUrl(config)}; memory off.`;
    }
    if (isVectorStoreError(err)) {
      return `Memory indexing failed to start: ${err.message}`;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return `Memory indexing failed to start: ${message}`;
}

// Requires Chroma server 1.0+ (v2 API) — uses chromadb client 3.x
export async function createVectorStore(config: StoreConfig): Promise<VectorStore> {
  switch (config.type) {
    case 'null': return new NullStore();
    case 'local-chroma':
    case 'remote-chroma': {
      const { ChromaClient } = await import('chromadb');
      const url = new URL(configuredChromaUrl(config));
      const client = new ChromaClient({
        host: url.hostname,
        port: parseInt(url.port || (url.protocol === 'https:' ? '443' : '8000'), 10),
        ssl: url.protocol === 'https:',
      });
      const collection = await withVectorStoreTimeout(
        client.getOrCreateCollection({
          name: config.collection ?? 'squirl-messages',
          embeddingFunction: null,
        }),
        DEFAULT_VECTOR_STORE_TIMEOUT_MS,
      );
      return new ChromaStore(collection as any);
    }
    default: throw new Error(`Unknown store type: ${(config as any).type}`);
  }
}
