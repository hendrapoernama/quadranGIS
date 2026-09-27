'use client';

import { API_BASE, ApiError, api, getToken } from './api';

/**
 * Antrean offline (IndexedDB): laporan gangguan & foto aset yang dibuat tanpa sinyal disimpan di
 * perangkat lalu dikirim berurutan saat online. Setiap item membawa client_id sehingga kiriman
 * ulang tidak membuat data ganda di server. Item hanya dikirim oleh pengguna yang membuatnya.
 */

export interface OutboxPhoto {
  kind: 'node' | 'edge' | 'report';
  id?: number; // target (kosong bila menunggu laporan offline)
  reportClientId?: string; // foto untuk laporan yang juga masih di antrean
  note: string;
  lng?: number;
  lat?: number;
  accuracy?: number;
  taken_at: string;
  image: Blob;
  thumb: Blob;
}

export interface OutboxItem {
  id: string; // = client_id
  kind: 'report' | 'photo';
  user: string;
  label: string;
  created: string;
  tries: number;
  error?: string;
  report?: Record<string, unknown>;
  photo?: OutboxPhoto;
}

const DB = 'qgis-outbox';
const STORE = 'items';
const EVENT = 'qgis-outbox';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
      if (!r.result.objectStoreNames.contains('map')) r.result.createObjectStore('map');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => {
          resolve(req.result);
          db.close();
        };
        t.onerror = () => {
          reject(t.error);
          db.close();
        };
      }),
  );
}

function changed() {
  window.dispatchEvent(new Event(EVENT));
}

export async function outboxAdd(item: OutboxItem): Promise<void> {
  await tx(STORE, 'readwrite', (s) => s.put(item));
  changed();
}

export async function outboxList(): Promise<OutboxItem[]> {
  try {
    const all = (await tx(STORE, 'readonly', (s) => s.getAll())) as OutboxItem[];
    return all.sort((a, b) => a.created.localeCompare(b.created));
  } catch {
    return [];
  }
}

export async function outboxRemove(id: string): Promise<void> {
  await tx(STORE, 'readwrite', (s) => s.delete(id));
  changed();
}

async function mapGet(clientId: string): Promise<number | undefined> {
  return tx<number | undefined>('map', 'readonly', (s) => s.get(clientId) as IDBRequest<number | undefined>);
}
async function mapSet(clientId: string, serverId: number): Promise<void> {
  await tx('map', 'readwrite', (s) => s.put(serverId, clientId));
}

export function onOutboxChange(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** Kirim foto (online) ke /api/field/photos. */
export async function uploadPhoto(p: OutboxPhoto & { id: number }, clientId: string, lang = 'id'): Promise<any> {
  const fd = new FormData();
  fd.set('kind', p.kind);
  fd.set('id', String(p.id));
  fd.set('note', p.note || '');
  fd.set('taken_at', p.taken_at);
  fd.set('client_id', clientId);
  if (p.lng !== undefined) fd.set('lng', String(p.lng));
  if (p.lat !== undefined) fd.set('lat', String(p.lat));
  if (p.accuracy !== undefined) fd.set('accuracy', String(p.accuracy));
  fd.set('image', p.image, 'photo.jpg');
  fd.set('thumb', p.thumb, 'thumb.jpg');
  const token = getToken();
  const res = await fetch(`${API_BASE}/api/field/photos`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
    headers: { 'X-Lang': lang, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* bukan JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

let flushing: Promise<{ sent: number; failed: number }> | null = null;

/**
 * Kirim antrean berurutan (laporan dulu, lalu foto). Berhenti bila jaringan putus; galat 4xx
 * (data ditolak) dicatat pada item agar pengguna bisa memperbaiki / menghapusnya.
 */
export function flushOutbox(username: string, lang = 'id'): Promise<{ sent: number; failed: number }> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    let failed = 0;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return { sent, failed };
    const items = (await outboxList()).filter((i) => i.user === username);
    const ordered = [...items.filter((i) => i.kind === 'report'), ...items.filter((i) => i.kind === 'photo')];
    for (const it of ordered) {
      try {
        if (it.kind === 'report' && it.report) {
          const r = await api<{ id: number }>('/api/ops/reports', { method: 'POST', body: { ...it.report, client_id: it.id, created_at: it.created } });
          await mapSet(it.id, r.id);
        } else if (it.kind === 'photo' && it.photo) {
          let target = it.photo.id;
          if (!target && it.photo.reportClientId) target = await mapGet(it.photo.reportClientId);
          if (!target) continue; // laporannya belum terkirim
          await uploadPhoto({ ...it.photo, id: target }, it.id, lang);
        }
        await outboxRemove(it.id);
        sent++;
      } catch (e: any) {
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 0 || status === 503 || status === 502 || status === 504 || status === 408 || status === 429 || status === 401) break; // jaringan / sesi: coba lagi nanti
        failed++;
        await tx(STORE, 'readwrite', (s) => s.put({ ...it, tries: it.tries + 1, error: e?.message || String(e) }));
        changed();
      }
    }
    return { sent, failed };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
