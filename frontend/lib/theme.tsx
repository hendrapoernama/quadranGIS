'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';
export const THEME_KEY = 'qgis_theme';

interface ThemeState {
  theme: ThemePref;
  resolved: Resolved;
  setTheme: (t: ThemePref) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeState>({ theme: 'system', resolved: 'light', setTheme: () => {}, toggle: () => {} });

function systemPref(): Resolved {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStored(): ThemePref | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function apply(resolved: Resolved) {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  root.dataset.theme = resolved;
}

/** Skrip inline untuk <head>: menerapkan tema sebelum hidrasi agar tidak berkedip. */
export const themeInitScript = `(function(){try{var k='${THEME_KEY}';var v=localStorage.getItem(k);var d=v==='dark'||((!v||v==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

export function ThemeProvider({ children, defaultTheme = 'system' }: { children: React.ReactNode; defaultTheme?: ThemePref }) {
  const [theme, setThemeState] = useState<ThemePref>(defaultTheme);
  const [resolved, setResolved] = useState<Resolved>('light');

  useEffect(() => {
    const stored = readStored();
    const initial = stored || defaultTheme;
    setThemeState(initial);
    const r = initial === 'system' ? systemPref() : initial;
    setResolved(r);
    apply(r);
  }, [defaultTheme]);

  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const r = systemPref();
      setResolved(r);
      apply(r);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemePref) => {
    setThemeState(t);
    try {
      window.localStorage.setItem(THEME_KEY, t);
    } catch {
      /* abaikan */
    }
    const r = t === 'system' ? systemPref() : t;
    setResolved(r);
    apply(r);
  }, []);

  const toggle = useCallback(() => setTheme(resolved === 'dark' ? 'light' : 'dark'), [resolved, setTheme]);

  const value = useMemo(() => ({ theme, resolved, setTheme, toggle }), [theme, resolved, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}
