import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { initialTheme, persistTheme, savedTheme, type Theme } from './theme';

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: 'light', setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState(initialTheme);
  const manual = useRef(savedTheme() !== null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => { if (!manual.current) updateTheme(media.matches ? 'dark' : 'light'); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  function setTheme(value: Theme) {
    manual.current = true; persistTheme(value); updateTheme(value);
  }
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
