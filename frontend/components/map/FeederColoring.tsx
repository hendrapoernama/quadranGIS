'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT } from '@/lib/i18n';
import type { RealtimeEvent } from '@/lib/types';
import { realtime } from '@/lib/ws';
import { NO_FEEDER_COLOR, feederColor } from './mapStyle';
import type { MapHandle } from './types';

const LIVE_KEY = 'qgis_feeder_live';
const MAX_ROWS = 40;

export interface FeederItem {
  id: number;
  code: string;
  name: string;
  gi_id: number;
  gi_code: string;
  color: number;
}

export interface FeederColoringState {
  enabled: boolean;
  /** true = penyulang penyuplai saat ini (mengikuti manuver), false = keanggotaan normal */
  live: boolean;
  setLive: (v: boolean) => void;
  highlight: number | null;
  toggleHighlight: (id: number) => void;
  clearHighlight: () => void;
  byId: Map<number, FeederItem>;
  inView: { id: number; count: number }[];
  /** objek & saluran yang saat ini disuplai penyulang lain dari keanggotaan normalnya */
  liveNodes: number;
  liveEdges: number;
  loading: boolean;
  /** hitung ulang penyulang yang tampak (panggil saat tampilan peta berubah) */
  refreshView: () => void;
}

/** Pilihan penyulang normal / aktual (disimpan per browser). */
export function useFeederLivePref(): [boolean, (v: boolean) => void] {
  const [live, setLiveState] = useState(() => {
    try {
      return window.localStorage.getItem(LIVE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const setLive = useCallback((v: boolean) => {
    setLiveState(v);
    try {
      window.localStorage.setItem(LIVE_KEY, String(v));
    } catch {
      /* penyimpanan browser tidak tersedia */
    }
  }, []);
  return [live, setLive];
}

export interface FeederColorsState {
  items: FeederItem[];
  byId: Map<number, FeederItem>;
  /** indeks warna palet per id kepala penyulang */
  colors: Record<number, number>;
  liveNodes: number;
  liveEdges: number;
  loading: boolean;
  reload: () => void;
}

/**
 * Daftar penyulang & indeks warnanya (GET /api/power/feeder-colors); dimuat ulang setelah event
 * feeders.changed (onChanged menerima versi tile baru) dan setelah manuver (jumlah objek dilimpahkan).
 */
export function useFeederColors(enabled: boolean, onChanged?: (tileVersion?: number) => void): FeederColorsState {
  const [items, setItems] = useState<FeederItem[]>([]);
  const [liveCount, setLiveCount] = useState({ nodes: 0, edges: 0 });
  const [loading, setLoading] = useState(false);
  const cb = useRef(onChanged);
  cb.current = onChanged;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: FeederItem[]; live_nodes: number; live_edges: number }>('/api/power/feeder-colors');
      setItems(r.items);
      setLiveCount({ nodes: r.live_nodes, edges: r.live_edges });
    } catch {
      /* dicoba lagi pada perubahan berikutnya */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    realtime.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type === 'feeders.changed') {
        cb.current?.(ev.tile_version);
        clearTimeout(timer);
        timer = setTimeout(load, 300);
      } else if (ev.type === 'maneuver') {
        clearTimeout(timer);
        timer = setTimeout(load, 1500);
      }
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [enabled, load]);

  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);
  const colors = useMemo(() => {
    const m: Record<number, number> = {};
    for (const it of items) m[it.id] = it.color;
    return m;
  }, [items]);
  return { items, byId, colors, liveNodes: liveCount.nodes, liveEdges: liveCount.edges, loading, reload: load };
}

/**
 * Pewarnaan peta per penyulang: warna diteruskan ke peta (normal / aktual / sorotan), tile dimuat
 * ulang saat keanggotaan berubah, dan penyulang yang tampak di layar dihitung untuk legenda.
 */
