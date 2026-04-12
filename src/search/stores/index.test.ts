import { describe, it, expect } from 'vitest';
import { createVectorStore } from './index.js';
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
