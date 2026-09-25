// Klien HTTP ringan untuk backend QuadranGIS.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

const TOKEN_KEY = 'qgis_token';
const LANG_KEY = 'qgis_lang';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token);
      document.cookie = 'qgis_session=1; path=/; SameSite=Lax';
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
      document.cookie = 'qgis_session=; path=/; Max-Age=0; SameSite=Lax';
    }
  } catch {
    /* abaikan */
  }
}

function currentLang(): string {
  if (typeof window === 'undefined') return 'id';
  try {
    return window.localStorage.getItem(LANG_KEY) || 'id';
  } catch {
    return 'id';
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Lang': currentLang() };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    cache: 'no-store',
  });

  if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    setToken(null);
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, currentLang() === 'en' ? 'session expired' : 'sesi berakhir');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {
      /* abaikan */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  if (opts.raw) return (await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}

export function wsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  if (typeof window === 'undefined') return '';
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws') + '/api/ws';
}
