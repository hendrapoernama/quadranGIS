'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { fmtNum } from '@/lib/format';
import { Button, Spinner, useToast } from '@/components/ui';
import { LoadChart, Heatmap } from '@/components/charts/LoadChart';
import { BarChart } from '@/components/charts/BarChart';
import { csvRow, downloadText } from '@/components/exec/common';
import { useLoadT } from './i18n';
import { EntityPicker, StatCard, fmtHM, fmtMWh, fmtPct, loadUnit, toUnit, todayISO, utilClass, type EntityRef } from './common';
import type { DayStat, Entity, ForecastInfo, ForecastPoint, MonthStat, PeriodStats, Profile, Reading, SeriesPoint } from './types';

interface Resp {
  entity: Entity;
  period: string;
  date: string;
  warn_pct: number;
  over_pct: number;
  cap_pf: number;
  series?: SeriesPoint[];
  last_week?: SeriesPoint[];
  forecast?: ForecastPoint[];
  forecast_info?: ForecastInfo;
  readings?: Reading[];
  profile?: Profile;
  days?: DayStat[];
  heatmap?: number[][];
  months?: MonthStat[];
  prev_months?: MonthStat[];
  duration?: number[];
  stats: PeriodStats;
  prev_year?: PeriodStats;
}

const t = (s: string) => new Date(s).getTime();

