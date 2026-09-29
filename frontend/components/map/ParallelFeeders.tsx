'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { RealtimeEvent } from '@/lib/types';
import { realtime } from '@/lib/ws';
import { useToast } from '@/components/ui';
import type { MapHandle, ParallelItem } from './types';

const key = (it: ParallelItem) => `${it.a.id}-${it.b.id}`;

/**
 * Penyulang yang beroperasi paralel (GET /api/power/parallel): penanda di peta pada tie penyebab,
 * dimuat ulang setelah manuver / energize / perubahan penyulang dan berkala; paralel baru diberi toast.
 * Loop yang sudah ada pada posisi normal switch (mis. data tanpa tie normally-open) hanya dihitung.
 */
export function useParallelFeeders(mapRef: React.RefObject<MapHandle | null>, configs: Record<string, string>, ready: boolean) {
  const { t } = useT();
  const toast = useToast();
  const [items, setItems] = useState<ParallelItem[]>([]);
  const [normalLoops, setNormalLoops] = useState(0);
  const known = useRef<Set<string> | null>(null);
  const tr = useRef(t);
  tr.current = t;
  const every = Math.max(10, Number(configs['monitoring.power_refresh_seconds'] || 15)) * 1000;

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: ParallelItem[]; normal_loops: number }>('/api/power/parallel');
      setItems(r.items);
      setNormalLoops(r.normal_loops || 0);
      mapRef.current?.setParallel(r.items);
      const now = new Set(r.items.map(key));
      if (known.current) {
        for (const it of r.items) {
          if (!known.current.has(key(it))) toast.push(tr.current('par.toast', { a: it.a.code || `#${it.a.id}`, b: it.b.code || `#${it.b.id}` }), 'warning');
        }
      }
      known.current = now;
    } catch {
      /* dicoba lagi pada pembaruan berikutnya */
    }
  }, [mapRef, toast]);

  useEffect(() => {
    if (!ready) return;
    load();
    const timer = setInterval(load, every);
    realtime.connect();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type === 'maneuver' || ev.type === 'energized' || ev.type === 'feeders.changed' || ev.type === 'topology.rebuilt') {
        clearTimeout(debounce);
        debounce = setTimeout(load, 800);
      }
    });
    return () => {
      clearInterval(timer);
      clearTimeout(debounce);
      off();
    };
  }, [ready, every, load]);

  /** items: paralel akibat manuver; normalLoops: pasangan yang sudah ber-loop pada posisi normal (data) */
  return { items, normalLoops };
}

/** Spanduk peringatan penyulang paralel (klik = arahkan peta ke tie penyebab). */
export function ParallelBanner({ items, mapRef }: { items: ParallelItem[]; mapRef: React.RefObject<MapHandle | null> }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const shown = open ? items : items.slice(0, 1);
  const focus = (it: ParallelItem) => {
    const p = it.ties[0] || it.meet;
    mapRef.current?.flyTo(p.lng, p.lat, 17);
  };
  return (
    <div className="w-fit max-w-full rounded-md border border-amber-300 bg-amber-100 px-2 py-1 text-xs text-amber-900 shadow" role="alert">
      {shown.map((it) => (
        <button key={key(it)} className="block max-w-full truncate text-left hover:underline" onClick={() => focus(it)} title={t('par.hint')}>
          <span className="mr-1 font-semibold">⚠ {t('par.title')}:</span>
          {it.a.code || `#${it.a.id}`} ⇄ {it.b.code || `#${it.b.id}`}
          {it.ties.length > 0 && <span className="text-amber-800"> · {t('par.via', { tie: it.ties.map((x) => x.code || `#${x.id}`).join(', ') })}</span>}
        </button>
      ))}
      {items.length > 1 && (
        <button className="mt-0.5 text-[11px] text-amber-800 underline" onClick={() => setOpen(!open)}>
          {open ? t('par.less') : t('par.more', { n: items.length - 1 })}
        </button>
      )}
    </div>
  );
}