export function useFeederColoring(mapRef: React.RefObject<MapHandle | null>, ready: boolean, enabled: boolean): FeederColoringState {
  const [live, setLive] = useFeederLivePref();
  const [highlight, setHighlight] = useState<number | null>(null);
  const [inView, setInView] = useState<{ id: number; count: number }[]>([]);
  const fc = useFeederColors(ready && enabled, (v) => mapRef.current?.refreshTiles(v));
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refreshView = useCallback(() => {
    if (enabledRef.current) setInView(mapRef.current?.feedersInView() || []);
  }, [mapRef]);

  useEffect(() => {
    if (!enabled) setHighlight(null);
  }, [enabled]);

  // warna / normal-aktual / sorotan diteruskan ke peta
  useEffect(() => {
    if (!ready) return;
    mapRef.current?.setFeederStyle({ colors: fc.colors, live, highlight });
    const t = setTimeout(refreshView, 50);
    return () => clearTimeout(t);
  }, [ready, fc.colors, live, highlight, mapRef, refreshView]);

  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const toggleHighlight = useCallback(
    (id: number) => {
      if (highlightRef.current === id) {
        setHighlight(null);
        return;
      }
      setHighlight(id);
      api<{ bbox: [number, number, number, number] }>(`/api/power/feeders/${id}/extent${live ? '?live=1' : ''}`)
        .then((r) => mapRef.current?.fitBBox(r.bbox))
        .catch(() => {});
    },
    [live, mapRef],
  );

  return {
    enabled,
    live,
    setLive,
    highlight,
    toggleHighlight,
    clearHighlight: () => setHighlight(null),
    byId: fc.byId,
    inView,
    liveNodes: fc.liveNodes,
    liveEdges: fc.liveEdges,
    loading: fc.loading,
    refreshView,
  };
}

/** Legenda penyulang: pilihan normal / aktual dan penyulang yang tampak (klik = sorot & perbesar). */
export function FeederLegend({ state, defaultOpen = true, normalLoops = 0 }: { state: FeederColoringState; defaultOpen?: boolean; normalLoops?: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(defaultOpen);
  const rows = state.inView.slice(0, MAX_ROWS);
  const hl = state.highlight != null ? state.byId.get(state.highlight) : undefined;
  return (
    <div className="w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border border-gray-200 bg-white/95 text-xs text-gray-800 shadow-xl">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <span className="flex-1 whitespace-nowrap text-sm font-semibold text-gray-900">{t('fdr.title')}</span>
        <div className="flex overflow-hidden rounded-md border border-gray-300" role="group" aria-label={t('fdr.mode')}>
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              className={`px-2 py-0.5 ${state.live === v ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
              onClick={() => state.setLive(v)}
              title={v ? t('fdr.live_hint') : t('fdr.normal_hint')}
              aria-pressed={state.live === v}
            >
              {v ? t('fdr.live') : t('fdr.normal')}
            </button>
          ))}
        </div>
        <button
          className="w-5 text-center text-sm leading-none text-gray-500 hover:text-gray-800"
          onClick={() => setOpen(!open)}
          aria-label={open ? t('fdr.collapse') : t('fdr.expand')}
          title={open ? t('fdr.collapse') : t('fdr.expand')}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[11px] text-gray-500">
            {state.live
              ? state.liveNodes > 0
                ? t('fdr.live_moved', { n: fmtNum(state.liveNodes) })
                : t('fdr.live_same')
              : t('fdr.normal_desc')}
          </div>
          {hl && (
            <div className="mb-1.5 flex items-center gap-2 rounded-md bg-brand-50 px-2 py-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: feederColor(hl.color) }} />
              <span className="flex-1 truncate">{t('fdr.highlighting', { code: hl.code || `#${hl.id}` })}</span>
              <button className="text-brand-700 hover:underline" onClick={state.clearHighlight}>
                {t('fdr.show_all')}
              </button>
            </div>
          )}
          {rows.length === 0 ? (
            <div className="py-2 text-gray-500">{state.loading ? t('common.loading') : t('fdr.none_in_view')}</div>
          ) : (
            <ul className={`${defaultOpen ? 'max-h-56' : 'max-h-32'} space-y-0.5 overflow-y-auto pr-1`}>
              {rows.map((r) => {
                const it = state.byId.get(r.id);
                const on = state.highlight === r.id;
                return (
                  <li key={r.id}>
                    <button
                      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-gray-100 ${on ? 'bg-gray-100 font-semibold' : ''}`}
                      onClick={() => state.toggleHighlight(r.id)}
                      title={t('fdr.row_hint')}
                    >
                      <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: feederColor(it?.color) }} />
                      <span className="min-w-0 flex-1 truncate">{it?.code || `#${r.id}`}</span>
                      {it?.gi_code && <span className="shrink-0 text-[10px] text-gray-500">{it.gi_code}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {normalLoops > 0 && (
            <div className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900" title={t('par.normal_loops_hint')}>
              {t('par.normal_loops', { n: fmtNum(normalLoops) })}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-1.5 border-t border-gray-100 pt-1.5 text-[11px] text-gray-500">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: NO_FEEDER_COLOR }} /> {t('fdr.no_feeder')}
            <span className="ml-2 inline-block h-2.5 w-2.5 rounded-sm bg-gray-400" /> {t('power.off')}
          </div>
        </div>
      )}
    </div>
  );
}
