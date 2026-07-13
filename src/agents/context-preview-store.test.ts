import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

let testHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome };
});

describe('participant context preview persistence', () => {
  afterEach(() => rmSync(testHome, { recursive: true, force: true }));

  it('atomically restores only sanitized previews for the same workspace', async () => {
    testHome = join(tmpdir(), `squirl-preview-store-${process.pid}-${Date.now()}`);
    mkdirSync(testHome, { recursive: true });
    const { loadParticipantContextPreviews, saveParticipantContextPreviews } = await import('./context-preview-store.js');
    const workspace = '/workspace/one';
    const preview = {
      participantId: 'cc', modelId: 'claude-test', source: 'claude-session' as const, fidelity: 'inspected' as const,
      matrixMode: 'categorized' as const, capturedAt: '2026-01-01T00:00:00Z', usedTokens: 50, contextWindow: 100,
      buckets: { system: 10, memory: 5, files: 10, messages: 25 },
      discs: Array.from({ length: 100 }, (_, index) => index < 50 ? 'messages' as const : 'available' as const),
    };

    saveParticipantContextPreviews(workspace, { cc: preview });

    expect(loadParticipantContextPreviews(workspace)).toEqual({ cc: preview });
    expect(loadParticipantContextPreviews('/workspace/two')).toEqual({});
  });
});
