import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSquirlServer } from './server.js';
import { defaultUiState, mergeUiState, normalizeUiState } from './ui-state.js';
import { UiStateStore } from './ui-state-store.js';

describe('UI state normalization', () => {
  it('provides safe defaults for missing and malformed values', () => {
    expect(normalizeUiState(null)).toEqual(defaultUiState());
    const state = normalizeUiState({ activeSurface: 'rewind', theme: 'light', chat: { draft: 'hello', viewport: { scrollTop: -4, atLatest: false } }, eval: { layer: 9 } });
    expect(state.activeSurface).toBeNull();
    expect(state.theme).toBe('light');
    expect(state.chat.draft).toBe('hello');
    expect(state.chat.viewport?.scrollTop).toBe(0);
    expect(state.eval.layer).toBe(1);
    expect(state.sidebar.squirlDependenciesExpanded).toBe(true);
    expect(state).not.toHaveProperty('anthropicApiKey');
    expect(normalizeUiState({ memory: { importPath: '/safe' }, settings: { openaiApiKey: 'secret' } })).not.toHaveProperty('settings');
  });

  it('merges nested partial patches without losing sibling fields', () => {
    const next = mergeUiState(defaultUiState(), { chat: { draft: 'durable' }, context: { mode: 'files' }, sidebar: { squirlDependenciesExpanded: false } });
    expect(next.chat).toMatchObject({ draft: 'durable', recipientId: 'squirl', showThinking: false });
    expect(next.context).toEqual({ mode: 'files', query: '', activeDiscIndex: null });
    expect(next.sidebar.squirlDependenciesExpanded).toBe(false);
  });
});

describe('UiStateStore', () => {
  it('loads defaults for missing/corrupt files and atomically persists normalized state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squirl-ui-state-'));
    const path = join(dir, 'state.json');
    const store = new UiStateStore(path);
    expect(store.load()).toEqual(defaultUiState());
    writeFileSync(path, '{broken', 'utf8');
    expect(store.load()).toEqual(defaultUiState());
    const saved = store.patch({ activeSurface: 'context', context: { query: 'src' } });
    expect(saved.activeSurface).toBe('context');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(saved);
  });
});

describe('UI state API', () => {
  const servers: Array<ReturnType<typeof createSquirlServer>['server']> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  it('persists PATCH updates across server recreation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'squirl-ui-api-'));
    const path = join(dir, 'ui-state.json');
    const start = async () => {
      const instance = createSquirlServer({ workingDir: dir, uiStatePath: path });
      servers.push(instance.server);
      await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
      const address = instance.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      return `http://127.0.0.1:${address.port}`;
    };
    const first = await start();
    const patched = await fetch(`${first}/api/ui-state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeSurface: 'context', chat: { draft: 'keep me' }, sidebar: { squirlDependenciesExpanded: false } }) }).then((res) => res.json());
    expect(patched).toMatchObject({ activeSurface: 'context', chat: { draft: 'keep me', recipientId: 'squirl' } });
    await new Promise<void>((resolve) => servers.shift()!.close(() => resolve()));
    const second = await start();
    const restored = await fetch(`${second}/api/ui-state`).then((res) => res.json());
    expect(restored).toMatchObject({ activeSurface: 'context', chat: { draft: 'keep me' }, sidebar: { squirlDependenciesExpanded: false } });
  });
});
