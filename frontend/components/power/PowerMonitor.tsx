'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { realtime } from '@/lib/ws';
import { bboxOf, fmtArea, fmtDistance } from '@/lib/geo';
import { fmtDate, fmtDuration, fmtNum, fmtTime, fmtVA } from '@/lib/format';
import type { ComponentType, FeatureCollection, FeederStatus, GDStatus, GeoFeature, GroupReport, Outage, PowerSummary, RealtimeEvent } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import MapCanvas from '@/components/map/MapCanvas';
import { OFF_STATUS, ON_STATUS } from '@/components/map/mapStyle';
import { SearchBox } from '@/components/map/SearchBox';
import type { BasemapKind, DrawMode, MapHandle, MeasureResult } from '@/components/map/types';

type Tab = 'summary' | 'outages' | 'feeders' | 'gardu';
const noop = async () => {};

function StatTile({ label, total, off, tone }: { label: string; total: number; off: number; tone?: 'green' | 'red' }) {
  const bad = off > 0;
  return (
    <div className={`rounded-lg border p-2 ${bad ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-white'}`}>
      <div className="text-[11px] uppercase text-gray-500">{label}</div>
      <div className="mt-0.5 flex items-baseline justify-between">
        <span className={`text-lg font-semibold tabular-nums ${bad ? 'text-red-700' : 'text-emerald-700'}`}>{fmtNum(bad ? off : total - off)}</span>
        <span className="text-[11px] text-gray-500">/ {fmtNum(total)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-200">
        <div className="h-full" style={{ width: `${total > 0 ? ((total - off) / total) * 100 : 100}%`, background: tone === 'red' ? OFF_STATUS : ON_STATUS }} />
      </div>
    </div>
  );
}

export default function PowerMonitor() {
  const { t, pick, locale } = useT();
  const { resolved } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const mapRef = useRef<MapHandle>(null);

  const [types, setTypes] = useState<ComponentType[]>([]);
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [tileVersion, setTileVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<PowerSummary | null>(null);
  const [graph, setGraph] = useState<Record<string, any> | null>(null);
  const [activeOutages, setActiveOutages] = useState(0);
  const [feedersOff, setFeedersOff] = useState<FeederStatus[]>([]);
  const [outages, setOutages] = useState<Outage[]>([]);
  const [history, setHistory] = useState(false);
  const [feeders, setFeeders] = useState<FeederStatus[]>([]);
  const [feederState, setFeederState] = useState<'all' | 'off' | 'partial' | 'on'>('all');
  const [feederQ, setFeederQ] = useState('');
  const [gardu, setGardu] = useState<GDStatus[]>([]);
  const [garduTotal, setGarduTotal] = useState(0);
  const [garduState, setGarduState] = useState<'all' | 'off' | 'partial' | 'on'>('all');
  const [garduQ, setGarduQ] = useState('');
  const [garduQd, setGarduQd] = useState(''); // kata kunci setelah jeda ketik
  const [tab, setTab] = useState<Tab>('summary');
  const [panelOpen, setPanelOpen] = useState(true);
  const [selected, setSelected] = useState<GeoFeature | null>(null);
  const [shownOutage, setShownOutage] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [mode, setMode] = useState<DrawMode>({ kind: 'select' });
  const [measure, setMeasure] = useState<MeasureResult | null>(null);
  const [energy, setEnergy] = useState<'all' | 'on' | 'off'>('all');
  const [wsOk, setWsOk] = useState(false);

  const basemap: BasemapKind = resolved === 'dark' ? 'dark' : 'light';
  const typeName = useCallback(
    (c: string) => {
      const x = types.find((y) => y.code === c);
      return x ? pick(x.name, x.name_en) : c;
    },
    [types, pick],
  );

  const loadSummary = useCallback(async () => {
    try {
      const r = await api<{ summary: PowerSummary; active_outages: number; feeders_off: FeederStatus[]; graph: any }>('/api/power/summary');
      setSummary(r.summary);
      setActiveOutages(r.active_outages);
      setFeedersOff(r.feeders_off);
      setGraph(r.graph);
      setUpdatedAt(new Date());
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);

  const loadOutages = useCallback(async () => {
    try {
      const r = await api<{ items: Outage[] }>(`/api/power/outages?active=${history ? 0 : 1}&limit=100`);
      setOutages(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [history, toast]);

  useEffect(() => {
    const tm = setTimeout(() => setGarduQd(garduQ.trim()), 300);
    return () => clearTimeout(tm);
  }, [garduQ]);

  const loadGardu = useCallback(async () => {
    try {
      const r = await api<{ items: GDStatus[]; total: number }>(`/api/power/gardu?state=${garduState}&q=${encodeURIComponent(garduQd)}&limit=300`);
      setGardu(r.items);
      setGarduTotal(r.total);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [garduState, garduQd, toast]);

  const loadFeeders = useCallback(async () => {
    try {
      const r = await api<{ items: FeederStatus[]; total: number }>(`/api/power/feeders?state=${feederState}&q=${encodeURIComponent(feederQ)}&limit=300`);
      setFeeders(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [feederState, feederQ, toast]);

  useEffect(() => {
    api<{ configs: Record<string, string>; types: ComponentType[]; tile_version: number; graph: any }>('/api/config/public')
      .then((r) => {
        setTypes(r.types);
        setConfigs(r.configs);
        setTileVersion(r.tile_version);
        setGraph(r.graph);
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    loadSummary();
    const every = Math.max(5, Number(configs['monitoring.power_refresh_seconds'] || 15)) * 1000;
    const timer = setInterval(loadSummary, every);
    return () => clearInterval(timer);
  }, [loaded, configs, loadSummary]);
  useEffect(() => {
    if (loaded) loadOutages();
  }, [loaded, loadOutages]);
  useEffect(() => {
    if (loaded && tab === 'feeders') loadFeeders();
  }, [loaded, tab, loadFeeders]);
  useEffect(() => {
    if (loaded && tab === 'gardu') loadGardu();
  }, [loaded, tab, loadGardu]);

  useEffect(() => {
    realtime.connect();
    const offStatus = realtime.onStatus(setWsOk);
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type === 'maneuver' || ev.type === 'energized' || ev.type === 'topology.rebuilt') {
        mapRef.current?.refreshTiles(ev.tile_version);
        if (ev.tile_version) setTileVersion(ev.tile_version);
        setTimeout(() => {
          loadSummary();
          loadOutages();
          if (tab === 'feeders') loadFeeders();
          if (tab === 'gardu') loadGardu();
        }, 600);
        if (ev.type === 'maneuver' && ev.data?.message) toast.push(ev.data.message, ev.data.action === 'open' ? 'warning' : 'success');
      } else if (ev.type.startsWith('feature.')) {
        mapRef.current?.refreshTiles(ev.tile_version);
      }
    });
    return () => {
      off();
      offStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSummary, loadOutages, loadFeeders, loadGardu, tab]);

  useEffect(() => {
    mapRef.current?.setBasemap(basemap);
    mapRef.current?.setDarkLabels(basemap === 'dark');
  }, [basemap]);

  const select = useCallback(
    async (kind: 'node' | 'edge', id: number) => {
      try {
        const f = await api<GeoFeature>(`/api/gis/features/${kind}/${id}`);
        setSelected(f);
        mapRef.current?.setSelected(f);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [toast],
  );

  const selectAndFly = useCallback(
    async (kind: 'node' | 'edge', id: number) => {
      try {
        const f = await api<GeoFeature>(`/api/gis/features/${kind}/${id}`);
        setSelected(f);
        mapRef.current?.setSelected(f);
        const b = bboxOf([f]);
        if (b) mapRef.current?.fitBBox(b);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [toast],
  );

  const showOutage = useCallback(
    async (o: Outage) => {
      try {
        const r = await api<{ geojson: FeatureCollection }>(`/api/power/outages/${o.id}`);
        mapRef.current?.setTrace(r.geojson);
        setShownOutage(o.id);
        const b = bboxOf(r.geojson);
        if (b) mapRef.current?.fitBBox(b);
        select('node', o.cause_node_id);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [select, toast],
  );

  const levelLabel = (lv: string) => {
    const key = `power.level_${lv}` as any;
    return t(key);
  };
  const stateBadge = (s: string) => (s === 'on' ? <Badge tone="green">{t('power.on')}</Badge> : s === 'off' ? <Badge tone="red">{t('power.off')}</Badge> : <Badge tone="amber">{t('power.partial')}</Badge>);

  const report = (r: GroupReport | undefined | null) => {
    if (!r) return null;
    const cells: [string, string][] = [
      [t('power.level_gi'), r.gi.length > 0 ? r.gi.map((x) => x.code).join(', ') : r.parent_gi.length > 0 ? `(${r.parent_gi.map((x) => x.code).join(', ')})` : '0'],
      [t('power.trafo_gi'), r.trafo_gi.length > 0 ? r.trafo_gi.map((x) => x.code).join(', ') : '0'],
      [t('power.feeders'), r.penyulang.length > 0 ? r.penyulang.map((x) => x.code).join(', ') : '0'],
      [t('power.zones'), r.zona.length > 0 ? r.zona.map((x) => x.code || `#${x.id}`).join(', ') : '0'],
      [t('power.gd'), fmtNum(r.gd)],
      [t('power.trafo_gd'), fmtNum(r.trafo_gd)],
      [t('power.customers'), fmtNum(r.pelanggan)],
      [t('power.load'), fmtVA(r.beban_va)],
    ];
    return (
      <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-[11px]">
        {cells.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-500">{k}</dt>
            <dd className="truncate text-gray-800" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    );
  };

  const tabBtn = (tb: Tab, label: string, count?: number) => (
    <button
      className={`flex-1 whitespace-nowrap border-b-2 px-1 py-2 text-xs font-medium ${tab === tb ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
      onClick={() => setTab(tb)}
    >
      {label}
      {count !== undefined && count > 0 && <span className="ml-1 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{count}</span>}
    </button>
  );

  const s = summary;
  const graphLoading = graph?.loading || (graph && graph.nodes === 0);

  if (error) return <div className="p-6 text-sm text-red-700">{t('map.config_failed', { msg: error })}</div>;
  if (!loaded)
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Spinner size={28} />
      </div>
    );

  return (
    <div className="relative h-full w-full">
      <MapCanvas
        ref={mapRef}
        types={types}
        configs={configs}
        initialVersion={tileVersion}
        initialBasemap={basemap}
        initialColorMode="status"
        mode={mode}
        onSelect={select}
        onCreatePoint={noop}
        onCreatePolygon={noop}
        onCreateLine={noop}
        onMove={noop}
        onReshape={noop}
        onReshapePolygon={noop}
        onSplit={noop}
        onVertexCommit={noop}
        onMeasure={setMeasure}
        onCursor={() => {}}
        onCancelMode={() => setMode({ kind: 'select' })}
        onReady={() => {
          mapRef.current?.setVisibleTypes(types.map((x) => x.code));
          mapRef.current?.setBasemap(basemap);
          mapRef.current?.setDarkLabels(basemap === 'dark');
          mapRef.current?.setColorMode('status');
          mapRef.current?.setEnergyFilter(energy);
        }}
        onError={(src, msg) => toast.push(t('map.source_error', { source: src || '-', msg: msg.slice(0, 120) }), 'warning')}
      />

      {/* judul & legenda */}
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-2">
        <div className="rounded-lg border border-gray-200 bg-white/95 px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Icon name="activity" size={16} /> {t('power.title')}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-gray-600">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ON_STATUS }} /> {t('power.on')}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: OFF_STATUS }} /> {t('power.off')}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-red-600 bg-white" /> {t('layers.legend_open')}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-1 w-4 rounded bg-amber-500" /> {t('power.outage_area')}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <SearchBox
            typeName={typeName}
            onPick={(h) => {
              mapRef.current?.flyTo(h.lng, h.lat, 17);
              select(h.kind, h.id);
            }}
          />
        </div>
        <div className="flex w-fit items-center gap-2 rounded-lg border border-gray-200 bg-white/95 p-1 shadow-lg">
          <div className="flex overflow-hidden rounded-md border border-gray-300 text-xs" role="group" aria-label={t('power.filter_label')}>
            {(['all', 'on', 'off'] as const).map((f) => (
              <button
                key={f}
                className={`px-2.5 py-1 ${energy === f ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
                onClick={() => {
                  setEnergy(f);
                  mapRef.current?.setEnergyFilter(f);
                }}
                title={t('power.filter_label')}
              >
                {f === 'all' ? t('power.filter_all') : f === 'on' ? t('power.filter_on') : t('power.filter_off')}
              </button>
            ))}
          </div>
          <span className="h-5 w-px bg-gray-300" />
          {([
            ['length', 'ruler', t('map.tool_measure_length')],
            ['area', 'area', t('map.tool_measure_area')],
          ] as const).map(([what, icon, title]) => {
            const active = mode.kind === 'measure' && mode.what === what;
            return (
              <button
                key={what}
                className={`flex h-7 w-7 items-center justify-center rounded-md ${active ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
                title={title}
                aria-label={title}
                onClick={() => setMode(active ? { kind: 'select' } : { kind: 'measure', what })}
              >
                <Icon name={icon} size={16} />
              </button>
            );
          })}
        </div>
        {mode.kind === 'measure' && (
          <div className="w-fit max-w-sm rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-900 shadow">
            {mode.what === 'length' ? t('map.mode_measure_length') : t('map.mode_measure_area')}
            <button className="ml-2 underline" onClick={() => setMode({ kind: 'select' })}>
              {t('common.cancel')}
            </button>
          </div>
        )}
        {shownOutage && (
          <button
            className="w-fit rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-900 shadow hover:bg-amber-200"
            onClick={() => {
              mapRef.current?.setTrace(null);
              setShownOutage(null);
            }}
          >
            {t('power.clear_outage_area')}
          </button>
        )}
      </div>

      <div className="absolute bottom-10 left-3 z-10 flex flex-col gap-2">
      {measure && (
        <div className="w-72 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-800 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900">{measure.what === 'area' ? t('measure.area_title') : t('measure.length_title')}</span>
            <button className="text-gray-500 hover:text-gray-800" onClick={() => mapRef.current?.clearMeasure()} aria-label={t('common.clear')}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-y-0.5">
            <dt className="text-gray-500">{measure.what === 'area' ? t('measure.perimeter') : t('measure.length')}</dt>
            <dd className="text-right font-semibold tabular-nums">{fmtDistance(measure.lengthM)}</dd>
            {measure.what === 'area' && (
              <>
                <dt className="text-gray-500">{t('measure.area')}</dt>
                <dd className="text-right font-semibold tabular-nums">{fmtArea(measure.areaM2)}</dd>
              </>
            )}
            <dt className="text-gray-500">{t('measure.vertices')}</dt>
            <dd className="text-right tabular-nums">{measure.vertices}</dd>
          </dl>
          <div className="mt-1 text-[11px] text-gray-500">{measure.done ? t('measure.done_hint') : t('measure.hint')}</div>
        </div>
      )}
      {/* objek terpilih */}
      {selected && (
        <div className="w-72 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-800 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900">{typeName(selected.properties.type_code)}</span>
            <button
              className="text-gray-500 hover:text-gray-800"
              onClick={() => {
                setSelected(null);
                mapRef.current?.setSelected(null);
              }}
              aria-label={t('common.close')}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="font-mono text-[11px] text-gray-500">
            {selected.properties.code || `#${selected.id}`} {selected.properties.name && <span className="font-sans text-gray-700">· {selected.properties.name}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {selected.properties.graph?.in_graph ? (
              selected.properties.energized ? <Badge tone="green">{t('feature.on')}</Badge> : <Badge tone="red">{t('feature.off')}</Badge>
            ) : (
              <span className="text-gray-500">{t('feature.not_in_graph')}</span>
            )}
            {selected.properties.graph?.open && <Badge tone="amber">{t('feature.device_open')}</Badge>}
          </div>
          <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5">
            {selected.properties.feeder && (
              <>
                <dt className="text-gray-500">{t('feature.feeder')}</dt>
                <dd>
                  {selected.properties.feeder.code}
                  {selected.properties.feeder_gi && <span className="text-gray-500"> · {selected.properties.feeder_gi.code}</span>}
                </dd>
              </>
            )}
            {selected.properties.zone && (
              <>
                <dt className="text-gray-500">{t('feature.zone')}</dt>
                <dd>{selected.properties.zone.code || `#${selected.properties.zone.id}`}</dd>
              </>
            )}
            {selected.properties.gd && (
              <>
                <dt className="text-gray-500">{t('power.gd_short')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => selectAndFly('node', selected.properties.gd.id)}>
                    {selected.properties.gd.code || `#${selected.properties.gd.id}`}
                  </button>
                </dd>
              </>
            )}
            {selected.properties.trafo_gd && (
              <>
                <dt className="text-gray-500">{t('power.trafo_gd_short')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => selectAndFly('node', selected.properties.trafo_gd.id)}>
                    {selected.properties.trafo_gd.code || `#${selected.properties.trafo_gd.id}`}
                  </button>
                </dd>
              </>
            )}
            {selected.properties.route && (
              <>
                <dt className="text-gray-500">{t('feature.route')}</dt>
                <dd>{selected.properties.route.code}</dd>
              </>
            )}
          </dl>
          <div className="mt-2">
            <Button size="sm" variant="secondary" icon="map" onClick={() => router.push(`/map?select=${selected.properties.kind}:${selected.id}`)}>
              {t('power.open_in_map')}
            </Button>
          </div>
        </div>
      )}

      </div>

      {/* panel kanan */}
      <div className={`absolute right-3 top-3 z-10 mr-11 flex max-h-[calc(100%-4.5rem)] flex-col rounded-lg border border-gray-200 bg-white shadow-xl transition-all ${panelOpen ? 'w-[26rem]' : 'w-10'}`}>
        <div className="flex items-center border-b border-gray-200">
          {panelOpen && (
            <>
              {tabBtn('summary', t('power.tab_summary'))}
              {tabBtn('outages', t('power.tab_outages'), activeOutages)}
              {tabBtn('feeders', t('power.tab_feeders'), s ? s.penyulang.off + s.penyulang.partial : 0)}
              {tabBtn('gardu', t('power.tab_gardu'), s?.gd_state ? s.gd_state.off + s.gd_state.partial : 0)}
            </>
          )}
          <button className="p-2 text-gray-500 hover:text-gray-800" onClick={() => setPanelOpen(!panelOpen)} aria-label={t('map.collapse_panel')}>
            <Icon name={panelOpen ? 'chevron-right' : 'activity'} size={16} />
          </button>
        </div>
        {panelOpen && (
          <div className="flex-1 overflow-y-auto p-3 text-sm">
            {graphLoading && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{t('power.graph_loading')}</div>}

            {tab === 'summary' && s && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label={t('power.gi')} total={s.gi.total} off={s.gi.off} />
                  <StatTile label={t('power.trafo_gi')} total={s.trafo_gi.total} off={s.trafo_gi.off} />
                  <StatTile label={t('power.feeders')} total={s.penyulang.total} off={s.penyulang.off + s.penyulang.partial} />
                  <StatTile label={t('power.zones')} total={s.zona.total} off={s.zona.off + s.zona.partial} />
                  <StatTile label={t('power.gd')} total={s.gd.total} off={s.gd.off} />
                  <StatTile label={t('power.trafo_gd')} total={s.trafo_gd.total} off={s.trafo_gd.off} />
                  <StatTile label={t('power.customers')} total={s.pelanggan.total} off={s.pelanggan.off} />
                  <div className={`rounded-lg border p-2 ${s.beban_off_va > 0 ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-white'}`}>
                    <div className="text-[11px] uppercase text-gray-500">{t('power.load')}</div>
                    <div className="mt-0.5 flex items-baseline justify-between">
                      <span className={`text-lg font-semibold tabular-nums ${s.beban_off_va > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmtVA(s.beban_off_va > 0 ? s.beban_off_va : s.beban_va - s.beban_off_va)}</span>
                      <span className="text-[11px] text-gray-500">/ {fmtVA(s.beban_va)}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-200">
                      <div className="h-full" style={{ width: `${s.beban_va > 0 ? ((s.beban_va - s.beban_off_va) / s.beban_va) * 100 : 100}%`, background: ON_STATUS }} />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { label: t('power.feeders'), c: s.penyulang },
                    { label: t('power.gd'), c: s.gd_state },
                  ].map(({ label, c }) => (
                    <div key={label} className="rounded-md bg-gray-50 p-2">
                      <div className="text-[11px] text-gray-500">{label}</div>
                      <div className="mt-0.5 grid grid-cols-3 gap-1">
                        <div>
                          <div className="text-sm font-semibold tabular-nums text-emerald-700">{fmtNum(c?.on ?? 0)}</div>
                          <div className="text-[10px] text-gray-500">{t('power.on')}</div>
                        </div>
                        <div>
                          <div className={`text-sm font-semibold tabular-nums ${(c?.partial ?? 0) > 0 ? 'text-amber-700' : 'text-gray-500'}`}>{fmtNum(c?.partial ?? 0)}</div>
                          <div className="text-[10px] text-gray-500">{t('power.partial')}</div>
                        </div>
                        <div>
                          <div className={`text-sm font-semibold tabular-nums ${(c?.off ?? 0) > 0 ? 'text-red-700' : 'text-gray-500'}`}>{fmtNum(c?.off ?? 0)}</div>
                          <div className="text-[10px] text-gray-500">{t('power.off')}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="rounded-md bg-gray-50 p-2">
                    <div className="text-[11px] text-gray-500">{t('power.active_outages')}</div>
                    <div className={`mt-0.5 text-base font-semibold ${activeOutages > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{activeOutages}</div>
                  </div>
                  <div className="rounded-md bg-gray-50 p-2">
                    <div className="text-[11px] text-gray-500">{t('power.open_switches')}</div>
                    <div className="mt-0.5 text-base font-semibold text-gray-800">{s.open_switches}</div>
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{t('power.feeders_off')}</div>
                  {feedersOff.length === 0 && <div className="text-xs text-gray-500">{t('power.no_feeders_off')}</div>}
                  <ul className="space-y-1">
                    {feedersOff.map((f) => (
                      <li key={f.head_id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-xs">
                        <button className="flex-1 truncate text-left text-brand-700 hover:underline" onClick={() => select('node', f.head_id)}>
                          {f.code || `#${f.head_id}`} <span className="text-gray-400">· {f.gi_code}</span>
                        </button>
                        <span className="text-gray-600">
                          {fmtNum(f.pelanggan_off)}/{fmtNum(f.pelanggan)} {t('power.customers').toLowerCase()}
                        </span>
                        {stateBadge(f.state)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="text-[11px] text-gray-400">
                  {updatedAt && t('power.updated', { time: fmtTime(updatedAt.toISOString()) })} · {t('layers.nodes')} {fmtNum(s.nodes.total)} ({fmtNum(s.nodes.off)} {t('power.off')})
                </div>
              </div>
            )}

            {tab === 'outages' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-gray-700">
                    <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> {t('power.show_history')}
                  </label>
                  <Button size="sm" variant="secondary" icon="refresh" onClick={loadOutages}>
                    {t('common.refresh')}
                  </Button>
                </div>
                {outages.length === 0 && <div className="py-4 text-center text-xs text-gray-500">{t('power.no_outages')}</div>}
                {outages.map((o) => (
                  <div key={o.id} className={`rounded-md border p-2 text-xs ${o.ended_at ? 'border-gray-200' : 'border-red-200 bg-red-50/50'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone={o.ended_at ? 'gray' : 'red'}>{levelLabel(o.level)}</Badge>
                        <Badge tone="purple">{o.kind}</Badge>
                        <span className="font-semibold text-gray-900">{o.group_code || o.cause_node_code || `#${o.cause_node_id}`}</span>
                      </div>
                      <span className="text-gray-500">#{o.id}</span>
                    </div>
                    <div className="mt-1 text-gray-600">
                      {t('power.cause')}: {typeName(o.cause_node_type)} {o.cause_node_code}
                      {o.way_edge_id ? ` (way #${o.way_edge_id})` : ''}
                    </div>
                    <div className="text-gray-600">
                      {t('power.started')} {fmtDate(o.started_at)} · {t('power.duration')} {fmtDuration(Math.round(o.duration_sec))}
                      {o.ended_at ? ` · ${t('power.ended')} ${fmtDate(o.ended_at)}` : ` · ${t('power.ongoing')}`}
                    </div>
                    <div className="mt-1 text-[11px] font-semibold uppercase text-gray-500">{t('power.group_counts')}</div>
                    {report(o.summary)}
                    <div className="mt-1 flex gap-1">
                      <Button size="sm" variant="secondary" icon="eye" onClick={() => showOutage(o)}>
                        {t('power.show_on_map')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'feeders' && (
              <div className="space-y-2">
                <div className="flex gap-1">
                  <input className="input flex-1" placeholder={t('common.search')} value={feederQ} onChange={(e) => setFeederQ(e.target.value)} />
                  <select className="input w-28" value={feederState} onChange={(e) => setFeederState(e.target.value as any)}>
                    <option value="all">{t('power.filter_all')}</option>
                    <option value="off">{t('power.off')}</option>
                    <option value="partial">{t('power.partial')}</option>
                    <option value="on">{t('power.on')}</option>
                  </select>
                </div>
                {feeders.length === 0 && <div className="py-4 text-center text-xs text-gray-500">{t('common.no_data')}</div>}
                <ul className="space-y-1">
                  {feeders.map((f) => (
                    <li key={f.head_id} className="rounded border border-gray-200 px-2 py-1 text-xs">
                      <div className="flex items-center gap-2">
                        <button className="flex-1 truncate text-left font-medium text-brand-700 hover:underline" onClick={() => select('node', f.head_id)}>
                          {f.code || `#${f.head_id}`}
                        </button>
                        <span className="text-gray-400">{f.gi_code}</span>
                        {stateBadge(f.state)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-600">
                        <span>
                          {t('power.gd')} {fmtNum(f.gd - f.gd_off)}/{fmtNum(f.gd)}
                        </span>
                        <span>
                          {t('power.customers')} {fmtNum(f.pelanggan - f.pelanggan_off)}/{fmtNum(f.pelanggan)}
                        </span>
                        <span>
                          {t('power.load')} {fmtVA(f.beban_va - f.beban_off_va)}/{fmtVA(f.beban_va)}
                        </span>
                        {f.zona > 0 && (
                          <span>
                            {t('power.zones')} {f.zona - f.zona_off}/{f.zona}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tab === 'gardu' && (
              <div className="space-y-2">
                <div className="flex gap-1">
                  <input className="input flex-1" placeholder={t('power.gardu_search')} value={garduQ} onChange={(e) => setGarduQ(e.target.value)} />
                  <select className="input w-28" value={garduState} onChange={(e) => setGarduState(e.target.value as any)}>
                    <option value="all">{t('power.filter_all')}</option>
                    <option value="off">{t('power.off')}</option>
                    <option value="partial">{t('power.partial')}</option>
                    <option value="on">{t('power.on')}</option>
                  </select>
                </div>
                <div className="text-[11px] text-gray-500">{t('power.gardu_count', { shown: fmtNum(gardu.length), total: fmtNum(garduTotal) })}</div>
                {gardu.length === 0 && <div className="py-4 text-center text-xs text-gray-500">{t('common.no_data')}</div>}
                <ul className="space-y-1">
                  {gardu.map((g) => (
                    <li key={g.id} className="rounded border border-gray-200 px-2 py-1 text-xs">
                      <div className="flex items-center gap-2">
                        <button className="flex-1 truncate text-left font-medium text-brand-700 hover:underline" onClick={() => selectAndFly('node', g.id)} title={g.name}>
                          {g.code || `#${g.id}`}
                        </button>
                        <span className="truncate text-gray-400">
                          {g.feeder_code}
                          {g.gi_code ? ` · ${g.gi_code}` : ''}
                        </span>
                        {stateBadge(g.state)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-600">
                        <span>
                          {t('power.customers')} {fmtNum(g.pelanggan - g.pelanggan_off)}/{fmtNum(g.pelanggan)}
                        </span>
                        <span>
                          {t('power.load')} {fmtVA(g.beban_va - g.beban_off_va)}/{fmtVA(g.beban_va)}
                        </span>
                        {g.nodes_off > 0 && (
                          <span className="text-red-700">
                            {fmtNum(g.nodes_off)} {t('power.objects_off')}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-3 rounded-md bg-white/90 px-3 py-1 text-[11px] text-gray-700 shadow">
        <span title={t('map.tile_version')}>v{tileVersion}</span>
        <span className="flex items-center gap-1" title={wsOk ? t('map.realtime_on') : t('map.realtime_off')}>
          <span className={`inline-block h-2 w-2 rounded-full ${wsOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {t('map.realtime')}
        </span>
        <span className="text-gray-500">{locale === 'en' ? 'auto refresh' : 'refresh otomatis'} {configs['monitoring.power_refresh_seconds'] || 15}s</span>
      </div>
    </div>
  );
}
