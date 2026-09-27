'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { Icon } from '@/components/Icon';
import { useLoadT } from './i18n';

/** Beban (MW): di bawah 1 MW ditampilkan dalam kW agar gardu distribusi tetap terbaca. */
export const fmtMW = (v: number | null | undefined, d = 2) => {
  if (v === null || v === undefined) return '-';
  if (Math.abs(v) > 0 && Math.abs(v) < 1) return `${fmtNum(v * 1000, 0)} kW`;
  return `${fmtNum(v, d)} MW`;
};
export const fmtMWh = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '-';
  if (Math.abs(v) > 0 && Math.abs(v) < 1) return `${fmtNum(v * 1000, 0)} kWh`;
  return `${fmtNum(v, Math.abs(v) < 100 ? 1 : 0)} MWh`;
};
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${fmtNum(v, Math.abs(v) < 10 ? 1 : 0)}%`);
export const fmtHM = (s: string | null | undefined) => (s ? new Date(s).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-');
export const fmtDT = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Satuan beban untuk sumbu grafik: gardu memakai kW. */
export const loadUnit = (capMW: number) => (capMW > 0 && capMW < 2 ? 'kW' : 'MW');
export const toUnit = (v: number, unit: string) => (unit === 'kW' ? v * 1000 : v);

/** Warna pembebanan: aman / perhatian / beban lebih — selalu disertai angka. */
export function utilClass(v: number, warn = 80, over = 100): string {
  if (v >= over) return 'text-red-600 font-semibold';
  if (v >= warn) return 'text-amber-700 font-semibold';
  return 'text-gray-800';
}

/** Warna susut: tinggi (≥ batas) merah, negatif (kesalahan meter) ungu. */
export function lossClass(v: number, high = 12): string {
  if (v >= high) return 'text-red-600 font-semibold';
  if (v >= high * 0.7) return 'text-amber-700 font-semibold';
  if (v < -2) return 'text-purple-700 font-semibold';
  return 'text-gray-800';
}

export function UtilBar({ v, warn = 80, over = 100 }: { v: number; warn?: number; over?: number }) {
  const color = v >= over ? 'var(--status-critical)' : v >= warn ? 'var(--status-warning)' : 'var(--status-good)';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, v))}%`, background: color }} />
    </div>
  );
}

export const SEV_CLS: Record<string, string> = {
  critical: 'border-red-300 bg-red-50 text-red-700',
  serious: 'border-orange-300 bg-orange-50 text-orange-700',
  warning: 'border-amber-300 bg-amber-50 text-amber-800',
  info: 'border-gray-300 bg-gray-50 text-gray-700',
};

export function SevBadge({ sev }: { sev: string }) {
  const L = useLoadT();
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SEV_CLS[sev] || SEV_CLS.info}`}>
      <Icon name={sev === 'info' ? 'info' : 'alert'} size={10} />
      {L(`sev_${sev}`)}
    </span>
  );
}

export interface EntityRef {
  level: string;
  id: string;
  name?: string;
}

interface EntityItem {
  id: string;
  name: string;
  parent?: string;
  cap_mw: number;
  count: number;
}

export const ALL_LEVELS = ['system', 'uid', 'up3', 'gi', 'trafo_gi', 'feeder', 'gd'];

/** Pemilih objek analisa: level (sistem/UID/UP3/GI/trafo/penyulang/gardu) + pencarian. */
export function EntityPicker({ value, onChange, levels = ALL_LEVELS }: { value: EntityRef; onChange: (e: EntityRef) => void; levels?: string[] }) {
  const L = useLoadT();
  const [items, setItems] = useState<EntityItem[]>([]);
  const [q, setQ] = useState('');
  const level = value.level;
  useEffect(() => {
    if (level === 'system') return setItems([]);
    let stop = false;
    api<{ items: EntityItem[] }>(`/api/load/entities?level=${level}`)
      .then((r) => !stop && setItems(r.items))
      .catch(() => !stop && setItems([]));
    return () => {
      stop = true;
    };
  }, [level]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? items.filter((i) => i.name.toLowerCase().includes(s) || (i.parent || '').toLowerCase().includes(s)) : items).slice(0, 300);
  }, [items, q]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {levels.length > 1 && (
        <div className="flex flex-wrap rounded-md border border-gray-300 bg-white p-0.5 text-xs">
          {levels.map((lv) => (
            <button key={lv} className={`rounded px-2 py-1 ${level === lv ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => onChange({ level: lv, id: '' })}>
              {L(`level_${lv}`)}
            </button>
          ))}
        </div>
      )}
      {level !== 'system' && (
        <>
          <input className="input !w-40 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('search')} aria-label={L('search')} />
          <select
            className="input !w-64 max-w-full text-xs"
            value={value.id}
            aria-label={L('pick_entity')}
            onChange={(e) => onChange({ level, id: e.target.value, name: items.find((i) => i.id === e.target.value)?.name })}
          >
            <option value="">
              — {L('pick_entity')} ({shown.length}) —
            </option>
            {shown.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.parent ? ` · ${i.parent}` : ''}
                {i.cap_mw ? ` · ${i.cap_mw < 1 ? `${fmtNum(i.cap_mw * 1000, 0)} kW` : `${fmtNum(i.cap_mw, 1)} MW`}` : ''}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

/** Kartu angka kecil. */
export function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-base font-semibold tabular-nums text-gray-900">{value}</div>
      {sub ? <div className="truncate text-[10px] text-gray-500">{sub}</div> : null}
    </div>
  );
}
