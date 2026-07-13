import { describe, it, expect } from 'vitest';

import { computeContextDiscs, type DiscKind } from './context-discs.js';

const count = (discs: DiscKind[], kind: DiscKind) => discs.filter((d) => d === kind).length;

describe('computeContextDiscs', () => {
  it('returns exactly `total` discs', () => {
    expect(computeContextDiscs({ system: 1000, files: 2000, messages: 3000 }, 100_000)).toHaveLength(100);
    expect(computeContextDiscs({ system: 0, files: 0, messages: 0 }, 100_000, 50)).toHaveLength(50);
  });

  it('all-empty buckets => entirely available', () => {
    const discs = computeContextDiscs({ system: 0, files: 0, messages: 0 }, 100_000);
    expect(count(discs, 'available')).toBe(100);
  });

  it('fills in order system -> memory -> files -> messages -> available', () => {
    // window 100k, tokensPerDisc = 1000 => 1 / 1 / 2 / 3 used, 93 available
    const discs = computeContextDiscs({ system: 1000, memory: 1000, files: 2000, messages: 3000 }, 100_000);
    expect(discs.slice(0, 1).every((d) => d === 'system')).toBe(true);
    expect(discs.slice(1, 2).every((d) => d === 'memory')).toBe(true);
    expect(discs.slice(2, 4).every((d) => d === 'files')).toBe(true);
    expect(discs.slice(4, 7).every((d) => d === 'messages')).toBe(true);
    expect(discs.slice(7).every((d) => d === 'available')).toBe(true);
    expect(count(discs, 'system')).toBe(1);
    expect(count(discs, 'memory')).toBe(1);
    expect(count(discs, 'files')).toBe(2);
    expect(count(discs, 'messages')).toBe(3);
    expect(count(discs, 'available')).toBe(93);
  });

  it('gives any non-zero used bucket at least one disc', () => {
    // tiny buckets that would round to 0 discs each (tokensPerDisc = 1000)
    const discs = computeContextDiscs({ system: 10, memory: 10, files: 10, messages: 10 }, 100_000);
    expect(count(discs, 'system')).toBe(1);
    expect(count(discs, 'memory')).toBe(1);
    expect(count(discs, 'files')).toBe(1);
    expect(count(discs, 'messages')).toBe(1);
    expect(count(discs, 'available')).toBe(96);
  });

  it('clips to `total` when usage overflows the window (no available)', () => {
    const discs = computeContextDiscs({ system: 200_000, files: 0, messages: 0 }, 100_000);
    expect(discs).toHaveLength(100);
    expect(count(discs, 'available')).toBe(0);
    expect(count(discs, 'system')).toBe(100);
  });

  it('treats a non-positive window as fully available (unknown window)', () => {
    expect(count(computeContextDiscs({ system: 1000, files: 0, messages: 0 }, 0), 'available')).toBe(100);
  });
});
