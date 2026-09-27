'use client';

import { API_BASE, getToken } from './api';

/**
 * Area kerja offline: tile vektor jaringan (dan peta dasar bila diizinkan konfigurasi) untuk
 * sebuah kotak batas & rentang zoom disimpan di Cache Storage 'qgis-area'. Service worker
 * memakai cache ini saat perangkat offline (kunci tile tanpa parameter versi).
 */

export interface OfflineArea {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  zmin: number;
  zmax: number;
  tiles: number;
  bytes: number;
  basemap: boolean;
  created: string;
  urls: string[];
}

const KEY = 'qgis_offline_areas';
const CACHE = 'qgis-area';

export function listAreas(): OfflineArea[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function saveAreas(a: OfflineArea[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* penyimpanan penuh */
  }
}

function lng2x(lng: number, z: number) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function lat2y(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function tilesFor(bbox: [number, number, number, number], zmin: number, zmax: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let z = zmin; z <= zmax; z++) {
    const x0 = lng2x(bbox[0], z);
    const x1 = lng2x(bbox[2], z);
    const y0 = lat2y(bbox[3], z);
    const y1 = lat2y(bbox[1], z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}

/** Kotak batas persegi di sekitar titik (radius meter). */
export function bboxAround(lng: number, lat: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export async function downloadArea(opts: {
  name: string;
  bbox: [number, number, number, number];
  zmin: number;
  zmax: number;
  basemapUrl?: string; // templat {z}/{x}/{y}; kosong = hanya tile jaringan
  maxTiles: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<OfflineArea> {
  const tiles = tilesFor(opts.bbox, opts.zmin, opts.zmax);
  const perTile = opts.basemapUrl ? 2 : 1;
  if (tiles.length * perTile > opts.maxTiles) throw new Error(`too_many:${tiles.length * perTile}`);
  const cache = await caches.open(CACHE);
  const token = getToken();
  const origin = window.location.origin;
  const jobs: { url: string; key: string; auth: boolean }[] = [];
  for (const [z, x, y] of tiles) {
    const path = `${API_BASE}/api/gis/tiles/${z}/${x}/${y}.pbf`;
    const abs = new URL(path, origin).href;
    jobs.push({ url: abs, key: abs, auth: true });
    if (opts.basemapUrl) {
      const u = opts.basemapUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace(/\{s\}/, 'a');
      jobs.push({ url: u, key: u, auth: false });
    }
  }
  let done = 0;
  let bytes = 0;
  const urls: string[] = [];
  const worker = async () => {
    while (jobs.length) {
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const j = jobs.shift()!;
      try {
        const res = await fetch(j.url, {
          credentials: j.auth ? 'include' : 'omit',
          headers: j.auth ? { 'x-qgis-area': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) } : {},
          mode: j.auth ? 'same-origin' : 'cors',
          signal: opts.signal,
        });
        if (res.ok) {
          const blob = await res.blob();
          bytes += blob.size;
          await cache.put(j.key, new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
          urls.push(j.key);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
      }
      done++;
      opts.onProgress?.(done, tiles.length * perTile);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const area: OfflineArea = {
    id: `${Date.now()}`,
    name: opts.name,
    bbox: opts.bbox,
    zmin: opts.zmin,
    zmax: opts.zmax,
    tiles: urls.length,
    bytes,
    basemap: !!opts.basemapUrl,
    created: new Date().toISOString(),
    urls,
  };
  saveAreas([area, ...listAreas()]);
  return area;
}

export async function deleteArea(id: string): Promise<void> {
  const areas = listAreas();
  const a = areas.find((x) => x.id === id);
  const rest = areas.filter((x) => x.id !== id);
  if (a) {
    // tile yang juga dipakai area lain tetap disimpan
    const keep = new Set(rest.flatMap((r) => r.urls));
    const cache = await caches.open(CACHE);
    await Promise.all(a.urls.filter((u) => !keep.has(u)).map((u) => cache.delete(u)));
  }
  saveAreas(rest);
}

export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : { usage: 0, quota: 0 };
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { usage: est.usage || 0, quota: est.quota || 0, persisted };
}

export async function requestPersist(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}

export function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
}
