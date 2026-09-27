'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { LoadChart } from '@/components/charts/LoadChart';
import { BarChart } from '@/components/charts/BarChart';
import { csvRow, downloadText } from '@/components/exec/common';
import { useLoadT } from './i18n';
import { EntityPicker, StatCard, UtilBar, fmtMWh, fmtPct, lossClass, todayISO, utilClass, type EntityRef } from './common';
import type { BalanceResult, LossRow } from './types';
import { CustomerLosses } from './CustomerLosses';
import { useCLT } from './i18nCustomer';

interface Resp {
  level: string;
  id: string;
  name: string;
  period: string;
  from: string;
  to: string;
  result: {
    dist: BalanceResult;
    gi: BalanceResult;
    combined_pct: number;
    feeders: LossRow[];
    trafos: LossRow[];
    coverage: { feeders: number; feeders_metered: number; gd_points: number; trafos_metered: number; min_coverage: number };
  };
  settings: { high: number; gi: number; min_coverage: number };
}

const STATUS_TONE: Record<string, 'green' | 'blue' | 'amber' | 'gray'> = { ok: 'green', estimasi: 'blue', cakupan_kurang: 'amber', tanpa_data: 'gray' };

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Tab Susut: neraca AMR harian (GI → penyulang → gardu) atau gardu → kWh pelanggan bulanan (tagihan). */
export function Losses({ onOpen, canManage }: { onOpen: (level: string, id: string) => void; canManage: boolean }) {
  const C = useCLT();
  const [mode, setMode] = useState<'amr' | 'cust'>(() => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('losses') === 'customers' ? 'cust' : 'amr'));
  return (
    <div className="space-y-3">
      <div className="flex w-fit rounded-md border border-gray-300 bg-white p-0.5 text-xs" role="tablist">
        {(['amr', 'cust'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`rounded px-3 py-1.5 ${mode === m ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setMode(m)}>
            {C(m === 'amr' ? 'mode_amr' : 'mode_cust')}
          </button>
        ))}
      </div>
      {mode === 'amr' ? <AmrLosses onOpen={onOpen} /> : <CustomerLosses canManage={canManage} onOpenPoint={(id) => onOpen('point', id)} />}
    </div>
  );
}

function AmrLosses({ onOpen }: { onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const { locale } = useT();
  const toast = useToast();
  const [ent, setEnt] = useState<EntityRef>({ level: 'system', id: '' });
  const [period, setPeriod] = useState<'day' | '30d' | 'month' | 'year'>('30d');
  const [date, setDate] = useState(yesterdayISO());
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';

  const load = useCallback(async () => {
    if (ent.level !== 'system' && !ent.id) return setData(null);
    setBusy(true);
    try {
      setData(await api<Resp>(`/api/load/losses?level=${ent.level}&id=${encodeURIComponent(ent.id)}&period=${period}&date=${date}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [ent, period, date, toast]);
  useEffect(() => {
    load();
  }, [load, locale]);
  useEffect(() => {
    // penyulang tunggal: langsung tampilkan rinciannya
    setSel(ent.level === 'feeder' && ent.id ? Number(ent.id) : null);
  }, [ent]);

  const r = data?.result;
  const high = data?.settings.high ?? 12;
  const dateRange = data ? `${new Date(data.from).toLocaleDateString(loc, { dateStyle: 'medium' })} – ${new Date(new Date(data.to).getTime() - 1).toLocaleDateString(loc, { dateStyle: 'medium' })}` : '';
  const csv = () => {
    if (!r || !data) return;
    const rows = [csvRow([`${L('ls_title')} ${data.name}`, dateRange]), '', csvRow(['Penyulang', 'UP3', 'Energi masuk MWh', 'Energi gardu MWh', 'Susut MWh', 'Susut %', 'Cakupan %', 'Gardu bermeter', 'Gardu', 'Hari sah', 'Status'])];
    for (const f of r.feeders) rows.push(csvRow([f.code, f.up3, f.e_in.toFixed(3), f.e_out.toFixed(3), f.loss.toFixed(3), f.pct.toFixed(2), f.coverage.toFixed(1), f.metered, f.members, f.valid_days, f.status]));
    rows.push('', csvRow(['Trafo GI', 'UP3', 'Energi trafo MWh', 'Σ penyulang MWh', 'Selisih MWh', 'Selisih %', 'Cakupan %', 'Penyulang bermeter', 'Penyulang', 'Hari sah', 'Status']));
    for (const f of r.trafos) rows.push(csvRow([f.code, f.up3, f.e_in.toFixed(3), f.e_out.toFixed(3), f.loss.toFixed(3), f.pct.toFixed(2), f.coverage.toFixed(1), f.metered, f.members, f.valid_days, f.status]));
    downloadText(`susut_${data.name}_${data.period}_${date}.csv`.replace(/[^\w.-]+/g, '_'), rows.join('\r\n'));
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600">{L('ls_hint', { c: data?.settings.min_coverage ?? 90 })}</p>
      <div className="card space-y-2 p-3">
        <EntityPicker value={ent} onChange={setEnt} levels={['system', 'uid', 'up3', 'gi', 'trafo_gi', 'feeder']} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex rounded-md border border-gray-300 bg-white p-0.5">
            {(['day', '30d', 'month', 'year'] as const).map((p) => (
              <button key={p} className={`rounded px-2.5 py-1 ${period === p ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setPeriod(p)}>
                {L(`period_${p}`)}
              </button>
            ))}
          </div>
          <input type="date" className="input !w-auto text-xs" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          {busy && <Spinner size={14} />}
          {data && <span className="text-gray-600">{dateRange}</span>}
          {r && (
            <Button size="sm" variant="ghost" icon="download" className="ml-auto" onClick={csv}>
              {L('csv')}
            </Button>
          )}
        </div>
      </div>

      {r && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <StatCard
              label={L('ls_dist')}
              value={r.dist.e_in > 0 ? <span className={lossClass(r.dist.pct, high)}>{fmtPct(r.dist.pct)}</span> : '-'}
              sub={r.dist.e_in > 0 ? `${fmtMWh(r.dist.loss)} · ${L('ls_coverage')} ${fmtPct(r.dist.coverage)}` : L('ls_none')}
            />
            <StatCard
              label={L('ls_gi')}
              value={r.gi.e_in > 0 ? <span className={lossClass(Math.abs(r.gi.pct), data!.settings.gi)}>{fmtPct(r.gi.pct)}</span> : '-'}
              sub={r.gi.e_in > 0 ? fmtMWh(r.gi.loss) : ''}
            />
            <StatCard label={L('ls_combined')} value={r.dist.e_in > 0 || r.gi.e_in > 0 ? fmtPct(r.combined_pct) : '-'} />
            <StatCard label={L('ls_coverage')} value={`${fmtNum(r.coverage.feeders_metered)} / ${fmtNum(r.coverage.feeders)}`} sub={`${fmtNum(r.coverage.gd_points)} ${L('ls_members')} · ${fmtNum(r.coverage.trafos_metered)} ${L('trafos').toLowerCase()}`} />
            <StatCard label={L('ls_valid_days')} value={fmtNum(r.dist.valid_days)} sub={`${L('ls_estimated')} bila cakupan < 100%`} />
          </div>

          {/* rantai energi: trafo GI → penyulang → gardu */}
          <div className="card p-3">
            <div className="flex flex-wrap items-stretch gap-2 text-xs">
              <EnergyBox title={L('ls_e_trafo')} value={r.gi.e_in} sub={r.gi.e_in > 0 ? `${fmtNum(r.coverage.trafos_metered)} trafo` : '-'} />
              <Arrow pct={r.gi.e_in > 0 ? r.gi.pct : null} label={L('ls_gi')} />
              <EnergyBox title={L('ls_e_feeder')} value={r.dist.e_in} sub={`${fmtNum(r.dist.included || 0)} penyulang`} />
              <Arrow pct={r.dist.e_in > 0 ? r.dist.pct : null} label={L('ls_dist')} warn={r.dist.pct >= high} />
              <EnergyBox title={L('ls_e_gd')} value={r.dist.e_out} sub={`${L('ls_measured')} ${fmtMWh(r.dist.e_out_measured)} · ${L('ls_estimated')} ${fmtMWh(r.dist.e_out - r.dist.e_out_measured)}`} />
            </div>
          </div>

          {(r.dist.daily?.length || 0) > 1 && (
            <LoadChart
              title={L('ls_daily')}
              lines={[
                { name: L('ls_gi'), points: (r.gi.daily || []).map((d) => ({ t: new Date(d.day).getTime(), v: d.pct })), color: 'var(--series-2)', dashed: true },
                { name: L('ls_dist'), points: (r.dist.daily || []).map((d) => ({ t: new Date(d.day).getTime(), v: d.pct })), color: 'var(--series-1)', width: 2.5 },
              ]}
              refs={[{ value: high, label: `${fmtNum(high, 0)}%`, color: 'var(--status-warning)' }]}
              unit="%"
              height={200}
              maxGap={36 * 3600_000}
              snap={12 * 3600_000}
              xFormat={(x) => new Date(x).toLocaleDateString(loc, { day: 'numeric', month: 'short' })}
              tipFormat={(x) => new Date(x).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' })}
              format={(v) => fmtNum(v, 1)}
            />
          )}

          <div className="grid gap-4">
            <LossTable title={L('ls_feeder_table')} rows={r.feeders} high={high} sel={sel} onSel={setSel} />
            {r.trafos.length > 0 && <LossTable title={L('ls_trafo_table')} rows={r.trafos} high={data!.settings.gi} trafo />}
          </div>
          {sel ? <FeederDetail pointId={sel} date={date} onOpen={onOpen} /> : r.feeders.length > 0 && <p className="text-xs text-gray-500">{L('ls_pick_feeder')}</p>}
        </>
      )}
    </div>
  );
}

function EnergyBox({ title, value, sub }: { title: string; value: number; sub: string }) {
  return (
    <div className="min-w-[140px] flex-1 rounded-md border border-gray-200 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{title}</div>
      <div className="text-lg font-semibold tabular-nums text-gray-900">{value > 0 ? fmtMWh(value) : '-'}</div>
      <div className="text-[10px] text-gray-500">{sub}</div>
    </div>
  );
}

function Arrow({ pct, label, warn }: { pct: number | null; label: string; warn?: boolean }) {
  return (
    <div className="flex min-w-[90px] flex-col items-center justify-center px-1 text-center" title={label}>
      <span className={`tabular-nums ${warn ? 'font-semibold text-red-600' : 'text-gray-700'}`}>{pct === null ? '-' : `−${fmtNum(pct, 2)}%`}</span>
      <span className="text-lg leading-none text-gray-400" aria-hidden>
        →
      </span>
    </div>
  );
}

function LossTable({ title, rows, high, sel, onSel, trafo }: { title: string; rows: LossRow[]; high: number; sel?: number | null; onSel?: (id: number) => void; trafo?: boolean }) {
  const L = useLoadT();
  const [q, setQ] = useState('');
  const shown = rows.filter((r) => !q || r.code.toLowerCase().includes(q.toLowerCase()) || r.up3.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card overflow-x-auto p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <input className="input ml-auto !w-36 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('search')} aria-label={L('search')} />
      </div>
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
            <th className="py-1">{trafo ? L('level_trafo_gi') : L('level_feeder')}</th>
            <th className="py-1 text-right">{L('ls_in')}</th>
            <th className="py-1 text-right">{L('ls_out')}</th>
            <th className="py-1 text-right">{L('ls_loss')}</th>
            <th className="py-1 text-right">%</th>
            <th className="py-1 text-right">{L('ls_coverage')}</th>
            <th className="py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, 300).map((r) => (
            <tr
              key={r.point_id}
              className={`border-b border-gray-100 ${onSel ? 'cursor-pointer hover:bg-gray-50' : ''} ${sel === r.point_id ? 'bg-brand-50' : ''}`}
              onClick={() => onSel?.(r.point_id)}
            >
              <td className="py-1">
                <span className="font-medium text-gray-900">{r.code}</span> <span className="text-gray-500">{r.up3 || '-'}</span>
              </td>
              <td className="py-1 text-right tabular-nums">{r.valid_days ? fmtMWh(r.e_in) : '-'}</td>
              <td className="py-1 text-right tabular-nums">{r.valid_days ? fmtMWh(r.e_out) : '-'}</td>
              <td className="py-1 text-right tabular-nums">{r.valid_days ? fmtMWh(r.loss) : '-'}</td>
              <td className={`py-1 text-right tabular-nums ${r.valid_days ? lossClass(trafo ? Math.abs(r.pct) : r.pct, high) : ''}`}>
                {r.valid_days ? fmtPct(r.pct) : '-'}
                {r.valid_days > 0 && !trafo && r.pct < -2 && <span className="ml-1 text-[10px]">({L('ls_negative')})</span>}
              </td>
              <td className="py-1 text-right tabular-nums">
                {r.valid_days ? fmtPct(r.coverage) : '-'}{' '}
                <span className="text-[10px] text-gray-500">
                  {r.metered}/{r.members}
                </span>
              </td>
              <td className="py-1">
                <Badge tone={STATUS_TONE[r.status]}>{L(`ls_status_${r.status}`)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface FeederResp {
  point: { id: number; code: string; up3: string };
  date: string;
  days: number;
  profile: { ts: string; feeder: number; gd: number; measured: number; loss: number; pct: number; coverage: number }[];
  fit: { a: number; b: number; c: number; r2: number; n: number; e_fixed: number; e_linear: number; e_quad: number };
  balance: BalanceResult;
  gds: { point_id: number; code: string; kva: number; energy_mwh: number; peak_kw: number; util: number; samples: number }[];
  members: number;
  metered: number;
  total_kva: number;
  settings: { high: number; min_coverage: number };
}

function FeederDetail({ pointId, date, onOpen }: { pointId: number; date: string; onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const { locale } = useT();
  const toast = useToast();
  const [d, setD] = useState<FeederResp | null>(null);
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  useEffect(() => {
    let stop = false;
    setD(null);
    api<FeederResp>(`/api/load/losses/feeder?point=${pointId}&date=${date}&days=30`)
      .then((r) => !stop && setD(r))
      .catch((e) => !stop && toast.push(e.message, 'error'));
    return () => {
      stop = true;
    };
  }, [pointId, date, toast]);
  if (!d) return <Spinner size={16} />;
  const t = (s: string) => new Date(s).getTime();
  const fit = d.fit;
  const eTot = fit.e_fixed + fit.e_linear + fit.e_quad;
  const share = (v: number) => (eTot > 0 ? (v / eTot) * 100 : 0);
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">
        {L('ls_detail')} ·{' '}
        <button className="text-brand-700 hover:underline" onClick={() => onOpen('feeder', String(d.point.id))}>
          {d.point.code}
        </button>{' '}
        <span className="font-normal text-gray-500">
          {d.metered}/{d.members} {L('ls_members')} · {fmtNum(d.total_kva, 0)} kVA
        </span>
      </h3>
      <div className="grid gap-4 xl:grid-cols-2">
        <LoadChart
          title={`${L('ls_profile')} · ${new Date(d.date).toLocaleDateString(loc, { dateStyle: 'medium' })}`}
          lines={[
            { name: L('level_feeder'), points: d.profile.map((p) => ({ t: t(p.ts), v: p.feeder })), color: 'var(--series-1)', width: 2.5 },
            { name: `Σ ${L('gds').toLowerCase()}`, points: d.profile.map((p) => ({ t: t(p.ts), v: p.gd })), color: 'var(--series-2)', dashed: true },
            { name: L('ls_loss'), points: d.profile.map((p) => ({ t: t(p.ts), v: p.loss })), color: 'var(--series-3)' },
          ]}
          unit=" MW"
          height={230}
          format={(v) => fmtNum(v, 3)}
          emptyText={L('no_data')}
        />
        <div className="card p-3 text-xs">
          <h4 className="mb-2 text-sm font-semibold text-gray-900">{L('ls_fit', { n: fmtNum(fit.n), r2: fmtNum(fit.r2, 2) })}</h4>
          {fit.n < 12 ? (
            <p className="text-gray-500">{L('no_data')}</p>
          ) : (
            <ul className="space-y-2">
              {(
                [
                  [L('ls_fixed'), fit.e_fixed, `a = ${fmtNum(fit.a * 1000, 1)} kW`],
                  [L('ls_linear'), fit.e_linear, `b = ${fmtNum(fit.b * 100, 2)}% × P`],
                  [L('ls_quad'), fit.e_quad, `c = ${fmtNum(fit.c, 4)} × P²`],
                ] as [string, number, string][]
              ).map(([k, v, f]) => (
                <li key={k}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-gray-800">{k}</span>
                    <span className="tabular-nums text-gray-900">
                      {fmtMWh(v)} · {fmtPct(share(v))}
                    </span>
                  </div>
                  <UtilBar v={Math.max(0, share(v))} warn={101} over={102} />
                  <div className="text-[10px] text-gray-500">{f}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-gray-500">
            {L('period_30d')}: {fmtMWh(d.balance.e_in)} → {fmtMWh(d.balance.e_out)} = {fmtPct(d.balance.pct)} ({d.balance.valid_days} {L('ls_valid_days')})
          </p>
        </div>
      </div>
      {(d.balance.daily?.length || 0) > 0 && (
        <BarChart
          title={`${L('ls_daily')} · ${d.point.code}`}
          name={L('ls_loss')}
          labels={(d.balance.daily || []).map((x) => x.day)}
          values={(d.balance.daily || []).map((x) => (x.valid ? x.pct : 0))}
          reference={{ value: d.settings.high, label: `${fmtNum(d.settings.high, 0)}%` }}
          format={(v) => fmtNum(v, 1)}
          tickLabel={(l) => l.slice(8)}
          tooltipLabel={(l) => new Date(l).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' })}
          height={180}
        />
      )}
      <div className="card overflow-x-auto p-3">
        <h4 className="mb-2 text-sm font-semibold text-gray-900">
          {L('ls_gd_list')} · {new Date(d.date).toLocaleDateString(loc, { dateStyle: 'medium' })}
        </h4>
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
              <th className="py-1">{L('level_gd')}</th>
              <th className="py-1 text-right">kVA</th>
              <th className="py-1 text-right">{L('energy')}</th>
              <th className="py-1 text-right">{L('peak')}</th>
              <th className="w-40 py-1 text-right">{L('util')}</th>
            </tr>
          </thead>
          <tbody>
            {d.gds.slice(0, 300).map((g) => (
              <tr key={g.point_id} className="cursor-pointer border-b border-gray-100 hover:bg-gray-50" onClick={() => onOpen('point', String(g.point_id))}>
                <td className="py-1 font-medium text-gray-900">{g.code}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(g.kva, 0)}</td>
                <td className="py-1 text-right tabular-nums">{fmtMWh(g.energy_mwh)}</td>
                <td className="py-1 text-right tabular-nums">{fmtNum(g.peak_kw, 0)} kW</td>
                <td className="py-1 pl-3">
                  <div className={`text-right tabular-nums ${utilClass(g.util)}`}>{fmtPct(g.util)}</div>
                  <UtilBar v={g.util} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
