'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { realtime } from '@/lib/ws';
import { Button, Modal, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { BarChart } from '@/components/charts/BarChart';
import { AiOpsPanel } from '@/components/ai/AiOpsPanel';
import { useExecT } from './i18n';
import { InsightList, ShareBar, TargetBadge, fmtIdx, fmtMin, fmtRp } from './common';
import { BigTile, Pill, SectionTitle, SplitCard, TileBadge, TileDelta, ValueCard } from './InfoWidgets';
import { KIND_COLOR } from './InfographicMap';
import { usePageBanner } from '@/components/PageBanner';
import { PeriodicReports } from './PeriodicReports';
import type { Dashboard, Insight } from './types';

type Period = 'today' | 'month' | 'year' | '30d';

export default function Executive() {
  const e = useExecT();
  const { locale } = useT();
  const { has } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<'summary' | 'reports'>('summary');
  const [period, setPeriod] = useState<Period>('month');
  const [data, setData] = useState<Dashboard | null>(null);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('tab') === 'reports') setTab('reports');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, ins] = await Promise.all([api<Dashboard>(`/api/exec/dashboard?period=${period}`), api<{ items: Insight[] }>('/api/ops/insights').catch(() => ({ items: [] as Insight[] }))]);
      setData(d);
      setInsights(ins.items);
    } catch (err: any) {
      toast.push(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [period, toast]);
  useEffect(() => {
    load();
  }, [load, locale]);

  // realtime: padam / laporan / rencana berubah → muat ulang (dibatasi)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    realtime.connect();
    const unsub = realtime.subscribe((ev) => {
      if (!['maneuver', 'ops.report', 'ops.plan', 'exec.report'].includes(ev.type)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, 4000);
    });
    const iv = setInterval(load, 120000);
    return () => {
      unsub();
      clearInterval(iv);
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const periods: [Period, string][] = [
    ['today', e('period_today')],
    ['month', e('period_month')],
    ['30d', e('period_30d')],
    ['year', e('period_year')],
  ];

  usePageBanner({ title: e('exec_title'), subtitle: e('exec_subtitle') });

  return (
    <div className="exec-scroll h-full overflow-y-auto bg-gray-100 p-4 md:p-6">
      <div className="no-print mb-4 space-y-3">
        <div className="flex w-fit rounded-md border border-gray-300 bg-white p-0.5 text-xs">
          {(['summary', 'reports'] as const).map((tb) => (
            <button key={tb} className={`rounded px-3 py-1 font-medium ${tab === tb ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setTab(tb)}>
              {tb === 'summary' ? e('tab_summary') : e('tab_reports')}
            </button>
          ))}
        </div>
      </div>

      {tab === 'reports' ? (
        <PeriodicReports />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-gray-300 bg-white p-0.5 text-xs">
              {periods.map(([k, label]) => (
                <button
                  key={k}
                  className={`rounded px-3 py-1 ${period === k ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`}
                  onClick={() => setPeriod(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="secondary" icon="refresh" loading={loading} onClick={load}>
              {e('refresh')}
            </Button>
            {data && (
              <span className="text-[11px] text-gray-500">
                {new Date(data.report.from).toLocaleDateString(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium' })} –{' '}
                {new Date(data.report.to).toLocaleString(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            )}
          </div>
          {!data ? (
            <div className="py-16 text-center">
              <Spinner size={24} />
            </div>
          ) : (
            <DashboardBody data={data} insights={insights} onAi={has('ai.use') ? () => setAiOpen(true) : undefined} onRegion={(id) => router.push(`/reliability?region=${id}`)} />
          )}
        </div>
      )}
      <Modal open={aiOpen} title={`${e('ai_title')} · ${e('ai_task_insights')}`} onClose={() => setAiOpen(false)} width="max-w-3xl">
        {aiOpen && <AiOpsPanel task="insights" autoStart />}
      </Modal>
    </div>
  );
}

function DashboardBody({ data, insights, onAi, onRegion }: { data: Dashboard; insights: Insight[] | null; onAi?: () => void; onRegion: (id: number) => void }) {
  const e = useExecT();
  const { locale } = useT();
  const r = data.report;
  const t = r.total;
  const prev = r.previous?.total;
  const n = data.now;
  const tg = r.targets;
  const slaPct = r.ops.reports > 0 ? ((r.ops.reports - r.ops.reports_overdue) / r.ops.reports) * 100 : null;
  const kinds = Object.entries(r.by_kind).sort((a, b) => b[1].customer_minutes - a[1].customer_minutes);
  const totalCM = kinds.reduce((s, [, g]) => s + g.customer_minutes, 0);
  const ulps = r.regions.filter((x) => x.level === 'ulp' && x.customers > 0 && x.rel.outages > 0).sort((a, b) => b.rel.saidi - a.rel.saidi);
  const monthLabel = (m: string) => {
    const [y, mm] = m.split('-').map(Number);
    return new Date(y, mm - 1, 1).toLocaleDateString(locale === 'en' ? 'en-GB' : 'id-ID', { month: 'short' });
  };
  const monthTip = (m: string) => {
    const [y, mm] = m.split('-').map(Number);
    return new Date(y, mm - 1, 1).toLocaleDateString(locale === 'en' ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric' });
  };
  const dayLabel = (d: string) => d.slice(8, 10);
  const pctOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
  const custOnPct = pctOf(n.customers.total - n.customers.off, n.customers.total);
  const reportsOkPct = n.reports_open > 0 ? pctOf(n.reports_open - n.reports_overdue, n.reports_open) : 100;
  const feedersTotal = n.feeders.on + n.feeders.partial + n.feeders.off;
  const feedersOkPct = pctOf(feedersTotal - n.feeders_high_load, feedersTotal);

  return (
    <>
      {!n.ready && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          <Icon name="clock" size={14} />
          {e('graph_loading')}
        </div>
      )}

      {/* kondisi saat ini */}
      <section>
        <SectionTitle icon="monitor" text={e('now_title')} />
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          <SplitCard
            icon="users"
            title={e('w_customers')}
            head={`${e('w_served')}: ${fmtNum(n.customers.total)}`}
            left={{ label: e('w_off'), value: fmtNum(n.customers.off) }}
            right={{ label: e('w_on'), value: fmtNum(n.customers.total - n.customers.off) }}
            caption={{ pct: custOnPct, text: e('w_on_pct', { p: fmtNum(custOnPct, custOnPct > 0 && custOnPct < 100 ? 2 : 0) }) }}
          />
          <ValueCard
            icon="alert"
            title={e('active_outages')}
            head={n.active_outages > 0 ? e('w_needs_action') : e('w_all_on')}
            value={fmtNum(n.active_outages)}
            tone={n.active_outages > 0 ? 'red' : 'emerald'}
          />
          <SplitCard
            icon="bell"
            title={e('w_reports')}
            head={`${e('w_open')}: ${fmtNum(n.reports_open)}`}
            left={{ label: e('w_overdue'), value: fmtNum(n.reports_overdue) }}
            right={{ label: e('w_in_sla'), value: fmtNum(Math.max(0, n.reports_open - n.reports_overdue)) }}
            caption={{ pct: reportsOkPct, text: n.reports_open > 0 ? e('w_in_sla_pct', { p: fmtNum(reportsOkPct, 0) }) : e('w_no_open') }}
          />
          <ValueCard icon="list" title={e('plans_active')} head={e('w_switching_plans')} value={fmtNum(n.plans_active)} tone="blue" />
          <SplitCard
            icon="diagram"
            title={e('w_feeders')}
            head={`${e('w_total')}: ${fmtNum(feedersTotal)}`}
            left={{ label: e('w_high'), value: fmtNum(n.feeders_high_load), tone: 'orange' }}
            right={{ label: e('w_normal'), value: fmtNum(Math.max(0, feedersTotal - n.feeders_high_load)) }}
            caption={{ pct: feedersOkPct, text: e('w_normal_pct', { p: fmtNum(feedersOkPct, feedersOkPct > 0 && feedersOkPct < 100 ? 1 : 0) }) }}
          />
        </div>
      </section>

      {/* kinerja periode */}
      <section>
        <SectionTitle icon="chart" text={e('period_title')} />
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <BigTile
            cls="bg-rose-600"
            label={e('saidi')}
            value={fmtIdx(t.saidi)}
            unit={e('unit_saidi')}
            badge={tg.saidi_period ? <TileBadge ok={t.saidi <= tg.saidi_period} okText={e('on_track')} badText={e('off_track')} /> : undefined}
            sub={
              <>
                <TileDelta cur={t.saidi} prev={prev?.saidi} /> · {e('target_pro')} {fmtIdx(tg.saidi_period)}
              </>
            }
          />
          <BigTile
            cls="bg-cyan-600"
            label={e('saifi')}
            value={fmtIdx(t.saifi)}
            unit={e('unit_saifi')}
            badge={tg.saifi_period ? <TileBadge ok={t.saifi <= tg.saifi_period} okText={e('on_track')} badText={e('off_track')} /> : undefined}
            sub={
              <>
                <TileDelta cur={t.saifi} prev={prev?.saifi} /> · {e('target_pro')} {fmtIdx(tg.saifi_period)}
              </>
            }
          />
          <BigTile
            cls="bg-orange-600"
            label={e('ens')}
            value={fmtRp(t.ens_rp)}
            sub={
              <>
                {fmtNum(t.ens_kwh, 1)} kWh · <TileDelta cur={t.ens_rp} prev={prev?.ens_rp} />
              </>
            }
          />
          <BigTile
            cls="bg-violet-600"
            label={e('outages')}
            value={fmtNum(t.outages)}
            sub={
              <>
                {fmtNum(t.momentary)} {e('momentary')} · <TileDelta cur={t.outages} prev={prev?.outages} />
              </>
            }
          />
          <BigTile cls="bg-indigo-600" label={e('mttr')} value={fmtMin(r.mttr_min)} sub={<TileDelta cur={r.mttr_min} prev={r.previous?.mttr_min} />} />
          <BigTile
            cls="bg-emerald-600"
            label={e('report_sla')}
            value={slaPct === null ? '-' : `${fmtNum(slaPct, 0)}%`}
            sub={`${fmtNum(r.ops.reports)} ${e('rep_reports').toLowerCase()} · ${fmtNum(r.ops.reports_overdue)} ${e('overdue')}`}
          />
        </div>
        <div className="mt-1 text-[11px] text-gray-500">{e('vs_prev')}</div>
      </section>

      {/* tahun berjalan vs target */}
      <section className="card p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle icon="target" text={e('ytd_title')} inline />
          <span className="text-[11px] text-gray-500">{e('ytd_elapsed', { pct: fmtNum(data.ytd.elapsed * 100, 0) })}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {(
            [
              ['saidi', data.ytd.rel.saidi, data.ytd.saidi_projection, data.ytd.targets.saidi_year, e('unit_saidi')],
              ['saifi', data.ytd.rel.saifi, data.ytd.saifi_projection, data.ytd.targets.saifi_year, e('unit_saifi')],
            ] as const
          ).map(([k, actual, proj, target, unit]) => {
            const scale = Math.max(target, proj, actual) * 1.05 || 1;
            return (
              <div key={k}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-semibold text-gray-800">{e(k)}</span>
                  <TargetBadge value={proj} target={target} />
                </div>
                <div className="relative mt-1.5 h-3 overflow-hidden rounded-full bg-gray-100">
                  <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(proj / scale) * 100}%`, background: 'var(--series-1)', opacity: 0.3 }} />
                  <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(actual / scale) * 100}%`, background: 'var(--series-1)' }} />
                  <div className="absolute inset-y-0 w-0.5" style={{ left: `${(target / scale) * 100}%`, background: 'var(--status-critical)' }} title={e('target_year')} />
                </div>
                <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-gray-600">
                  <span>
                    {e('ytd_actual')}: <b className="tabular-nums text-gray-900">{fmtIdx(actual)}</b> {unit}
                  </span>
                  <span>
                    {e('ytd_projection')}: <b className="tabular-nums text-gray-900">{fmtIdx(proj)}</b>
                  </span>
                  <span>
                    {e('target_year')}: <b className="tabular-nums text-gray-900">{fmtIdx(target)}</b>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* tren */}
      <section className="grid gap-4 xl:grid-cols-2">
        <BarChart
          title={e('trend_saidi')}
          name={e('saidi')}
          color="#e11d48"
          labels={data.trend.map((m) => m.month)}
          values={data.trend.map((m) => m.saidi)}
          reference={{ value: data.ytd.targets.saidi_year / 12, label: e('monthly_target') }}
          format={fmtIdx}
          tickLabel={monthLabel}
          tooltipLabel={monthTip}
          emptyText={e('no_data')}
        />
        {r.daily && r.daily.length > 1 ? (
          <BarChart
            title={e('daily_title')}
            name={e('daily_faults')}
            color="#dc2626"
            color2="#7c3aed"
            labels={r.daily.map((d) => d.date)}
            values={r.daily.map((d) => d.faults)}
            stacked={{ name: e('outages').toLowerCase(), values: r.daily.map((d) => d.outages - d.faults) }}
            format={(v) => fmtNum(v, 0)}
            tickLabel={dayLabel}
            tooltipLabel={(d) => new Date(d).toLocaleDateString(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium' })}
            emptyText={e('no_data')}
          />
        ) : (
          <BarChart
            title={e('trend_saifi')}
            name={e('saifi')}
            color="#0891b2"
            labels={data.trend.map((m) => m.month)}
            values={data.trend.map((m) => m.saifi)}
            reference={{ value: data.ytd.targets.saifi_year / 12, label: e('monthly_target') }}
            format={fmtIdx}
            tickLabel={monthLabel}
            tooltipLabel={monthTip}
            emptyText={e('no_data')}
          />
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        {/* per kategori */}
        <div className="card p-3">
          <SectionTitle icon="list" text={e('by_kind')} />
          {kinds.length === 0 ? (
            <div className="py-6 text-center text-xs text-gray-500">{e('no_data')}</div>
          ) : (
            <ul className="space-y-2 text-xs">
              {kinds.map(([k, g]) => (
                <li key={k}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium text-gray-800">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[k.toUpperCase()] || 'var(--series-1)' }} />
                      {k}
                    </span>
                    <span className="tabular-nums text-gray-600">
                      {fmtNum(g.outages)} × · SAIDI {fmtIdx(g.saidi)}
                    </span>
                  </div>
                  <ShareBar value={totalCM > 0 ? g.customer_minutes / totalCM : 0} color={KIND_COLOR[k.toUpperCase()] || 'var(--series-1)'} />
                </li>
              ))}
              <li className="text-[10px] text-gray-500">{e('share_cm')}</li>
            </ul>
          )}
        </div>
        {/* penyulang */}
        <div className="card p-3">
          <SectionTitle icon="diagram" text={e('top_feeders')} />
          {r.top_feeders.length === 0 ? (
            <div className="py-6 text-center text-xs text-gray-500">{e('no_data')}</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="pb-1 font-medium">{e('feeder')}</th>
                  <th className="pb-1 text-right font-medium">{e('events')}</th>
                  <th className="pb-1 text-right font-medium">{e('faults')}</th>
                  <th className="pb-1 text-right font-medium">{e('cust_min')}</th>
                  <th className="pb-1 text-right font-medium">ENS</th>
                </tr>
              </thead>
              <tbody>
                {r.top_feeders.slice(0, 8).map((f) => (
                  <tr key={f.id} className="border-t border-gray-100">
                    <td className="py-1 font-medium text-gray-800">{f.code}</td>
                    <td className="py-1 text-right">
                      <Pill cls="bg-blue-50 text-blue-800">{fmtNum(f.outages)}</Pill>
                    </td>
                    <td className="py-1 text-right">
                      <Pill cls={f.faults > 0 ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}>{fmtNum(f.faults)}</Pill>
                    </td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(f.customer_minutes, 0)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtRp(f.ens_rp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* wilayah */}
        <div className="card p-3">
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle icon="globe" text={e('top_regions')} inline />
            <a className="text-[11px] text-brand-700 hover:underline" href="/reliability">
              {e('see_all')}
            </a>
          </div>
          {ulps.length === 0 ? (
            <div className="py-6 text-center text-xs text-gray-500">{e('no_data')}</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="pb-1 font-medium">ULP</th>
                  <th className="pb-1 text-right font-medium">SAIDI</th>
                  <th className="pb-1 text-right font-medium">SAIFI</th>
                  <th className="pb-1 text-right font-medium">{e('events')}</th>
                </tr>
              </thead>
              <tbody>
                {ulps.slice(0, 8).map((x) => (
                  <tr key={x.id} className="cursor-pointer border-t border-gray-100 hover:bg-gray-50" onClick={() => onRegion(x.id)}>
                    <td className="py-1">
                      <div className="font-medium text-gray-800">{x.name}</div>
                      <div className="text-[10px] text-gray-500">UP3 {x.parent}</div>
                    </td>
                    <td className="py-1 text-right">
                      <Pill cls={x.rel.saidi > r.targets.saidi_period ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}>{fmtIdx(x.rel.saidi)}</Pill>
                    </td>
                    <td className="py-1 text-right tabular-nums">{fmtIdx(x.rel.saifi)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(x.rel.outages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* temuan */}
      <section className="card p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle icon="sparkles" text={e('insights_title')} inline />
          {onAi && (
            <Button size="sm" variant="secondary" icon="sparkles" onClick={onAi}>
              {e('insights_ai')}
            </Button>
          )}
        </div>
        {insights === null ? <Spinner size={16} /> : <InsightList items={insights} max={12} />}
      </section>
    </>
  );
}
