import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome = '';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome };
});

describe('context snapshot persistence', () => {
  beforeEach(() => {
    testHome = join(tmpdir(), `squirl-context-snapshot-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(testHome, { recursive: true });
    vi.resetModules();
  });
  afterEach(() => rmSync(testHome, { recursive: true, force: true }));

  it('round trips, overwrites, isolates workspaces, and uses owner-only permissions', async () => {
    const snapshots = await import('./context-snapshot.js');
    const store = await import('./context-snapshot-store.js');
    const first = snapshots.buildContextSnapshot([{ role: 'user', content: 'one' }], undefined, 'm', 1000, 'one');
    const second = snapshots.buildContextSnapshot([{ role: 'user', content: 'two' }], undefined, 'm', 1000, 'two');
    store.saveContextSnapshot('/workspace/a', first);
    store.saveContextSnapshot('/workspace/a', second);
    expect(store.loadContextSnapshot('/workspace/a')?.capturedAt).toBe('two');
    expect(store.loadContextSnapshot('/workspace/b')).toBeNull();
    expect(statSync(store.contextSnapshotPath('/workspace/a')).mode & 0o777).toBe(0o600);
  });

  it('ignores previews, malformed JSON, schema mismatches, and workspace mismatches', async () => {
    const snapshots = await import('./context-snapshot.js');
    const store = await import('./context-snapshot-store.js');
    const preview = snapshots.buildContextSnapshot([], undefined, 'm', 1000, 'now', 'preview');
    store.saveContextSnapshot('/workspace/a', preview);
    expect(store.loadContextSnapshot('/workspace/a')).toBeNull();

    const path = store.contextSnapshotPath('/workspace/a');
    mkdirSync(join(testHome, '.squirl', 'context-snapshots'), { recursive: true });
    writeFileSync(path, '{broken', 'utf-8');
    expect(store.loadContextSnapshot('/workspace/a')).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 99, workingDir: '/workspace/a', snapshot: preview }), 'utf-8');
    expect(store.loadContextSnapshot('/workspace/a')).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, workingDir: '/workspace/b', snapshot: { ...preview, origin: 'exact' } }), 'utf-8');
    expect(store.loadContextSnapshot('/workspace/a')).toBeNull();
    expect(readFileSync(path, 'utf-8')).toContain('/workspace/b');
  });
});
