'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { MetricSample } from '@/lib/types';
import { Badge, Button, PageHeader, StatCard, useToast } from '@/components/ui';
import { LineChart } from '@/components/charts/LineChart';
import { fmtBytesMB, fmtDate, fmtDuration, fmtNum } from '@/lib/format';

export default function MonitoringPage() {
  const { t } = useT();
  const toast = useToast();
  const [summary, setSummary] = useState<any>(null);
  const [series, setSeries] = useState<MetricSample[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [stream, setStream] = useState<any>(null);
  const [minutes, setMinutes] = useState(60);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, se, a, st] = await Promise.all([
        api('/api/admin/monitoring/summary'),
        api<{ items: MetricSample[] }>(`/api/admin/monitoring/series?minutes=${minutes}`),
        api<{ items: any[] }>('/api/admin/monitoring/audit?limit=30'),
        api('/api/admin/monitoring/stream?limit=20'),
      ]);
      setSummary(s);
      setSeries(se.items);
      setAudit(a.items);
      setStream(st);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [minutes, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const s: MetricSample | undefined = summary?.sample;
  const labels = series.map((x) => x.time);
  const ok = (v: boolean | undefined) => (v ? <Badge tone="green">{t('mon.ok')}</Badge> : <Badge tone="red">{t('mon.failed')}</Badge>);
  const empty = t('common.no_data');

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t('mon.title')}
        subtitle={summary ? t('mon.subtitle', { uptime: fmtDuration(summary.uptime_sec), go: summary.go_version, cpu: summary.num_cpu }) : t('common.loading')}
        actions={
          <>
            <select className="input w-36" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              <option value={30}>{t('mon.range_30m')}</option>
              <option value={60}>{t('mon.range_1h')}</option>
              <option value={360}>{t('mon.range_6h')}</option>
              <option value={1440}>{t('mon.range_24h')}</option>
              <option value={10080}>{t('mon.range_7d')}</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t('mon.auto')}
            </label>
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.refresh')}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t('mon.cpu')} value={`${fmtNum(s?.cpu_percent, 1)}%`} tone={(s?.cpu_percent || 0) > 80 ? 'red' : 'blue'} />
        <StatCard label={t('mon.memory')} value={fmtBytesMB(s?.mem_used_mb || 0)} sub={t('mon.of', { total: fmtBytesMB(s?.mem_total_mb || 0) })} tone="blue" />
        <StatCard label={t('mon.heap')} value={fmtBytesMB(s?.heap_mb || 0)} sub={t('mon.goroutines', { n: fmtNum(s?.goroutines) })} tone="gray" />
        <StatCard label="PostgreSQL" value={ok(s?.db_ok)} sub={t('mon.connections', { total: s?.db_conns_total ?? 0, idle: s?.db_conns_idle ?? 0 })} tone={s?.db_ok ? 'green' : 'red'} />
        <StatCard label="Redis" value={ok(s?.redis_ok)} sub={t('mon.latency', { ms: fmtNum(s?.redis_latency_ms, 2) })} tone={s?.redis_ok ? 'green' : 'red'} />
        <StatCard label="Kafka" value={summary?.kafka_enabled ? ok(s?.kafka_ok) : <Badge>{t('mon.disabled')}</Badge>} sub={t('mon.ws_clients', { n: s?.ws_clients ?? 0 })} tone={s?.kafka_ok ? 'green' : 'amber'} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <LineChart title={t('mon.chart_cpu')} labels={labels} series={[{ name: t('mon.cpu'), values: series.map((x) => x.cpu_percent) }]} unit="%" max={100} emptyText={empty} />
        <LineChart
          title={t('mon.chart_mem')}
          labels={labels}
          series={[
            { name: t('mon.mem_sys'), values: series.map((x) => x.mem_used_mb) },
            { name: t('mon.mem_heap'), values: series.map((x) => x.heap_mb) },
          ]}
          unit=" MB"
          format={(v) => fmtNum(v, 0)}
          emptyText={empty}
        />
        <LineChart title={t('mon.chart_http')} labels={labels} series={[{ name: t('mon.http_requests'), values: series.map((x) => x.http_requests) }]} format={(v) => fmtNum(v, 0)} emptyText={empty} />
        <LineChart title={t('mon.chart_latency')} labels={labels} series={[{ name: t('mon.latency_series'), values: series.map((x) => x.http_avg_ms) }]} unit=" ms" format={(v) => fmtNum(v, 1)} emptyText={empty} />
        <LineChart
          title={t('mon.chart_db')}
          labels={labels}
          series={[
            { name: t('mon.db_total'), values: series.map((x) => x.db_conns_total) },
            { name: t('mon.db_idle'), values: series.map((x) => x.db_conns_idle) },
          ]}
          format={(v) => fmtNum(v, 0)}
          emptyText={empty}
        />
        <LineChart title={t('mon.chart_ws')} labels={labels} series={[{ name: t('mon.ws_series'), values: series.map((x) => x.ws_clients) }]} format={(v) => fmtNum(v, 0)} emptyText={empty} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{t('mon.database')}</h3>
          {summary?.database ? (
            <>
              <dl className="grid grid-cols-3 gap-y-1 text-xs text-gray-800">
                <dt className="text-gray-500">{t('mon.size')}</dt>
                <dd className="col-span-2">{summary.database.database_size}</dd>
                <dt className="text-gray-500">{t('mon.extensions')}</dt>
                <dd className="col-span-2 font-mono">{JSON.stringify(summary.database.extensions)}</dd>
                <dt className="text-gray-500">{t('mon.active_queries')}</dt>
                <dd className="col-span-2">{summary.database.active_queries}</dd>
                <dt className="text-gray-500">{t('mon.version')}</dt>
                <dd className="col-span-2 truncate" title={summary.database.version}>
                  {summary.database.version}
                </dd>
              </dl>
              <table className="mt-2 w-full text-xs text-gray-800">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1">{t('mon.table')}</th>
                    <th className="py-1 text-right">{t('mon.rows_est')}</th>
                    <th className="py-1 text-right">{t('mon.size')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.database.tables?.map((x: any) => (
                    <tr key={x.table} className="border-t border-gray-100">
                      <td className="py-1 font-mono">{x.table}</td>
                      <td className="py-1 text-right tabular-nums">{fmtNum(x.rows)}</td>
                      <td className="py-1 text-right">{x.size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="text-xs text-gray-500">-</div>
          )}
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{t('mon.graph_tiles')}</h3>
          {summary?.graph && (
            <dl className="grid grid-cols-3 gap-y-1 text-xs text-gray-800">
              <dt className="text-gray-500">{t('mon.nodes_edges')}</dt>
              <dd className="col-span-2">
                {fmtNum(summary.graph.nodes)} / {fmtNum(summary.graph.edges)}
              </dd>
              <dt className="text-gray-500">{t('mon.sources')}</dt>
              <dd className="col-span-2">{fmtNum(summary.graph.sources)}</dd>
              <dt className="text-gray-500">{t('mon.unreachable')}</dt>
              <dd className="col-span-2">{fmtNum(summary.graph.unreachable)}</dd>
              <dt className="text-gray-500">{t('mon.loaded_at')}</dt>
              <dd className="col-span-2">{fmtDate(summary.graph.built_at)}</dd>
              <dt className="text-gray-500">{t('mon.dist_at')}</dt>
              <dd className="col-span-2">{fmtDate(summary.graph.dist_at)}</dd>
              <dt className="text-gray-500">{t('mon.tile_version')}</dt>
              <dd className="col-span-2">{summary.tile_version}</dd>
              <dt className="text-gray-500">Redis</dt>
              <dd className="col-span-2">{summary.redis_available ? t('mon.redis_available') : t('mon.redis_unavailable')}</dd>
              {summary.disk && (
                <>
                  <dt className="text-gray-500">{t('mon.disk')}</dt>
                  <dd className="col-span-2">
                    {fmtNum(summary.disk.used_gb, 1)} / {fmtNum(summary.disk.total_gb, 1)} GB ({fmtNum(summary.disk.percent, 0)}%)
                  </dd>
                </>
              )}
            </dl>
          )}
          <h3 className="mb-2 mt-4 text-sm font-semibold text-gray-900">
            {t('mon.stream_title')} {stream && (stream.enabled ? (stream.healthy ? <Badge tone="green">{t('mon.healthy')}</Badge> : <Badge tone="amber">{t('mon.no_delivery')}</Badge>) : <Badge>{t('mon.disabled')}</Badge>)}
          </h3>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-gray-800">
            {stream?.items?.length === 0 && <li className="text-gray-500">{t('mon.no_events')}</li>}
            {stream?.items?.map((e: any, i: number) => (
              <li key={i} className="truncate">
                <span className="text-gray-500">{fmtDate(e.time)}</span> <span className="font-mono">{e.key}</span> {e.payload?.type} #{e.payload?.id} {e.payload?.username}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800">{t('mon.audit_title')}</div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">{t('mon.time')}</th>
              <th className="th">{t('mon.user')}</th>
              <th className="th">{t('mon.action')}</th>
              <th className="th">{t('mon.entity')}</th>
              <th className="th">{t('mon.detail')}</th>
              <th className="th">{t('mon.ip')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {audit.map((a, i) => (
              <tr key={i}>
                <td className="td text-xs text-gray-500">{fmtDate(a.time)}</td>
                <td className="td">{a.username || '-'}</td>
                <td className="td font-mono text-xs">{a.action}</td>
                <td className="td text-xs">
                  {a.entity} {a.entity_id}
                </td>
                <td className="td max-w-xs truncate font-mono text-[11px] text-gray-500" title={JSON.stringify(a.detail)}>
                  {JSON.stringify(a.detail)}
                </td>
                <td className="td text-xs text-gray-500">{a.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
