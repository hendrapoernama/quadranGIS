'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { realtime } from '@/lib/ws';
import { fmtNum } from '@/lib/format';
import { PageHeader, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { LoadChart } from '@/components/charts/LoadChart';
import { useLoadT } from './i18n';
import { SevBadge, UtilBar, fmtDT, fmtHM, fmtMW, fmtMWh, fmtPct, lossClass, utilClass } from './common';
import { Analysis } from './Analysis';
import { Anomalies } from './Anomalies';
import { LoadReports } from './Reports';
import { Advanced } from './Advanced';
import { Losses } from './Losses';
import { Points } from './Points';
import type { BalanceResult, RankItem, SeriesPoint } from './types';

type Tab = 'overview' | 'analysis' | 'losses' | 'anomalies' | 'reports' | 'advanced' | 'points';
const TABS: Tab[] = ['overview', 'analysis', 'losses', 'anomalies', 'reports', 'advanced', 'points'];

interface Overview {
  points: Record<string, number>;
  cap_mw: number;
  system_series?: SeriesPoint[];
  peak_today?: SeriesPoint;
  peak_yesterday?: SeriesPoint;
  energy_today?: number;
  energy_yesterday?: number;
  losses_yesterday?: { dist: BalanceResult; gi: BalanceResult; combined_pct: number; coverage: Record<string, number> };
  completeness?: number;
  top: RankItem[];
  top_gd: RankItem[];
  gd_over: number;
  over_warn: number;
  over_limit: number;
  anomalies: Record<string, Record<string, number>>;
  anomalies_open: number;
  ingest: { messages: number; readings: number; unmapped: number; invalid: number; registered: number; last_at: string; buffer: number };
  simulator: Record<string, any>;
  simulator_enabled: boolean;
  topic: string;
  energy_mode: string;
  data_from: string | null;
  data_to: string | null;
  rows: number;
  settings: { warn: number; over: number; cap_pf: number };
}

export default function Load() {
  const L = useLoadT();
  const { locale } = useT();
  const { has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [ov, setOv] = useState<Overview | null>(null);
  const [focus, setFocus] = useState<{ level: string; id: string } | null>(null);
  const [tick, setTick] = useState(0);
  const canManage = has('load.manage');

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
  }, []);

  const load = useCallback(async () => {
    try {
      setOv(await api<Overview>('/api/load/overview'));
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load, locale]);
  // realtime: data baru / anomali → segarkan (dibatasi)
  useEffect(() => {
    realtime.connect();
    let tm: ReturnType<typeof setTimeout> | null = null;
    const off = realtime.subscribe((ev) => {
      if (ev.type !== 'load.data' && ev.type !== 'load.anomaly') return;
      if (tm) return;
      tm = setTimeout(() => {
        tm = null;
        load();
        setTick((x) => x + 1);
      }, 3000);
    });
    const iv = setInterval(load, 60000);
    return () => {
      off();
      clearInterval(iv);
      if (tm) clearTimeout(tm);
    };
  }, [load]);

  const openAnalysis = (level: string, id: string) => {
    setFocus({ level, id });
    setTab('analysis');
  };
  const tabs: [Tab, string, string][] = [
    ['overview', L('tab_overview'), 'home'],
    ['analysis', L('tab_analysis'), 'chart'],
    ['losses', L('tab_losses'), 'activity'],
    ['anomalies', L('tab_anomalies'), 'alert'],
    ['reports', L('tab_reports'), 'list'],
    ['advanced', L('tab_advanced'), 'sparkles'],
    ['points', L('tab_points'), 'settings'],
  ];

  return (
    <div className="h-full overflow-y-auto p-3 md:p-6">
      <PageHeader title={L('title')} subtitle={L('subtitle')} />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 [scrollbar-width:none]">
        {tabs.map(([k, label, icon]) => (
          <button
            key={k}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
            onClick={() => setTab(k)}
          >
            <Icon name={icon} size={15} />
            {label}
            {k === 'anomalies' && ov && ov.anomalies_open > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[10px] text-white">{ov.anomalies_open}</span>}
          </button>
        ))}
      </div>
      {tab === 'overview' && (ov ? <OverviewView ov={ov} onOpen={openAnalysis} onLosses={() => setTab('losses')} /> : <Spinner size={20} />)}
      {tab === 'analysis' && <Analysis focus={focus} refresh={tick} />}
      {tab === 'losses' && <Losses onOpen={openAnalysis} />}
      {tab === 'anomalies' && <Anomalies canManage={canManage} refresh={tick} onOpen={openAnalysis} />}
      {tab === 'reports' && <LoadReports canManage={canManage} />}
      {tab === 'advanced' && <Advanced onOpen={openAnalysis} />}
      {tab === 'points' && <Points canManage={canManage} overview={ov} onChanged={load} />}
    </div>
  );
}

function Tile({ label, value, sub, tone, onClick }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'red' | 'amber' | 'green'; onClick?: () => void }) {
  const bar = tone === 'red' ? 'bg-red-500' : tone === 'amber' ? 'bg-amber-400' : tone === 'green' ? 'bg-emerald-500' : 'bg-gray-300';
  const body = (
    <>
      <div className={`w-1.5 shrink-0 ${bar}`} />
      <div className="min-w-0 px-3 py-2.5 text-left">
        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
        <div className="mt-0.5 truncate text-xl font-semibold tabular-nums text-gray-900">{value}</div>
        {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
      </div>
    </>
  );
  return onClick ? (
    <button className="card flex overflow-hidden hover:border-gray-400" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="card flex overflow-hidden">{body}</div>
  );
}

function OverviewView({ ov, onOpen, onLosses }: { ov: Overview; onOpen: (level: string, id: string) => void; onLosses: () => void }) {
  const L = useLoadT();
  const { warn, over } = ov.settings;
  const ser = ov.system_series || [];
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayPts = ser.filter((p) => new Date(p.ts).getTime() >= today0).map((p) => ({ t: new Date(p.ts).getTime(), v: p.p }));
  const yPts = ser.filter((p) => new Date(p.ts).getTime() < today0).map((p) => ({ t: new Date(p.ts).getTime() + 86400000, v: p.p }));
  const openCount = Object.values(ov.anomalies || {}).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
  const sevTotals: Record<string, number> = {};
  for (const m of Object.values(ov.anomalies || {})) for (const [k, v] of Object.entries(m)) sevTotals[k] = (sevTotals[k] || 0) + v;
  const bf = ov.simulator?.backfill;
  const lz = ov.losses_yesterday;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Tile
          label={L('points')}
          value={fmtNum(ov.points.active)}
          sub={`${fmtNum(ov.points.trafo_gi)} ${L('trafos').toLowerCase()} · ${fmtNum(ov.points.feeder)} ${L('feeders').toLowerCase()} · ${fmtNum(ov.points.gd)} ${L('gds').toLowerCase()}`}
        />
        <Tile
          label={L('completeness')}
          value={fmtPct(ov.completeness ?? 0)}
          tone={(ov.completeness ?? 0) >= 95 ? 'green' : 'amber'}
          sub={`${fmtNum(ov.points.fresh)} ${L('fresh')} · ${fmtNum(ov.points.stale)} ${L('stale')}`}
        />
        <Tile label={L('peak_today')} value={fmtMW(ov.peak_today?.p, 1)} sub={`${fmtHM(ov.peak_today?.ts)} · ${fmtPct(ov.cap_mw ? ((ov.peak_today?.p || 0) / ov.cap_mw) * 100 : 0)}`} />
        <Tile label={L('peak_yesterday')} value={fmtMW(ov.peak_yesterday?.p, 1)} sub={`${fmtHM(ov.peak_yesterday?.ts)} · ${L('capacity')} ${fmtNum(ov.cap_mw, 0)} MW`} />
        <Tile label={L('energy_yesterday')} value={fmtMWh(ov.energy_yesterday)} sub={`${L('energy_today')}: ${fmtMWh(ov.energy_today)}`} />
        <Tile
          label={L('losses_yesterday')}
          value={lz && lz.dist.e_in > 0 ? <span className={lossClass(lz.dist.pct)}>{fmtPct(lz.dist.pct)}</span> : '-'}
          tone={lz && lz.dist.e_in > 0 ? (lz.dist.pct >= 12 ? 'red' : lz.dist.pct >= 8 ? 'amber' : 'green') : undefined}
          sub={lz ? `${L('ls_e_trafo')} ${fmtPct(lz.gi.pct)} · ${L('ls_feeders_metered', { a: lz.coverage.feeders_metered ?? 0, b: lz.coverage.feeders ?? 0 })}` : ''}
          onClick={onLosses}
        />
        <Tile
          label={L('over_limit', { p: over })}
          value={fmtNum(ov.over_limit)}
          tone={ov.over_limit > 0 ? 'red' : 'green'}
          sub={`${fmtNum(ov.over_warn)} · ${L('over_warn', { p: warn })} · ${L('gd_over', { n: ov.gd_over })}`}
        />
        <Tile label={L('anomalies_open')} value={fmtNum(ov.anomalies_open)} tone={ov.anomalies_open > 0 ? 'amber' : 'green'} sub={`7 hari: ${fmtNum(openCount)}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr,1fr]">
        <LoadChart
          title={L('system_curve')}
          lines={[
            { name: L('yesterday'), points: yPts, color: 'var(--series-2)', dashed: true },
            { name: L('today'), points: todayPts, color: 'var(--series-1)', width: 2.5 },
          ]}
          refs={ov.cap_mw ? [{ value: (ov.cap_mw * warn) / 100, label: L('limit_warn', { p: warn }), color: 'var(--status-warning)' }] : []}
          unit=" MW"
          emptyText={L('no_data')}
        />
        <div className="card p-3">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{L('top_util')}</h3>
          {ov.top.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-500">{L('no_data')}</p>
          ) : (
            <RankList items={ov.top} warn={warn} over={over} onOpen={onOpen} />
          )}
          {ov.top_gd?.length > 0 && (
            <>
              <h3 className="mb-2 mt-3 text-sm font-semibold text-gray-900">{L('top_gd')}</h3>
              <RankList items={ov.top_gd} warn={warn} over={over} onOpen={onOpen} />
            </>
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-500">{L('basis_mw', { pf: fmtNum(ov.settings.cap_pf, 2) })}</p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-3 text-xs">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{L('ingest')}</h3>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
            <dt className="text-gray-500">{L('source')}</dt>
            <dd>
              {ov.simulator_enabled ? L('simulator_on') : L('simulator_off')} · Kafka <code className="rounded bg-gray-100 px-1">{ov.topic}</code> · {L('pt_energy_mode')}{' '}
              <code className="rounded bg-gray-100 px-1">{ov.energy_mode}</code>
            </dd>
            <dt className="text-gray-500">Kafka</dt>
            <dd className="tabular-nums">
              {fmtNum(ov.ingest.messages)} {L('messages')} · {fmtNum(ov.ingest.readings)} {L('readings')} · {fmtNum(ov.ingest.unmapped)} {L('unmapped')}
              {ov.ingest.registered > 0 && ` · ${fmtNum(ov.ingest.registered)} ${L('pt_registered')}`}
              {ov.ingest.last_at && !ov.ingest.last_at.startsWith('0001') && ` · ${L('last_msg')} ${fmtDT(ov.ingest.last_at)}`}
            </dd>
            <dt className="text-gray-500">{L('data_range')}</dt>
            <dd>
              {ov.data_from ? new Date(ov.data_from).toLocaleDateString('id-ID', { dateStyle: 'medium' }) : '-'} – {ov.data_to ? new Date(ov.data_to).toLocaleDateString('id-ID', { dateStyle: 'medium' }) : '-'} · {fmtNum(ov.rows)} {L('readings')}
            </dd>
            {bf && (
              <>
                <dt className="text-gray-500">{L('backfill')}</dt>
                <dd>
                  {bf.phase} {bf.total ? `· ${fmtNum((bf.done / bf.total) * 100, 0)}%` : ''}
                </dd>
              </>
            )}
          </dl>
        </div>
        <div className="card p-3 text-xs">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{L('tab_anomalies')} · 7 hari</h3>
          <div className="mb-2 flex flex-wrap gap-2">
            {(['critical', 'serious', 'warning', 'info'] as const).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <SevBadge sev={s} /> <b className="tabular-nums">{fmtNum(sevTotals[s] || 0)}</b>
              </span>
            ))}
          </div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {Object.entries(ov.anomalies || {})
              .sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))
              .map(([k, m]) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-gray-700">{L(`k_${k}`)}</span>
                  <span className="tabular-nums text-gray-900">{fmtNum(Object.values(m).reduce((x, y) => x + y, 0))}</span>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function RankList({ items, warn, over, onOpen }: { items: RankItem[]; warn: number; over: number; onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  return (
    <ul className="space-y-1.5 text-xs">
      {items.map((r) => (
        <li key={r.point_id}>
          <button className="w-full text-left" onClick={() => onOpen('point', String(r.point_id))}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-gray-900">
                {r.code}{' '}
                <span className="font-normal text-gray-500">{r.kind === 'trafo_gi' ? L('level_trafo_gi') : r.kind === 'gd' ? `${L('level_gd')} · ${r.parent || '-'}` : r.up3}</span>
              </span>
              <span className={`shrink-0 tabular-nums ${utilClass(r.peak_util, warn, over)}`}>
                {fmtMW(r.peak_mw)} · {fmtPct(r.peak_util)} · {fmtHM(r.peak_ts)}
              </span>
            </div>
            <UtilBar v={r.peak_util} warn={warn} over={over} />
          </button>
        </li>
      ))}
    </ul>
  );
}
