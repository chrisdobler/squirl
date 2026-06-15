import { describe, it, expect } from 'vitest';
import { createVectorStore, formatVectorStoreStartupError, isChromaConnectionError } from './index.js';
import { NullStore } from './null-store.js';

describe('createVectorStore', () => {
  it('creates NullStore for type null', async () => {
    expect(await createVectorStore({ type: 'null' })).toBeInstanceOf(NullStore);
  });
  it('throws for unknown type', async () => {
    // @ts-expect-error testing invalid
    await expect(createVectorStore({ type: 'banana' })).rejects.toThrow('Unknown store type');
  });
});

describe('Chroma startup errors', () => {
  it('detects Chroma SDK connection errors', () => {
    const err = new Error('Failed to connect to chromadb. Make sure your server is running and try again.');
    err.name = 'ChromaConnectionError';

    expect(isChromaConnectionError(err)).toBe(true);
  });

  it('formats Chroma connection errors without SDK guidance or stack traces', () => {
    const err = new Error('Failed to connect to chromadb. Make sure your server is running and try again.');
    err.name = 'ChromaConnectionError';

    expect(formatVectorStoreStartupError(err, {
      type: 'local-chroma',
      chromaUrl: 'http://localhost:8000',
    })).toBe('ChromaDB down at http://localhost:8000; memory off.');
  });

  it('keeps non-Chroma startup failures concise', () => {
    expect(formatVectorStoreStartupError(new Error('bad collection'), {
      type: 'local-chroma',
      chromaUrl: 'http://localhost:8000',
    })).toBe('Memory indexing failed to start: bad collection');
  });
});
