import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome };
});

describe('system interaction store', () => {
  beforeEach(() => {
    testHome = join(tmpdir(), `squirl-system-interactions-${crypto.randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
  });
  afterEach(() => rmSync(testHome, { recursive: true, force: true }));

  it('persists workspace-scoped prompts atomically with restrictive permissions', async () => {
    const { interactionFromPending, loadSystemInteractions, saveSystemInteractions } = await import('./system-interactions.js');
    const now = new Date();
    const interaction = interactionFromPending({
      id: 'confirm-1', targetIds: ['pi'], task: 'Review the change', originalRequest: 'Could Pi review this?',
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }, 'parent-turn');
    saveSystemInteractions('/workspace/one', [interaction]);

    expect(loadSystemInteractions('/workspace/one')).toEqual([interaction]);
    expect(loadSystemInteractions('/workspace/two')).toEqual([]);
    const directory = join(testHome, '.squirl', 'system-interactions');
    const [file] = (await import('node:fs')).readdirSync(directory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, file!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, file!), 'utf8')).not.toContain('authorized');
  });

  it('prunes expired and malformed prompts on load', async () => {
    const { interactionFromPending, loadSystemInteractions, saveSystemInteractions } = await import('./system-interactions.js');
    const now = new Date();
    saveSystemInteractions('/workspace/one', [interactionFromPending({
      id: 'expired', targetIds: ['pi'], task: 'Old task', originalRequest: 'old',
      createdAt: new Date(now.getTime() - 120_000).toISOString(), expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    })]);
    expect(loadSystemInteractions('/workspace/one', now)).toEqual([]);
  });
});
