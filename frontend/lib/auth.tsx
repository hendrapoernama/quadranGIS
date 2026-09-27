'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setToken } from './api';
import type { Menu, User } from './types';

interface AuthState {
  user: User | null;
  permissions: string[];
  menus: Menu[];
  appName: string;
  appDescription: string;
  /** versi logo (0 = logo bawaan) */
  logoVersion: number;
  hasLogo: boolean;
  loading: boolean;
  has: (perm: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  permissions: [],
  menus: [],
  appName: 'QuadranGIS',
  appDescription: '',
  logoVersion: 0,
  hasLogo: false,
  loading: true,
  has: () => false,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [appName, setAppName] = useState('QuadranGIS');
  const [appDescription, setAppDescription] = useState('');
  const [logoVersion, setLogoVersion] = useState(0);
  const [hasLogo, setHasLogo] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; permissions: string[]; menus: Menu[]; app_name: string; app_description: string; logo_version: number; has_logo: boolean }>(
        '/api/auth/me',
      );
      setUser(me.user);
      setPermissions(me.permissions || []);
      setMenus(me.menus || []);
      setAppName(me.app_name || 'QuadranGIS');
      setAppDescription(me.app_description || '');
      setLogoVersion(me.logo_version || 0);
      setHasLogo(!!me.has_logo);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // judul tab & favicon mengikuti identitas aplikasi
  useEffect(() => {
    applyBranding(appName, hasLogo, logoVersion);
  }, [appName, hasLogo, logoVersion]);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* abaikan */
    }
    setToken(null);
    // data per pengguna yang di-cache untuk mode offline (API, halaman, foto) dihapus
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_USER_DATA' });
      if ('caches' in window) await Promise.all(['qgis-api', 'qgis-pages', 'qgis-photos'].map((c) => caches.delete(c)));
    } catch {
      /* cache tidak tersedia */
    }
    window.location.href = '/login';
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      permissions,
      menus,
      appName,
      appDescription,
      logoVersion,
      hasLogo,
      loading,
      has: (p) => permissions.includes(p),
      refresh,
      logout,
    }),
    [user, permissions, menus, appName, appDescription, logoVersion, hasLogo, loading, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/** URL logo aplikasi (null = logo bawaan). */
export function logoUrl(hasLogo: boolean, version: number): string | null {
  return hasLogo ? `/api/branding/logo?v=${version}` : null;
}

/** Terapkan judul dokumen & favicon sesuai identitas aplikasi. */
export function applyBranding(name: string, hasLogo: boolean, version: number) {
  if (typeof document === 'undefined') return;
  const base = document.title.includes(' · ') ? document.title.split(' · ').slice(0, -1).join(' · ') : '';
  document.title = base ? `${base} · ${name}` : name;
  const url = logoUrl(hasLogo, version);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-brand]');
  if (url) {
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.setAttribute('data-brand', '1');
      document.head.appendChild(link);
    }
    link.href = url;
  } else link?.remove();
}
