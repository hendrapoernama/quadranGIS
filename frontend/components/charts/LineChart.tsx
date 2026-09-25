'use client';

import { useMemo, useRef, useState } from 'react';

export interface Series {
  name: string;
  values: (number | null)[];
  color?: string;
}

interface Props {
  title: string;
  labels: string[]; // waktu (ISO) sepanjang values
  series: Series[];
  unit?: string;
  height?: number;
  format?: (v: number) => string;
  max?: number;
  emptyText?: string;
}

// Palet dataviz tervalidasi lewat token CSS (nilai gelap dipilih di globals.css).
const PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

export function LineChart({ title, labels, series, unit = '', height = 180, format = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 1 }), max, emptyText = 'No data yet.' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = labels.length;

  const dataMax = useMemo(() => {
    let m = 0;
    for (const s of series) for (const v of s.values) if (v !== null && v > m) m = v;
    return m;
  }, [series]);
  const ticks = niceTicks(max ?? dataMax);
  const yMax = ticks[ticks.length - 1] || 1;
  const x = (i: number) => pad.l + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => pad.t + h - (v / yMax) * h;

  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  });

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    if (n === 0) return;
    const i = Math.round(((px - pad.l) / w) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const fmtTime = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };
  const xLabelIdx = n <= 1 ? [0] : [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
  const color = (i: number) => series[i].color || PALETTE[i % PALETTE.length];

  return (
    <div ref={ref} className="card p-3">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {series.length >= 2 && (
          <div className="flex gap-3 text-xs text-gray-600">
            {series.map((s, i) => (
              <span key={s.name} className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-4 rounded" style={{ background: color(i) }} />
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>
      {n === 0 ? (
        <div className="py-8 text-center text-xs text-gray-500">{emptyText}</div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={pad.l} x2={width - pad.r} y1={y(tk)} y2={y(tk)} style={{ stroke: 'var(--chart-grid)' }} strokeWidth={1} />
              <text x={pad.l - 6} y={y(tk) + 3.5} fontSize={10} textAnchor="end" style={{ fill: 'var(--chart-text)' }}>
                {format(tk)}
              </text>
            </g>
          ))}
          {xLabelIdx.map((i) => (
            <text key={i} x={x(i)} y={height - 8} fontSize={10} textAnchor="middle" style={{ fill: 'var(--chart-text)' }}>
              {fmtTime(labels[i])}
            </text>
          ))}
          {paths.map((d, i) => (
            <path key={series[i].name} d={d} fill="none" style={{ stroke: color(i) }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} style={{ stroke: 'var(--chart-cursor)' }} strokeDasharray="3 3" />
              {series.map((s, i) => {
                const v = s.values[hover];
                if (v === null || v === undefined) return null;
                return <circle key={s.name} cx={x(hover)} cy={y(v)} r={4} style={{ fill: color(i), stroke: 'var(--surface-1)' }} strokeWidth={2} />;
              })}
              <foreignObject x={Math.min(x(hover) + 8, width - 160)} y={pad.t} width={150} height={20 + series.length * 16}>
                <div className="rounded border border-gray-200 bg-white/95 px-2 py-1 text-[11px] text-gray-800 shadow">
                  <div className="text-gray-500">{fmtTime(labels[hover])}</div>
                  {series.map((s) => (
                    <div key={s.name} className="flex justify-between gap-2">
                      <span>{s.name}</span>
                      <span className="font-medium tabular-nums">
                        {s.values[hover] === null ? '-' : format(s.values[hover] as number)}
                        {unit}
                      </span>
                    </div>
                  ))}
                </div>
              </foreignObject>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