export function Analysis({ focus, refresh }: { focus: { level: string; id: string } | null; refresh: number }) {
  const L = useLoadT();
  const { locale } = useT();
  const { resolved } = useTheme();
  const toast = useToast();
  const [ent, setEnt] = useState<EntityRef>(focus ? { level: focus.level === 'point' ? 'feeder' : focus.level, id: focus.id } : { level: 'system', id: '' });
  const [period, setPeriod] = useState<'day' | 'month' | 'year'>('day');
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  // titik dari ringkasan / peringkat dibuka lewat id titik (jenis apa pun)
  const [pointLevel, setPointLevel] = useState(focus?.level === 'point');
  useEffect(() => {
    if (focus) {
      setEnt({ level: focus.level === 'point' ? 'feeder' : focus.level, id: focus.id });
      setPointLevel(focus.level === 'point');
    }
  }, [focus]);

  const load = useCallback(async () => {
    if (ent.level !== 'system' && !ent.id) return setData(null);
    setBusy(true);
    try {
      const lv = pointLevel ? 'point' : ent.level;
      setData(await api<Resp>(`/api/load/analysis?level=${lv}&id=${encodeURIComponent(ent.id)}&period=${period}&date=${date}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [ent, period, date, pointLevel, toast]);
  useEffect(() => {
    load();
  }, [load, refresh, locale]);

  const e = data?.entity;
  const warn = data?.warn_pct ?? 80;
  const over = data?.over_pct ?? 100;
  const cap = e?.cap_mw || 0;
  // gardu distribusi: satuan kW agar angka terbaca
  const U = loadUnit(cap);
  const u = (v: number) => toUnit(v, U);
  const fmtL = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '-' : `${fmtNum(u(v), U === 'kW' ? 0 : d)} ${U}`);
  const refs = cap
    ? [
        { value: u((cap * warn) / 100), label: L('limit_warn', { p: warn }), color: 'var(--status-warning)' },
        { value: u(cap), label: L('limit_over'), color: 'var(--status-critical)' },
      ]
    : [];
  const st = data?.stats;
  const shiftDate = (d: number) => {
    const x = new Date(date);
    if (period === 'day') x.setDate(x.getDate() + d);
    else if (period === 'month') x.setMonth(x.getMonth() + d);
    else x.setFullYear(x.getFullYear() + d);
    setDate(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  };
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';

  return (
    <div className="space-y-4">
      <div className="card space-y-2 p-3">
        <EntityPicker
          value={ent}
          onChange={(v) => {
            setEnt(v);
            setPointLevel(false);
          }}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex rounded-md border border-gray-300 bg-white p-0.5">
            {(['day', 'month', 'year'] as const).map((p) => (
              <button key={p} className={`rounded px-2.5 py-1 ${period === p ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setPeriod(p)}>
                {L(`period_${p}`)}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" icon="chevron-left" onClick={() => shiftDate(-1)} aria-label="sebelumnya">
            {''}
          </Button>
          <input type="date" className="input !w-auto text-xs" value={date} onChange={(ev) => setDate(ev.target.value)} />
          <Button size="sm" variant="ghost" icon="chevron-right" onClick={() => shiftDate(1)} aria-label="berikutnya">
            {''}
          </Button>
          {busy && <Spinner size={14} />}
          {e && (
            <span className="ml-auto text-gray-600">
              <b className="text-gray-900">{e.name}</b>
              {e.parent ? ` · ${L('pt_feeder')} ${e.parent}` : ''} · {L('capacity')} {fmtL(cap, 1)} ({fmtNum(e.cap_mva < 1 ? e.cap_mva * 1000 : e.cap_mva, 1)} {e.cap_mva < 1 ? 'kVA' : 'MVA'}) · {e.members} titik
            </span>
          )}
        </div>
      </div>

      {!data ? (
        ent.level !== 'system' && !ent.id ? <p className="text-sm text-gray-500">{L('pick_entity')}</p> : busy ? null : <p className="text-sm text-gray-500">{L('no_data')}</p>
      ) : (
        <>
          {st && (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
              <StatCard label={L('peak')} value={fmtL(st.peak_mw)} sub={period === 'day' ? fmtHM(st.peak_ts) : st.peak_ts ? new Date(st.peak_ts).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' }) : '-'} />
              <StatCard label={L('util')} value={<span className={utilClass(st.peak_util, warn, over)}>{fmtPct(st.peak_util)}</span>} sub={`${L('capacity')} ${fmtL(cap, 1)}`} />
              <StatCard label={L('wbp')} value={fmtL(st.wbp_peak_mw)} sub={`${L('lwbp')} ${fmtL(st.lwbp_peak_mw)}`} />
              <StatCard label={L('avg')} value={fmtL(st.avg_mw)} sub={`${L('min')} ${fmtL(st.min_mw)}`} />
              <StatCard
                label={L('energy')}
                value={fmtMWh(st.energy_mwh)}
                sub={[
                  st.energy_exp_mwh > 0 ? `${L('energy_exp')} ${fmtMWh(st.energy_exp_mwh)}` : '',
                  data.prev_year?.energy_mwh ? `${L('vs_prev_year')} ${fmtPct(((st.energy_mwh - data.prev_year.energy_mwh) / data.prev_year.energy_mwh) * 100)}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
              <StatCard label={L('lf')} value={fmtNum(st.load_factor, 2)} />
              <StatCard label={L('hours80', { p: warn })} value={fmtNum(st.hours_over80, 1)} sub={`${L('hours100', { p: over })}: ${fmtNum(st.hours_over100, 1)}`} />
              <StatCard label={L('data_ok')} value={fmtPct(st.expected ? (st.samples / st.expected) * 100 : 0)} sub={`${fmtNum(st.samples)} / ${fmtNum(st.expected)}`} />
            </div>
          )}

          {period === 'day' && (
            <>
              <LoadChart
                title={`${e?.name} · ${new Date(data.date).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`}
                lines={[
                  { name: L('last_week'), points: (data.last_week || []).map((p) => ({ t: t(p.ts) + 7 * 86400000, v: u(p.p) })), color: 'var(--chart-cursor)', dashed: true, width: 1.5 },
                  { name: L('forecast'), points: (data.forecast || []).filter((f) => f.p > 0).map((f) => ({ t: t(f.ts), v: u(f.p) })), color: 'var(--series-2)', dashed: true },
                  { name: L('actual'), points: (data.series || []).map((p) => ({ t: t(p.ts), v: u(p.p) })), color: 'var(--series-1)', width: 2.5 },
                ]}
                band={(data.forecast || []).filter((f) => f.p > 0).map((f) => ({ t: t(f.ts), lo: u(f.lo), hi: u(f.hi) }))}
                bandColor="var(--series-2)"
                refs={refs}
                unit={` ${U}`}
                emptyText={L('no_data')}
              />
              {data.readings && data.readings.length > 0 && <Quantities readings={data.readings} capMW={cap} code={e?.name || ''} date={data.date} />}
              {data.profile && data.profile.class !== '-' && (
                <div className="card p-3 text-xs">
                  <h3 className="mb-2 text-sm font-semibold text-gray-900">{L('profile')}</h3>
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    <div className="text-2xl font-semibold text-gray-900">{L(`class_${data.profile.class}`)}</div>
                    <span>
                      <span className="text-gray-500">{L('peak_hour')}</span>{' '}
                      <b className="tabular-nums">{`${String(Math.floor(data.profile.peak_hour)).padStart(2, '0')}:${data.profile.peak_hour % 1 ? '30' : '00'}`}</b>
                    </span>
                    <span>
                      <span className="text-gray-500">{L('lf')}</span> <b className="tabular-nums">{fmtNum(data.profile.load_factor, 2)}</b>
                    </span>
                    <span>
                      <span className="text-gray-500">{L('weekend_ratio')}</span> <b className="tabular-nums">{fmtNum(data.profile.weekend_ratio, 2)}</b>
                    </span>
                    <span>
                      <span className="text-gray-500">siang/malam</span> <b className="tabular-nums">{fmtNum(data.profile.day_evening_ratio, 2)}</b>
                    </span>
                    {data.forecast_info && (
                      <span>
                        <span className="text-gray-500">{L('fc_mape')}</span> <b className="tabular-nums">{fmtPct(data.forecast_info.mape)}</b>
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {period === 'month' && (
            <>
              <BarChart
                title={`${L('daily_peaks')} (${U})`}
                name={L('peak')}
                labels={(data.days || []).map((d) => d.day)}
                values={(data.days || []).map((d) => u(d.peak_mw))}
                reference={cap ? { value: u((cap * warn) / 100), label: L('limit_warn', { p: warn }) } : undefined}
                format={(v) => fmtNum(v, U === 'kW' ? 0 : 1)}
                tickLabel={(l) => l.slice(8)}
                tooltipLabel={(l) => new Date(l).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' })}
                emptyText={L('no_data')}
              />
              <BarChart
                title={`${L('energy')} (MWh)`}
                name={L('energy')}
                labels={(data.days || []).map((d) => d.day)}
                values={(data.days || []).map((d) => d.energy_mwh)}
                color="var(--series-3)"
                format={(v) => fmtNum(v, v < 10 ? 2 : 0)}
                tickLabel={(l) => l.slice(8)}
                tooltipLabel={(l) => new Date(l).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' })}
                emptyText={L('no_data')}
              />
              {data.heatmap && (
                <Heatmap
                  title={L('heatmap')}
                  rows={data.heatmap.map((r) => r.map(u))}
                  rowLabel={(i) => String(i + 1)}
                  format={(v) => fmtNum(v, U === 'kW' ? 0 : 1)}
                  unit={` ${U}`}
                  dark={resolved === 'dark'}
                />
              )}
            </>
          )}

          {period === 'year' && (
            <div className="grid gap-4 xl:grid-cols-2">
              <BarChart
                title={`${L('monthly_peaks')} (${U})`}
                name={data.date.slice(0, 4)}
                labels={(data.months || []).map((m) => m.month)}
                values={(data.months || []).map((m) => u(m.peak_mw))}
                reference={cap ? { value: u((cap * warn) / 100), label: L('limit_warn', { p: warn }) } : undefined}
                format={(v) => fmtNum(v, U === 'kW' ? 0 : 1)}
                tickLabel={(l) => new Date(`${l}-01`).toLocaleDateString(loc, { month: 'short' })}
                tooltipLabel={(l) => {
                  const pm = (data.prev_months || []).find((m) => m.month.slice(5) === l.slice(5));
                  return `${new Date(`${l}-01`).toLocaleDateString(loc, { month: 'long', year: 'numeric' })}${pm ? ` · ${L('prev_year')} ${fmtL(pm.peak_mw, 1)}` : ''}`;
                }}
                emptyText={L('no_data')}
              />
              <LoadChart
                title={L('duration')}
                lines={[{ name: L('actual'), points: (data.duration || []).map((v, i, a) => ({ t: (i / Math.max(1, a.length - 1)) * 100, v: u(v) })), color: 'var(--series-1)' }]}
                refs={refs}
                xFormat={(x) => `${Math.round(x)}%`}
                tipFormat={(x) => `${Math.round(x)}% ${L('duration_x')}`}
                unit={` ${U}`}
                emptyText={L('no_data')}
              />
              <div className="card overflow-x-auto p-3 xl:col-span-2">
                <table className="w-full min-w-[680px] text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                      <th className="py-1">{L('months')}</th>
                      <th className="py-1 text-right">{L('peak')}</th>
                      <th className="py-1 text-right">{L('util')}</th>
                      <th className="py-1 text-right">{L('prev_year')}</th>
                      <th className="py-1 text-right">{L('energy')} (MWh)</th>
                      <th className="py-1 text-right">{L('lf')}</th>
                      <th className="py-1 text-right">{L('hours80', { p: warn })}</th>
                      <th className="py-1 text-right">{L('data_ok')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.months || []).map((m) => {
                      const pm = (data.prev_months || []).find((x) => x.month.slice(5) === m.month.slice(5));
                      const g = pm && pm.peak_mw ? ((m.peak_mw - pm.peak_mw) / pm.peak_mw) * 100 : null;
                      return (
                        <tr key={m.month} className="border-b border-gray-100">
                          <td className="py-1">{new Date(`${m.month}-01`).toLocaleDateString(loc, { month: 'long' })}</td>
                          <td className="py-1 text-right tabular-nums">{fmtL(m.peak_mw)}</td>
                          <td className={`py-1 text-right tabular-nums ${utilClass(m.peak_util, warn, over)}`}>{fmtPct(m.peak_util)}</td>
                          <td className="py-1 text-right tabular-nums text-gray-600">
                            {pm ? fmtL(pm.peak_mw) : '-'}{' '}
                            {g !== null && (
                              <span className={g > 0 ? 'text-red-600' : 'text-emerald-600'}>
                                ({g > 0 ? '+' : ''}
                                {fmtNum(g, 1)}%)
                              </span>
                            )}
                          </td>
                          <td className="py-1 text-right tabular-nums">{fmtNum(m.energy_mwh, m.energy_mwh < 10 ? 2 : 0)}</td>
                          <td className="py-1 text-right tabular-nums">{fmtNum(m.load_factor, 2)}</td>
                          <td className="py-1 text-right tabular-nums">{fmtNum(m.hours_over80, 1)}</td>
                          <td className="py-1 text-right tabular-nums">{fmtPct(m.completeness)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type QTab = 'current' | 'voltage' | 'power' | 'pf' | 'energy' | 'table';

/** Seluruh besaran SCADA satu titik pada satu hari: arus & tegangan per fasa, P/Q/S, pf, frekuensi, energi. */
function Quantities({ readings, capMW, code, date }: { readings: Reading[]; capMW: number; code: string; date: string }) {
  const L = useLoadT();
  const [tab, setTab] = useState<QTab>('current');
  const U = loadUnit(capMW);
  const pw = (v: number | null) => (v === null ? null : toUnit(v, U));
  // tegangan fasa gardu (fasa-netral, kV kecil) ditampilkan dalam volt
  const vmax = Math.max(0, ...readings.map((r) => Math.max(r.v_r || 0, r.v_s || 0, r.v_t || 0, r.v_kv || 0)));
  const VU = vmax > 0 && vmax < 1 ? 'V' : 'kV';
  const vv = (v: number | null) => (v === null ? null : VU === 'V' ? v * 1000 : v);
  const hm = (s: string) => new Date(s).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const tabs: [QTab, string][] = [
    ['current', L('q_current')],
    ['voltage', L('q_voltage')],
    ['power', L('q_power')],
    ['pf', L('q_pf')],
    ['energy', L('q_energy')],
    ['table', L('q_table')],
  ];
  const csv = () => {
    const head = ['ts', 'i_r', 'i_s', 'i_t', 'v_r', 'v_s', 'v_t', 'v_kv', 'p_mw', 'q_mvar', 's_mva', 'pf', 'f_hz', 'kwh_imp', 'kwh_exp', 'kvarh_imp', 'kvarh_exp', 'util'] as const;
    const rows = [csvRow([...head]), ...readings.map((r) => csvRow(head.map((k) => (k === 'ts' ? new Date(r.ts).toISOString() : (r as any)[k]))))];
    downloadText(`${code}_${date}.csv`, rows.join('\r\n'));
  };
  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        <h3 className="mr-2 text-sm font-semibold text-gray-900">{L('q_title')}</h3>
        {tabs.map(([k, l]) => (
          <button key={k} className={`rounded-full border px-2.5 py-0.5 ${tab === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:border-gray-500'}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
        <Button size="sm" variant="ghost" icon="download" className="ml-auto" onClick={csv}>
          {L('csv')}
        </Button>
      </div>
      {tab === 'current' && (
        <LoadChart
          title={L('phases')}
          lines={[
            { name: `I ${L('i_r')}`, points: readings.map((r) => ({ t: t(r.ts), v: r.i_r })), color: 'var(--series-2)' },
            { name: `I ${L('i_s')}`, points: readings.map((r) => ({ t: t(r.ts), v: r.i_s })), color: 'var(--series-3)' },
            { name: `I ${L('i_t')}`, points: readings.map((r) => ({ t: t(r.ts), v: r.i_t })), color: 'var(--series-1)' },
          ]}
          unit=" A"
          height={220}
          format={(v) => fmtNum(v, 0)}
        />
      )}
      {tab === 'voltage' && (
        <LoadChart
          title={`${L('q_voltage')} (${VU})`}
          lines={[
            { name: 'V R', points: readings.map((r) => ({ t: t(r.ts), v: vv(r.v_r) })), color: 'var(--series-2)' },
            { name: 'V S', points: readings.map((r) => ({ t: t(r.ts), v: vv(r.v_s) })), color: 'var(--series-3)' },
            { name: 'V T', points: readings.map((r) => ({ t: t(r.ts), v: vv(r.v_t) })), color: 'var(--series-1)' },
          ]}
          unit={` ${VU}`}
          height={220}
          format={(v) => fmtNum(v, VU === 'V' ? 1 : 2)}
        />
      )}
      {tab === 'power' && (
        <LoadChart
          title={`${L('q_power')} (P ${U}, Q ${U === 'kW' ? 'kVAr' : 'MVAr'}, S ${U === 'kW' ? 'kVA' : 'MVA'})`}
          lines={[
            { name: `${L('p_active')} (${U})`, points: readings.map((r) => ({ t: t(r.ts), v: pw(r.p_mw) })), color: 'var(--series-1)', width: 2.5 },
            { name: `${L('s_apparent')} (${U === 'kW' ? 'kVA' : 'MVA'})`, points: readings.map((r) => ({ t: t(r.ts), v: pw(r.s_mva) })), color: 'var(--series-2)', dashed: true },
            { name: `${L('q_reactive')} (${U === 'kW' ? 'kVAr' : 'MVAr'})`, points: readings.map((r) => ({ t: t(r.ts), v: pw(r.q_mvar) })), color: 'var(--series-3)' },
          ]}
          height={220}
          format={(v) => fmtNum(v, U === 'kW' ? 0 : 2)}
        />
      )}
      {tab === 'pf' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <LoadChart title={L('pf')} lines={[{ name: 'pf', points: readings.map((r) => ({ t: t(r.ts), v: r.pf })), color: 'var(--series-1)' }]} height={190} format={(v) => fmtNum(v, 3)} />
          <LoadChart title={`${L('freq')} (Hz)`} lines={[{ name: 'f', points: readings.map((r) => ({ t: t(r.ts), v: r.f_hz })), color: 'var(--series-2)' }]} unit=" Hz" height={190} format={(v) => fmtNum(v, 3)} />
        </div>
      )}
      {tab === 'energy' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <BarChart
            title={`${L('kwh_imp')} / ${L('kwh_exp')}`}
            name={L('kwh_imp')}
            labels={readings.map((r) => r.ts)}
            values={readings.map((r) => r.kwh_imp || 0)}
            stacked={{ name: L('kwh_exp'), values: readings.map((r) => r.kwh_exp || 0) }}
            format={(v) => fmtNum(v, 0)}
            tickLabel={(l, i) => (i % 8 === 0 ? hm(l) : '')}
            tooltipLabel={hm}
            height={200}
          />
          <BarChart
            title={`${L('kvarh_imp')} / ${L('kvarh_exp')}`}
            name={L('kvarh_imp')}
            labels={readings.map((r) => r.ts)}
            values={readings.map((r) => r.kvarh_imp || 0)}
            stacked={{ name: L('kvarh_exp'), values: readings.map((r) => r.kvarh_exp || 0) }}
            color="var(--series-3)"
            format={(v) => fmtNum(v, 0)}
            tickLabel={(l, i) => (i % 8 === 0 ? hm(l) : '')}
            tooltipLabel={hm}
            height={200}
          />
        </div>
      )}
      {tab === 'table' && (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[980px] text-[11px]">
            <thead className="sticky top-0 bg-white dark:bg-gray-800">
              <tr className="border-b border-gray-200 text-right text-[10px] uppercase tracking-wide text-gray-500">
                <th className="py-1 text-left">{L('time')}</th>
                <th>I R</th>
                <th>I S</th>
                <th>I T</th>
                <th>V R</th>
                <th>V S</th>
                <th>V T</th>
                <th>P ({U})</th>
                <th>Q</th>
                <th>S</th>
                <th>pf</th>
                <th>Hz</th>
                <th>kWh+</th>
                <th>kWh−</th>
                <th>kvarh+</th>
                <th>kvarh−</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((r) => (
                <tr key={r.ts} className={`border-b border-gray-100 text-right tabular-nums ${r.quality ? 'text-amber-700' : ''}`}>
                  <td className="py-0.5 text-left">{hm(r.ts)}</td>
                  {[r.i_r, r.i_s, r.i_t].map((v, i) => (
                    <td key={`i${i}`}>{v === null ? '-' : fmtNum(v, 0)}</td>
                  ))}
                  {[r.v_r, r.v_s, r.v_t].map((v, i) => (
                    <td key={`v${i}`}>{v === null ? '-' : fmtNum(vv(v) as number, VU === 'V' ? 1 : 2)}</td>
                  ))}
                  {[r.p_mw, r.q_mvar, r.s_mva].map((v, i) => (
                    <td key={`p${i}`}>{v === null ? '-' : fmtNum(pw(v) as number, U === 'kW' ? 0 : 3)}</td>
                  ))}
                  <td>{r.pf === null ? '-' : fmtNum(r.pf, 3)}</td>
                  <td>{r.f_hz === null ? '-' : fmtNum(r.f_hz, 2)}</td>
                  {[r.kwh_imp, r.kwh_exp, r.kvarh_imp, r.kvarh_exp].map((v, i) => (
                    <td key={`e${i}`}>{v === null ? '-' : fmtNum(v, 0)}</td>
                  ))}
                  <td>{r.util === null ? '-' : fmtNum(r.util, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
