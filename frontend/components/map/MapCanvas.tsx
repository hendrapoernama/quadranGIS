'use client';

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl, { Map as MLMap, MapMouseEvent, MapLayerMouseEvent, GeoJSONSource, VectorTileSource, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { API_BASE, api, getToken } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { closestOnPolyline, fmtArea, fmtDistance, haversine, metersPerPixel, midpoint, pathLength, ringArea } from '@/lib/geo';
import { useT } from '@/lib/i18n';
import type { ComponentType, FeatureCollection, GeoFeature } from '@/lib/types';
import {
  BOUNDARY_LAYERS,
  NODE_LAYERS,
  OFF_SOURCE,
  SOURCE,
  applyColorMode,
  baseFilters,
  buildLayers,
  energizedExpr,
  feederIdExpr,
  offClusterRadius,
  offMarkerLayers,
  typeFilter,
  typeFilteredLayers,
  type ColorMode,
  type FeederStyle,
} from './mapStyle';
import { registerSymbols } from './symbols';
import type { BasemapKind, ConnectedEdge, DrawMode, MapHandle, MeasureResult, BoundaryStyle, OffMarker, ParallelItem } from './types';

interface Props {
  types: ComponentType[];
  configs: Record<string, string>;
  initialVersion: number;
  initialBasemap: BasemapKind;
  /** pewarnaan awal: per tipe (peta jaringan) atau status nyala/padam (monitoring) */
  initialColorMode?: ColorMode;
  mode: DrawMode;
  onSelect: (kind: 'node' | 'edge', id: number) => void;
  onCreatePoint: (typeCode: string, lng: number, lat: number) => Promise<void>;
  onCreatePolygon: (typeCode: string, ring: [number, number][]) => Promise<void>;
  onCreateLine: (typeCode: string, coords: [number, number][]) => Promise<void>;
  onMove: (nodeId: number, lng: number, lat: number) => Promise<void>;
  onReshape: (edgeId: number, coords: [number, number][]) => Promise<void>;
  onReshapePolygon: (nodeId: number, ring: [number, number][]) => Promise<void>;
  onSplit: (edgeId: number, lng: number, lat: number) => Promise<void>;
  onVertexCommit: (target: 'edge' | 'node', id: number, geometry: any) => Promise<void>;
  onMeasure: (r: MeasureResult | null) => void;
  onCursor: (lng: number, lat: number, zoom: number) => void;
  onCancelMode: () => void;
  onReady?: () => void;
  onError?: (sourceId: string, message: string) => void;
  /** poligon area seleksi selesai digambar (mode 'area') */
  onArea?: (ring: [number, number][]) => void;
  /** tampilan peta berubah (selesai digeser / tile selesai dimuat), mis. untuk legenda penyulang */
  onViewChanged?: () => void;
  /** parameter tambahan untuk snap (mis. `cs=12`: titik usulan paket perubahan ikut disnap) */
  snapQuery?: string;
}

/** Layer penanda padam yang dapat diklik (gelombang tidak ikut: terlalu lebar). */
const OFF_CLICK_LAYERS = ['offmark-cluster', 'offmark-cluster-count', 'offmark-dot', 'offmark-icon'];
const OFF_BLINK_MS = 700; // lama satu keadaan kedip (terang / redup)
/** Penanda penyulang paralel (kuning tua: peringatan operasi, bukan padam). */
const PAR_COLOR = '#d97706';

/** Lapisan pratinjau paket perubahan: tambah (oranye), ubah (biru), hapus (merah), pisah/gabung (ungu). */
const DRAFT_COLOR: any = ['match', ['get', 'op'], 'create', '#f97316', 'update', '#2563eb', 'delete', '#dc2626', '#9333ea'];
const DRAFT_LAYERS = ['draft-fill', 'draft-line', 'draft-point'];

type Coord = [number, number];
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

interface EditSession {
  target: 'edge' | 'node';
  id: number;
  coords: Coord[];
  connected: ConnectedEdge[];
  drag: null | { type: 'vertex' | 'node'; index: number };
}

function tileUrl(version: number) {
  const base = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/api/gis/tiles/{z}/{x}/{y}.pbf?v=${version}`;
}

let fid = 1;
const pt = (c: Coord, props: Record<string, any> = {}): GeoFeature => ({ type: 'Feature', id: fid++, geometry: { type: 'Point', coordinates: c }, properties: props });
const ln = (c: Coord[], props: Record<string, any> = {}): GeoFeature => ({ type: 'Feature', id: fid++, geometry: { type: 'LineString', coordinates: c }, properties: props });
const pg = (ring: Coord[], props: Record<string, any> = {}): GeoFeature => ({ type: 'Feature', id: fid++, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: props });
const dedupe = (arr: Coord[]) => arr.filter((c, i) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1]);

const MapCanvas = forwardRef<MapHandle, Props>(function MapCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const p = useRef(props);
  p.current = props;
  const draw = useRef<Coord[]>([]);
  const measureDone = useRef(false);
  const versionRef = useRef(props.initialVersion);
  const busy = useRef(false);
  const pendingSnap = useRef<Promise<unknown> | null>(null);
  const session = useRef<EditSession | null>(null);
  const colorMode = useRef<ColorMode>(props.initialColorMode || 'type');
  const feederStyle = useRef<FeederStyle>({ colors: {}, live: true, highlight: null });
  const visibleCodes = useRef<string[] | null>(null);
  const energyFilter = useRef<'all' | 'on' | 'off'>('all');
  const feederFilter = useRef<{ ids: Set<number>; live: boolean } | null>(null);
  /** id penyulang sebuah objek (properti tile / penanda: fdr normal, fdl penyuplai saat ini bila berbeda) */
  const feederOf = (pr: { fdr?: number | null; fdl?: number | null }, live: boolean) => Number(live && pr.fdl != null ? pr.fdl : pr.fdr ?? 0);
  const { t, pick } = useT();
  const i18n = useRef({ t, pick });
  i18n.current = { t, pick };

  // ------------------------------------------------------------ penanda padam (berkedip / cluster merah)
  const offData = useRef<OffMarker[] | null>(null);
  const offTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const offTip = useRef<Popup | null>(null);
  const offTipId = useRef<number | null>(null);

  /** Kedip dua keadaan: simbol terang ↔ simbol redup + cincin merah (peta digambar ulang ±1,4 kali/detik). */
  const blinkFrame = (on: boolean) => {
    const map = mapRef.current;
    if (!map || !map.getLayer('offmark-icon')) return;
    map.setPaintProperty('offmark-pulse', 'circle-opacity', on ? 0 : 0.3);
    map.setPaintProperty('offmark-pulse', 'circle-stroke-opacity', on ? 0 : 0.9);
    map.setPaintProperty('offmark-icon', 'icon-opacity', on ? 1 : 0.2);
    map.setPaintProperty('offmark-dot', 'circle-opacity', on ? 1 : 0.2);
    map.setPaintProperty('offmark-dot', 'circle-stroke-opacity', on ? 1 : 0.2);
    map.setPaintProperty('offmark-cluster-halo', 'circle-radius', ['+', offClusterRadius, on ? 5 : 10]);
    map.setPaintProperty('offmark-cluster-halo', 'circle-opacity', on ? 0.35 : 0.15);
  };
  const offShown = useRef<OffMarker[]>([]);
  const parData = useRef<ParallelItem[] | null>(null);
  /** Penanda paralel: satu per tie penyebab (atau di titik temu bila tie tidak dikenali). */
  const renderPar = () => {
    const src = mapRef.current?.getSource('parallel') as GeoJSONSource | undefined;
    if (!src) return;
    const { t: tt } = i18n.current;
    const features: GeoFeature[] = [];
    const ff = feederFilter.current;
    for (const it of parData.current || []) {
      if (ff && !ff.ids.has(it.a.id) && !ff.ids.has(it.b.id)) continue;
      const label = tt('par.map_label', { a: it.a.code || `#${it.a.id}`, b: it.b.code || `#${it.b.id}` });
      const spots = it.ties.length > 0 ? it.ties.map((x) => ({ c: [x.lng, x.lat] as Coord, id: x.id })) : [{ c: [it.meet.lng, it.meet.lat] as Coord, id: 0 }];
      for (const sp of spots) features.push(pt(sp.c, { label, node_id: sp.id }));
    }
    src.setData({ type: 'FeatureCollection', features } as any);
  };
  const offKey = useRef<string | null>(null);
  const stopBlink = () => {
    if (offTimer.current) clearInterval(offTimer.current);
    offTimer.current = null;
  };
  // kedip hanya selama ada penanda di area tampilan; tanpa kedip (cincin statis) bila pengguna memilih gerak dikurangi
  const updateBlink = () => {
    const map = mapRef.current;
    const b = map?.getBounds();
    const inView = !!b && offShown.current.some((m) => b.contains([m.lng, m.lat]));
    if (!inView || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      stopBlink();
      return;
    }
    if (offTimer.current) return;
    let on = true;
    offTimer.current = setInterval(() => {
      if (document.hidden) return;
      on = !on;
      blinkFrame(on);
    }, OFF_BLINK_MS);
  };

  /** Isi sumber penanda padam: hanya tipe yang tampil, disembunyikan saat filter "nyala". */
  const renderOff = () => {
    const src = mapRef.current?.getSource(OFF_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    const codes = visibleCodes.current ? new Set(visibleCodes.current) : null;
    const ff = feederFilter.current;
    const items =
      energyFilter.current === 'on' ? [] : (offData.current || []).filter((m) => (!codes || codes.has(m.type_code)) && (!ff || ff.ids.has(feederOf(m, ff.live))));
    offShown.current = items;
    // pembaruan berkala dengan isi sama tidak mengisi ulang sumber (cluster tidak dihitung ulang)
    const key = items.map((m) => `${m.id}:${m.outage_id ?? ''}:${m.lng},${m.lat}`).join('|');
    if (key === offKey.current) {
      updateBlink();
      return;
    }
    offKey.current = key;
    src.setData({
      type: 'FeatureCollection',
      features: items.map((m) => ({
        type: 'Feature',
        id: m.id,
        geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
        properties: { id: m.id, type_code: m.type_code, code: m.code, name: m.name, outage_id: m.outage_id, outage_kind: m.outage_kind, since: m.since },
      })),
    } as any);
    updateBlink();
  };

  /** Keterangan singkat saat kursor di atas penanda padam (teks dari data, tanpa HTML). */
  const showOffTip = (map: MLMap, e: MapMouseEvent) => {
    const hit = map.getLayer('offmark-icon')
      ? map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: ['offmark-icon', 'offmark-dot'] })[0]
      : undefined;
    if (!hit || hit.geometry.type !== 'Point') {
      offTip.current?.remove();
      offTipId.current = null;
      return;
    }
    const pr = hit.properties || {};
    if (offTipId.current === Number(pr.id)) return;
    offTipId.current = Number(pr.id);
    const { t: tt, pick: pk } = i18n.current;
    const ct = p.current.types.find((x) => x.code === pr.type_code);
    const el = document.createElement('div');
    const line = (text: string, cls = '') => {
      const d = document.createElement('div');
      d.textContent = text;
      if (cls) d.className = cls;
      el.appendChild(d);
    };
    line(pr.code || `#${pr.id}`, 'font-semibold');
    if (pr.name && pr.name !== pr.code) line(pr.name);
    line(`${ct ? pk(ct.name, ct.name_en) : pr.type_code} · ${tt('offmark.off')}`, 'offmark-tip-state');
    line(pr.outage_id ? tt('offmark.outage', { id: pr.outage_id, kind: pr.outage_kind || '-', since: fmtDate(pr.since) }) : tt('offmark.no_outage'), 'offmark-tip-sub');
    if (!offTip.current) offTip.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, maxWidth: '280px', className: 'offmark-tip' });
    offTip.current
      .setLngLat(hit.geometry.coordinates as Coord)
      .setDOMContent(el)
      .addTo(map);
  };

  /** Filter gabungan: tipe yang tampil + status kelistrikan (semua / nyala / padam). */
  const applyFilters = () => {
    const map = mapRef.current;
    if (!map) return;
    const parts: any[] = [];
    if (visibleCodes.current) parts.push(typeFilter(visibleCodes.current));
    if (energyFilter.current !== 'all') parts.push(['==', energizedExpr(), energyFilter.current === 'on']);
    const ff = feederFilter.current;
    if (ff) parts.push(['in', feederIdExpr(ff.live), ['literal', Array.from(ff.ids)]]);
    for (const id of typeFilteredLayers) {
      if (!map.getLayer(id)) continue;
      const all = [...(baseFilters[id] ? [baseFilters[id]] : []), ...parts];
      // kepadatan tidak punya status & penyulang: disembunyikan saat memfilter padam / penyulang
      if ((id === 'density' || id === 'density-label') && (energyFilter.current === 'off' || ff)) all.push(['!', true]);
      map.setFilter(id, all.length === 0 ? null : all.length === 1 ? all[0] : ['all', ...all]);
    }
    renderOff();
  };
  const darkRef = useRef(props.initialBasemap === 'dark');

  // ------------------------------------------------------------ helpers
  const boundaryData = useRef<FeatureCollection | null>(null);
  const boundaryStyle = useRef<BoundaryStyle>({ show: true, ulp: false, labels: true, opacity: 0.15 });
  const applyBoundary = () => {
    const map = mapRef.current;
    if (!map || !map.getLayer('bnd-fill')) return;
    const st = boundaryStyle.current;
    const vis: Record<string, boolean> = {
      'bnd-fill': st.show,
      'bnd-line': st.show,
      'bnd-ulp-line': st.show && st.ulp,
      'bnd-label': st.show && st.labels,
      'bnd-ulp-label': st.show && st.ulp && st.labels,
    };
    for (const id of BOUNDARY_LAYERS) map.setLayoutProperty(id, 'visibility', vis[id] ? 'visible' : 'none');
    map.setPaintProperty('bnd-fill', 'fill-opacity', Math.max(0, Math.min(1, st.opacity)));
  };
  const setSource = (id: string, data: FeatureCollection) => {
    const src = mapRef.current?.getSource(id) as GeoJSONSource | undefined;
    src?.setData(data as any);
  };
  const modeKind = () => p.current.mode.kind;
  const isLineDraw = () => modeKind() === 'line' || modeKind() === 'reshape';
  const isPolyDraw = () => modeKind() === 'polygon' || modeKind() === 'reshape-polygon' || modeKind() === 'area';
  const isMeasure = () => modeKind() === 'measure';
  const isDrawing = () => isLineDraw() || isPolyDraw() || isMeasure();

  const updateDraw = (cursor?: Coord) => {
    if (isMeasure()) {
      renderMeasure(cursor);
      return;
    }
    const coords = draw.current;
    const features: GeoFeature[] = [];
    const seq = cursor && coords.length > 0 && !isPolyDraw() ? [...coords, cursor] : cursor && coords.length > 0 ? [...coords, cursor] : coords;
    if (isPolyDraw() && seq.length >= 3) features.push(pg(seq));
    else if (seq.length >= 2) features.push(ln(seq));
    coords.forEach((c) => features.push(pt(c)));
    setSource('draw', { type: 'FeatureCollection', features });
  };

  const clearDraw = () => {
    draw.current = [];
    setSource('draw', EMPTY);
    setSource('snap', EMPTY);
  };

  const clearMeasure = () => {
    draw.current = [];
    measureDone.current = false;
    setSource('measure', EMPTY);
    p.current.onMeasure(null);
  };

  function renderMeasure(cursor?: Coord) {
    const mode = p.current.mode;
    if (mode.kind !== 'measure') return;
    const base = draw.current;
    const seq = cursor && base.length > 0 && !measureDone.current ? [...base, cursor] : base;
    const features: GeoFeature[] = [];
    const segments: number[] = [];
    for (let i = 1; i < seq.length; i++) segments.push(haversine(seq[i - 1], seq[i]));
    const lengthM = mode.what === 'area' && seq.length >= 3 ? pathLength([...seq, seq[0]]) : pathLength(seq);
    const areaM2 = mode.what === 'area' && seq.length >= 3 ? ringArea(seq) : 0;
    if (mode.what === 'area' && seq.length >= 3) features.push(pg(seq));
    else if (seq.length >= 2) features.push(ln(seq));
    base.forEach((c) => features.push(pt(c)));
    for (let i = 1; i < seq.length; i++) features.push(pt(midpoint(seq[i - 1], seq[i]), { label: fmtDistance(segments[i - 1]) }));
    if (seq.length >= 2) {
      const last = seq[seq.length - 1];
      const label = mode.what === 'area' && areaM2 > 0 ? `${fmtArea(areaM2)} · ${fmtDistance(lengthM)}` : `Σ ${fmtDistance(lengthM)}`;
      features.push(pt(last, { label }));
    }
    setSource('measure', { type: 'FeatureCollection', features });
    p.current.onMeasure({ what: mode.what, lengthM, areaM2, vertices: base.length, segments, done: measureDone.current });
  }

  function renderEdit() {
    const s = session.current;
    if (!s) {
      setSource('edit', EMPTY);
      return;
    }
    const features: GeoFeature[] = [];
    if (s.target === 'edge') {
      if (s.coords.length >= 2) features.push(ln(s.coords, { role: 'line' }));
      for (let i = 0; i < s.coords.length - 1; i++) features.push(pt(midpoint(s.coords[i], s.coords[i + 1]), { role: 'mid', idx: i }));
      s.coords.forEach((c, i) => features.push(pt(c, { role: 'vertex', idx: i })));
    } else {
      s.connected.forEach((ce) => features.push(ln(ce.coords, { role: 'conn' })));
      features.push(pt(s.coords[0], { role: 'node', idx: 0 }));
    }
    setSource('edit', { type: 'FeatureCollection', features });
  }

  async function snapPoint(lng: number, lat: number): Promise<Coord> {
    const map = mapRef.current;
    if (!map) return [lng, lat];
    const radius = Math.max(1, 8 * metersPerPixel(lat, map.getZoom()));
    try {
      const r = await api<{ items: { kind: string; lng: number; lat: number; dist_m: number }[] }>(
        `/api/gis/snap?lng=${lng}&lat=${lat}&radius_m=${radius.toFixed(2)}${p.current.snapQuery ? `&${p.current.snapQuery}` : ''}`,
      );
      const node = r.items.filter((i) => i.kind === 'node').sort((a, b) => a.dist_m - b.dist_m)[0];
      const edge = r.items.filter((i) => i.kind === 'edge').sort((a, b) => a.dist_m - b.dist_m)[0];
      const pick = node || edge;
      if (pick) return [pick.lng, pick.lat];
    } catch {
      /* tanpa snap */
    }
    return [lng, lat];
  }

  async function finishDraw() {
    const map = mapRef.current;
    if (!map) return;
    const mode = p.current.mode;
    if (mode.kind === 'measure') {
      if (draw.current.length >= 2) {
        measureDone.current = true;
        renderMeasure();
      }
      return;
    }
    if (pendingSnap.current) {
      try {
        await pendingSnap.current;
      } catch {
        /* abaikan */
      }
    }
    const coords = dedupe(draw.current);
    if (busy.current) return;
    if (mode.kind === 'line' || mode.kind === 'reshape') {
      if (coords.length < 2) return;
      clearDraw();
      busy.current = true;
      try {
        if (mode.kind === 'line') await p.current.onCreateLine(mode.typeCode, coords);
        else await p.current.onReshape(mode.edgeId, coords);
      } finally {
        busy.current = false;
      }
      return;
    }
    if (mode.kind === 'polygon') {
      if (coords.length === 0) return;
      clearDraw();
      busy.current = true;
      try {
        if (coords.length >= 3) await p.current.onCreatePolygon(mode.typeCode, coords);
        else await p.current.onCreatePoint(mode.typeCode, coords[0][0], coords[0][1]); // ukuran bawaan
      } finally {
        busy.current = false;
      }
      return;
    }
    if (mode.kind === 'area') {
      if (coords.length < 3) return;
      clearDraw();
      setSource('area', { type: 'FeatureCollection', features: [pg(coords)] });
      p.current.onArea?.(coords);
      return;
    }
    if (mode.kind === 'reshape-polygon') {
      if (coords.length < 3) return;
      clearDraw();
      busy.current = true;
      try {
        await p.current.onReshapePolygon(mode.nodeId, coords);
      } finally {
        busy.current = false;
      }
    }
  }

  const applyBasemap = (kind: BasemapKind) => {
    const map = mapRef.current;
    if (!map || !map.getLayer('basemap-light')) return;
    map.setLayoutProperty('basemap-light', 'visibility', kind === 'light' ? 'visible' : 'none');
    map.setLayoutProperty('basemap-dark', 'visibility', kind === 'dark' ? 'visible' : 'none');
  };

  const applyDarkLabels = (dark: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    darkRef.current = dark;
    if (map.getLayer('nodes')) applyColorMode(map, p.current.types, colorMode.current, dark, feederStyle.current);
    const text = dark ? '#f9fafb' : '#111827';
    const halo = dark ? '#111827' : '#ffffff';
    for (const id of ['node-labels', 'edge-labels', 'density-label', 'bnd-label', 'bnd-ulp-label']) {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, 'text-color', id === 'edge-labels' || id === 'bnd-ulp-label' ? (dark ? '#d1d5db' : '#374151') : text);
        map.setPaintProperty(id, 'text-halo-color', halo);
      }
    }
    if (map.getLayer('measure-labels')) {
      map.setPaintProperty('measure-labels', 'text-color', dark ? '#fed7aa' : '#7c2d12');
      map.setPaintProperty('measure-labels', 'text-halo-color', halo);
    }
    if (map.getLayer('draw-line')) map.setPaintProperty('draw-line', 'line-color', dark ? '#f9fafb' : '#111827');
    if (map.getLayer('draw-vertices')) map.setPaintProperty('draw-vertices', 'circle-color', dark ? '#f9fafb' : '#111827');
    if (map.getLayer('edges-open')) map.setPaintProperty('edges-open', 'line-color', dark ? '#111827' : '#ffffff');
    if (map.getLayer('par-label')) {
      map.setPaintProperty('par-label', 'text-color', dark ? '#fbbf24' : '#92400e');
      map.setPaintProperty('par-label', 'text-halo-color', halo);
    }
  };

  // ------------------------------------------------------------ init
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const cfg = p.current.configs;
    const [lng, lat] = (cfg['app.map_center'] || '106.8330,-6.1760').split(',').map(Number);
    const zoom = Number(cfg['app.map_zoom'] || 13);
    const lightUrl = cfg['app.basemap_light_url'] || cfg['app.basemap_url'] || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const darkUrl = cfg['app.basemap_dark_url'] || lightUrl;
    const darkInvert = (cfg['app.basemap_dark_invert'] || 'true') !== 'false';
    const fallbackUrl = cfg['app.basemap_fallback_url'] || 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';
    const attribution = cfg['app.basemap_attribution'] || '&copy; OpenStreetMap contributors';
    const darkPaint = darkInvert
      ? { 'raster-brightness-min': 1, 'raster-brightness-max': 0, 'raster-hue-rotate': 180, 'raster-saturation': -0.45, 'raster-contrast': 0.1 }
      : { 'raster-brightness-min': 0.06, 'raster-contrast': 0.05 };
    const glyphs = cfg['app.glyphs_url'] || 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';
    const font = cfg['app.text_font'] || 'Open Sans Semibold';
    const initialBasemap = p.current.initialBasemap;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs,
        sources: {
          'basemap-light': { type: 'raster', tiles: [lightUrl], tileSize: 256, maxzoom: 19, attribution },
          'basemap-dark': { type: 'raster', tiles: [darkUrl], tileSize: 256, maxzoom: 19, attribution },
        },
        layers: [
          { id: 'basemap-light', type: 'raster', source: 'basemap-light', layout: { visibility: initialBasemap === 'light' ? 'visible' : 'none' } },
          { id: 'basemap-dark', type: 'raster', source: 'basemap-dark', layout: { visibility: initialBasemap === 'dark' ? 'visible' : 'none' }, paint: darkPaint as any },
        ],
      },
      center: [lng, lat],
      zoom,
      maxZoom: 24, // di atas 22 tile vektor di-overzoom: garis rapat (jalur tiang bersama) dapat dipisahkan
      attributionControl: {},
      transformRequest: (url) => {
        if (url.includes('/api/gis/tiles/')) {
          const token = getToken();
          return { url, credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {} };
        }
        return { url };
      },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    const errCount: Record<string, number> = {};
    map.on('error', (ev: any) => {
      const src: string = ev?.sourceId || ev?.source?.id || '';
      const msg: string = ev?.error?.message || String(ev?.error || '');
      if (/AbortError|abort/i.test(msg)) return;
      errCount[src] = (errCount[src] || 0) + 1;
      if (errCount[src] <= 2) p.current.onError?.(src, msg);
      if ((src === 'basemap-light' || src === 'basemap-dark') && errCount[src] === 3) {
        const s = map.getSource(src) as any;
        if (s && typeof s.setTiles === 'function') s.setTiles([fallbackUrl]);
      }
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    // ---- drag handle (sesi edit vertex)
    const onDragMove = (e: MapMouseEvent) => {
      const s = session.current;
      if (!s || !s.drag) return;
      const c: Coord = [e.lngLat.lng, e.lngLat.lat];
      if (s.drag.type === 'vertex') s.coords[s.drag.index] = c;
      else {
        s.coords[0] = c;
        s.connected.forEach((ce) => {
          ce.coords[ce.endIndex === 0 ? 0 : ce.coords.length - 1] = c;
        });
      }
      renderEdit();
    };
    const onDragEnd = async () => {
      const s = session.current;
      map.off('mousemove', onDragMove);
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      if (!s || !s.drag) return;
      s.drag = null;
      renderEdit();
      if (busy.current) return;
      busy.current = true;
      try {
        if (s.target === 'edge') await p.current.onVertexCommit('edge', s.id, { type: 'LineString', coordinates: s.coords });
        else await p.current.onVertexCommit('node', s.id, { type: 'Point', coordinates: s.coords[0] });
      } finally {
        busy.current = false;
      }
    };
    const onHandleDown = (e: MapLayerMouseEvent) => {
      const s = session.current;
      const f = e.features?.[0];
      if (!s || !f || e.originalEvent.button !== 0) return;
      const role = f.properties?.role as string;
      const idx = Number(f.properties?.idx ?? 0);
      e.preventDefault();
      if (role === 'mid') {
        s.coords.splice(idx + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
        s.drag = { type: 'vertex', index: idx + 1 };
      } else if (role === 'vertex') s.drag = { type: 'vertex', index: idx };
      else if (role === 'node') s.drag = { type: 'node', index: 0 };
      else return;
      map.dragPan.disable();
      map.getCanvas().style.cursor = 'grabbing';
      renderEdit();
      map.on('mousemove', onDragMove);
      map.once('mouseup', onDragEnd);
      // cadangan bila mouse dilepas di luar kanvas (onDragEnd idempoten)
      window.addEventListener('mouseup', () => onDragEnd(), { once: true });
    };
    const onVertexContext = async (e: MapLayerMouseEvent) => {
      const s = session.current;
      const f = e.features?.[0];
      if (!s || !f || s.target !== 'edge') return;
      e.preventDefault();
      if (s.coords.length <= 2) return;
      s.coords.splice(Number(f.properties?.idx ?? 0), 1);
      renderEdit();
      if (busy.current) return;
      busy.current = true;
      try {
        await p.current.onVertexCommit('edge', s.id, { type: 'LineString', coordinates: s.coords });
      } finally {
        busy.current = false;
      }
    };

    map.on('load', () => {
      map.resize();
      map.addSource(SOURCE, { type: 'vector', tiles: [tileUrl(versionRef.current)], minzoom: 0, maxzoom: 22 });
      for (const id of ['trace', 'overlay', 'area', 'selected', 'draw', 'snap', 'edit', 'measure']) map.addSource(id, { type: 'geojson', data: EMPTY as any });
      map.addSource('boundary', { type: 'geojson', data: (boundaryData.current || EMPTY) as any, tolerance: 0.5 });
      registerSymbols(map);
      for (const layer of buildLayers(p.current.types, font, colorMode.current)) map.addLayer(layer);
      applyDarkLabels(p.current.initialBasemap === 'dark');
      applyBoundary();
      // pratinjau paket perubahan (di atas jaringan aktif)
      map.addSource('draft', { type: 'geojson', data: EMPTY as any });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': DRAFT_COLOR, 'fill-opacity': 0.25, 'fill-outline-color': DRAFT_COLOR } });
      map.addLayer({
        id: 'draft-line',
        type: 'line',
        source: 'draft',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': DRAFT_COLOR, 'line-width': ['case', ['==', ['get', 'op'], 'delete'], 5, 4], 'line-opacity': 0.85, 'line-dasharray': [2, 1.2] },
      });
      map.addLayer({
        id: 'draft-point',
        type: 'circle',
        source: 'draft',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': DRAFT_COLOR, 'circle-stroke-width': 3.5 },
      });
      // penanda objek padam (di atas jaringan): cluster merah bila berdekatan, radius 0 = tanpa cluster
      const clusterRadius = Number(cfg['monitoring.off_marker_cluster_radius'] || 50);
      map.addSource(OFF_SOURCE, {
        type: 'geojson',
        data: EMPTY as any,
        cluster: clusterRadius > 0,
        clusterRadius: Math.max(1, clusterRadius),
        clusterMaxZoom: Number(cfg['monitoring.off_marker_cluster_max_zoom'] || 15),
      });
      for (const layer of offMarkerLayers(p.current.types, font)) map.addLayer(layer);
      renderOff();
      // penyulang paralel: cincin + titik kuning tua dan label pasangan penyulang
      map.addSource('parallel', { type: 'geojson', data: EMPTY as any });
      map.addLayer({ id: 'par-ring', type: 'circle', source: 'parallel', paint: { 'circle-radius': 17, 'circle-color': PAR_COLOR, 'circle-opacity': 0.18, 'circle-stroke-color': PAR_COLOR, 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'par-dot', type: 'circle', source: 'parallel', paint: { 'circle-radius': 6, 'circle-color': PAR_COLOR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      map.addLayer({
        id: 'par-label',
        type: 'symbol',
        source: 'parallel',
        layout: { 'text-field': ['get', 'label'], 'text-font': [font], 'text-size': 11, 'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-allow-overlap': true, 'text-max-width': 24 },
        paint: { 'text-color': '#92400e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });
      renderPar();
      // posisi GPS pengguna (lingkar akurasi + titik), selalu paling atas
      map.addSource('user-loc', { type: 'geojson', data: EMPTY as any });
      map.addLayer({ id: 'user-acc', type: 'fill', source: 'user-loc', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12, 'fill-outline-color': '#2563eb' } });
      map.addLayer({
        id: 'user-dot',
        type: 'circle',
        source: 'user-loc',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 7, 'circle-color': '#2563eb', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
      });
      for (const id of ['edit-vertices', 'edit-midpoints', 'edit-node']) {
        map.on('mousedown', id, onHandleDown);
        map.on('mouseenter', id, () => {
          if (session.current) map.getCanvas().style.cursor = id === 'edit-midpoints' ? 'copy' : 'move';
        });
        map.on('mouseleave', id, () => {
          if (session.current && !session.current.drag) map.getCanvas().style.cursor = '';
        });
      }
      map.on('contextmenu', 'edit-vertices', onVertexContext);
      map.getCanvasContainer().addEventListener('contextmenu', (ev) => {
        if (session.current) ev.preventDefault();
      });
      p.current.onReady?.();
    });

    map.on('mousemove', (e: MapMouseEvent) => {
      p.current.onCursor(e.lngLat.lng, e.lngLat.lat, map.getZoom());
      if (!map.getLayer('nodes')) return;
      const kind = modeKind();
      if (kind === 'vertex') return; // kursor diatur oleh handle
      if (kind === 'select') {
        const hits = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], {
          layers: [...NODE_LAYERS, 'edges', 'buildings-fill', 'density', ...DRAFT_LAYERS, ...OFF_CLICK_LAYERS, 'par-dot', 'par-ring'].filter((l) => map.getLayer(l)),
        });
        map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
        showOffTip(map, e);
        return;
      }
      if (offTipId.current !== null) {
        offTip.current?.remove();
        offTipId.current = null;
      }
      map.getCanvas().style.cursor = 'crosshair';
      if (kind === 'move' || kind === 'split') return;
      if (isMeasure() || isPolyDraw()) {
        if (draw.current.length > 0) updateDraw([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      // indikator snap visual untuk titik & garis
      const hits = map.queryRenderedFeatures([[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]], { layers: [...NODE_LAYERS, 'edges'] });
      let snap: Coord | null = null;
      const node = hits.find((h) => NODE_LAYERS.includes(h.layer.id));
      if (node && node.geometry.type === 'Point') snap = node.geometry.coordinates as Coord;
      else {
        const edge = hits.find((h) => h.layer.id === 'edges');
        if (edge && edge.geometry.type === 'LineString') {
          const screen = (edge.geometry.coordinates as Coord[]).map((c) => {
            const q = map.project(c);
            return [q.x, q.y] as Coord;
          });
          const { point, dist } = closestOnPolyline([e.point.x, e.point.y], screen);
          if (dist <= 8) {
            const ll = map.unproject(point);
            snap = [ll.lng, ll.lat];
          }
        }
      }
      setSource('snap', snap ? { type: 'FeatureCollection', features: [pt(snap)] } : EMPTY);
      if (isLineDraw()) updateDraw(snap || [e.lngLat.lng, e.lngLat.lat]);
    });

    map.on('click', async (e: MapMouseEvent) => {
      const mode = p.current.mode;
      const { lng, lat } = e.lngLat;
      if (!map.getLayer('nodes')) return;
      if (mode.kind === 'select') {
        // penanda paralel: pilih tie penyebab (atau dekati titik temu)
        const par = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['par-dot', 'par-ring'].filter((l) => map.getLayer(l)) })[0];
        if (par && par.geometry.type === 'Point') {
          const nodeId = Number(par.properties?.node_id || 0);
          if (nodeId) p.current.onSelect('node', nodeId);
          if (map.getZoom() < 16) map.easeTo({ center: par.geometry.coordinates as Coord, zoom: 17 });
          return;
        }
        // penanda padam paling atas: cluster diperbesar, objek dipilih (dan didekati bila masih jauh)
        const off = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: OFF_CLICK_LAYERS.filter((l) => map.getLayer(l)) })[0];
        if (off && off.geometry.type === 'Point') {
          const center = off.geometry.coordinates as Coord;
          if (off.properties?.cluster_id !== undefined) {
            try {
              const z = await (map.getSource(OFF_SOURCE) as GeoJSONSource).getClusterExpansionZoom(Number(off.properties.cluster_id));
              map.easeTo({ center, zoom: Math.min(z + 0.5, 22) });
            } catch {
              map.easeTo({ center, zoom: map.getZoom() + 2 });
            }
          } else {
            p.current.onSelect('node', Number(off.properties?.id));
            if (map.getZoom() < 16) map.easeTo({ center, zoom: 17 });
          }
          return;
        }
        // objek usulan (paket perubahan) didahulukan
        const dh = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: DRAFT_LAYERS.filter((l) => map.getLayer(l)) });
        const d = dh.find((h) => h.layer.id === 'draft-point') || dh[0];
        if (d && d.properties?.fid) {
          p.current.onSelect(d.properties.kind === 'edge' ? 'edge' : 'node', Number(d.properties.fid));
          return;
        }
        const hits = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: [...NODE_LAYERS, 'edges', 'buildings-fill', 'density'].filter((l) => map.getLayer(l)) });
        const node = hits.find((h) => NODE_LAYERS.includes(h.layer.id));
        const edge = hits.find((h) => h.layer.id === 'edges');
        const bldg = hits.find((h) => h.layer.id === 'buildings-fill');
        const dens = hits.find((h) => h.layer.id === 'density');
        if (node) p.current.onSelect('node', Number(node.id));
        else if (edge) p.current.onSelect('edge', Number(edge.id));
        else if (bldg) p.current.onSelect('node', Number(bldg.id));
        else if (dens) map.easeTo({ center: e.lngLat, zoom: Math.min(22, map.getZoom() + 3) });
        return;
      }
      if (mode.kind === 'vertex') return;
      if (busy.current) return;
      if (mode.kind === 'point') {
        busy.current = true;
        try {
          const [x, y] = await snapPoint(lng, lat);
          await p.current.onCreatePoint(mode.typeCode, x, y);
        } finally {
          busy.current = false;
        }
        return;
      }
      if (mode.kind === 'move') {
        busy.current = true;
        try {
          await p.current.onMove(mode.nodeId, lng, lat);
        } finally {
          busy.current = false;
        }
        return;
      }
      if (mode.kind === 'split') {
        busy.current = true;
        try {
          await p.current.onSplit(mode.edgeId, lng, lat);
        } finally {
          busy.current = false;
        }
        return;
      }
      if (mode.kind === 'measure') {
        if (measureDone.current) {
          draw.current = [];
          measureDone.current = false;
        }
        draw.current.push([lng, lat]);
        renderMeasure();
        return;
      }
      if (isPolyDraw()) {
        draw.current.push([lng, lat]);
        updateDraw();
        return;
      }
      if (isLineDraw()) {
        const pr = snapPoint(lng, lat).then((c) => {
          const last = draw.current[draw.current.length - 1];
          if (!last || last[0] !== c[0] || last[1] !== c[1]) draw.current.push(c);
          updateDraw();
        });
        pendingSnap.current = pr;
        await pr;
      }
    });

    map.on('dblclick', (e) => {
      if (isDrawing()) {
        e.preventDefault();
        finishDraw();
      }
    });

    map.on('moveend', updateBlink);
    // tampilan berubah: selesai digeser, atau tile jaringan selesai dimuat (setelah refresh)
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    const viewChanged = () => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => p.current.onViewChanged?.(), 350);
    };
    map.on('moveend', viewChanged);
    map.on('sourcedata', (ev: any) => {
      if (ev.sourceId === SOURCE && ev.isSourceLoaded) viewChanged();
    });

    map.on('mouseout', () => {
      offTip.current?.remove();
      offTipId.current = null;
    });

    map.on('zoomend', () => {
      const c = map.getCenter();
      p.current.onCursor(c.lng, c.lat, map.getZoom());
    });

    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (ev.key === 'Escape') {
        clearDraw();
        if (isMeasure()) clearMeasure();
        p.current.onCancelMode();
      } else if (ev.key === 'Enter' && isDrawing()) {
        finishDraw();
      } else if (ev.key === 'Backspace' && isDrawing() && draw.current.length > 0) {
        ev.preventDefault();
        draw.current.pop();
        if (isMeasure()) {
          measureDone.current = false;
          renderMeasure();
        } else updateDraw();
      }
    };
    window.addEventListener('keydown', onKey);
    mapRef.current = map;
    (window as any).__qgisMap = map; // untuk debugging / uji otomatis
    return () => {
      window.removeEventListener('keydown', onKey);
      stopBlink();
      offTip.current?.remove();
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      delete (window as any).__qgisMap;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ mode effects
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    clearDraw();
    if (props.mode.kind !== 'vertex') {
      session.current = null;
      renderEdit();
    }
    if (props.mode.kind !== 'measure') {
      measureDone.current = false;
      setSource('measure', EMPTY);
      p.current.onMeasure(null);
    }
    if (props.mode.kind === 'select' || props.mode.kind === 'vertex') {
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
    } else {
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  // ------------------------------------------------------------ imperative API
  useImperativeHandle(
    ref,
    () => ({
      flyTo: (lng, lat, zoom) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 16), duration: 800 });
      },
      fitBBox: (b) => mapRef.current?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 18, duration: 700 }),
      refreshTiles: (version) => {
        versionRef.current = version && version > versionRef.current ? version : Date.now();
        const src = mapRef.current?.getSource(SOURCE) as VectorTileSource | undefined;
        src?.setTiles([tileUrl(versionRef.current)]);
      },
      setTrace: (fc) => setSource('trace', fc || EMPTY),
      setOverlay: (fc) => setSource('overlay', fc || EMPTY),
      setDraft: (fc) => setSource('draft', fc || EMPTY),
      setBoundary: (fc) => {
        boundaryData.current = fc;
        setSource('boundary', fc || EMPTY);
      },
      setBoundaryStyle: (st) => {
        boundaryStyle.current = st;
        applyBoundary();
      },
      setSelected: (f) => {
        if (!f) {
          setSource('selected', EMPTY);
          return;
        }
        const features: GeoFeature[] = [f];
        const fp = f.properties?.footprint;
        if (fp && fp.type === 'Polygon') features.push({ type: 'Feature', id: fid++, geometry: fp, properties: { role: 'footprint' } });
        setSource('selected', { type: 'FeatureCollection', features });
      },
      setVisibleTypes: (codes) => {
        visibleCodes.current = codes;
        applyFilters();
      },
      setEnergyFilter: (f) => {
        energyFilter.current = f;
        applyFilters();
      },
      setBasemap: (kind) => applyBasemap(kind),
      setLabelsVisible: (v) => {
        for (const id of ['node-labels', 'edge-labels', 'density-label']) {
          if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
        }
      },
      setDarkLabels: (dark) => applyDarkLabels(dark),
      setColorMode: (mode) => {
        colorMode.current = mode;
        const map = mapRef.current;
        if (map && map.getLayer('nodes')) applyColorMode(map, p.current.types, mode, darkRef.current, feederStyle.current);
      },
      cancelDraw: () => clearDraw(),
      getZoom: () => mapRef.current?.getZoom() ?? 0,
      startVertexEdit: (feature, connected) => {
        const g = feature.geometry;
        const target = feature.properties.kind === 'edge' ? 'edge' : 'node';
        const coords: Coord[] = target === 'edge' ? (g.coordinates as Coord[]).map((c) => [c[0], c[1]]) : [[g.coordinates[0], g.coordinates[1]]];
        session.current = { target, id: feature.id, coords, connected: connected.map((c) => ({ ...c, coords: c.coords.map((x) => [x[0], x[1]] as Coord) })), drag: null };
        renderEdit();
      },
      stopVertexEdit: () => {
        session.current = null;
        renderEdit();
      },
      clearMeasure: () => clearMeasure(),
      getBounds: () => {
        const b = mapRef.current?.getBounds();
        return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
      },
      setArea: (ring) => setSource('area', ring && ring.length >= 3 ? { type: 'FeatureCollection', features: [pg(ring)] } : EMPTY),
      setUserLocation: (pos) => {
        if (!pos) return setSource('user-loc', EMPTY);
        const ring: [number, number][] = [];
        const r = Math.max(3, Math.min(pos.accuracy || 0, 2000));
        const dLat = r / 111320;
        const dLng = r / (111320 * Math.cos((pos.lat * Math.PI) / 180));
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * 2 * Math.PI;
          ring.push([pos.lng + dLng * Math.cos(a), pos.lat + dLat * Math.sin(a)]);
        }
        setSource('user-loc', {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', id: 1, properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } } as any,
            { type: 'Feature', id: 2, properties: {}, geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] } } as any,
          ],
        });
      },
      getCenter: () => {
        const c = mapRef.current?.getCenter();
        return c ? [c.lng, c.lat] : null;
      },
      setOffMarkers: (items) => {
        offData.current = items;
        renderOff();
      },
      setParallel: (items) => {
        parData.current = items;
        renderPar();
      },
      setFeederFilter: (ids, live) => {
        feederFilter.current = ids && ids.length > 0 ? { ids: new Set(ids), live } : null;
        offKey.current = null;
        applyFilters();
        renderPar();
      },
      setFeederStyle: (st) => {
        feederStyle.current = { ...feederStyle.current, ...st };
        const map = mapRef.current;
        if (map && map.getLayer('nodes') && colorMode.current === 'feeder') applyColorMode(map, p.current.types, 'feeder', darkRef.current, feederStyle.current);
      },
      feedersInView: () => {
        const map = mapRef.current;
        if (!map || !map.getLayer('edges')) return [];
        const live = feederStyle.current.live;
        const cnt = new Map<number, number>();
        for (const f of map.queryRenderedFeatures({ layers: ['edges', 'nodes', 'nodes-symbol'].filter((l) => map.getLayer(l)) })) {
          const pr = f.properties || {};
          const id = feederOf(pr, live);
          if (id) cnt.set(id, (cnt.get(id) || 0) + 1);
        }
        return Array.from(cnt, ([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});

export default MapCanvas;
