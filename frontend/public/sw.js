/* QuadranGIS service worker: cangkang aplikasi offline, cache data & tile, Web Push.
 *
 * Strategi:
 *  - halaman (navigasi) & payload RSC : network-first → cache → /offline.html
 *  - /_next/static (hash, immutable)   : cache-first
 *  - GET /api/* (JSON)                 : network-first → cache (data terakhir, header X-QGIS-Offline)
 *  - vector tile /api/gis/tiles        : network-first → cache (kunci tanpa ?v=) → area kerja offline
 *  - peta dasar raster & glyph         : stale-while-revalidate (dibatasi)
 *  - foto aset                         : cache-first (isi tidak pernah berubah)
 * Tidak di-cache: WebSocket, /api/auth, /api/ai (streaming), request non-GET.
 */
const VERSION = 'v2';
const SHELL = `qgis-shell-${VERSION}`;
const PAGES = 'qgis-pages';
const STATIC = 'qgis-static';
const API = 'qgis-api';
const TILES = 'qgis-tiles';
const AREA = 'qgis-area'; // area kerja yang diunduh pengguna (tidak dipangkas otomatis)
const BASEMAP = 'qgis-basemap';
const PHOTOS = 'qgis-photos';
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/badge-96.png'];
const LIMITS = { [TILES]: 4000, [BASEMAP]: 2500, [API]: 400, [PAGES]: 80, [PHOTOS]: 600 };

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('qgis-shell-') && k !== SHELL).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const t = event.data && event.data.type;
  if (t === 'SKIP_WAITING') self.skipWaiting();
  if (t === 'CLEAR_USER_DATA') {
    // keluar: data per pengguna (API & halaman) dihapus; tile & area kerja tetap
    event.waitUntil(Promise.all([caches.delete(API), caches.delete(PAGES), caches.delete(PHOTOS)]));
  }
});

// ------------------------------------------------------------------ utilitas
const trimming = {};
async function trim(name) {
  const max = LIMITS[name];
  if (!max || trimming[name]) return;
  trimming[name] = true;
  try {
    const c = await caches.open(name);
    const keys = await c.keys();
    if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => c.delete(k)));
  } finally {
    trimming[name] = false;
  }
}
async function put(name, key, res) {
  try {
    const c = await caches.open(name);
    await c.put(key, res);
    if (Math.random() < 0.05) trim(name);
  } catch (e) {
    /* kuota penuh / respons tidak bisa disimpan */
  }
}
function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}
function offlineJSON() {
  return new Response(JSON.stringify({ error: 'offline', offline: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'X-QGIS-Offline': '1' },
  });
}
async function markOffline(res) {
  if (!res) return res;
  const h = new Headers(res.headers);
  h.set('X-QGIS-Offline', '1');
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: h });
}
function tileKey(url) {
  return `${url.origin}${url.pathname}`;
}

// ------------------------------------------------------------------ strategi
async function networkFirst(req, cacheName, { key = req, ms = 0, fallback } = {}) {
  try {
    const res = await (ms ? Promise.race([fetch(req), timeout(ms)]) : fetch(req));
    if (res && res.ok && res.type !== 'opaqueredirect') put(cacheName, key, res.clone());
    return res;
  } catch (e) {
    const hit = await caches.match(key, { cacheName });
    if (hit) return fallback ? fallback(hit) : hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req, { cacheName });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) put(cacheName, req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const hit = await caches.match(req, { cacheName });
  const net = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) put(cacheName, req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await net) || Response.error();
}

async function tile(req, url) {
  const key = tileKey(url);
  try {
    const res = await fetch(req);
    if (res.ok) put(TILES, key, res.clone());
    return res;
  } catch (e) {
    const hit = (await caches.match(key, { cacheName: AREA })) || (await caches.match(key, { cacheName: TILES }));
    if (hit) return hit;
    // tile kosong agar peta tidak penuh galat saat offline di luar area tersimpan
    return new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'application/x-protobuf', 'X-QGIS-Offline': '1' } });
  }
}

async function navigate(req, url) {
  try {
    const res = await Promise.race([fetch(req), timeout(8000)]);
    if (res.ok) put(PAGES, url.pathname, res.clone());
    return res;
  } catch (e) {
    const hit = (await caches.match(url.pathname, { cacheName: PAGES })) || (await caches.match(req, { ignoreSearch: true }));
    return hit || (await caches.match('/offline.html', { cacheName: SHELL })) || Response.error();
  }
}

// ------------------------------------------------------------------ fetch
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.get('x-qgis-area')) return; // unduhan area kerja ditangani halaman
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    const p = url.pathname;
    // sesi (/api/auth/me) ikut di-cache agar aplikasi terbuka saat offline; login/captcha tidak
    if (p.startsWith('/api/ws') || (p.startsWith('/api/auth/') && p !== '/api/auth/me') || p.startsWith('/api/ai/') || p.startsWith('/api/push/')) return;
    if (p.startsWith('/api/gis/tiles/')) return event.respondWith(tile(req, url));
    if (/^\/api\/field\/photos\/\d+\/image/.test(p)) return event.respondWith(cacheFirst(req, PHOTOS));
    if (p.startsWith('/api/')) {
      return event.respondWith(
        networkFirst(req, API, { fallback: markOffline }).catch(() => offlineJSON()),
      );
    }
    if (p.startsWith('/_next/static/')) return event.respondWith(cacheFirst(req, STATIC));
    if (req.mode === 'navigate') return event.respondWith(navigate(req, url));
    if (p.startsWith('/icons/') || p.startsWith('/guide/') || /\.(svg|png|jpg|webp|woff2?)$/.test(p)) {
      return event.respondWith(staleWhileRevalidate(req, STATIC));
    }
    // payload RSC / data halaman Next.js
    return event.respondWith(networkFirst(req, PAGES, { ms: 8000 }).catch(() => Response.error()));
  }

  // lintas-origin: peta dasar raster & glyph font peta
  if (/\.pbf$/.test(url.pathname) && /font|glyph/i.test(url.href)) return event.respondWith(cacheFirst(req, STATIC));
  if (/\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)$/.test(url.pathname)) return event.respondWith(staleWhileRevalidate(req, BASEMAP));
});

// ------------------------------------------------------------------ Web Push
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { title: 'QuadranGIS', body: event.data ? event.data.text() : '' };
  }
  const title = d.title || 'QuadranGIS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || '/monitoring' },
      vibrate: d.topic === 'outage' ? [120, 60, 120] : undefined,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (c.url.startsWith(self.location.origin)) {
          await c.focus();
          if ('navigate' in c) return c.navigate(target);
          return;
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
