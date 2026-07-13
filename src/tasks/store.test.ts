import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { loadTaskActivitySnapshot, saveTaskActivitySnapshot } from './store.js';
import type { TaskActivitySnapshot } from './types.js';

const directory = join(tmpdir(), `squirl-task-store-${process.pid}`);
const path = join(directory, 'task-activity.json');

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('task activity store', () => {
  it('round-trips an atomic private snapshot and rejects corrupt data', () => {
    const snapshot: TaskActivitySnapshot = {
      version: 1,
      generatedAt: '2026-07-13T18:00:00.000Z',
      sourceWatermark: 'watermark',
      tasks: [{ id: 'task-1', title: 'Build task feed', lastActiveAt: '2026-07-13T17:59:00.000Z', participantIds: ['codex'], evidenceIds: ['u1'] }],
    };
    saveTaskActivitySnapshot(snapshot, path);
    expect(loadTaskActivitySnapshot(path)).toEqual(snapshot);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, '{broken', 'utf-8');
    expect(loadTaskActivitySnapshot(path)).toBeNull();
  });

  it('returns null for an unsupported schema without modifying the file', () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, tasks: [] }), 'utf-8');
    expect(loadTaskActivitySnapshot(path)).toBeNull();
    expect(readFileSync(path, 'utf-8')).toContain('"version":2');
  });
});
