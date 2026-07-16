import { describe, expect, it, vi } from 'vitest';

import { readThemePreference, THEME_PREFERENCE_KEY, writeThemePreference } from './theme-preference.js';

describe('browser theme preference', () => {
  it('restores only supported theme values', () => {
    expect(readThemePreference({ getItem: () => 'light', setItem: vi.fn() })).toBe('light');
    expect(readThemePreference({ getItem: () => 'dark', setItem: vi.fn() })).toBe('dark');
    expect(readThemePreference({ getItem: () => 'system', setItem: vi.fn() })).toBeNull();
  });

  it('persists the selected theme under a stable browser key', () => {
    const setItem = vi.fn();
    writeThemePreference('light', { getItem: vi.fn(), setItem });
    expect(setItem).toHaveBeenCalledWith(THEME_PREFERENCE_KEY, 'light');
  });

  it('does not break rendering when browser storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(readThemePreference(storage)).toBeNull();
    expect(() => writeThemePreference('dark', storage)).not.toThrow();
  });
});
