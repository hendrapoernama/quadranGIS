'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { FeatureCollection } from '@/lib/types';
import { BOUNDARY_PALETTE } from './mapStyle';
import type { BoundaryStyle, MapHandle } from './types';

const STORE_KEY = 'qgis.boundary.v1';
let dataPromise: Promise<FeatureCollection & { meta?: { up3: number; ulp: number } }> | null = null;

/** Data batas wilayah dimuat sekali per halaman (dibagi antar peta). */
function loadBoundaries() {
  if (!dataPromise) {
    dataPromise = api<FeatureCollection & { meta?: { up3: number; ulp: number } }>('/api/gis/boundaries').catch((e) => {
      dataPromise = null;
      throw e;
    });
  }
  return dataPromise;
}

export interface BoundaryState {
  style: BoundaryStyle;
  setStyle: (s: BoundaryStyle) => void;
  meta: { up3: number; ulp: number } | null;
  error: string;
}

/**
 * Overlay batas UP3 / ULP pada peta: memuat data, menerapkan tampilan, dan mengingat pilihan
 * pengguna (tampil, garis ULP, label, transparansi) di browser. Bawaan dari konfigurasi
 * map.boundary_visible & map.boundary_opacity.
 */
export function useBoundaryOverlay(mapRef: React.RefObject<MapHandle | null>, configs: Record<string, string>, ready: boolean): BoundaryState {
  const [style, setStyleState] = useState<BoundaryStyle>(() => {
    const def: BoundaryStyle = {
      show: (configs['map.boundary_visible'] ?? 'true') !== 'false',
      ulp: false,
      labels: true,
      opacity: Number(configs['map.boundary_opacity'] ?? 0.15) || 0.15,
    };
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) return { ...def, ...JSON.parse(raw) };
    } catch {
      /* penyimpanan browser tidak tersedia */
    }
    return def;
  });
  const [meta, setMeta] = useState<{ up3: number; ulp: number } | null>(null);
  const stored = useRef<boolean | null>(null);
  // bawaan dari konfigurasi (dimuat asinkron) dipakai selama pengguna belum menyimpan pilihan sendiri
  useEffect(() => {
    if (stored.current === null) {
      try {
        stored.current = !!window.localStorage.getItem(STORE_KEY);
      } catch {
        stored.current = false;
      }
    }
    if (stored.current || !('map.boundary_visible' in configs || 'map.boundary_opacity' in configs)) return;
    setStyleState((cur) => ({
      ...cur,
      show: (configs['map.boundary_visible'] ?? 'true') !== 'false',
      opacity: Number(configs['map.boundary_opacity'] ?? 0.15) || 0.15,
    }));
  }, [configs]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    loadBoundaries()
      .then((fc) => {
        if (!alive) return;
        mapRef.current?.setBoundary(fc);
        setMeta(fc.meta || null);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [ready, mapRef]);

  useEffect(() => {
    if (ready) mapRef.current?.setBoundaryStyle(style);
  }, [ready, style, mapRef]);

  const setStyle = (s: BoundaryStyle) => {
    setStyleState(s);
    stored.current = true;
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      /* abaikan */
    }
  };
  return { style, setStyle, meta, error };
}

/** Kontrol overlay batas wilayah (dipakai di tab Layer editor dan Power Monitor). */
export function BoundaryControl({ state, compact = false }: { state: BoundaryState; compact?: boolean }) {
  const { t } = useT();
  const { style, setStyle, meta, error } = state;
  const transparency = Math.round((1 - style.opacity) * 100);
  return (
    <div className={`space-y-1.5 text-xs ${compact ? '' : 'rounded-md border border-gray-200 p-2'}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">{t('bnd.title')}</span>
        <span className="flex gap-0.5" aria-hidden>
          {BOUNDARY_PALETTE.map((c) => (
            <span key={c} className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ background: `${c}55`, borderColor: c }} />
          ))}
        </span>
      </div>
      <label className="flex items-center gap-2 text-gray-800">
        <input type="checkbox" checked={style.show} onChange={(e) => setStyle({ ...style, show: e.target.checked })} />
        {t('bnd.show_up3')}
        {meta && <span className="text-[10px] text-gray-500">({meta.up3})</span>}
      </label>
      <label className={`flex items-center gap-2 text-gray-800 ${style.show ? '' : 'opacity-50'}`}>
        <input type="checkbox" disabled={!style.show} checked={style.ulp} onChange={(e) => setStyle({ ...style, ulp: e.target.checked })} />
        {t('bnd.show_ulp')}
        {meta && <span className="text-[10px] text-gray-500">({meta.ulp})</span>}
      </label>
      <label className={`flex items-center gap-2 text-gray-800 ${style.show ? '' : 'opacity-50'}`}>
        <input type="checkbox" disabled={!style.show} checked={style.labels} onChange={(e) => setStyle({ ...style, labels: e.target.checked })} />
        {t('bnd.labels')}
      </label>
      <div className={style.show ? '' : 'opacity-50'}>
        <div className="flex items-center justify-between text-gray-700">
          <label htmlFor="bnd-transparency">{t('bnd.transparency')}</label>
          <span className="tabular-nums text-gray-500">{transparency}%</span>
        </div>
        <input
          id="bnd-transparency"
          type="range"
          min={0}
          max={100}
          step={5}
          disabled={!style.show}
          value={transparency}
          onChange={(e) => setStyle({ ...style, opacity: Math.round(100 - Number(e.target.value)) / 100 })}
          className="w-full accent-brand-600"
          aria-valuetext={`${transparency}%`}
        />
        <div className="flex justify-between text-[10px] text-gray-400">
          <span>{t('bnd.solid')}</span>
          <span>{t('bnd.clear')}</span>
        </div>
      </div>
      {error && <div className="text-[11px] text-red-700">{error}</div>}
    </div>
  );
}
