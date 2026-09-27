'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { Badge, Spinner, useToast } from '@/components/ui';
import { LoadChart } from '@/components/charts/LoadChart';
import { BarChart } from '@/components/charts/BarChart';
import { AiOpsPanel } from '@/components/ai/AiOpsPanel';
import { useLoadT } from './i18n';
import { EntityPicker, UtilBar, fmtDT, fmtMW, fmtMWh, fmtPct, loadUnit, toUnit, utilClass, type EntityRef } from './common';

const fmtMVA = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '-' : `${fmtNum(v, d)} MVA`);
import type { ForecastInfo, ForecastPoint, Profile, SeriesPoint } from './types';

type Sub = 'forecast' | 'n1' | 'gd' | 'profiles' | 'health' | 'calib' | 'ai';

export function Advanced({ onOpen }: { onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const { has } = useAuth();
  const [sub, setSub] = useState<Sub>('forecast');
  const subs: [Sub, string][] = [
    ['forecast', L('adv_forecast')],
    ['n1', L('adv_n1')],
    ['gd', L('adv_gd')],
    ['profiles', L('adv_profiles')],
    ['health', L('adv_health')],
    ['calib', L('adv_calib')],
    ...(has('ai.use') ? ([['ai', L('adv_ai')]] as [Sub, string][]) : []),
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {subs.map(([k, l]) => (
          <button key={k} className={`rounded-full border px-3 py-1 text-xs ${sub === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:border-gray-500'}`} onClick={() => setSub(k)}>
            {l}
          </button>
        ))}
      </div>
      {sub === 'forecast' && <ForecastView />}
      {sub === 'n1' && <N1View onOpen={onOpen} />}
      {sub === 'gd' && <GDView />}
      {sub === 'profiles' && <ProfilesView onOpen={onOpen} />}
      {sub === 'health' && <HealthView onOpen={onOpen} />}
      {sub === 'calib' && <CalibView />}
      {sub === 'ai' && (
        <div className="card p-3">
          <AiOpsPanel task="load" autoStart />
        </div>
      )}
    </div>
  );
}

function useFetch<T>(url: string | null) {
  const toast = useToast();
  const [data, setData] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!url) return setData(null);
    setBusy(true);
    try {
      setData(await api<T>(url));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [url, toast]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, busy, reload: load };
}

