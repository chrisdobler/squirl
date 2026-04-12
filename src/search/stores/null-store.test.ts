import { describe, it, expect } from 'vitest';
import { NullStore } from './null-store.js';

describe('NullStore', () => {
  it('upsert is no-op', async () => { await expect(new NullStore().upsert([])).resolves.toBeUndefined(); });
  it('query returns empty', async () => { expect(await new NullStore().query([0.1], 5)).toEqual([]); });
  it('has returns empty set', async () => { expect((await new NullStore().has(['a'])).size).toBe(0); });
});
