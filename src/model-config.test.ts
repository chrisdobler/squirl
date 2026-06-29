import { describe, it, expect } from 'vitest';

import type { SquirlConfig } from './config.js';
import type { SelectedModel } from './components/ModelPicker.js';
import { getKnownContextWindow, resolveContextWindow } from './model-config.js';

const local = (overrides: Partial<SelectedModel> = {}): SelectedModel => ({
  id: 'qwen2.5-coder',
  label: 'qwen2.5-coder',
  provider: 'local',
  baseUrl: 'http://localhost:8000/v1',
  ...overrides,
});

describe('getKnownContextWindow', () => {
  it('returns the curated constant for a known cloud model', () => {
    expect(getKnownContextWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(getKnownContextWindow('gpt-4o')).toBe(128_000);
  });

  it('returns undefined for an unknown id (never the 8192 default)', () => {
    expect(getKnownContextWindow('qwen2.5-coder')).toBeUndefined();
    expect(getKnownContextWindow('claude-some-future-id')).toBeUndefined();
  });
});

describe('resolveContextWindow', () => {
  it('prefers the live in-memory value', () => {
    const config: SquirlConfig = { modelContextWindows: { 'qwen2.5-coder': 32_768 } };
    expect(resolveContextWindow(local({ contextWindow: 131_072 }), config)).toBe(131_072);
  });

  it('falls back to the persisted value when no live value', () => {
    const config: SquirlConfig = { modelContextWindows: { 'qwen2.5-coder': 32_768 } };
    expect(resolveContextWindow(local(), config)).toBe(32_768);
  });

  it('falls back to the curated cloud constant', () => {
    const model: SelectedModel = { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' };
    expect(resolveContextWindow(model, {})).toBe(200_000);
  });

  it('returns undefined when the window is genuinely unknown (so the UI can show "?")', () => {
    expect(resolveContextWindow(local(), {})).toBeUndefined();
  });
});
