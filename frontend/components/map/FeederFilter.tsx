'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { Icon } from '@/components/Icon';
import { feederColor } from './mapStyle';
import { useFeederColors, type FeederItem } from './FeederColoring';
import type { MapHandle } from './types';

/** kunci penyimpanan pilihan per halaman (Pusat Operasi & Editor Peta terpisah) */
export const OPS_FEEDERS_KEY = 'qgis_ops_feeders';
export const EDITOR_FEEDERS_KEY = 'qgis_editor_feeders';
const MAX_ZOOM_FEEDERS = 30;

export interface FeederFilterState {
  /** penyulang yang ditampilkan (id kepala penyulang); kosong = semua */
  ids: number[];
  setIds: (ids: number[]) => void;
  toggle: (id: number) => void;
  clear: () => void;
  items: FeederItem[];
  byId: Map<number, FeederItem>;
  loading: boolean;
  /** perbesar peta ke penyulang terpilih (atau ke daftar id tertentu) */
  zoom: (ids?: number[]) => void;
}

function readIds(key: string): number[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x) && x > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Filter penyulang peta (Pusat Operasi, Editor Peta): hanya penyulang terpilih yang tampil (kubikel outgoing sampai
 * pelanggan), menurut keanggotaan normal atau penyulang penyuplai saat ini (live, sama dengan pewarnaan per penyulang).
 * Pilihan disimpan per browser di storageKey. Daftar penyulang dimuat saat panel dibuka atau filter aktif.
 */
export function useFeederFilter(mapRef: React.RefObject<MapHandle | null>, ready: boolean, live: boolean, listOpen: boolean, storageKey: string = OPS_FEEDERS_KEY): FeederFilterState {
  const [ids, setIdsState] = useState<number[]>(() => readIds(storageKey));
  const fc = useFeederColors(ready && (listOpen || ids.length > 0));

  const setIds = useCallback(
    (next: number[]) => {
      const uniq = Array.from(new Set(next)).sort((a, b) => a - b);
      setIdsState(uniq);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(uniq));
      } catch {
        /* penyimpanan browser tidak tersedia */
      }
    },
    [storageKey],
  );

  // penyulang yang sudah tidak ada (mis. data diimpor ulang) dibuang dari pilihan
  useEffect(() => {
    if (fc.items.length === 0 || ids.length === 0) return;
    const keep = ids.filter((id) => fc.byId.has(id));
    if (keep.length !== ids.length) setIds(keep);
  }, [fc.items, fc.byId, ids, setIds]);

  useEffect(() => {
    if (ready) mapRef.current?.setFeederFilter(ids, live);
  }, [ready, ids, live, mapRef]);

  const idsRef = useRef(ids);
  idsRef.current = ids;
  const zoom = useCallback(
    (only?: number[]) => {
      const list = (only ?? idsRef.current).slice(0, MAX_ZOOM_FEEDERS);
      if (list.length === 0) return;
      Promise.all(list.map((id) => api<{ bbox: [number, number, number, number] }>(`/api/power/feeders/${id}/extent${live ? '?live=1' : ''}`).catch(() => null)))
        .then((rs) => {
          const bs = rs.filter((r): r is { bbox: [number, number, number, number] } => !!r && Array.isArray(r.bbox));
          if (bs.length === 0) return;
          mapRef.current?.fitBBox([Math.min(...bs.map((r) => r.bbox[0])), Math.min(...bs.map((r) => r.bbox[1])), Math.max(...bs.map((r) => r.bbox[2])), Math.max(...bs.map((r) => r.bbox[3]))]);
        })
        .catch(() => {});
    },
    [live, mapRef],
  );

  return {
    ids,
    setIds,
    toggle: (id) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]),
    clear: () => setIds([]),
    items: fc.items,
    byId: fc.byId,
    loading: fc.loading,
    zoom,
  };
}

/** Tombol toolbar: "Semua penyulang" / kode penyulang / "n penyulang". */
export function FeederFilterButton({ state, open, onToggle }: { state: FeederFilterState; open: boolean; onToggle: () => void }) {
  const { t } = useT();
  const n = state.ids.length;
  const one = n === 1 ? state.byId.get(state.ids[0]) : undefined;
  const label = n === 0 ? t('fdr.filter_all') : n === 1 ? one?.code || t('fdr.filter_n', { n }) : t('fdr.filter_n', { n });
  return (
    <button
      className={`flex h-7 max-w-[11rem] items-center gap-1 rounded-md border px-2 text-xs ${
        open ? 'border-brand-600 bg-brand-600 text-white' : n > 0 ? 'border-brand-600 text-brand-700 hover:bg-gray-100' : 'border-gray-300 text-gray-700 hover:bg-gray-100'
      }`}
      title={t('fdr.filter_title')}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name="sliders" size={14} />
      <span className="truncate">{label}</span>
      <span aria-hidden>▾</span>
    </button>
  );
}

