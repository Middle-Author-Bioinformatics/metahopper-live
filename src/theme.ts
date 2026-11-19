export type Theme = 'light' | 'dark';
export const THEME_KEY = 'metahopper-theme';

export function resolveTheme(preference: unknown, systemDark: boolean): Theme {
  return preference === 'light' || preference === 'dark' ? preference : systemDark ? 'dark' : 'light';
}

export function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch { return null; }
}

export function initialTheme(): Theme {
  return resolveTheme(savedTheme(), window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function persistTheme(theme: Theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Preference still works for this session. */ }
}
