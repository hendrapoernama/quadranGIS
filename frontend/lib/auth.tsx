'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setToken } from './api';
import type { Menu, User } from './types';

interface AuthState {
  user: User | null;
  permissions: string[];
  menus: Menu[];
  appName: string;
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; permissions: string[]; menus: Menu[]; app_name: string }>('/api/auth/me');
      setUser(me.user);
      setPermissions(me.permissions || []);
      setMenus(me.menus || []);
      setAppName(me.app_name || 'QuadranGIS');
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* abaikan */
    }
    setToken(null);
    window.location.href = '/login';
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      permissions,
      menus,
      appName,
      loading,
      has: (p) => permissions.includes(p),
      refresh,
      logout,
    }),
    [user, permissions, menus, appName, loading, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
