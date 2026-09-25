'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { id, type DictKey } from './locales/id';
import { en } from './locales/en';

export type Locale = 'id' | 'en';
export const LOCALE_KEY = 'qgis_lang';

const dicts: Record<Locale, Record<DictKey, string>> = { id, en };

export function readStoredLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(LOCALE_KEY);
    return v === 'en' || v === 'id' ? v : null;
  } catch {
    return null;
  }
}

export function format(tpl: string, params?: Record<string, string | number>): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: DictKey, params?: Record<string, string | number>) => string;
  /** memilih label lokal dari pasangan (id, en) yang datang dari backend */
  pick: (idText: string, enText?: string | null) => string;
}

const Ctx = createContext<LocaleState>({
  locale: 'id',
  setLocale: () => {},
  t: (k) => id[k],
  pick: (a) => a,
});

export function LocaleProvider({ children, defaultLocale = 'id' }: { children: React.ReactNode; defaultLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useEffect(() => {
    const stored = readStoredLocale();
    if (stored) setLocaleState(stored);
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(LOCALE_KEY, l);
    } catch {
      /* abaikan */
    }
  }, []);

  const value = useMemo<LocaleState>(() => {
    const dict = dicts[locale];
    return {
      locale,
      setLocale,
      t: (key, params) => format(dict[key] ?? id[key] ?? key, params),
      pick: (idText, enText) => (locale === 'en' && enText ? enText : idText),
    };
  }, [locale, setLocale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT() {
  return useContext(Ctx);
}