/** Panel pilihan penyulang per GI (centang = tambah / hapus; klik nama = tampilkan penyulang itu saja & perbesar). */
export function FeederFilterPanel({
  state,
  live,
  setLive,
  onClose,
  note,
}: {
  state: FeederFilterState;
  live: boolean;
  setLive: (v: boolean) => void;
  onClose: () => void;
  /** catatan tambahan di bawah petunjuk (mis. snapping di Editor Peta) */
  note?: string;
}) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const sel = useMemo(() => new Set(state.ids), [state.ids]);
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const m = new Map<string, FeederItem[]>();
    for (const it of state.items) {
      if (term && !`${it.code} ${it.name} ${it.gi_code}`.toLowerCase().includes(term)) continue;
      const g = it.gi_code || '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(it);
    }
    return Array.from(m, ([gi, list]) => ({ gi, list: list.sort((a, b) => (a.code || '').localeCompare(b.code || '')) })).sort((a, b) =>
      a.gi === '' ? 1 : b.gi === '' ? -1 : a.gi.localeCompare(b.gi),
    );
  }, [state.items, q]);
  const shown = groups.reduce((a, g) => a + g.list.length, 0);

  const setGroup = (list: FeederItem[], on: boolean) => {
    const ids = new Set(state.ids);
    for (const it of list) {
      if (on) ids.add(it.id);
      else ids.delete(it.id);
    }
    state.setIds(Array.from(ids));
  };

  return (
    <div className="w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border border-gray-200 bg-white/95 text-xs text-gray-800 shadow-xl">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <span className="flex-1 text-sm font-semibold text-gray-900">{t('fdr.filter_title')}</span>
        <div className="flex overflow-hidden rounded-md border border-gray-300" role="group" aria-label={t('fdr.mode')}>
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              className={`px-2 py-0.5 ${live === v ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
              onClick={() => setLive(v)}
              title={v ? t('fdr.live_hint') : t('fdr.normal_hint')}
              aria-pressed={live === v}
            >
              {v ? t('fdr.live') : t('fdr.normal')}
            </button>
          ))}
        </div>
        <button className="w-5 text-center text-sm leading-none text-gray-500 hover:text-gray-800" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          ×
        </button>
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] text-gray-500">{t('fdr.filter_hint')}</p>
        {note && state.ids.length > 0 && <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{note}</p>}
        <input className="input h-7 py-0 text-xs" value={q} placeholder={t('fdr.filter_search')} aria-label={t('fdr.filter_search')} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-72 overflow-y-auto pr-1">
          {state.items.length === 0 ? (
            <div className="py-2 text-gray-500">{state.loading ? t('common.loading') : t('fdr.filter_none')}</div>
          ) : shown === 0 ? (
            <div className="py-2 text-gray-500">{t('fdr.filter_none')}</div>
          ) : (
            groups.map((g) => {
              const n = g.list.filter((it) => sel.has(it.id)).length;
              return (
                <div key={g.gi || '-'} className="mb-1">
                  <label className="flex items-center gap-2 rounded px-1 py-1 font-semibold text-gray-700 hover:bg-gray-100" title={t('fdr.filter_gi', { gi: g.gi || t('fdr.no_gi') })}>
                    <input
                      type="checkbox"
                      checked={n > 0 && n === g.list.length}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && n < g.list.length;
                      }}
                      onChange={(e) => setGroup(g.list, e.target.checked)}
                    />
                    <span className="flex-1 truncate">{g.gi ? `GI ${g.gi}` : t('fdr.no_gi')}</span>
                    <span className="text-[10px] font-normal tabular-nums text-gray-500">
                      {n > 0 ? `${fmtNum(n)}/` : ''}
                      {fmtNum(g.list.length)}
                    </span>
                  </label>
                  <ul className="ml-3 space-y-0.5">
                    {g.list.map((it) => (
                      <li key={it.id} className="flex items-center gap-2 rounded px-1 hover:bg-gray-100">
                        <input type="checkbox" checked={sel.has(it.id)} onChange={() => state.toggle(it.id)} aria-label={it.code || `#${it.id}`} />
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: feederColor(it.color) }} />
                        <button
                          className={`min-w-0 flex-1 truncate py-0.5 text-left ${sel.has(it.id) ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                          onClick={() => {
                            state.setIds([it.id]);
                            state.zoom([it.id]);
                          }}
                          title={t('fdr.filter_only')}
                        >
                          {it.code || `#${it.id}`}
                          {it.name && it.name !== it.code && <span className="ml-1 font-normal text-gray-500">{it.name}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
          <span className="flex-1 text-[11px] text-gray-500">{state.ids.length > 0 ? t('fdr.filter_selected', { n: fmtNum(state.ids.length) }) : t('fdr.filter_all')}</span>
          <button className="rounded-md px-2 py-1 text-brand-700 hover:bg-gray-100 disabled:opacity-40" disabled={state.ids.length === 0} onClick={() => state.zoom()}>
            {t('fdr.filter_zoom')}
          </button>
          <button className="rounded-md px-2 py-1 text-brand-700 hover:bg-gray-100 disabled:opacity-40" disabled={state.ids.length === 0} onClick={state.clear}>
            {t('fdr.filter_clear')}
          </button>
        </div>
      </div>
    </div>
  );
}
