'use client';

import { OPERATE_PERMS } from '@/components/power/OperateBox';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { realtime } from '@/lib/ws';
import { bboxOf, fmtArea, fmtDistance } from '@/lib/geo';
import type { ComponentType, EditResult, GeoFeature, RealtimeEvent, TraceResponse } from '@/lib/types';
import { Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import MapCanvas from './MapCanvas';
import { DrawToolbar } from './DrawToolbar';
import { SearchBox } from './SearchBox';
import { BoundaryControl, useBoundaryOverlay } from './BoundaryOverlay';
import { LayerPanel } from './LayerPanel';
import { FeaturePanel, type ManeuverBody } from './FeaturePanel';
import { TracePanel, type TraceSeed } from './TracePanel';
import { ExchangePanel } from './ExchangePanel';
import { modeLabel, type BasemapKind, type BasemapPref, type ColorMode, type ConnectedEdge, type DrawMode, type MapHandle, type MeasureResult } from './types';

type Tab = 'layers' | 'feature' | 'trace' | 'data';
const BASEMAP_KEY = 'qgis_basemap';

function readBasemapPref(): BasemapPref {
  try {
    const v = window.localStorage.getItem(BASEMAP_KEY);
    return v === 'light' || v === 'dark' || v === 'none' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export default function MapWorkspace() {
  const { has, user } = useAuth();
  const { t, pick } = useT();
  const { resolved } = useTheme();
  const toast = useToast();
  const mapRef = useRef<MapHandle>(null);

  const [types, setTypes] = useState<ComponentType[]>([]);
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [mapReady, setMapReady] = useState(false);
  const [tileVersion, setTileVersion] = useState(0);
  const [graph, setGraph] = useState<Record<string, any> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const [mode, setMode] = useState<DrawMode>({ kind: 'select' });
  const modeRef = useRef<DrawMode>(mode);
  modeRef.current = mode;
  const [selected, setSelected] = useState<GeoFeature | null>(null);
  const [selLoading, setSelLoading] = useState(false);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [basemapPref, setBasemapPref] = useState<BasemapPref>('auto');
  const [labels, setLabels] = useState(true);
  const [tab, setTab] = useState<Tab>('layers');
  const [panelOpen, setPanelOpen] = useState(true);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceSeed, setTraceSeed] = useState<TraceSeed | null>(null);
  const [cursor, setCursor] = useState({ lng: 0, lat: 0, zoom: 0 });
  const [wsOk, setWsOk] = useState(false);
  const [lastEvent, setLastEvent] = useState<string>('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [measure, setMeasure] = useState<MeasureResult | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [area, setArea] = useState<[number, number][] | null>(null);

  const canEdit = has('gis.edit');
  const canTrace = has('gis.trace');
  const canManeuver = OPERATE_PERMS.some((x) => has(x));
  const typeName = useCallback(
    (c: string) => {
      const x = types.find((y) => y.code === c);
      return x ? pick(x.name, x.name_en) : c;
    },
    [types, pick],
  );

  const effectiveBasemap: BasemapKind = basemapPref === 'auto' ? (resolved === 'dark' ? 'dark' : 'light') : basemapPref;

  // ------------------------------------------------------------ data awal
  useEffect(() => {
    setBasemapPref(readBasemapPref());
    api<{ configs: Record<string, string>; types: ComponentType[]; tile_version: number; graph: any }>('/api/config/public')
      .then((r) => {
        setTypes(r.types);
        setConfigs(r.configs);
        setTileVersion(r.tile_version);
        setGraph(r.graph);
        setVisible(new Set(r.types.map((x) => x.code)));
        const [lng, lat] = (r.configs['app.map_center'] || '106.8330,-6.1760').split(',').map(Number);
        setCursor({ lng, lat, zoom: Number(r.configs['app.map_zoom'] || 13) });
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = setInterval(() => {
      api('/api/gis/topology/status').then(setGraph).catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, [loaded]);

  // ------------------------------------------------------------ realtime
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(
    (version?: number) => {
      const delay = Number(configs['loading.realtime_debounce_ms'] || 500);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        mapRef.current?.refreshTiles(version);
        if (version) setTileVersion(version);
      }, delay);
    },
    [configs],
  );

  const reloadSelected = useCallback(async (kind: 'node' | 'edge', id: number) => {
    try {
      const f = await api<GeoFeature>(`/api/gis/features/${kind}/${id}`);
      setSelected(f);
      mapRef.current?.setSelected(f);
      return f;
    } catch {
      setSelected(null);
      mapRef.current?.setSelected(null);
      return null;
    }
  }, []);

  useEffect(() => {
    realtime.connect();
    const offStatus = realtime.onStatus(setWsOk);
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type.startsWith('feature.')) {
        scheduleRefresh(ev.tile_version);
        const action = ev.type.replace('feature.', '');
        setLastEvent(`${action} ${ev.kind} #${ev.id} ${t('map.by')} ${ev.username || '-'}`);
        if (ev.username && ev.username !== user?.username) {
          toast.push(t('map.realtime_event', { user: ev.username, action, type: ev.type_code || ev.kind || '', id: ev.id ?? '' }), 'info');
        }
        setSelected((cur) => {
          if (cur && ev.affected?.includes(cur.id) && ev.username !== user?.username) {
            reloadSelected(cur.properties.kind, cur.id);
          }
          return cur;
        });
      } else if (ev.type === 'topology.rebuilt') {
        toast.push(t('map.graph_reloaded'), 'success');
        api('/api/gis/topology/status').then(setGraph).catch(() => {});
      } else if (ev.type === 'maneuver') {
        scheduleRefresh(ev.tile_version);
        const msg = ev.data?.message || `${ev.data?.action || ''} ${ev.data?.node_code || ''}`;
        setLastEvent(`${t('map.maneuver_event', { msg })} ${t('map.by')} ${ev.username || '-'}`);
        if (ev.username && ev.username !== user?.username) toast.push(t('map.maneuver_event', { msg }), 'warning');
        setSelected((cur) => {
          if (cur) reloadSelected(cur.properties.kind, cur.id);
          return cur;
        });
        api('/api/gis/topology/status').then(setGraph).catch(() => {});
      } else if (ev.type === 'energized') {
        scheduleRefresh(ev.tile_version);
        setLastEvent(t('map.energized_event'));
        setSelected((cur) => {
          if (cur) reloadSelected(cur.properties.kind, cur.id);
          return cur;
        });
      }
    });
    return () => {
      off();
      offStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleRefresh, user?.username, t]);

  // ------------------------------------------------------------ seleksi
  const select = useCallback(
    async (kind: 'node' | 'edge', id: number) => {
      setSelLoading(true);
      setTab('feature');
      setPanelOpen(true);
      try {
        const f = await api<GeoFeature>(`/api/gis/features/${kind}/${id}`);
        setSelected(f);
        mapRef.current?.setSelected(f);
        return f;
      } catch (e: any) {
        toast.push(e.message, 'error');
        return null;
      } finally {
        setSelLoading(false);
      }
    },
    [toast],
  );

  const clearSelection = () => {
    setSelected(null);
    mapRef.current?.setSelected(null);
  };

  // ?select=node:123 (mis. dari halaman monitoring): pilih & arahkan peta ke objek tersebut
  useEffect(() => {
    if (!loaded) return;
    const q = new URLSearchParams(window.location.search).get('select');
    if (!q) return;
    const [k, idStr] = q.split(':');
    const fid = Number(idStr);
    if ((k !== 'node' && k !== 'edge') || !fid) return;
    select(k, fid).then((f) => {
      const b = f ? bboxOf([f]) : null;
      if (b) setTimeout(() => mapRef.current?.fitBBox(b), 600);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // ------------------------------------------------------------ editing
  const afterEdit = useCallback(
    (res: EditResult) => {
      const v = res.feature?.properties?.tile_version as number | undefined;
      mapRef.current?.refreshTiles(v);
      if (v) setTileVersion(v);
      if (res.messages?.length) toast.push(res.messages.join(' · '), 'info');
      api('/api/gis/topology/status').then(setGraph).catch(() => {});
    },
    [toast],
  );

  const createPoint = useCallback(
    async (typeCode: string, lng: number, lat: number) => {
      try {
        const res = await api<EditResult>('/api/gis/features', { method: 'POST', body: { kind: 'node', type_code: typeCode, geometry: { type: 'Point', coordinates: [lng, lat] } } });
        afterEdit(res);
        toast.push(t('map.created', { type: typeName(typeCode), id: res.id }), 'success');
        select('node', res.id);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [afterEdit, select, toast, typeName, t],
  );

  const createPolygon = useCallback(
    async (typeCode: string, ring: [number, number][]) => {
      try {
        const res = await api<EditResult>('/api/gis/features', {
          method: 'POST',
          body: { kind: 'node', type_code: typeCode, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } },
        });
        afterEdit(res);
        toast.push(t('map.created', { type: typeName(typeCode), id: res.id }), 'success');
        select('node', res.id);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [afterEdit, select, toast, typeName, t],
  );

  const createLine = useCallback(
    async (typeCode: string, coords: [number, number][]) => {
      try {
        const res = await api<EditResult>('/api/gis/features', { method: 'POST', body: { kind: 'edge', type_code: typeCode, geometry: { type: 'LineString', coordinates: coords } } });
        afterEdit(res);
        toast.push(t('map.created', { type: typeName(typeCode), id: res.id }), 'success');
        select('edge', res.id);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [afterEdit, select, toast, typeName, t],
  );

  const moveNode = useCallback(
    async (nodeId: number, lng: number, lat: number) => {
      try {
        const res = await api<EditResult>(`/api/gis/features/node/${nodeId}`, { method: 'PUT', body: { geometry: { type: 'Point', coordinates: [lng, lat] } } });
        afterEdit(res);
        toast.push(t('map.moved', { id: nodeId }), 'success');
        setMode({ kind: 'select' });
        select('node', nodeId);
      } catch (e: any) {
        toast.push(e.message, 'error');
        setMode({ kind: 'select' });
      }
    },
    [afterEdit, select, toast, t],
  );

  const reshapeEdge = useCallback(
    async (edgeId: number, coords: [number, number][]) => {
      try {
        const res = await api<EditResult>(`/api/gis/features/edge/${edgeId}`, { method: 'PUT', body: { geometry: { type: 'LineString', coordinates: coords } } });
        afterEdit(res);
        toast.push(t('map.reshaped', { id: edgeId }), 'success');
        setMode({ kind: 'select' });
        select('edge', edgeId);
      } catch (e: any) {
        toast.push(e.message, 'error');
        setMode({ kind: 'select' });
      }
    },
    [afterEdit, select, toast, t],
  );

  const reshapePolygon = useCallback(
    async (nodeId: number, ring: [number, number][]) => {
      try {
        const res = await api<EditResult>(`/api/gis/features/node/${nodeId}`, { method: 'PUT', body: { geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } } });
        afterEdit(res);
        toast.push(t('map.reshaped_building', { id: nodeId }), 'success');
        setMode({ kind: 'select' });
        select('node', nodeId);
      } catch (e: any) {
        toast.push(e.message, 'error');
        setMode({ kind: 'select' });
      }
    },
    [afterEdit, select, toast, t],
  );

  const splitEdge = useCallback(
    async (edgeId: number, lng: number, lat: number) => {
      try {
        const res = await api<EditResult>(`/api/gis/edges/${edgeId}/split`, { method: 'POST', body: { lng, lat } });
        afterEdit(res);
        toast.push(t('map.split_done', { id: edgeId }), 'success');
        setMode({ kind: 'select' });
        if (res.feature) select('node', res.feature.id);
      } catch (e: any) {
        toast.push(e.message, 'error');
        setMode({ kind: 'select' });
      }
    },
    [afterEdit, select, toast, t],
  );

  const mergeAtJunction = useCallback(
    async (nodeId: number) => {
      try {
        const res = await api<EditResult>(`/api/gis/nodes/${nodeId}/merge`, { method: 'POST' });
        afterEdit(res);
        toast.push(t('map.merge_done', { id: res.id }), 'success');
        select('edge', res.id);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [afterEdit, select, toast, t],
  );

  /** Menyiapkan sesi edit vertex: untuk node, ambil geometri garis-garis yang terhubung agar ikut bergerak. */
  const startVertexEdit = useCallback(
    async (target: 'edge' | 'node', id: number, feature?: GeoFeature | null) => {
      let f = feature ?? null;
      if (!f || f.id !== id || (f.properties.kind as string) !== target) f = await reloadSelected(target, id);
      if (!f) return;
      let connected: ConnectedEdge[] = [];
      if (target === 'node') {
        try {
          const nb = await api<{ items: any[] }>(`/api/gis/nodes/${id}/neighbors`);
          const feats = await Promise.all(nb.items.slice(0, 24).map((n) => api<GeoFeature>(`/api/gis/features/edge/${n.edge_id}`)));
          connected = feats.map((ef) => ({ edgeId: ef.id, coords: ef.geometry.coordinates as [number, number][], endIndex: ef.properties.from_node_id === id ? 0 : -1 }));
        } catch {
          connected = [];
        }
      }
      setMode({ kind: 'vertex', target, id });
      // tunggu efek mode (yang membersihkan sesi) selesai, lalu mulai sesi
      setTimeout(() => mapRef.current?.startVertexEdit(f!, connected), 0);
    },
    [reloadSelected],
  );

  const vertexCommit = useCallback(
    async (target: 'edge' | 'node', id: number, geometry: any) => {
      try {
        const res = await api<EditResult>(`/api/gis/features/${target}/${id}`, { method: 'PUT', body: { geometry } });
        afterEdit(res);
        const f = res.feature || (await reloadSelected(target, id));
        if (f) {
          setSelected(f);
          mapRef.current?.setSelected(f);
        }
        // sesi tetap aktif dengan geometri terbaru (ujung mungkin di-snap server)
        if (modeRef.current.kind === 'vertex') await startVertexEdit(target, id, f);
      } catch (e: any) {
        toast.push(e.message, 'error');
        const f = await reloadSelected(target, id);
        if (modeRef.current.kind === 'vertex' && f) await startVertexEdit(target, id, f);
      }
    },
    [afterEdit, reloadSelected, startVertexEdit, toast],
  );

  const saveAttrs = useCallback(
    async (kind: 'node' | 'edge', id: number, body: any) => {
      try {
        const res = await api<EditResult>(`/api/gis/features/${kind}/${id}`, { method: 'PUT', body });
        afterEdit(res);
        toast.push(t('map.attrs_saved'), 'success');
        if (res.feature) {
          setSelected(res.feature);
          mapRef.current?.setSelected(res.feature);
        }
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [afterEdit, toast, t],
  );

  const doManeuver = useCallback(
    async (targetId: number, body: ManeuverBody) => {
      const { target = 'node', ...rest } = body;
      try {
        const res = await api<{ message: string; tile_version: number; feature?: GeoFeature }>('/api/gis/maneuver', {
          method: 'POST',
          body: target === 'edge' ? { edge_id: targetId, ...rest } : { node_id: targetId, ...rest },
        });
        mapRef.current?.refreshTiles(res.tile_version);
        if (res.tile_version) setTileVersion(res.tile_version);
        toast.push(res.message, body.action === 'open' ? 'warning' : 'success');
        if (res.feature) {
          setSelected(res.feature);
          mapRef.current?.setSelected(res.feature);
        } else await reloadSelected(target, targetId);
        api('/api/gis/topology/status').then(setGraph).catch(() => {});
      } catch (e: any) {
        toast.push(e.message, 'error');
        throw e;
      }
    },
    [reloadSelected, toast],
  );

  const deleteFeature = useCallback(
    async (kind: 'node' | 'edge', id: number) => {
      try {
        const res = await api<EditResult>(`/api/gis/features/${kind}/${id}`, { method: 'DELETE' });
        afterEdit(res);
        toast.push(t('map.deleted', { kind: kind === 'node' ? t('map.node') : t('map.edge'), id }), 'success');
        setMode({ kind: 'select' });
        clearSelection();
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [afterEdit, toast, t],
  );

  const boundary = useBoundaryOverlay(mapRef, configs, mapReady);

  // ------------------------------------------------------------ trace
  const onTraceResult = useCallback((r: TraceResponse | null) => {
    setTrace(r);
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

  const startTrace = (nodeId: number, direction: 'down' | 'up' | 'connected') => {
    setTab('trace');
    setPanelOpen(true);
    setTraceSeed({ nodeId, direction, nonce: Date.now() });
  };

  // ------------------------------------------------------------ tampilan
  useEffect(() => {
    if (loaded) mapRef.current?.setVisibleTypes(Array.from(visible));
  }, [visible, loaded]);
  useEffect(() => {
    mapRef.current?.setBasemap(effectiveBasemap);
    mapRef.current?.setDarkLabels(effectiveBasemap === 'dark');
  }, [effectiveBasemap]);
  useEffect(() => {
    mapRef.current?.setLabelsVisible(labels);
  }, [labels]);
  useEffect(() => {
    mapRef.current?.setColorMode(colorMode);
  }, [colorMode]);

  const changeBasemap = (v: BasemapPref) => {
    setBasemapPref(v);
    try {
      window.localStorage.setItem(BASEMAP_KEY, v);
    } catch {
      /* abaikan */
    }
  };

  const modeText = useMemo(() => modeLabel(mode, typeName, t), [mode, typeName, t]);

  if (error) return <div className="p-6 text-sm text-red-700">{t('map.config_failed', { msg: error })}</div>;
  if (!loaded)
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Spinner size={28} />
      </div>
    );

  const tabBtn = (tb: Tab, label: string) => (
    <button
      className={`flex-1 border-b-2 px-2 py-2 text-xs font-medium ${tab === tb ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
      onClick={() => setTab(tb)}
    >
      {label}
    </button>
  );

  return (
    <div className="relative h-full w-full">
      <MapCanvas
        ref={mapRef}
        types={types}
        configs={configs}
        initialVersion={tileVersion}
        initialBasemap={effectiveBasemap}
        mode={mode}
        onSelect={select}
        onCreatePoint={createPoint}
        onCreatePolygon={createPolygon}
        onCreateLine={createLine}
        onMove={moveNode}
        onReshape={reshapeEdge}
        onReshapePolygon={reshapePolygon}
        onSplit={splitEdge}
        onVertexCommit={vertexCommit}
        onMeasure={setMeasure}
        onCursor={(lng, lat, zoom) => setCursor({ lng, lat, zoom })}
        onCancelMode={() => setMode({ kind: 'select' })}
        onReady={() => {
          setMapReady(true);
          mapRef.current?.setVisibleTypes(Array.from(visible));
          mapRef.current?.setBasemap(effectiveBasemap);
          mapRef.current?.setDarkLabels(effectiveBasemap === 'dark');
          mapRef.current?.setColorMode(colorMode);
        }}
        onError={(src, msg) => toast.push(t('map.source_error', { source: src || '-', msg: msg.slice(0, 120) }), 'warning')}
        onArea={(ring) => {
          setArea(ring);
          setMode({ kind: 'select' });
        }}
      />

      <div className="absolute left-3 top-3 z-10 flex items-start gap-2">
        <DrawToolbar types={types} mode={mode} onMode={setMode} canEdit={canEdit} />
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <SearchBox
              typeName={typeName}
              onPick={(h) => {
                mapRef.current?.flyTo(h.lng, h.lat, 17);
                select(h.kind, h.id);
              }}
            />
            <button
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 shadow-lg hover:bg-gray-100 ${helpOpen ? 'text-brand-700' : ''}`}
              onClick={() => setHelpOpen(!helpOpen)}
              title={t('help.title')}
              aria-label={t('help.title')}
            >
              <Icon name="info" size={18} />
            </button>
          </div>
          <div className={`w-fit max-w-md rounded-md px-2 py-1 text-xs shadow ${mode.kind === 'select' ? 'bg-white/90 text-gray-600' : 'bg-amber-100 text-amber-900'}`}>
            {modeText}
            {mode.kind !== 'select' && (
              <button className="ml-2 underline" onClick={() => setMode({ kind: 'select' })}>
                {t('common.cancel')}
              </button>
            )}
          </div>
          {helpOpen && (
            <div className="w-[26rem] max-w-[calc(100vw-6rem)] rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-800 shadow-xl">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">{t('help.title')}</span>
                <button className="text-gray-500 hover:text-gray-800" onClick={() => setHelpOpen(false)} aria-label={t('common.close')}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              {!canEdit && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-amber-900">{t('help.no_edit')}</div>}
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>{t('help.step_point')}</li>
                <li>{t('help.step_polygon')}</li>
                <li>{t('help.step_line')}</li>
                <li>{t('help.step_snap')}</li>
                <li>{t('help.step_vertex')}</li>
                <li>{t('help.step_edit')}</li>
                <li>{t('help.step_measure')}</li>
                <li>{t('help.step_trace')}</li>
                <li>{t('help.step_maneuver')}</li>
              </ol>
              <div className="mt-2 text-gray-500">{t('help.keys')}</div>
            </div>
          )}
        </div>
      </div>

      {measure && (
        <div className="absolute bottom-10 left-3 z-10 w-64 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-800 shadow-xl">
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
          {measure.segments.length > 0 && (
            <div className="mt-1 max-h-20 overflow-y-auto text-[11px] text-gray-500">
              {measure.segments.map((s, i) => (
                <span key={i} className="mr-2 inline-block">
                  {i + 1}: {fmtDistance(s)}
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 text-[11px] text-gray-500">{measure.done ? t('measure.done_hint') : t('measure.hint')}</div>
        </div>
      )}

      <div className={`absolute right-3 top-3 z-10 mr-11 flex max-h-[calc(100%-4.5rem)] flex-col rounded-lg border border-gray-200 bg-white shadow-xl transition-all ${panelOpen ? 'w-[22rem]' : 'w-10'}`}>
        <div className="flex items-center border-b border-gray-200">
          {panelOpen && (
            <>
              {tabBtn('layers', t('map.tab_layers'))}
              {tabBtn('feature', selected ? t('map.tab_feature_id', { id: selected.id }) : t('map.tab_feature'))}
              {canTrace && tabBtn('trace', t('map.tab_trace'))}
              {tabBtn('data', t('map.tab_data'))}
            </>
          )}
          <button className="p-2 text-gray-500 hover:text-gray-800" onClick={() => setPanelOpen(!panelOpen)} aria-label={t('map.collapse_panel')}>
            <Icon name={panelOpen ? 'chevron-right' : 'layers'} size={16} />
          </button>
        </div>
        {panelOpen && (
          <div className="flex-1 overflow-y-auto p-3">
            {tab === 'layers' && (
              <LayerPanel
                types={types}
                visible={visible}
                onVisible={setVisible}
                basemap={basemapPref}
                onBasemap={changeBasemap}
                labels={labels}
                onLabels={setLabels}
                colorMode={colorMode}
                onColorMode={setColorMode}
                onReload={() => mapRef.current?.refreshTiles()}
                graph={graph}
                canEdit={canEdit}
                zoom={cursor.zoom}
                overlay={<BoundaryControl state={boundary} />}
              />
            )}
            {tab === 'feature' && (
              <FeaturePanel
                feature={selected}
                loading={selLoading}
                types={types}
                canEdit={canEdit}
                canTrace={canTrace}
                canManeuver={canManeuver}
                onManeuver={doManeuver}
                onSave={saveAttrs}
                onDelete={deleteFeature}
                onMove={(id) => setMode({ kind: 'move', nodeId: id })}
                onReshape={(id, tc) => setMode({ kind: 'reshape', edgeId: id, typeCode: tc })}
                onReshapePolygon={(id) => setMode({ kind: 'reshape-polygon', nodeId: id })}
                onVertex={(target, id) => startVertexEdit(target, id, selected)}
                onSplit={(id) => setMode({ kind: 'split', edgeId: id })}
                onMerge={mergeAtJunction}
                onTrace={startTrace}
                onSelect={select}
                onFlyTo={() => {
                  const b = selected ? bboxOf([selected]) : null;
                  if (b) mapRef.current?.fitBBox(b);
                }}
              />
            )}
            {tab === 'trace' && canTrace && (
              <TracePanel
                types={types}
                seed={traceSeed}
                selectedNodeId={selected?.properties.kind === 'node' ? selected.id : null}
                result={trace}
                onResult={onTraceResult}
                onSelect={(k, id) => {
                  select(k, id);
                  const f = trace?.geojson.features.find((x) => x.id === id && x.properties.kind === k);
                  const b = f ? bboxOf([f]) : null;
                  if (b) mapRef.current?.fitBBox(b);
                }}
              />
            )}
            {tab === 'data' && (
              <ExchangePanel
                mapRef={mapRef}
                types={types}
                visibleTypes={Array.from(visible)}
                format="geojson"
                allowImport={canEdit}
                area={area}
                drawing={mode.kind === 'area'}
                onDrawArea={() => setMode({ kind: 'area' })}
                onClearArea={() => {
                  setArea(null);
                  mapRef.current?.setArea(null);
                }}
                onImported={() => {
                  mapRef.current?.refreshTiles();
                  api('/api/gis/topology/status').then(setGraph).catch(() => {});
                }}
              />
            )}
          </div>
        )}
      </div>

      {mode.kind === 'vertex' && (
        <div className="absolute bottom-10 right-3 z-10 mr-11 flex items-center gap-2 rounded-md bg-white/95 px-3 py-1.5 text-xs text-gray-700 shadow">
          <Icon name="vertices" size={14} />
          <span>{mode.target === 'edge' ? t('feature.vertex_hint') : t('feature.drag_node_hint')}</span>
          <Button size="sm" onClick={() => setMode({ kind: 'select' })}>
            {t('common.done')}
          </Button>
        </div>
      )}

      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-3 rounded-md bg-white/90 px-3 py-1 text-[11px] text-gray-700 shadow">
        <span className="font-mono">
          {cursor.lng.toFixed(6)}, {cursor.lat.toFixed(6)}
        </span>
        <span>z {cursor.zoom.toFixed(1)}</span>
        <span title={t('map.tile_version')}>v{tileVersion}</span>
        <span className="flex items-center gap-1" title={wsOk ? t('map.realtime_on') : t('map.realtime_off')}>
          <span className={`inline-block h-2 w-2 rounded-full ${wsOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {t('map.realtime')}
        </span>
        {lastEvent && <span className="max-w-xs truncate text-gray-500">{lastEvent}</span>}
      </div>
    </div>
  );
}
