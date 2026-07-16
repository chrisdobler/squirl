import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { withCalendarSyncLock } from './lock.js';

describe('calendar synchronization lock', () => {
  it('serializes overlapping calendar transactions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'squirl-calendar-lock-'));
    const path = join(directory, 'lock');
    const order: string[] = [];
    let release!: () => void;
    const first = withCalendarSyncLock(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => { release = resolve; });
      order.push('first-end');
    }, { path, retryMs: 5 });
    while (order.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withCalendarSyncLock(async () => { order.push('second'); }, { path, retryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    rmSync(directory, { recursive: true, force: true });
  });

  it('reclaims an abandoned lock owned by a dead process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'squirl-calendar-lock-'));
    const path = join(directory, 'lock');
    mkdirSync(path);
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: 999_999_999, token: 'dead' }));
    await withCalendarSyncLock(async () => {
      const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
      expect(owner.pid).toBe(process.pid);
    }, { path, retryMs: 1 });
    rmSync(directory, { recursive: true, force: true });
  });
});
