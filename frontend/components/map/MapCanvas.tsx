'use client';

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl, { Map as MLMap, MapMouseEvent, MapLayerMouseEvent, GeoJSONSource, VectorTileSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { API_BASE, api, getToken } from '@/lib/api';
import { closestOnPolyline, fmtArea, fmtDistance, haversine, metersPerPixel, midpoint, pathLength, ringArea } from '@/lib/geo';
import type { ComponentType, FeatureCollection, GeoFeature } from '@/lib/types';
import { BOUNDARY_LAYERS, NODE_LAYERS, SOURCE, applyColorMode, baseFilters, buildLayers, energizedExpr, typeFilter, typeFilteredLayers, type ColorMode } from './mapStyle';
import { registerSymbols } from './symbols';
import type { BasemapKind, ConnectedEdge, DrawMode, MapHandle, MeasureResult, BoundaryStyle } from './types';

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
}

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
  const visibleCodes = useRef<string[] | null>(null);
  const energyFilter = useRef<'all' | 'on' | 'off'>('all');

  /** Filter gabungan: tipe yang tampil + status kelistrikan (semua / nyala / padam). */
  const applyFilters = () => {
    const map = mapRef.current;
    if (!map) return;
    const parts: any[] = [];
    if (visibleCodes.current) parts.push(typeFilter(visibleCodes.current));
    if (energyFilter.current !== 'all') parts.push(['==', energizedExpr(), energyFilter.current === 'on']);
    for (const id of typeFilteredLayers) {
      if (!map.getLayer(id)) continue;
      const all = [...(baseFilters[id] ? [baseFilters[id]] : []), ...parts];
      // kepadatan tidak punya status: disembunyikan saat memfilter padam
      if ((id === 'density' || id === 'density-label') && energyFilter.current === 'off') all.push(['!', true]);
      map.setFilter(id, all.length === 0 ? null : all.length === 1 ? all[0] : ['all', ...all]);
    }
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
        `/api/gis/snap?lng=${lng}&lat=${lat}&radius_m=${radius.toFixed(2)}`,
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
    if (map.getLayer('nodes')) applyColorMode(map, p.current.types, colorMode.current, dark);
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
      maxZoom: 22,
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
        const hits = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: [...NODE_LAYERS, 'edges', 'buildings-fill', 'density'].filter((l) => map.getLayer(l)) });
        map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
        return;
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
        if (map && map.getLayer('nodes')) applyColorMode(map, p.current.types, mode, darkRef.current);
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