function ForecastView() {
  const L = useLoadT();
  const { locale } = useT();
  const [ent, setEnt] = useState<EntityRef>({ level: 'system', id: '' });
  const [days, setDays] = useState(2);
  const url = ent.level === 'system' || ent.id ? `/api/load/forecast?level=${ent.level}&id=${encodeURIComponent(ent.id)}&days=${days}` : null;
  const { data, busy } = useFetch<{
    entity: { name: string; cap_mw: number };
    actual: SeriesPoint[];
    forecast: ForecastPoint[];
    info: ForecastInfo;
    months: { month: string; peak_mw: number }[];
    projection: { month: string; peak_mw: number; util: number }[] | null;
    growth_pct: number;
    reach_capacity: string;
  }>(url);
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const t = (s: string) => new Date(s).getTime();
  const cap = data?.entity.cap_mw || 0;
  const U = loadUnit(cap);
  const u = (v: number) => toUnit(v, U);
  const allMonths = [...(data?.months || []).map((m) => ({ ...m, proj: false })), ...(data?.projection || []).map((m) => ({ ...m, proj: true }))];
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-2 p-3 text-xs">
        <EntityPicker value={ent} onChange={setEnt} />
        <select className="input !w-auto text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={L('fc_days')}>
          {[1, 2, 3, 7].map((d) => (
            <option key={d} value={d}>
              {d} {L('fc_days').toLowerCase()}
            </option>
          ))}
        </select>
        {busy && <Spinner size={14} />}
      </div>
      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {(
              [
                [L('fc_peak'), fmtMW(data.info.peak_mw), fmtDT(data.info.peak_ts)],
                [L('util'), <span key="u" className={utilClass(data.info.peak_util)}>{fmtPct(data.info.peak_util)}</span>, `${L('capacity')} ${fmtMW(cap, 1)}`],
                [L('fc_mape'), fmtPct(data.info.mape), `${data.info.history_days} hari riwayat`],
                [L('fc_growth'), data.growth_pct ? `${data.growth_pct > 0 ? '+' : ''}${fmtNum(data.growth_pct, 1)}%` : '-', `${L('fc_trend')} ${fmtNum(data.info.trend, 3)}`],
                [L('fc_reach'), data.reach_capacity ? new Date(`${data.reach_capacity}-01`).toLocaleDateString(loc, { month: 'long', year: 'numeric' }) : L('fc_never'), ''],
              ] as [string, React.ReactNode, string][]
            ).map(([k, v, s]) => (
              <div key={k} className="card px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">{k}</div>
                <div className="text-base font-semibold tabular-nums text-gray-900">{v}</div>
                {s && <div className="truncate text-[10px] text-gray-500">{s}</div>}
              </div>
            ))}
          </div>
          <LoadChart
            title={`${L('adv_forecast')} · ${data.entity.name}`}
            lines={[
              { name: L('forecast'), points: data.forecast.filter((f) => f.p > 0).map((f) => ({ t: t(f.ts), v: u(f.p) })), color: 'var(--series-2)', dashed: true },
              { name: L('actual'), points: data.actual.map((p) => ({ t: t(p.ts), v: u(p.p) })), color: 'var(--series-1)', width: 2.5 },
            ]}
            band={data.forecast.filter((f) => f.p > 0).map((f) => ({ t: t(f.ts), lo: u(f.lo), hi: u(f.hi) }))}
            bandColor="var(--series-2)"
            refs={cap ? [{ value: u(cap * 0.8), label: L('limit_warn', { p: 80 }), color: 'var(--status-warning)' }, { value: u(cap), label: L('limit_over'), color: 'var(--status-critical)' }] : []}
            unit={` ${U}`}
            xFormat={(x) => new Date(x).toLocaleString(loc, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
          />
          {allMonths.length > 0 && (
            <BarChart
              title={`${L('fc_proj')} (${U})`}
              name={L('actual')}
              labels={allMonths.map((m) => m.month)}
              values={allMonths.map((m) => (m.proj ? 0 : u(m.peak_mw)))}
              stacked={{ name: L('forecast'), values: allMonths.map((m) => (m.proj ? u(m.peak_mw) : 0)) }}
              reference={cap ? { value: u(cap), label: L('limit_over') } : undefined}
              format={(v) => fmtNum(v, 1)}
              tickLabel={(l) => l.slice(2).replace('-', '/')}
              tooltipLabel={(l) => new Date(`${l}-01`).toLocaleDateString(loc, { month: 'long', year: 'numeric' })}
            />
          )}
          <p className="text-[11px] text-gray-500">
            {L('fc_method')}: {data.info.method}
          </p>
        </>
      )}
    </div>
  );
}

interface N1Row {
  point_id: number;
  code: string;
  up3: string;
  peak_mw: number;
  peak_ts: string | null;
  cap_mw: number;
  neighbors: { code: string; switch: string; load_at_peak: number; after: number; cap_mw: number; pct_after: number; spare: number }[];
  best_pct: number;
  spare_sum: number;
  status: string;
}

