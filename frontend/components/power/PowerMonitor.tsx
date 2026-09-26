'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { realtime } from '@/lib/ws';
import { bboxOf, fmtArea, fmtDistance } from '@/lib/geo';
import { fmtDate, fmtDuration, fmtNum, fmtTime, fmtVA } from '@/lib/format';
import type { ComponentType, FeatureCollection, FeederStatus, GDStatus, GeoFeature, GroupReport, Outage, PowerSummary, RealtimeEvent, Reliability, ReliabilityGroup, TraceResponse } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import MapCanvas from '@/components/map/MapCanvas';
import { OFF_STATUS, ON_STATUS } from '@/components/map/mapStyle';
import { SearchBox } from '@/components/map/SearchBox';
import { SectionRecap } from './SectionRecap';
import { SOEPanel } from './SOEPanel';
import { CustomersPanel, type CustomerState } from './CustomersPanel';
import { BoundaryControl, useBoundaryOverlay } from '@/components/map/BoundaryOverlay';
import { OperateBox, type ManeuverBody } from './OperateBox';
import { TracePanel, type TraceSeed } from '@/components/map/TracePanel';
import { useAuth } from '@/lib/auth';
import { ExchangePanel } from '@/components/map/ExchangePanel';
import type { BasemapKind, DrawMode, MapHandle, MeasureResult } from '@/components/map/types';

type Tab = 'outages' | 'soe' | 'trace' | 'gi' | 'feeders' | 'gardu' | 'customers' | 'export';

interface GIStatus {
  id: number;
  code: string;
  name: string;
  energized: boolean;
  state: 'on' | 'partial' | 'off';
  trafo_gi: number;
  trafo_gi_off: number;
  feeders: number;
  feeders_partial: number;
  feeders_off: number;
  gd: number;
  gd_off: number;
  pelanggan: number;
  pelanggan_off: number;
  beban_va: number;
  beban_off_va: number;
}
type Period = 'today' | 'month' | 'year';
const noop = async () => {};
const LEVELS = ['gi', 'trafo_gi', 'penyulang', 'zona', 'gardu_distribusi', 'trafo_gd', 'jurusan', 'pelanggan'];
const fmtDec = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
/** Indeks keandalan: nilai sangat kecil (jutaan pelanggan) tetap terbaca dengan 3 angka penting. */
const fmtIdx = (n: number) => {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1) return fmtDec(n, 2);
  return n.toLocaleString('id-ID', { maximumSignificantDigits: 3 });
};
const fmtRp = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `Rp ${fmtDec(n / 1e9, 2)} M`;
  if (a >= 1e6) return `Rp ${fmtDec(n / 1e6, 2)} jt`;
  return `Rp ${fmtDec(n, 0)}`;
};
const fmtKWh = (n: number) => (Math.abs(n) >= 1e6 ? `${fmtDec(n / 1e6, 2)} GWh` : Math.abs(n) >= 1e3 ? `${fmtDec(n / 1e3, 2)} MWh` : `${fmtDec(n, 1)} kWh`);

/** Kartu indeks keandalan (SAIDI, SAIFI, ENS). */
function RelTile({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="min-w-[6.5rem] flex-1 basis-0 rounded-md border border-gray-200 bg-white px-2 py-1" title={title}>
      <div className="truncate text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="truncate text-base font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="truncate text-[10px] text-gray-500">{sub}</div>}
    </div>
  );
}

