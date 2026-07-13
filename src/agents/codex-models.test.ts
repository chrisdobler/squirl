import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverCodexModels } from './codex-models.js';

const dirs: string[] = [];

function codexHome(): string {
  const dir = join(tmpdir(), `squirl-codex-models-${process.pid}-${dirs.length}`);
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('discoverCodexModels', () => {
  it('returns visible cached models in CLI priority order and the configured default', () => {
    const dir = codexHome();
    writeFileSync(join(dir, 'config.toml'), 'model = "gpt-current"\n');
    writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-second', display_name: 'GPT Second', visibility: 'list', priority: 2 },
      { slug: 'internal', display_name: 'Internal', visibility: 'hide', priority: 0 },
      { slug: 'gpt-current', display_name: 'GPT Current', visibility: 'list', priority: 1, context_window: 272000, effective_context_window_percent: 95 },
    ] }));

    expect(discoverCodexModels(dir)).toEqual({
      defaultModel: 'gpt-current',
      models: [
        { id: 'gpt-current', label: 'GPT Current', contextWindow: 258400 },
        { id: 'gpt-second', label: 'GPT Second' },
      ],
    });
  });

  it('keeps a configured model available when the cache is missing or stale', () => {
    const dir = codexHome();
    writeFileSync(join(dir, 'config.toml'), 'model = "custom-model"\n');

    expect(discoverCodexModels(dir)).toEqual({
      defaultModel: 'custom-model',
      models: [{ id: 'custom-model', label: 'custom-model' }],
    });
  });
});