function N1View({ onOpen }: { onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const [filter, setFilter] = useState('');
  const { data, busy } = useFetch<{ items: N1Row[]; counts: Record<string, number>; ties: number }>('/api/load/n1?days=30&limit=2000');
  const tone: Record<string, 'red' | 'amber' | 'green' | 'gray'> = { tidak_aman: 'red', parsial: 'amber', aman: 'green', tanpa_tie: 'gray', tanpa_data: 'gray' };
  const list = (data?.items || []).filter((r) => !filter || r.status === filter);
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">{L('n1_hint')}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {busy && <Spinner size={14} />}
        {['tidak_aman', 'parsial', 'aman', 'tanpa_tie'].map((s) => (
          <button key={s} className={`rounded-full border px-3 py-1 ${filter === s ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700'}`} onClick={() => setFilter(filter === s ? '' : s)}>
            {L(`n1_${s}`)} <b className="tabular-nums">{fmtNum(data?.counts?.[s] || 0)}</b>
          </button>
        ))}
        {data && <span className="self-center text-gray-500">tie: {fmtNum(data.ties)}</span>}
      </div>
      <ul className="space-y-1.5">
        {list.slice(0, 200).map((r) => (
          <li key={r.point_id} className="card px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone[r.status]}>{L(`n1_${r.status}`)}</Badge>
              <button className="font-semibold text-brand-700 hover:underline" onClick={() => onOpen('feeder', String(r.point_id))}>
                {r.code}
              </button>
              <span className="text-gray-500">{r.up3}</span>
              <span className="ml-auto tabular-nums text-gray-700">
                {L('peak')} {fmtMW(r.peak_mw)} · {fmtDT(r.peak_ts)}
              </span>
            </div>
            {r.neighbors.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-2">
                {r.neighbors.map((n) => (
                  <li key={n.code + n.switch} className="flex flex-wrap items-center gap-2">
                    <span className="text-gray-500">↳ {n.switch || 'tie'} →</span>
                    <span className="font-medium text-gray-800">{n.code}</span>
                    <span className="tabular-nums text-gray-600">
                      {fmtMW(n.load_at_peak)} → {fmtMW(n.after)} ({L('n1_after')})
                    </span>
                    <span className={`tabular-nums ${utilClass(n.pct_after)}`}>{fmtPct(n.pct_after)}</span>
                    <span className="text-gray-500">
                      {L('n1_spare')} {fmtMW(n.spare)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GDView() {
  const L = useLoadT();
  const [ent, setEnt] = useState<EntityRef>({ level: 'feeder', id: '' });
  const { data, busy } = useFetch<{
    point: { code: string };
    peak_mw: number;
    peak_ts: string | null;
    default_kva: number;
    measured: number;
    items: {
      id: number;
      point_id?: number;
      code: string;
      name: string;
      customers: number;
      contract_va: number;
      share: number;
      measured: boolean;
      peak_kw: number;
      energy_mwh: number;
      kva: number;
      kva_known: boolean;
      util: number;
    }[];
  }>(ent.id ? `/api/load/gd?point=${ent.id}&days=30` : null);
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">{L('gd_hint')}</p>
      <div className="card flex flex-wrap items-center gap-2 p-3 text-xs">
        <EntityPicker value={ent} onChange={(v) => setEnt({ ...v, level: 'feeder' })} />
        {busy && <Spinner size={14} />}
      </div>
      {data && (
        <div className="card overflow-x-auto p-3">
          <div className="mb-2 text-xs text-gray-700">
            <b>{data.point.code}</b> · {L('peak')} {fmtMW(data.peak_mw)} · {fmtDT(data.peak_ts)} · {data.items.length} gardu · {fmtNum(data.measured)} {L('gd_measured')}
          </div>
          <table className="w-full min-w-[720px] text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <th className="py-1">Gardu</th>
                <th className="py-1 text-right">Pelanggan</th>
                <th className="py-1 text-right">{L('calib_contract')}</th>
                <th className="py-1 text-right">{L('peak')}</th>
                <th className="py-1 text-right">{L('energy')}</th>
                <th className="py-1 text-right">{L('gd_kva')}</th>
                <th className="w-40 py-1 text-right">{L('util')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.slice(0, 300).map((g) => (
                <tr key={g.id} className="border-b border-gray-100">
                  <td className="py-1">
                    <div className="font-medium text-gray-900">{g.code}</div>
                    <div className="text-[10px] text-gray-500">{g.name}</div>
                  </td>
                  <td className="py-1 text-right tabular-nums">{fmtNum(g.customers)}</td>
                  <td className="py-1 text-right tabular-nums">{fmtNum(g.contract_va / 1000, 0)} kVA</td>
                  <td className="py-1 text-right tabular-nums">
                    {fmtNum(g.peak_kw, 0)} kW <span className="text-[10px] text-gray-500">({g.measured ? L('gd_measured') : L('gd_allocated')})</span>
                  </td>
                  <td className="py-1 text-right tabular-nums">{g.measured ? fmtMWh(g.energy_mwh) : '-'}</td>
                  <td className="py-1 text-right tabular-nums">
                    {fmtNum(g.kva, 0)} kVA {!g.kva_known && <span className="text-[10px] text-gray-500">({L('gd_default')})</span>}
                  </td>
                  <td className="py-1 pl-3">
                    <div className={`text-right tabular-nums ${utilClass(g.util)}`}>{fmtPct(g.util)}</div>
                    <UtilBar v={g.util} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProfilesView({ onOpen }: { onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const [cls, setCls] = useState('');
  const [kind, setKind] = useState('feeder');
  const { data, busy } = useFetch<{ items: ({ point_id: number; code: string; kind: string; up3: string } & Profile)[]; counts: Record<string, number> }>(`/api/load/profiles?kind=${kind}`);
  const list = (data?.items || []).filter((r) => !cls || r.class === cls);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <select className="input !w-auto text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={L('pt_kind')}>
          <option value="feeder">{L('level_feeder')}</option>
          <option value="trafo_gi">{L('level_trafo_gi')}</option>
          <option value="gd">{L('level_gd')}</option>
        </select>
        {busy && <Spinner size={14} />}
        {['residensial', 'bisnis', 'industri', 'campuran'].map((c) => (
          <button key={c} className={`rounded-full border px-3 py-1 ${cls === c ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700'}`} onClick={() => setCls(cls === c ? '' : c)}>
            {L(`class_${c}`)} <b className="tabular-nums">{fmtNum(data?.counts?.[c] || 0)}</b>
          </button>
        ))}
      </div>
      <div className="card overflow-x-auto p-3">
        <table className="w-full min-w-[600px] text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
              <th className="py-1">Titik</th>
              <th className="py-1">{L('profile')}</th>
              <th className="py-1 text-right">{L('peak_hour')}</th>
              <th className="py-1 text-right">{L('lf')}</th>
              <th className="py-1 text-right">{L('weekend_ratio')}</th>
              <th className="py-1 text-right">siang/malam</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, 400).map((r) => (
              <tr key={r.point_id} className="cursor-pointer border-b border-gray-100 hover:bg-gray-50" onClick={() => onOpen('point', String(r.point_id))}>
                <td className="py-1">
                  <span className="font-medium text-gray-900">{r.code}</span> <span className="text-gray-500">{r.kind === 'trafo_gi' ? L('level_trafo_gi') : r.kind === 'gd' ? L('level_gd') : r.up3}</span>
                </td>
                <td className="py-1">{L(`class_${r.class}`)}</td>
                <td className="py-1 text-right tabular-nums">{`${String(Math.floor(r.peak_hour)).padStart(2, '0')}:${r.peak_hour % 1 ? '30' : '00'}`}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(r.load_factor, 2)}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(r.weekend_ratio, 2)}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(r.day_evening_ratio, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HealthView({ onOpen }: { onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const [kind, setKind] = useState('trafo_gi');
  const { data, busy } = useFetch<{
    items: { point_id: number; code: string; up3: string; peak_util: number; hours_over80: number; hours_over100: number; age: number; age_known: boolean; anomalies: number; days: number; score: number; category: string; penalties: Record<string, number> }[];
    counts: Record<string, number>;
  }>(`/api/load/health?kind=${kind}&limit=500`);
  const tone: Record<string, 'red' | 'amber' | 'green' | 'blue'> = { kritis: 'red', perhatian: 'amber', cukup: 'blue', baik: 'green' };
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">{L('health_hint')}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="input !w-auto text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="trafo_gi">{L('level_trafo_gi')}</option>
          <option value="feeder">{L('level_feeder')}</option>
          <option value="gd">{L('level_gd')}</option>
        </select>
        {busy && <Spinner size={14} />}
        {['kritis', 'perhatian', 'cukup', 'baik'].map((c) => (
          <span key={c} className="flex items-center gap-1">
            <Badge tone={tone[c]}>{L(`h_${c}`)}</Badge> <b className="tabular-nums">{fmtNum(data?.counts?.[c] || 0)}</b>
          </span>
        ))}
      </div>
      <div className="card overflow-x-auto p-3">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
              <th className="py-1">Titik</th>
              <th className="py-1 text-right">Indeks</th>
              <th className="py-1 text-right">{L('util')} 12 bln</th>
              <th className="py-1 text-right">{L('hours80', { p: 80 })}</th>
              <th className="py-1 text-right">{L('hours100', { p: 100 })}</th>
              <th className="py-1 text-right">{L('age')}</th>
              <th className="py-1 text-right">{L('tab_anomalies')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items || []).slice(0, 300).map((r) => (
              <tr key={r.point_id} className="cursor-pointer border-b border-gray-100 hover:bg-gray-50" onClick={() => onOpen('point', String(r.point_id))}>
                <td className="py-1">
                  <span className="font-medium text-gray-900">{r.code}</span> <span className="text-gray-500">{r.up3}</span>
                </td>
                <td className="py-1 text-right">
                  <Badge tone={tone[r.category]}>
                    {fmtNum(r.score, 0)} · {L(`h_${r.category}`)}
                  </Badge>
                </td>
                <td className={`py-1 text-right tabular-nums ${utilClass(r.peak_util)}`}>{fmtPct(r.peak_util)}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(r.hours_over80, 1)}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(r.hours_over100, 1)}</td>
                <td className="py-1 text-right tabular-nums">{r.age_known ? `${fmtNum(r.age)} ${L('years')}` : '-'}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(r.anomalies)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CalibView() {
  const L = useLoadT();
  const { data, busy } = useFetch<{ items: { point_id: number; code: string; peak_mva: number; contract_va: number; factor: number; cap_mva: number }[]; enabled: boolean; default_load_factor: number }>('/api/load/calibration?limit=400');
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">{L('calib_hint')}</p>
      {busy && <Spinner size={14} />}
      {data && (
        <>
          <div className="flex flex-wrap gap-3 text-xs">
            <Badge tone={data.enabled ? 'green' : 'gray'}>{data.enabled ? L('calib_on') : L('calib_off')}</Badge>
            <span className="text-gray-600">
              {L('calib_default')}: <b>{fmtNum(data.default_load_factor, 2)}</b>
            </span>
          </div>
          <div className="card overflow-x-auto p-3">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1">{L('level_feeder')}</th>
                  <th className="py-1 text-right">{L('peak')} 7 hari</th>
                  <th className="py-1 text-right">{L('calib_contract')}</th>
                  <th className="py-1 text-right">{L('calib_factor')}</th>
                  <th className="py-1 text-right">{L('capacity')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.point_id} className="border-b border-gray-100">
                    <td className="py-1 font-medium text-gray-900">{r.code}</td>
                    <td className="py-1 text-right tabular-nums">{fmtMVA(r.peak_mva)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(r.contract_va / 1e6, 2)} MVA</td>
                    <td className="py-1 text-right tabular-nums">{r.factor ? fmtNum(r.factor, 2) : '-'}</td>
                    <td className="py-1 text-right tabular-nums">{fmtMVA(r.cap_mva)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
