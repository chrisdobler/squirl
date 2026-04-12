import { describe, it, expect } from 'vitest';
import { chunkId } from './id.js';

describe('chunkId', () => {
  it('produces a stable 40-char hex hash', () => {
    const a = chunkId('squirl', 'u1', 'a1');
    const b = chunkId('squirl', 'u1', 'a1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{40}$/);
  });

  it('differs when source differs', () => {
    expect(chunkId('squirl', 'u1', 'a1')).not.toBe(chunkId('chatgpt', 'u1', 'a1'));
  });

  it('differs when msg IDs differ', () => {
    expect(chunkId('squirl', 'u1', 'a1')).not.toBe(chunkId('squirl', 'u2', 'a1'));
  });
});
