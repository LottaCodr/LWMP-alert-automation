import { useCallback, useEffect, useState } from 'react';

/**
 * Colour-scheme preference.
 *
 * "System" is the default and is honoured through `prefers-color-scheme` in
 * `tokens.css`; an explicit choice is written to `data-theme` on the root so it
 * survives a reload and wins over the OS setting.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'lwmp.theme';

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const root = document.documentElement;
  if (preference === 'system') {
    delete root.dataset.theme;
    return systemTheme();
  }
  root.dataset.theme = preference;
  return preference;
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    readPreference() === 'system' ? systemTheme() : (readPreference() as ResolvedTheme),
  );

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    setResolved(applyTheme(next));
    try {
      if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Private browsing can block storage; the in-memory choice still applies. */
    }
  }, []);

  useEffect(() => {
    setResolved(applyTheme(readPreference()));
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readPreference() === 'system') setResolved(systemTheme());
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return { preference, resolved, setPreference };
}
