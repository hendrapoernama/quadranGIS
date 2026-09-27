'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { fmtNum } from '@/lib/format';
import { useExecT } from './i18n';
import type { Insight } from './types';

/** Indeks keandalan: angka kecil (SAIDI sistem jutaan pelanggan) tetap terbaca. */
export function fmtIdx(v: number | undefined | null): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  if (v === 0) return '0';
  if (Math.abs(v) < 0.01) return v.toLocaleString('id-ID', { maximumSignificantDigits: 3 });
  if (Math.abs(v) < 10) return v.toLocaleString('id-ID', { maximumFractionDigits: 3 });
  return v.toLocaleString('id-ID', { maximumFractionDigits: 1 });
}

export function fmtRp(v: number | undefined | null): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  if (v >= 1e9) return `Rp ${fmtNum(v / 1e9, 2)} M`;
  if (v >= 1e6) return `Rp ${fmtNum(v / 1e6, 1)} jt`;
  return `Rp ${fmtNum(v, 0)}`;
}

export function fmtMin(m: number | undefined | null): string {
  if (m === undefined || m === null || Number.isNaN(m)) return '-';
  if (m < 60) return `${fmtNum(m, m < 10 ? 1 : 0)} mnt`;
  const h = Math.floor(m / 60);
  return `${h} j ${Math.round(m % 60)} mnt`;
}

/** Perubahan terhadap periode sebelumnya. badUp: kenaikan = memburuk (merah). */
export function Delta({ cur, prev, badUp = true }: { cur: number; prev: number | undefined; badUp?: boolean }) {
  if (prev === undefined || prev === null) return null;
  if (cur === 0 && prev === 0) return <span className="text-gray-400">±0</span>;
  if (prev === 0) return <span className={badUp ? 'text-red-600' : 'text-emerald-600'}>▲ {cur > 0 ? 'baru' : ''}</span>;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return <span className="text-gray-500">±0%</span>;
  const up = pct > 0;
  const bad = up === badUp;
  return (
    <span className={bad ? 'text-red-600' : 'text-emerald-600'}>
      {up ? '▲' : '▼'} {fmtNum(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}%
    </span>
  );
}

/** Status terhadap target: selalu ikon + label, bukan warna saja. */
export function TargetBadge({ value, target }: { value: number; target: number }) {
  const e = useExecT();
  if (!target) return null;
  const ok = value <= target;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
      <Icon name={ok ? 'check' : 'alert'} size={11} />
      {ok ? e('on_track') : e('off_track')}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  unit,
  sub,
  status,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  sub?: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <div className="card flex min-w-0 flex-col px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</span>
        {status}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="truncate text-2xl font-semibold tabular-nums text-gray-900">{value}</span>
        {unit && <span className="text-xs text-gray-500">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

export const SEV_STYLE: Record<Insight['severity'], { cls: string; icon: string }> = {
  critical: { cls: 'border-red-300 bg-red-50 text-red-700', icon: 'alert' },
  serious: { cls: 'border-orange-300 bg-orange-50 text-orange-700', icon: 'alert' },
  warning: { cls: 'border-amber-300 bg-amber-50 text-amber-800', icon: 'info' },
  info: { cls: 'border-gray-300 bg-gray-50 text-gray-700', icon: 'info' },
};

/** Tautan ke menu yang relevan untuk target temuan. */
export function insightHref(it: Insight): string | null {
  const t = it.target;
  if (!t) return null;
  switch (t.kind) {
    case 'node':
    case 'edge':
      return `/sld?focus=${t.kind}:${t.id}`;
    case 'region':
      return `/reliability?region=${t.id}`;
    case 'outage':
      return '/monitoring?tab=flisr';
    case 'report':
      return '/monitoring?tab=reports';
    case 'plan':
      return '/monitoring?tab=plans';
  }
  return null;
}

export function InsightList({ items, max }: { items: Insight[]; max?: number }) {
  const e = useExecT();
  const router = useRouter();
  const list = max ? items.slice(0, max) : items;
  if (items.length === 0)
    return (
      <div className="flex items-center gap-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-700">
        <Icon name="check" size={14} />
        {e('insights_none')}
      </div>
    );
  return (
    <ul className="space-y-1.5">
      {list.map((it, i) => {
        const st = SEV_STYLE[it.severity];
        const href = insightHref(it);
        return (
          <li key={i} className="flex gap-2 rounded-md border border-gray-200 px-2 py-1.5 text-xs">
            <span className={`mt-0.5 inline-flex h-fit shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>
              <Icon name={st.icon} size={11} />
              {e(`sev_${it.severity}` as any)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-gray-900">{it.title}</div>
              <div className="text-gray-600">{it.detail}</div>
            </div>
            {href && (
              <button className="h-fit shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-brand-700" onClick={() => router.push(href)} title={it.target?.code || ''}>
                <Icon name="chevron-right" size={14} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Batang horizontal sederhana untuk porsi (0–1). */
export function ShareBar({ value, color = 'var(--series-1)' }: { value: number; color?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </div>
  );
}

/** Unduh teks sebagai berkas (CSV dengan BOM agar Excel membaca UTF-8). */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells
    .map((c) => {
      const s = c === null || c === undefined ? '' : String(c);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(';');
}
