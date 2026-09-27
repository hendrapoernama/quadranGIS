'use client';

import { fmtNum, fmtVA } from '@/lib/format';
import { useOpsT } from './i18n';
import type { Codes, SimResult, SimWarning } from './types';

export const OPS_COLORS = {
  restored: '#0ca30c',
  newOff: '#d03b3b',
  section: '#f59e0b',
  step: '#2563eb',
  stillOff: '#8a94a6',
};

/** Legenda warna overlay hasil simulasi di peta. */
export function SimLegend({ section = false, stillOff = false }: { section?: boolean; stillOff?: boolean }) {
  const o = useOpsT();
  const items: [string, string][] = [
    [OPS_COLORS.restored, o('legend_restored')],
    [OPS_COLORS.newOff, o('legend_new_off')],
    [OPS_COLORS.step, o('legend_step')],
  ];
  if (section) items.push([OPS_COLORS.section, o('legend_section')]);
  if (stillOff) items.push([OPS_COLORS.stillOff, o('legend_still_off')]);
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded" style={{ background: c }} /> {l}
        </span>
      ))}
    </div>
  );
}

export function codeOf(codes: Codes, id: number | undefined | null) {
  if (!id) return '-';
  return codes[String(id)]?.code || `#${id}`;
}

function warnText(o: ReturnType<typeof useOpsT>, w: SimWarning, codes: Codes) {
  const f = (w.feeders || []).map((h) => codeOf(codes, h)).join(' ↔ ');
  switch (w.code) {
    case 'parallel':
      return `${o('w_parallel')}: ${f}`;
    case 'overload':
      return `${o('w_overload')} ${f} ${w.pct}%`;
    case 'high_load':
      return `${o('w_high_load')} ${f} ${w.pct}%`;
    default:
      return o(`w_${w.code}`);
  }
}

/** Beban penyulang: bilah dengan warna status + teks persen (tidak hanya warna). */
function LoadBar({ pct }: { pct: number }) {
  const color = pct > 100 ? '#d03b3b' : pct >= 80 ? '#ec835a' : pct >= 60 ? '#fab219' : '#0ca30c';
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-1.5 w-14 overflow-hidden rounded bg-gray-200">
        <span className="block h-full" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </span>
      <span className="tabular-nums">{pct.toFixed(1)}%</span>
    </span>
  );
}

/** Ringkasan & tabel langkah hasil simulasi what-if. */
export function SimView({ sim, codes, section = false }: { sim: SimResult; codes: Codes; section?: boolean }) {
  const o = useOpsT();
  const cards: [string, string, string][] = [
    [o('sim_now'), fmtNum(sim.base_customers_off), 'text-gray-900'],
    [o('sim_after'), fmtNum(sim.customers_off_after), sim.customers_off_after > 0 ? 'text-red-700' : 'text-emerald-700'],
    [o('sim_restored'), `+${fmtNum(sim.customers_restored)}`, 'text-emerald-700'],
    [o('sim_new_off'), fmtNum(sim.customers_new_off), sim.customers_new_off > 0 ? 'text-red-700' : 'text-gray-500'],
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1.5">
        {cards.map(([l, v, cls]) => (
          <div key={l} className="rounded-md border border-gray-200 bg-white px-2 py-1">
            <div className="truncate text-[10px] uppercase tracking-wide text-gray-500">{l}</div>
            <div className={`text-base font-semibold tabular-nums ${cls}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-gray-500">
        {fmtVA(sim.load_restored_va)} {o('legend_restored')} · {fmtNum(sim.region_nodes)} {o('sim_region')}
      </div>
      <ol className="space-y-1">
        {sim.steps.map((s) => (
          <li key={s.seq} className={`rounded border px-2 py-1 text-xs ${s.valid ? 'border-gray-200' : 'border-red-300 bg-red-50/50'}`}>
            <div className="flex items-center gap-2">
              <span className="w-5 text-right font-semibold tabular-nums text-gray-500">{s.seq}</span>
              <span className={`rounded px-1.5 text-[10px] font-bold ${s.action.action === 'open' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>
                {s.action.action === 'open' ? o('open') : o('close')}
              </span>
              <span className="flex-1 truncate font-medium text-gray-900">{codeOf(codes, s.action.target_id)}</span>
              <span className="tabular-nums text-gray-700" title={o('sim_cust_off')}>
                {fmtNum(s.customers_off)}
              </span>
              <span className={`w-12 text-right tabular-nums ${s.customers_diff > 0 ? 'text-red-700' : s.customers_diff < 0 ? 'text-emerald-700' : 'text-gray-400'}`}>
                {s.customers_diff > 0 ? '+' : ''}
                {fmtNum(s.customers_diff)}
              </span>
            </div>
            {s.action.note && <div className="ml-7 text-[11px] text-gray-500">{s.action.note}</div>}
            {s.feeders.length > 0 && (
              <div className="ml-7 mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-600">
                {s.feeders.slice(0, 3).map((f) => (
                  <span key={f.head} className="flex items-center gap-1">
                    {codeOf(codes, f.head)} <LoadBar pct={f.pct} />
                  </span>
                ))}
              </div>
            )}
            {s.warnings.length > 0 && (
              <div className="ml-7 mt-0.5 flex flex-wrap gap-1">
                {s.warnings.map((w, i) => (
                  <span key={i} className={`rounded px-1.5 text-[10px] font-medium ${w.code === 'overload' || w.code === 'parallel' || w.code === 'not_found' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>
                    ⚠ {warnText(o, w, codes)}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <SimLegend section={section} stillOff={section} />
    </div>
  );
}
