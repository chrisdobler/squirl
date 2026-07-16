export type ThemePreference = 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'squirl.theme';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseThemePreference(value: unknown): ThemePreference | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export function readThemePreference(storage?: ThemeStorage): ThemePreference | null {
  try {
    const source = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    return source ? parseThemePreference(source.getItem(THEME_PREFERENCE_KEY)) : null;
  } catch {
    return null;
  }
}

export function writeThemePreference(theme: ThemePreference, storage?: ThemeStorage): void {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    target?.setItem(THEME_PREFERENCE_KEY, theme);
  } catch {
    // Storage can be unavailable in privacy modes or restricted browser contexts.
  }
}