/** Kartu ringkas pita rekap: nilai utama nyala (atau jumlah padam bila ada), total, bilah proporsi. */
function SumTile({ label, total, off, format = fmtNum, onClick, title }: { label: string; total: number; off: number; format?: (n: number) => string; onClick?: () => void; title?: string }) {
  const bad = off > 0;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`min-w-[5.5rem] flex-1 basis-0 rounded-md border px-2 py-1 text-left ${bad ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-white'} ${onClick ? 'hover:border-brand-600' : ''}`}
      onClick={onClick}
      title={title ?? label}
    >
      <div className="truncate text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="flex items-baseline justify-between gap-1">
        <span className={`whitespace-nowrap text-base font-semibold tabular-nums ${bad ? 'text-red-700' : 'text-emerald-700'}`}>{format(bad ? off : total - off)}</span>
        <span className="min-w-0 truncate text-[10px] text-gray-500" title={format(total)}>/ {format(total)}</span>
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-gray-200">
        <div className="h-full" style={{ width: `${total > 0 ? ((total - off) / total) * 100 : 100}%`, background: ON_STATUS }} />
      </div>
    </Tag>
  );
}

/** Kartu status group (nyala / sebagian / padam). */
function StateTile({ label, c, labels, onClick }: { label: string; c?: { on: number; partial: number; off: number }; labels: [string, string, string]; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  const bad = (c?.off ?? 0) + (c?.partial ?? 0) > 0;
  return (
    <Tag className={`min-w-[10rem] flex-[2] basis-0 rounded-md border px-2 py-1 text-left ${bad ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-white'} ${onClick ? 'hover:border-brand-600' : ''}`} onClick={onClick} title={label}>
      <div className="truncate text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="flex justify-between gap-3">
        {([
          [c?.on ?? 0, labels[0], 'text-emerald-700'],
          [c?.partial ?? 0, labels[1], 'text-amber-700'],
          [c?.off ?? 0, labels[2], 'text-red-700'],
        ] as const).map(([v, l, cls], i) => (
          <div key={i}>
            <div className={`text-sm font-semibold leading-tight tabular-nums ${i === 0 || v > 0 ? cls : 'text-gray-500'}`}>{fmtNum(v)}</div>
            <div className="text-[10px] leading-tight text-gray-500">{l}</div>
          </div>
        ))}
      </div>
    </Tag>
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
  const [period, setPeriod] = useState<Period>('month');
  const [rel, setRel] = useState<Reliability | null>(null);
  const [levelFilter, setLevelFilter] = useState('all');
  const [outageGroups, setOutageGroups] = useState<Record<string, ReliabilityGroup>>({});
  const [feeders, setFeeders] = useState<FeederStatus[]>([]);
  const [feederState, setFeederState] = useState<'all' | 'off' | 'partial' | 'on'>('all');
  const [feederQ, setFeederQ] = useState('');
  const [gis, setGis] = useState<GIStatus[]>([]);
  const [giCounts, setGiCounts] = useState<{ on: number; partial: number; off: number } | null>(null);
  const [giState, setGiState] = useState<'all' | 'off' | 'partial' | 'on'>('all');
  const [giQ, setGiQ] = useState('');
  const [custState, setCustState] = useState<CustomerState>('all');
  const [custRefresh, setCustRefresh] = useState(0);
  const [gardu, setGardu] = useState<GDStatus[]>([]);
  const [garduTotal, setGarduTotal] = useState(0);
  const [garduState, setGarduState] = useState<'all' | 'off' | 'partial' | 'on'>('all');
  const [garduQ, setGarduQ] = useState('');
  const [garduQd, setGarduQd] = useState(''); // kata kunci setelah jeda ketik
  const [tab, setTab] = useState<Tab>('outages');
  // tab aktif selalu terlihat walau bar tab lebih lebar dari panel (mis. dibuka dari widget rekap)
  useEffect(() => {
    document.querySelector(`aside [data-tab="${tab}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [tab]);
  const [soeUnread, setSoeUnread] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [bndOpen, setBndOpen] = useState(false);
  const { has } = useAuth();
  const canTrace = has('gis.trace');
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceSeed, setTraceSeed] = useState<TraceSeed | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [selected, setSelected] = useState<GeoFeature | null>(null);
  const [shownOutage, setShownOutage] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [mode, setMode] = useState<DrawMode>({ kind: 'select' });
  const [measure, setMeasure] = useState<MeasureResult | null>(null);
  const [energy, setEnergy] = useState<'all' | 'on' | 'off'>('all');
  const [area, setArea] = useState<[number, number][] | null>(null);
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
      const r = await api<{ items: Outage[]; groups: Record<string, ReliabilityGroup> }>(
        history ? `/api/power/outages?period=${period}&limit=1000` : `/api/power/outages?active=1&limit=500`,
      );
      setOutages(r.items);
      setOutageGroups(r.groups || {});
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [history, period, toast]);

  const loadReliability = useCallback(async () => {
    try {
      setRel(await api<Reliability>(`/api/power/reliability?period=${period}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [period, toast]);

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

  const loadGI = useCallback(async () => {
    try {
      const r = await api<{ items: GIStatus[]; counts: { on: number; partial: number; off: number } }>(`/api/power/gi?state=${giState}&q=${encodeURIComponent(giQ)}`);
      setGis(r.items);
      setGiCounts(r.counts);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [giState, giQ, toast]);

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
    if (!loaded) return;
    loadReliability();
    const timer = setInterval(loadReliability, 60000); // durasi padam berjalan terus bertambah
    return () => clearInterval(timer);
  }, [loaded, loadReliability]);
  useEffect(() => {
    if (loaded) loadOutages();
  }, [loaded, loadOutages]);
  // ?select=node:123 (mis. dari SLD): pilih & arahkan peta ke objek tersebut
  useEffect(() => {
    if (!loaded) return;
    const q = new URLSearchParams(window.location.search).get('select');
    if (!q) return;
    const [k, idStr] = q.split(':');
    const fid = Number(idStr);
    if ((k !== 'node' && k !== 'edge') || !fid) return;
    setTimeout(() => selectAndFly(k, fid), 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  useEffect(() => {
    if (loaded && tab === 'feeders') loadFeeders();
  }, [loaded, tab, loadFeeders]);
  useEffect(() => {
    if (loaded && tab === 'gi') loadGI();
  }, [loaded, tab, loadGI]);
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
          loadReliability();
          if (tab === 'feeders') loadFeeders();
          if (tab === 'gi') loadGI();
          if (tab === 'customers') setCustRefresh((x) => x + 1);
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
  }, [loadSummary, loadOutages, loadReliability, loadFeeders, loadGI, loadGardu, tab]);

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
        select(o.cause_kind === 'edge' ? 'edge' : 'node', o.cause_node_id);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [select, toast],
  );

  const shownOutages = useMemo(() => {
    const list = levelFilter === 'all' ? outages : outages.filter((o) => o.level === levelFilter);
    const order = (lv: string) => (LEVELS.indexOf(lv) < 0 ? LEVELS.length : LEVELS.indexOf(lv));
    const groups: { level: string; items: Outage[] }[] = [];
    for (const o of list) {
      let g = groups.find((x) => x.level === o.level);
      if (!g) groups.push((g = { level: o.level, items: [] }));
      g.items.push(o);
    }
    return groups.sort((a, b) => order(a.level) - order(b.level));
  }, [outages, levelFilter]);

  const boundary = useBoundaryOverlay(mapRef, configs, mapReady);

  // ------------------------------------------------------------ trace hilir / hulu
  const onTraceResult = useCallback((r: TraceResponse | null) => {
    setTrace(r);
    setShownOutage(null);
    if (!r) {
      mapRef.current?.setTrace(null);
      return;
    }
    const fc = {
      ...r.geojson,
      features: r.geojson.features.map((f) => (f.properties.kind === 'node' && f.id === r.result.start_node ? { ...f, properties: { ...f.properties, is_start: true } } : f)),
    };
    mapRef.current?.setTrace(fc);
    const b = bboxOf(fc);
    if (b) mapRef.current?.fitBBox(b);
  }, []);
  const startTrace = (nodeId: number, direction: 'down' | 'up') => {
    setTab('trace');
    setPanelOpen(true);
    setTraceSeed({ nodeId, direction, nonce: Date.now() });
  };

  // operasi buka / tutup, energize / deenergize dari popup objek terpilih
  const operate = async (body: ManeuverBody) => {
    if (!selected) return;
    const { target = 'node', ...rest } = body;
    try {
      const res = await api<{ message: string; tile_version: number; feature?: GeoFeature }>('/api/gis/maneuver', {
        method: 'POST',
        body: target === 'edge' ? { edge_id: selected.id, ...rest } : { node_id: selected.id, ...rest },
      });
      mapRef.current?.refreshTiles(res.tile_version);
      if (res.tile_version) setTileVersion(res.tile_version);
      toast.push(res.message, body.action === 'open' ? 'warning' : 'success');
      if (res.feature) {
        setSelected(res.feature);
        mapRef.current?.setSelected(res.feature);
      } else await select(target, selected.id as number);
      setTimeout(() => {
        loadSummary();
        loadOutages();
      }, 600);
    } catch (e: any) {
      toast.push(e.message, 'error');
      throw e;
    }
  };

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
      data-tab={tb}
      className={`flex-1 whitespace-nowrap border-b-2 px-0.5 py-2 text-[11px] font-medium ${tab === tb ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
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

  const stateLabels: [string, string, string] = [t('power.on'), t('power.partial'), t('power.off')];
  const openTab = (tb: Tab, st?: { off: number; partial: number }) => {
    setTab(tb);
    setPanelOpen(true);
    if (!st) return;
    const f = st.off > 0 ? 'off' : st.partial > 0 ? 'partial' : 'all';
    if (tb === 'feeders') setFeederState(f);
    if (tb === 'gardu') setGarduState(f);
    if (tb === 'gi') setGiState(f);
    if (tb === 'customers') setCustState(f === 'off' ? 'off' : 'all');
  };

  return (
    <div className="flex h-full w-full flex-col">
      {/* pita rekap */}
      <header className="shrink-0 border-b border-gray-200 bg-white px-3 pb-2 pt-1.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Icon name="activity" size={16} /> {t('power.title')}
          </span>
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
          <span className="ml-auto flex items-center gap-3 text-gray-500">
            {graphLoading && <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-900">{t('power.graph_loading')}</span>}
            {updatedAt && s && (
              <span>
                {t('power.updated', { time: fmtTime(updatedAt.toISOString()) })} · {t('layers.nodes')} {fmtNum(s.nodes.total)} ({fmtNum(s.nodes.off)} {t('power.off')})
              </span>
            )}
            <span className="flex items-center gap-1" title={wsOk ? t('map.realtime_on') : t('map.realtime_off')}>
              <span className={`inline-block h-2 w-2 rounded-full ${wsOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
              {t('map.realtime')} · {configs['monitoring.power_refresh_seconds'] || 15}s
            </span>
          </span>
        </div>
        {s ? (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            <SumTile label={t('power.gi')} total={s.gi.total} off={s.gi.off} onClick={() => openTab('gi', { off: s.gi.off, partial: 0 })} title={t('power.tab_gi')} />
            <SumTile label={t('power.trafo_gi')} total={s.trafo_gi.total} off={s.trafo_gi.off} />
            <StateTile label={t('power.feeders')} c={s.penyulang} labels={stateLabels} onClick={() => openTab('feeders', s.penyulang)} />
            <StateTile label={t('power.zones')} c={s.zona} labels={stateLabels} />
            <StateTile label={t('power.gd')} c={s.gd_state} labels={stateLabels} onClick={() => openTab('gardu', s.gd_state)} />
            <SumTile label={t('power.trafo_gd')} total={s.trafo_gd.total} off={s.trafo_gd.off} />
            <SumTile label={t('power.customers')} total={s.pelanggan.total} off={s.pelanggan.off} onClick={() => openTab('customers', { off: s.pelanggan.off, partial: 0 })} title={t('power.tab_customers')} />
            <SumTile label={t('power.load')} total={s.beban_va} off={s.beban_off_va} format={fmtVA} />
            <button
              className={`min-w-[5rem] flex-[0.8] basis-0 rounded-md border px-2 py-1 text-left hover:border-brand-600 ${activeOutages > 0 ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-white'}`}
              onClick={() => openTab('outages')}
              title={t('power.active_outages')}
            >
              <div className="truncate text-[10px] uppercase tracking-wide text-gray-500">{t('power.active_outages')}</div>
              <div className={`text-base font-semibold tabular-nums ${activeOutages > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{activeOutages}</div>
            </button>
            <div className="min-w-[5rem] flex-[0.8] basis-0 rounded-md border border-gray-200 bg-white px-2 py-1" title={t('power.open_switches')}>
              <div className="truncate text-[10px] uppercase tracking-wide text-gray-500">{t('power.open_switches')}</div>
              <div className="text-base font-semibold tabular-nums text-gray-800">{s.open_switches}</div>
            </div>
          </div>
        ) : (
          <div className="flex h-12 items-center gap-2 text-xs text-gray-500">
            <Spinner size={14} /> {t('common.loading')}
          </div>
        )}
        <div className="mt-1.5 flex items-stretch gap-1.5 overflow-x-auto pb-0.5">
          <div className="flex min-w-[7rem] flex-col justify-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-600">{t('rel.title')}</div>
            <select className="input !h-6 !py-0 text-xs" value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label={t('rel.period')}>
              <option value="today">{t('rel.period_today')}</option>
              <option value="month">{t('rel.period_month')}</option>
              <option value="year">{t('rel.period_year')}</option>
            </select>
          </div>
          {rel ? (
            <>
              <RelTile label="SAIDI" value={`${fmtIdx(rel.total.saidi)} ${t('rel.min_cust')}`} sub={t('rel.saidi_desc')} title={t('rel.saidi_hint')} />
              <RelTile label="SAIFI" value={`${fmtIdx(rel.total.saifi)} ${t('rel.times_cust')}`} sub={t('rel.saifi_desc')} title={t('rel.saifi_hint')} />
              <RelTile label="ENS (kWh)" value={fmtKWh(rel.total.ens_kwh)} sub={t('rel.ens_desc')} title={t('rel.ens_hint', { lf: rel.params.load_factor, pf: rel.params.power_factor })} />
              <RelTile
                label="ENS (Rupiah)"
                value={fmtRp(rel.total.ens_rp)}
                sub={t('rel.tariff', { rp: fmtDec(rel.params.tariff_rp_per_kwh, 2) })}
                title={t('rel.tariff_hint')}
              />
              <RelTile
                label={t('rel.events')}
                value={fmtNum(rel.total.outages)}
                sub={t('rel.events_sub', { m: rel.total.momentary, c: fmtNum(rel.total.customers_out) })}
                title={t('rel.momentary_hint', { min: rel.params.sustained_minutes })}
              />
              <div className="flex min-w-[14rem] flex-[2] basis-0 flex-wrap content-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1" title={t('rel.by_level')}>
                {LEVELS.filter((lv) => rel.by_level[lv]).map((lv) => (
                  <button
                    key={lv}
                    className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-200"
                    onClick={() => {
                      setHistory(true);
                      setLevelFilter(lv);
                      openTab('outages');
                    }}
                    title={`SAIDI ${fmtIdx(rel.by_level[lv].saidi)} · SAIFI ${fmtIdx(rel.by_level[lv].saifi)} · ENS ${fmtKWh(rel.by_level[lv].ens_kwh)} / ${fmtRp(rel.by_level[lv].ens_rp)}`}
                  >
                    {levelLabel(lv)} <b className="tabular-nums">{rel.by_level[lv].outages}</b>
                  </button>
                ))}
                {rel.total.outages === 0 && <span className="text-[11px] text-gray-500">{t('rel.no_events')}</span>}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 px-2 text-xs text-gray-500">
              <Spinner size={12} /> {t('common.loading')}
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
      {/* peta kerja */}
      <div className="relative min-w-0 flex-1">
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
        onArea={(ring) => {
          setArea(ring);
          setMode({ kind: 'select' });
        }}
        onReady={() => {
          setMapReady(true);
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
          <span className="h-5 w-px bg-gray-300" />
          <button
            className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-xs ${bndOpen ? 'bg-brand-600 text-white' : boundary.style.show ? 'text-brand-700 hover:bg-gray-100' : 'text-gray-700 hover:bg-gray-100'}`}
            title={t('bnd.title')}
            aria-expanded={bndOpen}
            onClick={() => setBndOpen(!bndOpen)}
          >
            <Icon name="layers" size={16} /> UP3
          </button>
        </div>
        {bndOpen && (
          <div className="w-64 rounded-lg border border-gray-200 bg-white/95 p-2 shadow-lg">
            <BoundaryControl state={boundary} compact />
          </div>
        )}
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
        <div className="w-80 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-800 shadow-xl">
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
          <SectionRecap sec={selected.properties.section} />
          {canTrace && selected.properties.kind === 'node' && selected.properties.graph?.in_graph && (
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="secondary" icon="arrow-down" onClick={() => startTrace(selected.id as number, 'down')}>
                {t('power.downtrace')}
              </Button>
              <Button size="sm" variant="secondary" icon="arrow-up" onClick={() => startTrace(selected.id as number, 'up')}>
                {t('power.uptrace')}
              </Button>
            </div>
          )}
          <div className="mt-2">
            <OperateBox feature={selected} types={types} submit={operate} />
          </div>
          <div className="mt-2">
            <Button size="sm" variant="secondary" icon="map" onClick={() => router.push(`/map?select=${selected.properties.kind}:${selected.id}`)}>
              {t('power.open_in_map')}
            </Button>
            <Button size="sm" variant="secondary" icon="diagram" onClick={() => router.push(`/sld?focus=${selected.properties.kind}:${selected.id}`)}>
              {t('sld.open_sld')}
            </Button>
          </div>
        </div>
      )}

      </div>

      </div>

      {/* panel tab info: kejadian padam, penyulang, gardu */}
      <aside className={`flex shrink-0 flex-col border-l border-gray-200 bg-white transition-all ${panelOpen ? 'w-[26rem]' : 'w-10'}`}>
        <div className="flex items-center overflow-x-auto border-b border-gray-200 [scrollbar-width:none]">
          {panelOpen && (
            <>
              {tabBtn('outages', t('power.tab_outages'), activeOutages)}
              {tabBtn('soe', 'SOE', soeUnread)}
              {canTrace && tabBtn('trace', t('map.tab_trace'))}
              {tabBtn('gi', t('power.tab_gi'), s ? s.gi.off : 0)}
              {tabBtn('feeders', t('power.tab_feeders'), s ? s.penyulang.off + s.penyulang.partial : 0)}
              {tabBtn('gardu', t('power.tab_gardu'), s?.gd_state ? s.gd_state.off + s.gd_state.partial : 0)}
              {tabBtn('customers', t('power.tab_customers'), s ? s.pelanggan.off : 0)}
              {tabBtn('export', t('power.tab_export'))}
            </>
          )}
          <button className="sticky right-0 shrink-0 bg-white p-2 text-gray-500 hover:text-gray-800" onClick={() => setPanelOpen(!panelOpen)} aria-label={t('map.collapse_panel')} title={t('map.collapse_panel')}>
            <Icon name={panelOpen ? 'chevron-right' : 'chevron-left'} size={16} />
          </button>
        </div>
        {panelOpen && (
          <div className="flex-1 overflow-y-auto p-3 text-sm">

            {tab === 'outages' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-gray-700">
                    <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> {t('rel.history_period')}
                  </label>
                  <Button size="sm" variant="secondary" icon="refresh" onClick={loadOutages}>
                    {t('common.refresh')}
                  </Button>
                </div>
                <div className="flex gap-1">
                  <select className="input flex-1 text-xs" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} aria-label={t('rel.level')}>
                    <option value="all">{t('rel.all_levels')}</option>
                    {LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {levelLabel(lv)}
                      </option>
                    ))}
                  </select>
                  {history && (
                    <select className="input w-28 text-xs" value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label={t('rel.period')}>
                      <option value="today">{t('rel.period_today')}</option>
                      <option value="month">{t('rel.period_month')}</option>
                      <option value="year">{t('rel.period_year')}</option>
                    </select>
                  )}
                </div>
                {shownOutages.length === 0 && <div className="py-4 text-center text-xs text-gray-500">{t('power.no_outages')}</div>}
                {shownOutages.map((grp) => (
                  <section key={grp.level} className="space-y-1.5">
                    <div className="sticky top-0 z-[1] -mx-1 rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-700">
                      <div className="flex items-center justify-between font-semibold uppercase tracking-wide">
                        <span>{levelLabel(grp.level)}</span>
                        <span className="tabular-nums">{grp.items.length}</span>
                      </div>
                      {outageGroups[grp.level] && (
                        <div className="flex flex-wrap gap-x-3 tabular-nums text-gray-600">
                          <span>SAIDI {fmtIdx(outageGroups[grp.level].saidi)}</span>
                          <span>SAIFI {fmtIdx(outageGroups[grp.level].saifi)}</span>
                          <span>ENS {fmtKWh(outageGroups[grp.level].ens_kwh)}</span>
                          <span>{fmtRp(outageGroups[grp.level].ens_rp)}</span>
                        </div>
                      )}
                    </div>
                {grp.items.map((o) => (
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
                      {t('power.cause')}: {typeName(o.cause_node_type)} {o.cause_node_code || `#${o.cause_node_id}`}
                      {o.cause_kind === 'edge' ? ` (${t('rel.line')})` : ''}
                      {o.way_edge_id ? ` (way #${o.way_edge_id})` : ''}
                    </div>
                    <div className="text-gray-600">
                      {t('power.started')} {fmtDate(o.started_at)} · {t('power.duration')} {fmtDuration(Math.round(o.duration_sec))}
                      {o.ended_at ? ` · ${t('power.ended')} ${fmtDate(o.ended_at)}` : ` · ${t('power.ongoing')}`}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 rounded bg-gray-50 px-1.5 py-0.5 text-[11px] tabular-nums text-gray-700">
                      <span title={t('rel.cust_min_hint')}>
                        {fmtNum(Math.round(o.customer_minutes || 0))} {t('rel.cust_min')}
                      </span>
                      <span>ENS {fmtKWh(o.ens_kwh || 0)}</span>
                      <span>{fmtRp(o.ens_rp || 0)}</span>
                      {o.momentary && <span className="text-amber-700">{t('rel.momentary')}</span>}
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
                  </section>
                ))}
              </div>
            )}

            {tab === 'gi' && (
              <div className="space-y-2">
                <div className="flex gap-1">
                  <input className="input flex-1" placeholder={t('common.search')} value={giQ} onChange={(e) => setGiQ(e.target.value)} />
                  <select className="input w-28" value={giState} onChange={(e) => setGiState(e.target.value as any)} aria-label={t('common.status')}>
                    <option value="all">{t('power.filter_all')}</option>
                    <option value="off">{t('power.off')}</option>
                    <option value="partial">{t('power.partial')}</option>
                    <option value="on">{t('power.on')}</option>
                  </select>
                </div>
                {giCounts && (
                  <div className="flex flex-wrap gap-x-3 text-[11px] text-gray-600">
                    <span>
                      {t('power.gi')}: {fmtNum(giCounts.on + giCounts.partial + giCounts.off)}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: ON_STATUS }} /> {t('power.on')} {giCounts.on}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> {t('power.partial')} {giCounts.partial}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: OFF_STATUS }} /> {t('power.off')} {giCounts.off}
                    </span>
                  </div>
                )}
                {gis.length === 0 && <div className="py-4 text-center text-xs text-gray-500">{t('common.no_data')}</div>}
                <ul className="space-y-1">
                  {gis.map((g) => (
                    <li key={g.id} className="rounded border border-gray-200 px-2 py-1 text-xs">
                      <div className="flex items-center gap-2">
                        <button className="truncate text-left font-medium text-brand-700 hover:underline" onClick={() => selectAndFly('node', g.id)}>
                          {g.code || `#${g.id}`}
                        </button>
                        <span className="flex-1 truncate text-gray-500">{g.name}</span>
                        {stateBadge(g.state)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-600">
                        <span>
                          {t('power.trafo_gi')} {fmtNum(g.trafo_gi - g.trafo_gi_off)}/{fmtNum(g.trafo_gi)}
                        </span>
                        <span>
                          {t('power.feeders')} {fmtNum(g.feeders - g.feeders_off - g.feeders_partial)}/{fmtNum(g.feeders)}
                          {g.feeders_partial > 0 && <span className="text-amber-700"> · {t('power.partial')} {g.feeders_partial}</span>}
                          {g.feeders_off > 0 && <span className="text-red-700"> · {t('power.off')} {g.feeders_off}</span>}
                        </span>
                        <span>
                          {t('power.gd')} {fmtNum(g.gd - g.gd_off)}/{fmtNum(g.gd)}
                        </span>
                        <span>
                          {t('power.customers')} {fmtNum(g.pelanggan - g.pelanggan_off)}/{fmtNum(g.pelanggan)}
                        </span>
                        <span>
                          {t('power.load')} {fmtVA(g.beban_va - g.beban_off_va)}/{fmtVA(g.beban_va)}
                        </span>
                      </div>
                      {g.feeders > 0 && (
                        <button
                          className="mt-0.5 text-[11px] text-brand-700 hover:underline"
                          onClick={() => {
                            setFeederQ(g.code);
                            setFeederState('all');
                            setTab('feeders');
                          }}
                        >
                          {t('power.gi_show_feeders', { n: g.feeders })} →
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
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
            <div className={tab === 'soe' ? 'h-full' : 'hidden'}>
              <SOEPanel active={tab === 'soe'} onUnread={setSoeUnread} onSelect={selectAndFly} typeName={typeName} levelLabel={levelLabel} />
            </div>
            {tab === 'trace' && canTrace && (
              <TracePanel
                types={types}
                seed={traceSeed}
                selectedNodeId={selected?.properties.kind === 'node' ? (selected.id as number) : null}
                result={trace}
                onResult={onTraceResult}
                directions={['down', 'up']}
                onSelect={(k, id) => {
                  const f = trace?.geojson.features.find((x) => x.id === id && x.properties.kind === k);
                  const b = f ? bboxOf([f]) : null;
                  if (b) mapRef.current?.fitBBox(b);
                  select(k, id);
                }}
              />
            )}
            {tab === 'customers' && (
              <CustomersPanel active={tab === 'customers'} state={custState} onState={setCustState} refreshKey={custRefresh} onSelect={selectAndFly} typeName={typeName} />
            )}
            {tab === 'export' && (
              <ExchangePanel
                mapRef={mapRef}
                types={types}
                format="gdb"
                energyFilter
                area={area}
                drawing={mode.kind === 'area'}
                onDrawArea={() => setMode({ kind: 'area' })}
                onClearArea={() => {
                  setArea(null);
                  mapRef.current?.setArea(null);
                }}
              />
            )}
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
