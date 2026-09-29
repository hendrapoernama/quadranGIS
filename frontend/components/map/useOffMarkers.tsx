'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT } from '@/lib/i18n';
import type { RealtimeEvent } from '@/lib/types';
import { realtime } from '@/lib/ws';
import type { MapHandle, OffMarker } from './types';

const STORE_KEY = 'qgis_off_markers';

export interface OffMarkerState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** jumlah objek padam bertanda (sebelum dibatasi server) */
  total: number;
  truncated: boolean;
}

/**
 * Penanda objek padam di peta (gardu distribusi & trafo GI berkedip merah, cluster merah bila banyak).
 * Dimuat saat peta siap, lalu diperbarui setelah manuver / energize / edit (realtime) dan berkala
 * (monitoring.power_refresh_seconds). Pilihan tampil / sembunyi disimpan per browser.
 */
export function useOffMarkers(mapRef: React.RefObject<MapHandle | null>, configs: Record<string, string>, ready: boolean): OffMarkerState {
  const [enabled, setEnabledState] = useState(() => {
    try {
      return window.localStorage.getItem(STORE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [info, setInfo] = useState({ total: 0, truncated: false });
  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      window.localStorage.setItem(STORE_KEY, String(v));
    } catch {
      /* penyimpanan browser tidak tersedia */
    }
  }, []);
  const every = Math.max(10, Number(configs['monitoring.power_refresh_seconds'] || 15)) * 1000;

  useEffect(() => {
    if (!ready) return;
    if (!enabled) {
      mapRef.current?.setOffMarkers(null);
      setInfo({ total: 0, truncated: false });
      return;
    }
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await api<{ items: OffMarker[]; total: number; truncated: boolean }>('/api/power/off-markers');
        if (!alive) return;
        mapRef.current?.setOffMarkers(r.items);
        setInfo({ total: r.total, truncated: r.truncated });
      } catch {
        /* dicoba lagi pada pembaruan berikutnya */
      }
    };
    load();
    const timer = setInterval(load, every);
    realtime.connect();
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type === 'maneuver' || ev.type === 'energized' || ev.type === 'topology.rebuilt' || ev.type.startsWith('feature.')) {
        clearTimeout(debounce);
        debounce = setTimeout(load, 700);
      }
    });
    return () => {
      alive = false;
      clearTimeout(debounce);
      clearInterval(timer);
      off();
    };
  }, [ready, enabled, every, mapRef]);

  return { enabled, setEnabled, ...info };
}

/** Titik merah berkedip (legenda penanda padam). */
export function OffBlinkDot() {
  return <span className="offmark-legend-dot" aria-hidden />;
}

/** Tombol tampil / sembunyi penanda padam beserta jumlahnya. */
export function OffMarkerButton({ state }: { state: OffMarkerState }) {
  const { t } = useT();
  return (
    <button
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
        state.enabled ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
      }`}
      aria-pressed={state.enabled}
      onClick={() => state.setEnabled(!state.enabled)}
      title={t('offmark.hint')}
    >
      <OffBlinkDot />
      {t('offmark.short')}
      {state.enabled && state.total > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold tabular-nums text-white">{fmtNum(state.total)}</span>}
    </button>
  );
}

/** Kotak centang penanda padam (panel layer peta jaringan). */
export function OffMarkerCheckbox({ state }: { state: OffMarkerState }) {
  const { t } = useT();
  return (
    <label className="flex items-center gap-2 text-gray-800" title={t('offmark.hint')}>
      <input type="checkbox" checked={state.enabled} onChange={(e) => state.setEnabled(e.target.checked)} />
      <OffBlinkDot />
      <span className="flex-1">{t('offmark.toggle')}</span>
      {state.enabled && state.total > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold tabular-nums text-white">{fmtNum(state.total)}</span>}
    </label>
  );
}
