'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { fmtNum } from '@/lib/format';
import type { FeatureCollection, ReliabilityGroup } from '@/lib/types';
import { Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useExecT } from './i18n';
import { RAMP_DARK, RAMP_LIGHT, NO_DATA_DARK, NO_DATA_LIGHT, RegionMap } from './RegionMap';
import { TargetBadge, fmtIdx, fmtMin, fmtRp } from './common';
import type { FeederAgg, OutageBrief, RegionRel, Targets } from './types';

type Period = 'today' | 'month' | '30d' | 'year';
type Metric = 'saidi' | 'saifi' | 'ens' | 'outages' | 'off';

interface RegionsResp {
  items: RegionRel[];
  total: ReliabilityGroup;
  targets: Targets;
  customers_served: number;
  pending: number;
  from: string;
  to: string;
}

interface RegionDetail {
  region: RegionRel;
  children: RegionRel[];
  targets: Targets;
  by_kind: Record<string, ReliabilityGroup>;
  top_feeders: FeederAgg[];
  outages: OutageBrief[];
}

function metricOf(r: RegionRel, m: Metric): number {
  switch (m) {
    case 'saidi':
      return r.rel.saidi;
    case 'saifi':
      return r.rel.saifi;
    case 'ens':
      return r.rel.ens_rp;
    case 'outages':
      return r.rel.outages;
    case 'off':
      return r.customers_off;
  }
}

