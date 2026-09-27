'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { compressPhoto, uid } from '@/lib/photo';
import { outboxAdd, uploadPhoto } from '@/lib/outbox';
import { Button, Modal, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useFieldT } from './i18n';

export interface PhotoMeta {
  id: number;
  target_kind: string;
  target_id: number;
  width: number;
  height: number;
  bytes: number;
  lng: number | null;
  lat: number | null;
  taken_at: string;
  note: string;
  created_by_name: string;
}

export const photoUrl = (id: number, thumb = false) => `${API_BASE}/api/field/photos/${id}/image${thumb ? '?thumb=1' : ''}`;

/** Tangkap foto kamera (input file capture), kompres, lalu kirim atau antre saat offline. */
export function usePhotoCapture() {
  const { user } = useAuth();
  const { locale } = useT();
  const f = useFieldT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const capture = useCallback(
    async (file: File, target: { kind: 'node' | 'edge' | 'report'; id?: number; reportClientId?: string }, note: string, pos?: { lng: number; lat: number; accuracy: number } | null) => {
      setBusy(true);
      try {
        const maxKB = 1400;
        const c = await compressPhoto(file, 1600, maxKB);
        const payload = { kind: target.kind, id: target.id, reportClientId: target.reportClientId, note, lng: pos?.lng, lat: pos?.lat, accuracy: pos?.accuracy, taken_at: new Date().toISOString(), image: c.image, thumb: c.thumb };
        const clientId = uid();
        if (navigator.onLine && target.id) {
          try {
            const saved = await uploadPhoto({ ...payload, id: target.id }, clientId, locale);
            toast.push(f('photo_saved'), 'success');
            return saved as PhotoMeta;
          } catch (e: any) {
            if (e?.status && e.status < 500) throw e; // ditolak server: tampilkan galat
          }
        }
        await outboxAdd({ id: clientId, kind: 'photo', user: user?.username || '', label: `${target.kind} ${target.id ?? ''} ${note}`.trim(), created: new Date().toISOString(), tries: 0, photo: payload });
        toast.push(f('photo_queued'), 'warning');
        return null;
      } catch (e: any) {
        toast.push(e.message || String(e), 'error');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [user, locale, toast, f],
  );
  return { capture, busy };
}

/** Tombol foto aset + galeri (lihat, ambil foto, hapus milik sendiri). */
export function AssetPhotos({ kind, id, pos }: { kind: 'node' | 'edge'; id: number; pos?: { lng: number; lat: number; accuracy: number } | null }) {
  const f = useFieldT();
  const { has, user } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PhotoMeta[] | null>(null);
  const [view, setView] = useState<PhotoMeta | null>(null);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const { capture, busy } = usePhotoCapture();
  const canUpload = has('field.photo');

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: PhotoMeta[] }>(`/api/field/photos?kind=${kind}&id=${id}`);
      setItems(r.items);
    } catch {
      setItems([]);
    }
  }, [kind, id]);
  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const onFile = async (file?: File | null) => {
    if (!file) return;
    const saved = await capture(file, { kind, id }, note, pos);
    setNote('');
    if (saved) load();
  };
  const del = async (p: PhotoMeta) => {
    try {
      await api(`/api/field/photos/${p.id}`, { method: 'DELETE' });
      setView(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" icon="eye" onClick={() => setOpen(true)}>
        {f('photo')} {items ? `(${items.length})` : ''}
      </Button>
      <Modal open={open} title={f('photos')} onClose={() => (setOpen(false), setView(null))} width="max-w-2xl">
        {view ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl(view.id)} alt={view.note || f('photo')} className="max-h-[55vh] w-full rounded-md object-contain" />
            <div className="text-xs text-gray-600">
              {new Date(view.taken_at).toLocaleString('id-ID')} · {f('photo_by')} {view.created_by_name}
              {view.lat !== null && ` · ${view.lat.toFixed(6)}, ${view.lng?.toFixed(6)}`}
            </div>
            {view.note && <p className="text-sm text-gray-800">{view.note}</p>}
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon="chevron-left" onClick={() => setView(null)}>
                {f('back')}
              </Button>
              {canUpload && (view.created_by_name === user?.username || has('gis.edit')) && (
                <Button size="sm" variant="danger" icon="trash" onClick={() => del(view)}>
                  {f('photo_delete')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {canUpload && (
              <div className="flex flex-wrap items-center gap-2">
                <input className="input min-w-0 flex-1 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={f('photo_note')} />
                <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ''))} />
                <Button size="sm" icon="plus" loading={busy} onClick={() => input.current?.click()}>
                  {f('take_photo')}
                </Button>
              </div>
            )}
            {items === null ? (
              <Spinner size={16} />
            ) : items.length === 0 ? (
              <p className="text-sm text-gray-500">{f('photos_none')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {items.map((p) => (
                  <button key={p.id} className="group relative aspect-square overflow-hidden rounded-md bg-gray-100" onClick={() => setView(p)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoUrl(p.id, true)} alt={p.note || f('photo')} loading="lazy" className="h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 text-[10px] text-white">{new Date(p.taken_at).toLocaleDateString('id-ID')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

