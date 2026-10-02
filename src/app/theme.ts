// Light/dark theme: follows the OS setting until the viewer picks one, which is remembered in localStorage.
// index.html applies the stored choice before first paint; every storage access is wrapped in try/catch.

export type Theme = 'light' | 'dark';
const THEME_KEY = 'lk-theme';

export function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // not persisted; the choice still applies to this page view
  }
}
