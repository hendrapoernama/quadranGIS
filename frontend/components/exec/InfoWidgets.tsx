'use client';

import React from 'react';
import { Icon } from '@/components/Icon';
import { fmtNum } from '@/lib/format';

// Widget bergaya infografis, dipakai Dashboard › Infografis, Dashboard › Keandalan & Operasi, dan Pusat Operasi.

/** Judul kartu kecil: ikon + huruf kapital, rata tengah. */
export function CardTitle({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
      <Icon name={icon as any} size={13} />
      <span className="truncate">{text}</span>
    </div>
  );
}

/** Judul bagian: ikon + huruf kapital tebal. */
export function SectionTitle({ icon, text, inline }: { icon: string; text: string; inline?: boolean }) {
  return (
    <h3 className={`flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-800 ${inline ? '' : 'mb-2'}`}>
      <Icon name={icon as any} size={14} />
      {text}
    </h3>
  );
}

/** Angka berlatar warna lembut (tabel). */
export function Pill({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-block min-w-[2.25rem] rounded px-1.5 py-0.5 text-center text-[11px] font-semibold tabular-nums ${cls}`}>{children}</span>;
}

/** Kotak berwarna solid untuk indeks utama (SAIDI, SAIFI, ENS, ...), teks putih. compact = versi pita (Pusat Operasi). */
export function BigTile({
  cls,
  label,
  value,
  unit,
  badge,
  sub,
  compact,
  title,
}: {
  cls: string;
  label: string;
  value: string;
  unit?: string;
  badge?: React.ReactNode;
  sub?: React.ReactNode;
  compact?: boolean;
  title?: string;
}) {
  return (
    <div className={`flex flex-col rounded-lg text-white shadow ${compact ? 'min-w-[7.5rem] flex-1 basis-0 px-2.5 py-1.5' : 'px-4 py-3'} ${cls}`} title={title}>
      <div className="flex items-start justify-between gap-2">
        <div className={`truncate font-semibold uppercase tracking-wide opacity-90 ${compact ? 'text-[10px]' : 'text-xs'}`}>{label}</div>
        {badge}
      </div>
      <div className={`flex flex-wrap items-baseline gap-x-1.5 ${compact ? '' : 'mt-1'}`}>
        <span className={`font-bold tabular-nums ${compact ? 'text-lg leading-tight' : 'text-xl md:text-2xl'}`}>{value}</span>
        {unit && <span className={`opacity-90 ${compact ? 'text-[10px]' : 'text-xs'}`}>{unit}</span>}
      </div>
      {sub && <div className={`truncate opacity-90 ${compact ? 'text-[10px]' : 'mt-1 text-[11px]'}`}>{sub}</div>}
    </div>
  );
}

/** Lencana di atas kotak berwarna solid (mis. status terhadap target): selalu ikon + label. */
export function TileBadge({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold">
      <Icon name={ok ? 'check' : 'alert'} size={11} />
      {ok ? okText : badText}
    </span>
  );
}

/** Perubahan terhadap periode sebelumnya, untuk teks putih di atas kotak berwarna (panah + persen). */
export function TileDelta({ cur, prev }: { cur: number; prev: number | undefined }) {
  if (prev === undefined || prev === null) return null;
  if (cur === 0 && prev === 0) return <span>±0</span>;
  if (prev === 0) return <span>▲ {cur > 0 ? 'baru' : ''}</span>;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return <span>±0%</span>;
  return (
    <span>
      {pct > 0 ? '▲' : '▼'} {fmtNum(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}%
    </span>
  );
}

const TONE: Record<string, string> = {
  red: 'bg-red-50 text-red-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-800',
  orange: 'bg-orange-50 text-orange-700',
  blue: 'bg-blue-50 text-blue-800',
};

/**
 * Kartu dua kotak bergaya infografis: judul, pil teal (angka utama), kotak kiri (masalah, mis. padam) & kanan
 * (baik, mis. nyala), dan batang persentase "baik".
 */
export function SplitCard({
  icon,
  title,
  head,
  left,
  right,
  caption,
}: {
  icon: string;
  title: string;
  head: string;
  left: { label: string; value: string; tone?: keyof typeof TONE };
  right: { label: string; value: string; tone?: keyof typeof TONE };
  /** persen bagian kanan (0–100) dan keterangannya; null = tanpa batang */
  caption?: { pct: number | null; text: string };
}) {
  return (
    <div className="card flex flex-col gap-2 p-3">
      <CardTitle icon={icon} text={title} />
      <div className="truncate rounded-full bg-teal-600 px-2 py-1 text-center text-xs font-semibold text-white">{head}</div>
      <div className="grid grid-cols-2 gap-1">
        {[left, right].map((b, i) => (
          <div key={i} className={`rounded-md px-1 py-1.5 text-center ${TONE[b.tone || (i === 0 ? 'red' : 'emerald')]}`}>
            <div className="truncate text-[10px] font-semibold uppercase">{b.label}</div>
            <div className="whitespace-nowrap text-[13px] font-bold leading-tight tabular-nums sm:text-base">{b.value}</div>
          </div>
        ))}
      </div>
      {caption && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-red-100">
            <div className="h-full bg-emerald-500" style={{ width: `${caption.pct ?? 0}%` }} />
          </div>
          <div className="mt-1 text-center text-[11px] text-gray-500">{caption.text}</div>
        </div>
      )}
    </div>
  );
}

/** Kartu satu angka bergaya infografis: judul, pil teal (keterangan), angka besar berlatar warna. */
export function ValueCard({ icon, title, head, value, tone = 'blue', note }: { icon: string; title: string; head: string; value: string; tone?: keyof typeof TONE; note?: React.ReactNode }) {
  return (
    <div className="card flex flex-col gap-2 p-3">
      <CardTitle icon={icon} text={title} />
      <div className="truncate rounded-full bg-teal-600 px-2 py-1 text-center text-xs font-semibold text-white">{head}</div>
      <div className={`flex flex-1 items-center justify-center rounded-md px-2 py-1.5 text-center ${TONE[tone]}`}>
        <span className="text-2xl font-bold tabular-nums">{value}</span>
      </div>
      {note && <div className="text-center text-[11px] text-gray-500">{note}</div>}
    </div>
  );
}

/** gaya kartu / kotak yang bisa diklik (membuka tab / daftar terkait) */
const CLICKABLE = 'cursor-pointer transition hover:ring-2 hover:ring-teal-500/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/** Atribut elemen yang bisa diklik & dipakai papan ketik (div, bukan <button>, agar isi kartu tetap selebar kartu). */
function clickProps(onClick?: () => void) {
  if (!onClick) return {};
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
}

/** Ukuran angka di kotak sempit: angka panjang diperkecil agar tidak terpotong. */
const valueSize = (v: string) => (v.length >= 9 ? 'text-[11px]' : v.length >= 7 ? 'text-xs' : 'text-[13px]');

/**
 * Kartu status ringkas bergaya infografis (pita Pusat Operasi): judul, pil teal (total), kotak padam / sebagian / nyala,
 * dan batang persentase nyala. Kartu tiga kotak dibuat lebih lebar.
 */
export function StatusCard({
  icon,
  title,
  head,
  boxes,
  pct,
  caption,
  onClick,
  hint,
}: {
  icon: string;
  title: string;
  head: string;
  boxes: { label: string; value: string; tone: keyof typeof TONE }[];
  /** persen nyala (0–100) */
  pct: number;
  caption: string;
  onClick?: () => void;
  hint?: string;
}) {
  const wide = boxes.length > 2;
  return (
    <div className={`card flex basis-0 flex-col gap-1 p-2 ${wide ? 'min-w-[11rem] flex-[1.3]' : 'min-w-[8.75rem] flex-1'} ${onClick ? CLICKABLE : ''}`} title={hint ?? title} {...clickProps(onClick)}>
      <CardTitle icon={icon} text={title} />
      <div className="truncate rounded-full bg-teal-600 px-2 py-0.5 text-center text-[11px] font-semibold text-white">{head}</div>
      <div className={`grid gap-1 ${wide ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {boxes.map((b, i) => (
          <div key={i} className={`min-w-0 rounded px-0.5 py-1 text-center ${TONE[b.tone]}`}>
            <div className="truncate text-[9px] font-semibold uppercase leading-tight">{b.label}</div>
            <div className={`truncate font-bold leading-tight tabular-nums ${valueSize(b.value)}`} title={b.value}>
              {b.value}
            </div>
          </div>
        ))}
      </div>
      <div>
        <div className="h-1 overflow-hidden rounded-full bg-red-100">
          <div className="h-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
        <div className="mt-0.5 truncate text-center text-[10px] text-gray-500">{caption}</div>
      </div>
    </div>
  );
}

/**
 * Kartu beberapa jumlah bergaya infografis (seperti "Jumlah event"): judul + kotak berwarna kecil yang masing-masing dapat
 * diklik, mis. kejadian aktif / rencana / laporan / switch terbuka di Pusat Operasi.
 */
export function BoxesCard({
  icon,
  title,
  boxes,
}: {
  icon: string;
  title: string;
  boxes: { label: string; value: string; tone: keyof typeof TONE; note?: string; onClick?: () => void; hint?: string }[];
}) {
  return (
    <div className="card flex min-w-[16rem] flex-[1.8] basis-0 flex-col gap-1 p-2">
      <CardTitle icon={icon} text={title} />
      <div className="grid flex-1 grid-cols-2 gap-1">
        {boxes.map((b, i) => (
          <div
            key={i}
            className={`flex min-w-0 items-center justify-between gap-1 rounded px-1.5 py-0.5 ${TONE[b.tone]} ${b.onClick ? CLICKABLE : ''}`}
            title={b.hint ?? b.label}
            {...clickProps(b.onClick)}
          >
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[9px] font-semibold uppercase">{b.label}</span>
              {b.note && <span className="block truncate text-[9px]">{b.note}</span>}
            </span>
            <span className="shrink-0 text-sm font-bold tabular-nums">{b.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
