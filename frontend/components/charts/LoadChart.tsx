'use client';

import { useMemo, useState } from 'react';

export interface LoadLine {
  name: string;
  points: { t: number; v: number | null }[]; // t = epoch ms
  color: string;
  dashed?: boolean;
  width?: number;
}

interface Props {
  title: string;
  lines: LoadLine[];
  band?: { t: number; lo: number; hi: number }[];
  bandColor?: string;
  refs?: { value: number; label: string; color: string }[];
  unit?: string;
  height?: number;
  xFormat?: (t: number) => string;
  tipFormat?: (t: number) => string;
  format?: (v: number) => string;
  emptyText?: string;
  onPick?: (t: number) => void;
  /** celah maksimum antar-titik sebelum garis diputus (ms), bawaan 1 jam; deret harian: ~36 jam */
  maxGap?: number;
  /** jarak maksimum kursor ke titik untuk tooltip (ms), bawaan 20 menit */
  snap?: number;
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Number(v.toPrecision(6)));
  return out;
}

/** Grafik deret waktu beban: beberapa garis, pita prakiraan, garis batas (80% / 100%), crosshair + tooltip. */
export function LoadChart({
  title,
  lines,
  band,
  bandColor = 'var(--series-1)',
  refs = [],
  unit = '',
  height = 220,
  xFormat = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
  tipFormat = (t) => new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
  format = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 2 }),
  emptyText = '-',
  onPick,
  maxGap = 3600_000,
  snap = 20 * 60_000,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 700;
  const pad = { l: 46, r: 12, t: 10, b: 24 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const all = lines.flatMap((l) => l.points);
  const [t0, t1] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const p of all) {
      a = Math.min(a, p.t);
      b = Math.max(b, p.t);
    }
    for (const p of band || []) {
      a = Math.min(a, p.t);
      b = Math.max(b, p.t);
    }
    return [a, b];
  }, [all, band]);
  const vmax = Math.max(0, ...all.map((p) => p.v || 0), ...(band || []).map((b) => b.hi), ...refs.map((r) => r.value));
  const ticks = niceTicks(vmax * 1.02);
  const ymax = ticks[ticks.length - 1] || 1;
  const x = (t: number) => pad.l + (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : w / 2);
  const y = (v: number) => pad.t + h - (v / ymax) * h;
  const empty = !isFinite(t0) || all.every((p) => p.v === null || p.v === 0);
  const path = (pts: LoadLine['points']) => {
    let d = '';
    let pen = false;
    let last = 0;
    for (const p of pts) {
      // putus garis bila ada celah data > maxGap
      if (p.v === null || (pen && p.t - last > maxGap)) {
        pen = false;
        if (p.v === null) continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
      pen = true;
      last = p.t;
    }
    return d;
  };
  const bandPath = band && band.length > 1 ? `M${band.map((b) => `${x(b.t).toFixed(1)},${y(b.hi).toFixed(1)}`).join(' L')} L${[...band].reverse().map((b) => `${x(b.t).toFixed(1)},${y(b.lo).toFixed(1)}`).join(' L')} Z` : '';
  const xticks = useMemo(() => {
    if (!isFinite(t0)) return [];
    const n = 6;
    return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
  }, [t0, t1]);
  const nearest = (pts: LoadLine['points'], t: number) => {
    let best: LoadLine['points'][number] | null = null;
    for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && Math.abs(best.t - t) <= snap ? best : null;
  };

  return (
    <div className="card p-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <div className="flex flex-wrap gap-3 text-[11px] text-gray-600">
          {lines.map((l) => (
            <span key={l.name} className="flex items-center gap-1">
              <span className="inline-block w-4 border-t-2" style={{ borderColor: l.color, borderStyle: l.dashed ? 'dashed' : 'solid' }} />
              {l.name}
            </span>
          ))}
          {refs.map((r) => (
            <span key={r.label} className="flex items-center gap-1">
              <span className="inline-block w-4 border-t-2 border-dotted" style={{ borderColor: r.color }} />
              {r.label}
            </span>
          ))}
        </div>
      </div>
      {empty ? (
        <div className="py-12 text-center text-xs text-gray-500">{emptyText}</div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full touch-none"
          role="img"
          aria-label={title}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * width;
            const t = t0 + ((px - pad.l) / w) * (t1 - t0);
            setHover(t >= t0 && t <= t1 ? t : null);
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => hover !== null && onPick?.(hover)}
        >
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={pad.l} x2={width - pad.r} y1={y(tk)} y2={y(tk)} style={{ stroke: 'var(--chart-grid)' }} />
              <text x={pad.l - 6} y={y(tk) + 3.5} fontSize={10} textAnchor="end" style={{ fill: 'var(--chart-text)' }}>
                {format(tk)}
              </text>
            </g>
          ))}
          {xticks.map((t, i) => (
            <text key={i} x={x(t)} y={height - 6} fontSize={10} textAnchor={i === 0 ? 'start' : i === xticks.length - 1 ? 'end' : 'middle'} style={{ fill: 'var(--chart-text)' }}>
              {xFormat(t)}
            </text>
          ))}
          {bandPath && <path d={bandPath} style={{ fill: bandColor, opacity: 0.14 }} />}
          {refs.map((r) => (
            <line key={r.label} x1={pad.l} x2={width - pad.r} y1={y(r.value)} y2={y(r.value)} style={{ stroke: r.color }} strokeWidth={1.4} strokeDasharray="2 4" />
          ))}
          {lines.map((l) => (
            <path key={l.name} d={path(l.points)} fill="none" style={{ stroke: l.color }} strokeWidth={l.width || 2} strokeDasharray={l.dashed ? '6 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} style={{ stroke: 'var(--chart-cursor)' }} strokeDasharray="3 3" />
              {lines.map((l) => {
                const p = nearest(l.points, hover);
                return p && p.v !== null ? <circle key={l.name} cx={x(p.t)} cy={y(p.v)} r={4} style={{ fill: l.color, stroke: 'var(--surface-1)' }} strokeWidth={2} /> : null;
              })}
              <foreignObject x={Math.min(x(hover) + 10, width - 196)} y={pad.t} width={186} height={24 + lines.length * 16}>
                <div className="rounded border border-gray-200 bg-white/95 px-2 py-1 text-[11px] text-gray-800 shadow">
                  <div className="text-gray-500">{tipFormat(hover)}</div>
                  {lines.map((l) => {
                    const p = nearest(l.points, hover);
                    return (
                      <div key={l.name} className="flex justify-between gap-2">
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
                          {l.name}
                        </span>
                        <span className="font-medium tabular-nums">{p && p.v !== null ? `${format(p.v)}${unit}` : '-'}</span>
                      </div>
                    );
                  })}
                </div>
              </foreignObject>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

/** Peta panas hari × jam (nilai 0..max) dengan ramp sekuensial satu hue. */
export function Heatmap({
  title,
  rows,
  rowLabel,
  max,
  format = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 2 }),
  unit = '',
  dark = false,
}: {
  title: string;
  rows: number[][];
  rowLabel: (i: number) => string;
  max?: number;
  format?: (v: number) => string;
  unit?: string;
  dark?: boolean;
}) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const m = max ?? Math.max(0, ...rows.flat());
  const light = ['#eef4fd', '#c9dcf7', '#94bbef', '#5a93e2', '#2a6cc9', '#174b96'];
  const darkRamp = ['#18263a', '#1f3b62', '#27538b', '#3070b8', '#4d93e0', '#8ab8f2'];
  const ramp = dark ? darkRamp : light;
  const color = (v: number) => (v <= 0 ? (dark ? '#1f2937' : '#f3f4f6') : ramp[Math.min(ramp.length - 1, Math.floor((v / (m || 1)) * ramp.length))]);
  return (
    <div className="card p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <div className="flex items-center gap-1 text-[10px] text-gray-500">
          0
          {ramp.map((c) => (
            <span key={c} className="inline-block h-2.5 w-4" style={{ background: c }} />
          ))}
          {format(m)}
          {unit}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="ml-10 grid grid-cols-[repeat(24,minmax(0,1fr))] text-[9px] text-gray-500">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i}>{i % 3 === 0 ? String(i).padStart(2, '0') : ''}</span>
            ))}
          </div>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center">
              <span className="w-10 shrink-0 text-[10px] tabular-nums text-gray-500">{rowLabel(i)}</span>
              <div className="grid flex-1 grid-cols-[repeat(48,minmax(0,1fr))] gap-px">
                {r.map((v, j) => (
                  <span key={j} className="h-3.5" style={{ background: color(v) }} onMouseEnter={() => setHover({ r: i, c: j })} onMouseLeave={() => setHover(null)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 h-4 text-[11px] text-gray-600">
        {hover && (
          <>
            {rowLabel(hover.r)} · {String(Math.floor(hover.c / 2)).padStart(2, '0')}:{hover.c % 2 ? '30' : '00'} → <b className="tabular-nums">{format(rows[hover.r][hover.c])}</b>
            {unit}
          </>
        )}
      </div>
    </div>
  );
}
