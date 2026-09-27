'use client';

import { useMemo, useState } from 'react';

interface Props {
  title: string;
  labels: string[];
  values: number[];
  /** nilai kedua bertumpuk di atas nilai pertama (opsional), mis. gangguan vs pemeliharaan */
  stacked?: { name: string; values: number[] };
  name?: string;
  color?: string;
  color2?: string;
  /** garis acuan horizontal (mis. target) */
  reference?: { value: number; label: string };
  height?: number;
  format?: (v: number) => string;
  tickLabel?: (label: string, i: number) => string;
  tooltipLabel?: (label: string) => string;
  emptyText?: string;
  onSelect?: (i: number) => void;
}

function niceMax(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(6)));
  return ticks;
}

/** Grafik batang satu seri (opsional bertumpuk dua) dengan tooltip & garis target. Warna dari token --series-*. */
export function BarChart({
  title,
  labels,
  values,
  stacked,
  name = '',
  color = 'var(--series-1)',
  color2 = 'var(--series-2)',
  reference,
  height = 190,
  format = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 2 }),
  tickLabel = (l) => l,
  tooltipLabel = (l) => l,
  emptyText = '-',
  onSelect,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = labels.length;
  const totals = values.map((v, i) => v + (stacked?.values[i] || 0));
  const ticks = useMemo(() => niceMax(Math.max(0, ...totals, reference?.value || 0)), [totals, reference]);
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v: number) => pad.t + h - (v / yMax) * h;
  const slot = n > 0 ? w / n : w;
  const bw = Math.max(2, Math.min(28, slot - 2)); // celah 2px antar batang
  const x = (i: number) => pad.l + slot * i + (slot - bw) / 2;
  const everyTick = Math.max(1, Math.ceil(n / 12));
  const empty = n === 0 || totals.every((v) => v === 0);

  const bar = (i: number, from: number, to: number, fill: string, top: boolean) => {
    const y1 = y(to);
    const y0 = y(from);
    const hh = Math.max(0, y0 - y1);
    if (hh <= 0) return null;
    const r = top ? Math.min(4, bw / 2, hh) : 0;
    // sudut membulat hanya di ujung data (atas), pangkal tetap rata di garis dasar
    const d = `M${x(i)},${y0} L${x(i)},${y1 + r} Q${x(i)},${y1} ${x(i) + r},${y1} L${x(i) + bw - r},${y1} Q${x(i) + bw},${y1} ${x(i) + bw},${y1 + r} L${x(i) + bw},${y0} Z`;
    return <path key={`${i}-${from}`} d={d} style={{ fill }} />;
  };

  return (
    <div className="card p-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <div className="flex gap-3 text-[11px] text-gray-600">
          {stacked && (
            <>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                {name}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color2 }} />
                {stacked.name}
              </span>
            </>
          )}
          {reference && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--status-critical)' }} />
              {reference.label}
            </span>
          )}
        </div>
      </div>
      {empty ? (
        <div className="py-10 text-center text-xs text-gray-500">{emptyText}</div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="img"
          aria-label={title}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * width;
            const i = Math.floor((px - pad.l) / slot);
            setHover(i >= 0 && i < n ? i : null);
          }}
          onClick={() => hover !== null && onSelect?.(hover)}
          style={{ cursor: onSelect ? 'pointer' : undefined }}
        >
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={pad.l} x2={width - pad.r} y1={y(tk)} y2={y(tk)} style={{ stroke: 'var(--chart-grid)' }} strokeWidth={1} />
              <text x={pad.l - 6} y={y(tk) + 3.5} fontSize={10} textAnchor="end" style={{ fill: 'var(--chart-text)' }}>
                {format(tk)}
              </text>
            </g>
          ))}
          {hover !== null && <rect x={pad.l + slot * hover} y={pad.t} width={slot} height={h} style={{ fill: 'var(--chart-grid)', opacity: 0.5 }} />}
          {values.map((v, i) => (
            <g key={i}>
              {bar(i, 0, v, color, !stacked || !stacked.values[i])}
              {stacked && stacked.values[i] > 0 && bar(i, v, v + stacked.values[i], color2, true)}
            </g>
          ))}
          {reference && reference.value > 0 && (
            <line x1={pad.l} x2={width - pad.r} y1={y(reference.value)} y2={y(reference.value)} style={{ stroke: 'var(--status-critical)' }} strokeWidth={1.5} strokeDasharray="5 4" />
          )}
          {labels.map((l, i) =>
            i % everyTick === 0 ? (
              <text key={l + i} x={x(i) + bw / 2} y={height - 8} fontSize={10} textAnchor="middle" style={{ fill: 'var(--chart-text)' }}>
                {tickLabel(l, i)}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <foreignObject x={Math.min(x(hover) + bw + 6, width - 176)} y={pad.t} width={170} height={30 + (stacked ? 32 : 16) + (reference ? 16 : 0)}>
              <div className="rounded border border-gray-200 bg-white/95 px-2 py-1 text-[11px] text-gray-800 shadow">
                <div className="text-gray-500">{tooltipLabel(labels[hover])}</div>
                <div className="flex justify-between gap-2">
                  <span>{name || title}</span>
                  <span className="font-medium tabular-nums">{format(values[hover])}</span>
                </div>
                {stacked && (
                  <div className="flex justify-between gap-2">
                    <span>{stacked.name}</span>
                    <span className="font-medium tabular-nums">{format(stacked.values[hover] || 0)}</span>
                  </div>
                )}
                {reference && (
                  <div className="flex justify-between gap-2 text-gray-500">
                    <span>{reference.label}</span>
                    <span className="tabular-nums">{format(reference.value)}</span>
                  </div>
                )}
              </div>
            </foreignObject>
          )}
        </svg>
      )}
    </div>
  );
}
