import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverClaudeModels } from './claude-models.js';

const dirs: string[] = [];

function claudeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'squirl-claude-models-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('discoverClaudeModels', () => {
  it('returns stable aliases, the configured default, and account-specific choices', () => {
    const dir = claudeHome();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'claude-fable-5[1m]' }));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({
      additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'Longest-running tasks' }],
    }));

    expect(discoverClaudeModels(dir)).toEqual({
      defaultModel: 'claude-fable-5[1m]',
      models: [
        { id: 'fable', label: 'Fable' },
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
        { id: 'claude-fable-5[1m]', label: 'Fable', description: 'Longest-running tasks' },
      ],
    });
  });

  it('keeps aliases available when Claude state is missing or partially written', () => {
    const dir = claudeHome();
    writeFileSync(join(dir, '.claude.json'), '{incomplete');

    expect(discoverClaudeModels(dir).models.map((model) => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });
});
