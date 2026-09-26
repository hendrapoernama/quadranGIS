'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { bboxOf } from '@/lib/geo';
import { fmtDate, fmtNum } from '@/lib/format';
import type { ComponentType, FeatureCollection, GeoFeature } from '@/lib/types';
import { Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import MapCanvas from '@/components/map/MapCanvas';
import { SearchBox } from '@/components/map/SearchBox';
import type { BasemapKind, MapHandle } from '@/components/map/types';

// Palet status (tetap, tidak mengikuti tema); selalu disertai label teks.
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#9ca3af' };
type Level = keyof typeof STATUS;

interface Params {
  source_pu: number;
  load_factor: number;
  power_factor: number;
  v_min_pu: number;
  v_max_pu: number;
}

interface Summary {
  head_id: number;
  code: string;
  name: string;
  gi_code: string;
  status: 'ok' | 'warning' | 'critical' | 'error';
  error?: string;
  nodes: number;
  customers: number;
  load_kw: number;
  load_kvar: number;
  send_kw: number;
  send_kvar: number;
  head_current_a: number;
  loss_kw: number;
  loss_pct: number;
  v_min_pu: number;
  v_min_node: number;
  v_min_mv_pu: number;
  v_max_pu: number;
  i_max_pct: number;
  i_max_edge: number;
  trafo_max_pct: number;
  trafo_max_node: number;
  under_v: number;
  over_v: number;
  overload: number;
  trafo_overload: number;
  iterations: number;
  converged: boolean;
  mesh_skipped: number;
  duration_ms: number;
}

interface Trafo {
  id: number;
  rated_kva: number;
  s_kva: number;
  loading_pct: number;
  v_sec_pu: number;
  loss_kw: number;
  assumed: boolean;
}

interface FeederResult {
  summary: Summary;
  trafos: Trafo[] | null;
  worst_nodes: { id: number; v_pu: number; v_kv: number; lv: boolean }[];
  worst_edges: { id: number; i_a: number; ampacity: number; loading_pct: number }[];
  params: Params;
  geojson: FeatureCollection;
}

interface Results {
  items: Summary[];
  total: number;
  has_run: boolean;
  at?: string;
  duration_ms?: number;
  params: Params;
  stats?: { feeders: number; by_status: Record<string, number>; load_kw: number; loss_kw: number; send_kw: number; loss_pct?: number; v_min_pu: number };
}

const noop = async () => {};

function loadingLevel(pct: number, ampacity = 1): Level {
  if (!ampacity) return 'neutral';
  if (pct > 100) return 'critical';
  if (pct >= 80) return 'serious';
  if (pct >= 60) return 'warning';
  return 'good';
}

function voltageLevel(v: number, p: Params): Level {
  if (v < p.v_min_pu || v > p.v_max_pu) return 'critical';
  if (v < p.v_min_pu + 0.025) return 'serious';
  if (v < p.v_min_pu + 0.05) return 'warning';
  return 'good';
}

export default function PowerFlow() {
  const { t } = useT();
  const { resolved } = useTheme();
  const toast = useToast();
  const mapRef = useRef<MapHandle>(null);
  const basemap: BasemapKind = resolved === 'dark' ? 'dark' : 'light';

  const [types, setTypes] = useState<ComponentType[]>([]);
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [tileVersion, setTileVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [params, setParams] = useState<Params | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<'all' | 'critical' | 'warning' | 'ok'>('all');
  const [sort, setSort] = useState<'severity' | 'v_min' | 'loading' | 'loss'>('severity');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [tab, setTab] = useState<'feeders' | 'detail'>('feeders');
  const [detail, setDetail] = useState<FeederResult | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [colorBy, setColorBy] = useState<'loading' | 'voltage'>('loading');
  const [picked, setPicked] = useState<GeoFeature | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const typeName = useCallback((c: string) => types.find((x) => x.code === c)?.name || c, [types]);

  useEffect(() => {
    Promise.all([
      api<{ configs: Record<string, string>; types: ComponentType[]; tile_version: number }>('/api/config/public'),
      api<{ params: Params }>('/api/powerflow/params'),
    ])
      .then(([cfg, pp]) => {
        setTypes(cfg.types);
        setConfigs(cfg.configs);
        setTileVersion(cfg.tile_version);
        setParams(pp.params);
        setLoaded(true);
      })
      .catch((e) => toast.push(e.message, 'error'));
  }, [toast]);

  useEffect(() => {
    const tm = setTimeout(() => setQd(q.trim()), 300);
    return () => clearTimeout(tm);
  }, [q]);

  const loadResults = useCallback(async () => {
    try {
      setResults(await api<Results>(`/api/powerflow/results?status=${status}&sort=${sort}&q=${encodeURIComponent(qd)}&limit=300`));
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [status, sort, qd, toast]);

  useEffect(() => {
    if (loaded) loadResults();
  }, [loaded, loadResults]);

  useEffect(() => {
    mapRef.current?.setBasemap(basemap);
    mapRef.current?.setDarkLabels(basemap === 'dark');
  }, [basemap]);

  const scenario = () => (params ? { source_pu: params.source_pu, load_factor: params.load_factor, power_factor: params.power_factor } : {});

  async function runAll() {
    setRunning(true);
    try {
      const r = await api<Results>('/api/powerflow/run-all', { method: 'POST', body: scenario() });
      toast.push(t('pf.run_all_done', { n: fmtNum(r.stats?.feeders ?? 0), s: ((r.duration_ms ?? 0) / 1000).toFixed(1) }), 'success');
      await loadResults();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  // pewarnaan overlay dihitung di klien dari nilai hasil hitung
  const colored = useMemo<FeatureCollection | null>(() => {
    if (!detail) return null;
    const p = detail.params;
    return {
      type: 'FeatureCollection',
      features: detail.geojson.features.map((f) => {
        const pr = f.properties;
        let color: string | undefined;
        let big = false;
        if (pr.kind === 'edge') {
          color = STATUS[colorBy === 'loading' ? loadingLevel(pr.loading_pct, pr.ampacity) : voltageLevel(pr.v_pu, p)];
        } else if (pr.trafo_loading_pct !== undefined) {
          big = true;
          color = STATUS[colorBy === 'loading' ? loadingLevel(pr.trafo_loading_pct) : voltageLevel(pr.v_sec_pu ?? pr.v_pu, p)];
        } else if (colorBy === 'voltage') {
          color = STATUS[voltageLevel(pr.v_pu, p)];
        }
        return { ...f, properties: { ...pr, ...(color ? { color } : {}), big } };
      }),
    };
  }, [detail, colorBy]);

  useEffect(() => {
    mapRef.current?.setOverlay(colored);
  }, [colored]);

  const featureById = useCallback((kind: string, id: number) => detail?.geojson.features.find((f) => f.id === id && f.properties.kind === kind) || null, [detail]);

  const flyTo = (kind: 'node' | 'edge', id: number) => {
    const f = featureById(kind, id);
    const b = f ? bboxOf([f]) : null;
    if (b) mapRef.current?.fitBBox(b);
    if (f) setPicked(f);
  };

  async function openFeeder(headId: number, keepView = false) {
    setDetailBusy(true);
    setTab('detail');
    try {
      const r = await api<FeederResult>('/api/powerflow/feeder', { method: 'POST', body: { head_id: headId, ...scenario() } });
      setDetail(r);
      setPicked(null);
      if (!keepView) {
        const b = bboxOf(r.geojson);
        if (b) mapRef.current?.fitBBox(b);
      }
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setDetailBusy(false);
    }
  }

  const code = (kind: 'node' | 'edge', id: number) => featureById(kind, id)?.properties.code || `#${id}`;

  const statusLabel = (s: string) => (s === 'ok' ? t('pf.status_ok') : s === 'warning' ? t('pf.status_warning') : s === 'critical' ? t('pf.status_critical') : t('pf.status_error'));
  const statusChip = (s: string) => {
    const lv: Level = s === 'ok' ? 'good' : s === 'warning' ? 'warning' : s === 'critical' ? 'critical' : 'neutral';
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-700">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS[lv] }} />
        {statusLabel(s)}
      </span>
    );
  };
  const levelDot = (lv: Level) => <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: STATUS[lv] }} />;

  const legend =
    colorBy === 'loading'
      ? [
          ['good', t('pf.leg_load_good')],
          ['warning', t('pf.leg_load_warning')],
          ['serious', t('pf.leg_load_serious')],
          ['critical', t('pf.leg_load_critical')],
        ]
      : [
          ['good', t('pf.leg_v_good')],
          ['warning', t('pf.leg_v_warning')],
          ['serious', t('pf.leg_v_serious')],
          ['critical', t('pf.leg_v_critical')],
        ];

  if (!loaded || !params)
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Spinner size={28} />
      </div>
    );

  const st = results?.stats;
  const s = detail?.summary;
  const num = (v: number, d = 2) => fmtNum(v, d);

  return (
    <div className="relative h-full w-full">
      <MapCanvas
        ref={mapRef}
        types={types}
        configs={configs}
        initialVersion={tileVersion}
        initialBasemap={basemap}
        mode={{ kind: 'select' }}
        onSelect={(kind, id) => {
          const f = featureById(kind, id);
          if (f) setPicked(f);
        }}
        onCreatePoint={noop}
        onCreatePolygon={noop}
        onCreateLine={noop}
        onMove={noop}
        onReshape={noop}
        onReshapePolygon={noop}
        onSplit={noop}
        onVertexCommit={noop}
        onMeasure={() => {}}
        onCursor={() => {}}
        onCancelMode={() => {}}
        onReady={() => {
          mapRef.current?.setVisibleTypes(types.map((x) => x.code));
          mapRef.current?.setBasemap(basemap);
          mapRef.current?.setDarkLabels(basemap === 'dark');
          mapRef.current?.setOverlay(colored);
        }}
        onError={(src, msg) => toast.push(t('map.source_error', { source: src || '-', msg: msg.slice(0, 120) }), 'warning')}
      />

      {/* kiri atas: judul, pencarian penyulang, legenda */}
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-2">
        <div className="rounded-lg border border-gray-200 bg-white/95 px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Icon name="bolt" size={16} /> {t('pf.title')}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500">{t('pf.subtitle')}</div>
        </div>
        <SearchBox
          typeName={typeName}
          onPick={(h) => {
            mapRef.current?.flyTo(h.lng, h.lat, 16);
            if (h.type_code === 'kubikel_20kv') openFeeder(h.id);
          }}
        />
        {detail && (
          <div className="w-fit rounded-lg border border-gray-200 bg-white/95 p-2 text-xs text-gray-700 shadow-lg">
            <div className="mb-1 flex overflow-hidden rounded-md border border-gray-300" role="group">
              {(['loading', 'voltage'] as const).map((m) => (
                <button key={m} className={`px-2.5 py-1 ${colorBy === m ? 'bg-brand-600 text-white' : 'hover:bg-gray-100'}`} onClick={() => setColorBy(m)}>
                  {m === 'loading' ? t('pf.color_loading') : t('pf.color_voltage')}
                </button>
              ))}
            </div>
            <ul className="space-y-0.5">
              {legend.map(([lv, label]) => (
                <li key={lv} className="flex items-center gap-1.5">
                  <span className="inline-block h-1.5 w-5 rounded" style={{ background: STATUS[lv as Level] }} />
                  {label}
                </li>
              ))}
            </ul>
            <div className="mt-1 text-[10px] text-gray-500">{colorBy === 'loading' ? t('pf.leg_load_note') : t('pf.leg_v_note', { min: params.v_min_pu, max: params.v_max_pu })}</div>
          </div>
        )}
      </div>

      {/* objek terpilih di overlay */}
      {picked && (
        <div className="absolute bottom-10 left-3 z-10 w-72 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-800 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900">{typeName(picked.properties.type_code)}</span>
            <button className="text-gray-500 hover:text-gray-800" onClick={() => setPicked(null)} aria-label={t('common.close')}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="mb-1 font-mono text-[11px] text-gray-500">{picked.properties.code || `#${picked.id}`}</div>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
            {picked.properties.kind === 'edge' ? (
              <>
                <dt className="text-gray-500">{t('pf.current')}</dt>
                <dd>
                  {num(picked.properties.i_a, 1)} A{picked.properties.ampacity ? ` / ${picked.properties.ampacity} A` : ''}
                </dd>
                <dt className="text-gray-500">{t('pf.loading')}</dt>
                <dd>
                  {levelDot(loadingLevel(picked.properties.loading_pct, picked.properties.ampacity))}
                  {picked.properties.ampacity ? `${num(picked.properties.loading_pct, 1)}%` : '-'}
                </dd>
                <dt className="text-gray-500">{t('pf.loss')}</dt>
                <dd>{num(picked.properties.loss_kw, 3)} kW</dd>
                <dt className="text-gray-500">{t('pf.v_end')}</dt>
                <dd>{num(picked.properties.v_pu, 4)} pu</dd>
              </>
            ) : (
              <>
                <dt className="text-gray-500">{t('pf.voltage')}</dt>
                <dd>
                  {levelDot(voltageLevel(picked.properties.v_pu, detail!.params))}
                  {num(picked.properties.v_pu, 4)} pu · {picked.properties.lv ? `${num(picked.properties.v_kv * 1000, 1)} V` : `${num(picked.properties.v_kv, 3)} kV`}
                </dd>
                {picked.properties.trafo_loading_pct !== undefined && (
                  <>
                    <dt className="text-gray-500">{t('pf.trafo')}</dt>
                    <dd>
                      {levelDot(loadingLevel(picked.properties.trafo_loading_pct))}
                      {num(picked.properties.trafo_s_kva, 1)} / {num(picked.properties.trafo_kva, 0)} kVA ({num(picked.properties.trafo_loading_pct, 1)}%)
                    </dd>
                    <dt className="text-gray-500">{t('pf.v_secondary')}</dt>
                    <dd>{num(picked.properties.v_sec_pu, 4)} pu</dd>
                  </>
                )}
              </>
            )}
          </dl>
        </div>
      )}

      {/* panel kanan */}
      <div className={`absolute right-3 top-3 z-10 mr-11 flex max-h-[calc(100%-4.5rem)] flex-col rounded-lg border border-gray-200 bg-white shadow-xl transition-all ${panelOpen ? 'w-[27rem]' : 'w-10'}`}>
        <div className="flex items-center border-b border-gray-200">
          {panelOpen && (
            <>
              {(['feeders', 'detail'] as const).map((tb) => (
                <button
                  key={tb}
                  className={`flex-1 whitespace-nowrap border-b-2 px-2 py-2 text-xs font-medium ${tab === tb ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
                  onClick={() => setTab(tb)}
                >
                  {tb === 'feeders' ? t('pf.tab_feeders') : s ? `${t('pf.tab_detail')} · ${s.code}` : t('pf.tab_detail')}
                </button>
              ))}
            </>
          )}
          <button className="p-2 text-gray-500 hover:text-gray-800" onClick={() => setPanelOpen(!panelOpen)} aria-label={t('map.collapse_panel')}>
            <Icon name={panelOpen ? 'chevron-right' : 'bolt'} size={16} />
          </button>
        </div>
        {panelOpen && (
          <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
            {/* skenario */}
            <div className="rounded-md border border-gray-200 p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('pf.scenario')}</div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-[11px] text-gray-500">
                  {t('pf.load_factor')}
                  <input className="input mt-0.5" type="number" step="0.05" min="0.05" max="2" value={params.load_factor} onChange={(e) => setParams({ ...params, load_factor: Number(e.target.value) })} />
                </label>
                <label className="text-[11px] text-gray-500">
                  cos φ
                  <input className="input mt-0.5" type="number" step="0.01" min="0.5" max="1" value={params.power_factor} onChange={(e) => setParams({ ...params, power_factor: Number(e.target.value) })} />
                </label>
                <label className="text-[11px] text-gray-500">
                  {t('pf.source_pu')}
                  <input className="input mt-0.5" type="number" step="0.01" min="0.8" max="1.2" value={params.source_pu} onChange={(e) => setParams({ ...params, source_pu: Number(e.target.value) })} />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" icon="bolt" loading={running} onClick={runAll}>
                  {t('pf.run_all')}
                </Button>
                {s && (
                  <Button size="sm" variant="secondary" icon="refresh" loading={detailBusy} onClick={() => openFeeder(s.head_id, true)}>
                    {t('pf.recalc_feeder', { code: s.code })}
                  </Button>
                )}
              </div>
            </div>

            {tab === 'feeders' && (
              <div className="space-y-2">
                {!results?.has_run ? (
                  <div className="rounded-md bg-gray-50 px-3 py-4 text-center text-xs text-gray-600">{t('pf.not_run')}</div>
                ) : (
                  <>
                    {st && (
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        {(['critical', 'warning', 'ok'] as const).map((k) => (
                          <button
                            key={k}
                            className={`rounded-md border p-2 text-left ${status === k ? 'border-brand-600' : 'border-gray-200'} bg-gray-50 hover:bg-gray-100`}
                            onClick={() => setStatus(status === k ? 'all' : k)}
                          >
                            <div className="flex items-center gap-1 text-[11px] text-gray-500">
                              <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS[k === 'ok' ? 'good' : k] }} />
                              {statusLabel(k)}
                            </div>
                            <div className="text-lg font-semibold tabular-nums text-gray-900">{fmtNum(st.by_status[k] || 0)}</div>
                          </button>
                        ))}
                        <div className="col-span-3 grid grid-cols-3 gap-2 rounded-md bg-gray-50 p-2">
                          <div>
                            <div className="text-[11px] text-gray-500">{t('pf.total_load')}</div>
                            <div className="font-semibold tabular-nums text-gray-900">{num(st.load_kw / 1000, 1)} MW</div>
                          </div>
                          <div>
                            <div className="text-[11px] text-gray-500">{t('pf.total_loss')}</div>
                            <div className="font-semibold tabular-nums text-gray-900">
                              {num(st.loss_kw / 1000, 2)} MW <span className="text-[11px] font-normal text-gray-500">({num(st.loss_pct ?? 0, 2)}%)</span>
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-gray-500">{t('pf.worst_v')}</div>
                            <div className="font-semibold tabular-nums text-gray-900">{num(st.v_min_pu, 4)} pu</div>
                          </div>
                        </div>
                        <div className="col-span-3 text-[11px] text-gray-500">
                          {t('pf.last_run', { at: fmtDate(results.at), s: ((results.duration_ms ?? 0) / 1000).toFixed(1), lf: results.params.load_factor, pf: results.params.power_factor })}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-1">
                      <input className="input flex-1" placeholder={t('pf.search')} value={q} onChange={(e) => setQ(e.target.value)} />
                      <select className="input w-36" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label={t('pf.sort')}>
                        <option value="severity">{t('pf.sort_severity')}</option>
                        <option value="v_min">{t('pf.sort_vmin')}</option>
                        <option value="loading">{t('pf.sort_loading')}</option>
                        <option value="loss">{t('pf.sort_loss')}</option>
                      </select>
                    </div>
                    <div className="text-[11px] text-gray-500">{t('pf.showing', { shown: fmtNum(results.items.length), total: fmtNum(results.total) })}</div>
                    <ul className="space-y-1">
                      {results.items.map((f) => (
                        <li key={f.head_id}>
                          <button className="w-full rounded border border-gray-200 px-2 py-1 text-left text-xs hover:bg-gray-50" onClick={() => openFeeder(f.head_id)}>
                            <div className="flex items-center gap-2">
                              <span className="flex-1 truncate font-medium text-brand-700">{f.code || `#${f.head_id}`}</span>
                              <span className="text-gray-400">{f.gi_code}</span>
                              {statusChip(f.status)}
                            </div>
                            {f.status === 'error' ? (
                              <div className="mt-0.5 text-[11px] text-gray-500">{f.error}</div>
                            ) : (
                              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-600">
                                <span>
                                  {levelDot(voltageLevel(f.v_min_pu, results.params))}V min {num(f.v_min_pu, 4)} pu
                                </span>
                                <span>
                                  {levelDot(loadingLevel(f.i_max_pct))}
                                  {t('pf.line_short')} {num(f.i_max_pct, 1)}%
                                </span>
                                <span>
                                  {levelDot(loadingLevel(f.trafo_max_pct))}
                                  {t('pf.trafo_short')} {num(f.trafo_max_pct, 1)}%
                                </span>
                                <span>
                                  {t('pf.loss')} {num(f.loss_kw, 1)} kW
                                </span>
                              </div>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {tab === 'detail' && (
              <div className="space-y-3">
                {detailBusy && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Spinner size={14} /> {t('pf.computing')}
                  </div>
                )}
                {!s && !detailBusy && <div className="rounded-md bg-gray-50 px-3 py-4 text-center text-xs text-gray-600">{t('pf.pick_feeder')}</div>}
                {s && detail && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">{s.code}</div>
                        <div className="text-[11px] text-gray-500">
                          {s.gi_code} · {fmtNum(s.nodes)} {t('pf.nodes')} · {fmtNum(s.customers)} {t('power.customers').toLowerCase()}
                        </div>
                      </div>
                      {statusChip(s.status)}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-gray-50 p-2 text-xs">
                      <div>
                        <dt className="text-[11px] text-gray-500">{t('pf.load')}</dt>
                        <dd className="font-semibold tabular-nums">
                          {num(s.load_kw, 1)} kW · {num(s.load_kvar, 1)} kVAr
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-gray-500">{t('pf.send')}</dt>
                        <dd className="font-semibold tabular-nums">
                          {num(s.send_kw, 1)} kW · {num(s.head_current_a, 1)} A
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-gray-500">{t('pf.loss')}</dt>
                        <dd className="font-semibold tabular-nums">
                          {num(s.loss_kw, 2)} kW ({num(s.loss_pct, 2)}%)
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-gray-500">{t('pf.v_range')}</dt>
                        <dd className="font-semibold tabular-nums">
                          {levelDot(voltageLevel(s.v_min_pu, detail.params))}
                          {num(s.v_min_pu, 4)} – {num(s.v_max_pu, 4)} pu
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-gray-500">{t('pf.v_min_mv')}</dt>
                        <dd className="font-semibold tabular-nums">
                          {num(s.v_min_mv_pu, 4)} pu ({num(s.v_min_mv_pu * 20, 2)} kV)
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-gray-500">{t('pf.max_loading')}</dt>
                        <dd className="font-semibold tabular-nums">
                          {levelDot(loadingLevel(s.i_max_pct))}
                          {t('pf.line_short')} {num(s.i_max_pct, 1)}% · {levelDot(loadingLevel(s.trafo_max_pct))}
                          {t('pf.trafo_short')} {num(s.trafo_max_pct, 1)}%
                        </dd>
                      </div>
                      <div className="col-span-2 text-[11px] text-gray-600">
                        {t('pf.violations', { uv: s.under_v, ov: s.over_v, ol: s.overload, tol: s.trafo_overload })}
                      </div>
                      <div className="col-span-2 text-[10px] text-gray-500">
                        {t('pf.solver', { it: s.iterations, conv: s.converged ? t('common.yes') : t('common.no'), ms: num(s.duration_ms, 1) })}
                        {s.mesh_skipped > 0 ? ` · ${t('pf.mesh', { n: s.mesh_skipped })}` : ''}
                      </div>
                    </dl>

                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('pf.worst_nodes')}</div>
                      <table className="w-full text-xs">
                        <tbody>
                          {detail.worst_nodes.slice(0, 8).map((n) => (
                            <tr key={n.id} className="border-t border-gray-100">
                              <td className="py-0.5">
                                <button className="truncate text-left text-brand-700 hover:underline" onClick={() => flyTo('node', n.id)}>
                                  {code('node', n.id)}
                                </button>
                              </td>
                              <td className="py-0.5 text-right tabular-nums">
                                {levelDot(voltageLevel(n.v_pu, detail.params))}
                                {num(n.v_pu, 4)} pu
                              </td>
                              <td className="py-0.5 text-right tabular-nums text-gray-500">{n.lv ? `${num(n.v_kv * 1000, 1)} V` : `${num(n.v_kv, 3)} kV`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('pf.worst_edges')}</div>
                      <table className="w-full text-xs">
                        <tbody>
                          {detail.worst_edges.slice(0, 8).map((e) => (
                            <tr key={e.id} className="border-t border-gray-100">
                              <td className="py-0.5">
                                <button className="truncate text-left text-brand-700 hover:underline" onClick={() => flyTo('edge', e.id)}>
                                  {code('edge', e.id)}
                                </button>
                              </td>
                              <td className="py-0.5 text-right tabular-nums">
                                {num(e.i_a, 1)} / {e.ampacity || '-'} A
                              </td>
                              <td className="py-0.5 text-right tabular-nums">
                                {levelDot(loadingLevel(e.loading_pct, e.ampacity))}
                                {e.ampacity ? `${num(e.loading_pct, 1)}%` : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {(detail.trafos?.length ?? 0) > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('pf.trafos', { n: detail.trafos!.length })}</div>
                        <table className="w-full text-xs">
                          <tbody>
                            {[...detail.trafos!]
                              .sort((a, b) => b.loading_pct - a.loading_pct)
                              .slice(0, 10)
                              .map((tr) => (
                                <tr key={tr.id} className="border-t border-gray-100">
                                  <td className="py-0.5">
                                    <button className="truncate text-left text-brand-700 hover:underline" onClick={() => flyTo('node', tr.id)}>
                                      {code('node', tr.id)}
                                    </button>
                                  </td>
                                  <td className="py-0.5 text-right tabular-nums">
                                    {num(tr.s_kva, 1)} / {num(tr.rated_kva, 0)} kVA{tr.assumed ? '*' : ''}
                                  </td>
                                  <td className="py-0.5 text-right tabular-nums">
                                    {levelDot(loadingLevel(tr.loading_pct))}
                                    {num(tr.loading_pct, 1)}%
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                        {detail.trafos!.some((x) => x.assumed) && <div className="mt-0.5 text-[10px] text-gray-500">* {t('pf.assumed_kva')}</div>}
                      </div>
                    )}
                    <div className="text-[10px] text-gray-500">{t('pf.method_note')}</div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