export default function RegionReliability() {
  const e = useExecT();
  const { locale } = useT();
  const { resolved } = useTheme();
  const { has } = useAuth();
  const toast = useToast();
  const dark = resolved === 'dark';
  const [period, setPeriod] = useState<Period>('year');
  const [level, setLevel] = useState<'up3' | 'ulp'>('up3');
  const [metric, setMetric] = useState<Metric>('saidi');
  const [data, setData] = useState<RegionsResp | null>(null);
  const [bnd, setBnd] = useState<FeatureCollection | null>(null);
  const [configs, setConfigs] = useState<Record<string, string> | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<RegionDetail | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('region');
    if (q !== null && q !== '') setSel(Number(q));
    api<{ configs: Record<string, string> }>('/api/config/public')
      .then((r) => setConfigs(r.configs))
      .catch(() => setConfigs({}));
    api<FeatureCollection>('/api/gis/boundaries')
      .then(setBnd)
      .catch((err) => toast.push(err.message, 'error'));
  }, [toast]);

  const load = useCallback(async () => {
    try {
      setData(await api<RegionsResp>(`/api/exec/regions?period=${period}`));
    } catch (err: any) {
      toast.push(err.message, 'error');
    }
  }, [period, toast]);
  useEffect(() => {
    load();
  }, [load, locale]);

  useEffect(() => {
    if (sel === null) {
      setDetail(null);
      return;
    }
    let stop = false;
    setDetail(null);
    api<RegionDetail>(`/api/exec/regions/${sel}?period=${period}`)
      .then((d) => {
        if (stop) return;
        setDetail(d);
        if (d.region.level === 'ulp') setLevel('ulp');
        if (d.region.parent_id) setExpanded((x) => ({ ...x, [d.region.parent_id as number]: true }));
      })
      .catch((err) => !stop && toast.push(err.message, 'error'));
    return () => {
      stop = true;
    };
  }, [sel, period, toast]);

  const byId = useMemo(() => {
    const m: Record<number, RegionRel> = {};
    data?.items.forEach((r) => (m[r.id] = r));
    return m;
  }, [data]);

  // kelas warna: 5 interval sama dari 0 sampai maksimum wilayah pada level aktif
  const { classes, breaks, labels } = useMemo(() => {
    const classes: Record<number, number> = {};
    const labels: Record<number, string> = {};
    const list = (data?.items || []).filter((r) => r.level === level);
    const max = Math.max(0, ...list.filter((r) => r.customers > 0).map((r) => metricOf(r, metric)));
    const breaks = [0, 1, 2, 3, 4, 5].map((i) => (max * i) / 5);
    for (const r of list) {
      const v = metricOf(r, metric);
      if (r.customers <= 0) classes[r.id] = -1;
      else if (max <= 0) classes[r.id] = 0;
      else classes[r.id] = Math.min(4, Math.floor((v / max) * 5));
      labels[r.id] = r.name;
    }
    return { classes, breaks, labels };
  }, [data, level, metric]);

  const fmtMetric = (v: number) => (metric === 'ens' ? fmtRp(v) : metric === 'outages' || metric === 'off' ? fmtNum(v) : fmtIdx(v));
  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const up3s = (data?.items || []).filter((r) => r.level === 'up3').sort((a, b) => metricOf(b, metric) - metricOf(a, metric) || b.customers - a.customers);
  const outside = data?.items.find((r) => r.level === 'outside');
  const tg = data?.targets;
  const hovered = hover !== null ? byId[hover] : null;

  const recompute = async () => {
    setBusy(true);
    try {
      const r = await api<{ outages: number }>('/api/exec/regions/recompute', { method: 'POST' });
      toast.push(e('reg_recomputed', { n: r.outages }), 'success');
      load();
    } catch (err: any) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const periods: [Period, string][] = [
    ['today', e('period_today')],
    ['month', e('period_month')],
    ['30d', e('period_30d')],
    ['year', e('period_year')],
  ];
  const metrics: [Metric, string][] = [
    ['saidi', e('reg_metric_saidi')],
    ['saifi', e('reg_metric_saifi')],
    ['ens', e('reg_metric_ens')],
    ['outages', e('reg_metric_outages')],
    ['off', e('reg_metric_off')],
  ];

  const row = (r: RegionRel, child = false) => {
    const above = tg && r.customers > 0 && r.rel.saidi > tg.saidi_period;
    return (
      <tr
        key={r.id}
        className={`cursor-pointer border-t border-gray-100 ${sel === r.id ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
        onClick={() => setSel(r.id)}
        onMouseEnter={() => setHover(r.id)}
        onMouseLeave={() => setHover(null)}
      >
        <td className={`py-1 pr-1 ${child ? 'pl-6' : 'pl-1'}`}>
          <div className="flex items-center gap-1">
            {!child && r.level === 'up3' && (
              <button
                className="rounded p-0.5 text-gray-500 hover:bg-gray-100"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setExpanded((x) => ({ ...x, [r.id]: !x[r.id] }));
                }}
                aria-label="expand"
              >
                <Icon name={expanded[r.id] ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
            )}
            <span className={child ? 'text-gray-700' : 'font-semibold text-gray-900'}>{r.level === 'outside' ? e('rep_outside') : r.name}</span>
            {r.active > 0 && <span className="rounded bg-red-50 px-1 text-[10px] text-red-700">{r.active}</span>}
          </div>
        </td>
        <td className="py-1 text-right tabular-nums text-gray-600">{fmtNum(r.customers)}</td>
        <td className={`py-1 text-right tabular-nums ${above ? 'font-semibold text-red-600' : ''}`}>{r.customers > 0 ? fmtIdx(r.rel.saidi) : '–'}</td>
        <td className="py-1 text-right tabular-nums">{r.customers > 0 ? fmtIdx(r.rel.saifi) : '–'}</td>
        <td className="py-1 text-right tabular-nums">{fmtNum(r.rel.outages)}</td>
        <td className="py-1 pr-1 text-right tabular-nums">{fmtRp(r.rel.ens_rp)}</td>
      </tr>
    );
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="relative h-[42%] min-h-[220px] shrink-0 lg:h-auto lg:flex-1">
        {configs && <RegionMap configs={configs} dark={dark} data={bnd} level={level} classes={classes} labels={labels} selected={sel} onSelect={setSel} onHover={setHover} />}
        {/* kontrol peta */}
        <div className="absolute left-3 top-3 z-10 space-y-2">
          <div className="card flex flex-wrap items-center gap-1 p-1 text-xs shadow">
            {(['up3', 'ulp'] as const).map((l) => (
              <button key={l} className={`rounded px-2 py-0.5 font-medium ${level === l ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setLevel(l)}>
                {l === 'up3' ? e('reg_level_up3') : e('reg_level_ulp')}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-gray-200" />
            <select className="rounded border-0 bg-transparent py-0 text-xs text-gray-800" value={metric} onChange={(ev) => setMetric(ev.target.value as Metric)} aria-label={e('reg_metric')}>
              {metrics.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {/* legenda */}
          <div className="card p-2 text-[10px] text-gray-600 shadow">
            <div className="mb-1 font-semibold text-gray-700">{metrics.find((m) => m[0] === metric)?.[1]}</div>
            {ramp.map((c, i) => (
              <div key={c} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: c }} />
                <span className="tabular-nums">
                  {fmtMetric(breaks[i])} – {fmtMetric(breaks[i + 1])}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: dark ? NO_DATA_DARK : NO_DATA_LIGHT }} />
              {e('reg_legend_none')}
            </div>
          </div>
        </div>
        {hovered && (
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 card px-2 py-1 text-xs shadow">
            <div className="font-semibold text-gray-900">
              {hovered.level.toUpperCase()} {hovered.name}
              {hovered.level === 'ulp' && <span className="font-normal text-gray-500"> · UP3 {hovered.parent}</span>}
            </div>
            <div className="text-gray-600">
              {fmtNum(hovered.customers)} {e('reg_customers').toLowerCase()} · SAIDI {fmtIdx(hovered.rel.saidi)} · SAIFI {fmtIdx(hovered.rel.saifi)} · {fmtNum(hovered.rel.outages)} {e('events').toLowerCase()}
            </div>
          </div>
        )}
      </div>

      <aside className="flex min-h-0 w-full flex-1 flex-col border-gray-200 bg-white lg:w-[460px] lg:flex-none lg:border-l">
        <div className="border-b border-gray-200 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold text-gray-900">{e('reg_title')}</h1>
              <p className="text-[11px] text-gray-500">{e('reg_subtitle')}</p>
            </div>
            {has('exec.report') && (
              <Button size="sm" variant="ghost" icon="refresh" loading={busy} onClick={recompute} title={e('reg_recompute')}>
                {data?.pending ? e('reg_recompute') : ''}
              </Button>
            )}
          </div>
          <div className="mt-2 flex rounded-md border border-gray-300 p-0.5 text-xs">
            {periods.map(([k, l]) => (
              <button key={k} className={`flex-1 rounded px-2 py-0.5 ${period === k ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setPeriod(k)}>
                {l}
              </button>
            ))}
          </div>
          {data && tg && (
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] uppercase text-gray-500">SAIDI</div>
                <div className="font-semibold tabular-nums text-gray-900">{fmtIdx(data.total.saidi)}</div>
                <div className="text-[10px] text-gray-500">
                  {e('target_pro')} {fmtIdx(tg.saidi_period)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-gray-500">SAIFI</div>
                <div className="font-semibold tabular-nums text-gray-900">{fmtIdx(data.total.saifi)}</div>
                <div className="text-[10px] text-gray-500">
                  {e('target_pro')} {fmtIdx(tg.saifi_period)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-gray-500">ENS</div>
                <div className="font-semibold tabular-nums text-gray-900">{fmtRp(data.total.ens_rp)}</div>
                <div className="text-[10px] text-gray-500">
                  {fmtNum(data.total.outages)} {e('events').toLowerCase()}
                </div>
              </div>
            </div>
          )}
          {data && data.pending > 0 && <div className="mt-1 text-[11px] text-amber-700">{e('reg_pending', { n: data.pending })}</div>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {detail ? (
            <RegionDetailView d={detail} onClose={() => setSel(null)} onSelect={setSel} />
          ) : sel !== null ? (
            <div className="py-6 text-center">
              <Spinner size={18} />
            </div>
          ) : !data ? (
            <div className="py-6 text-center">
              <Spinner size={18} />
            </div>
          ) : (
            <div className="p-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500">
                    <th className="pb-1 pl-1 font-medium">{e('region')}</th>
                    <th className="pb-1 text-right font-medium">{e('reg_customers')}</th>
                    <th className="pb-1 text-right font-medium">SAIDI</th>
                    <th className="pb-1 text-right font-medium">SAIFI</th>
                    <th className="pb-1 text-right font-medium">{e('events')}</th>
                    <th className="pb-1 pr-1 text-right font-medium">ENS</th>
                  </tr>
                </thead>
                <tbody>
                  {up3s.map((u) => [row(u), ...(expanded[u.id] ? data.items.filter((c) => c.parent_id === u.id).map((c) => row(c, true)) : [])])}
                  {outside && row(outside)}
                </tbody>
              </table>
              <p className="mt-2 px-1 text-[10px] text-gray-500">{e('reg_outside_note')}</p>
              {tg && (
                <p className="mt-1 px-1 text-[10px] text-gray-500">
                  <span className="font-semibold text-red-600">SAIDI</span> = {e('reg_above_target')} ({fmtIdx(tg.saidi_period)} {e('unit_saidi')}).
                </p>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function RegionDetailView({ d, onClose, onSelect }: { d: RegionDetail; onClose: () => void; onSelect: (id: number) => void }) {
  const e = useExecT();
  const { locale } = useT();
  const r = d.region;
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const kinds = Object.entries(d.by_kind).sort((a, b) => b[1].customer_minutes - a[1].customer_minutes);
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">{r.level === 'outside' ? '' : r.level.toUpperCase()}</div>
          <div className="text-base font-semibold text-gray-900">{r.level === 'outside' ? e('rep_outside') : r.name}</div>
          {r.level === 'ulp' && (
            <button className="text-[11px] text-brand-700 hover:underline" onClick={() => r.parent_id && onSelect(r.parent_id)}>
              UP3 {r.parent}
            </button>
          )}
        </div>
        <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
          {e('reg_close')}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['SAIDI', fmtIdx(r.rel.saidi), <TargetBadge key="a" value={r.rel.saidi} target={r.customers > 0 ? d.targets.saidi_period : 0} />],
            ['SAIFI', fmtIdx(r.rel.saifi), <TargetBadge key="b" value={r.rel.saifi} target={r.customers > 0 ? d.targets.saifi_period : 0} />],
            ['ENS', fmtRp(r.rel.ens_rp), `${fmtNum(r.rel.ens_kwh, 1)} kWh`],
            [e('events'), fmtNum(r.rel.outages), `${fmtNum(r.rel.momentary)} ${e('momentary')}`],
            [e('reg_customers'), fmtNum(r.customers), r.area_km2 ? `${fmtNum(r.area_km2, 1)} km²` : ''],
            [e('reg_off_now'), fmtNum(r.customers_off), r.active ? `${r.active} ${e('reg_active')}` : ''],
          ] as [string, string, React.ReactNode][]
        ).map(([k, v, s]) => (
          <div key={k} className="rounded-md border border-gray-200 px-2 py-1.5">
            <div className="text-[10px] uppercase text-gray-500">{k}</div>
            <div className="text-lg font-semibold tabular-nums text-gray-900">{v}</div>
            <div className="text-[10px] text-gray-500">{s}</div>
          </div>
        ))}
      </div>
      {r.customers === 0 && <p className="text-[11px] text-gray-500">{e('reg_no_customers')}</p>}

      {d.children.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('reg_children')}</div>
          <ul className="space-y-0.5">
            {d.children.map((c) => (
              <li key={c.id}>
                <button className="flex w-full items-center justify-between rounded px-1 py-0.5 hover:bg-gray-50" onClick={() => onSelect(c.id)}>
                  <span className="text-gray-800">{c.name}</span>
                  <span className="tabular-nums text-gray-600">
                    {fmtNum(c.customers)} plg · SAIDI {fmtIdx(c.rel.saidi)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {kinds.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('by_kind')}</div>
          <ul className="space-y-0.5">
            {kinds.map(([k, g]) => (
              <li key={k} className="flex justify-between">
                <span className="text-gray-800">{k}</span>
                <span className="tabular-nums text-gray-600">
                  {fmtNum(g.outages)} × · SAIDI {fmtIdx(g.saidi)} · {fmtRp(g.ens_rp)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.top_feeders.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('top_feeders')}</div>
          <ul className="space-y-0.5">
            {d.top_feeders.map((f) => (
              <li key={f.id} className="flex justify-between">
                <a className="font-medium text-brand-700 hover:underline" href={`/sld?focus=node:${f.id}`}>
                  {f.code}
                </a>
                <span className="tabular-nums text-gray-600">
                  {fmtNum(f.outages)} × ({fmtNum(f.faults)} {e('faults').toLowerCase()}) · {fmtNum(f.customer_minutes, 0)} {e('cust_min').toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('reg_outages')}</div>
        <div className="mb-1 text-[10px] text-gray-500">{e('reg_share_note')}</div>
        {d.outages.length === 0 ? (
          <p className="text-gray-500">{e('no_data')}</p>
        ) : (
          <ul className="space-y-1">
            {d.outages.map((o) => (
              <li key={o.id} className="rounded border border-gray-200 px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">#{o.id}</span>
                  <span className="font-medium text-gray-900">{o.cause_code}</span>
                  <span className="text-[10px] text-gray-500">{o.kind}</span>
                  {!o.ended_at && <span className="rounded bg-red-50 px-1 text-[10px] text-red-700">{e('ai_active')}</span>}
                  <span className="ml-auto tabular-nums text-gray-600">{fmtNum(o.customers)} plg</span>
                </div>
                <div className="text-[10px] text-gray-500">
                  {new Date(o.started_at).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' })} · {fmtMin(o.duration_min)} · {fmtNum(o.customer_minutes, 0)} {e('cust_min').toLowerCase()}
                  {o.momentary ? ` · ${e('momentary')}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
