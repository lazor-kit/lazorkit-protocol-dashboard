import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { applyTheme, storedTheme, systemTheme, type Theme } from '../app/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (typeof window === 'undefined' ? 'dark' : (storedTheme() ?? systemTheme())));
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="iconButton"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </button>
  );
}
