import type { VectorStore } from '../types.js';
import { NullStore } from './null-store.js';
import { ChromaStore } from './chroma.js';

export interface StoreConfig {
  type: 'local-chroma' | 'remote-chroma' | 'null';
  chromaUrl?: string;
  chromaAuthToken?: string;
  collection?: string;
}

export async function createVectorStore(config: StoreConfig): Promise<VectorStore> {
  switch (config.type) {
    case 'null': return new NullStore();
    case 'local-chroma':
    case 'remote-chroma': {
      const { ChromaClient } = await import('chromadb');
      const client = new ChromaClient({ path: config.chromaUrl ?? 'http://localhost:8000' });
      const collection = await client.getOrCreateCollection({ name: config.collection ?? 'squirl-messages' });
      return new ChromaStore(collection as any);
    }
    default: throw new Error(`Unknown store type: ${(config as any).type}`);
  }
}
