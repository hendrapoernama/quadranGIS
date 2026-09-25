import type { Map as MLMap } from 'maplibre-gl';
import type { ComponentType } from '@/lib/types';

export const SOURCE = 'quadran';

/** Mode pewarnaan: per tipe komponen, atau status kelistrikan (nyala hijau / padam merah). */
export type ColorMode = 'type' | 'status';

export const OFF_COLOR = '#9ca3af'; // padam pada mode tipe (abu)
export const ON_STATUS = '#16a34a'; // nyala pada mode status
export const OFF_STATUS = '#dc2626'; // padam pada mode status

/** Fitur tanpa properti energized (tile lama / kepadatan) dianggap nyala. */
export function energizedExpr(): any {
  return ['coalesce', ['get', 'energized'], true];
}

function typeMatch(types: ComponentType[]): any {
  if (types.length === 0) return '#9ca3af';
  const m: any[] = ['match', ['get', 'type_code']];
  types.forEach((t) => m.push(t.code, t.color));
  m.push('#9ca3af');
  return m;
}

export const SUPPORT_COLOR = '#a8a29e'; // objek pendukung (tiang) pada mode status: netral

export function colorExpr(types: ComponentType[], mode: ColorMode = 'type'): any {
  // objek pendukung (bukan topologi) tidak punya status nyala/padam
  const support = types.filter((t) => t.topology === false).map((t) => t.code);
  const isSupport = ['in', ['get', 'type_code'], ['literal', support]];
  if (mode === 'status') return ['case', isSupport, SUPPORT_COLOR, energizedExpr(), ON_STATUS, OFF_STATUS];
  return ['case', isSupport, typeMatch(types), energizedExpr(), typeMatch(types), OFF_COLOR];
}

/** Warna kepadatan selalu per tipe (agregat tidak punya status). */
export function densityColorExpr(types: ComponentType[]): any {
  return typeMatch(types);
}

export function nodeStrokeColorExpr(mode: ColorMode, dark = false): any {
  const base = dark ? '#111827' : '#ffffff';
  return ['case', ['==', ['get', 'status'], 'open'], '#dc2626', ['!', energizedExpr()], mode === 'status' ? '#7f1d1d' : '#dc2626', base];
}

export function nodeStrokeWidthExpr(): any {
  return ['case', ['==', ['get', 'status'], 'open'], 2.5, ['!', energizedExpr()], 2, 1.2];
}

export function sizeExpr(types: ComponentType[], kinds: string[]): any {
  const list = types.filter((t) => kinds.includes(t.geom_kind));
  if (list.length === 0) return 4;
  const m: any[] = ['match', ['get', 'type_code']];
  list.forEach((t) => m.push(t.code, t.size));
  m.push(4);
  return m;
}

export function typeFilter(codes: string[]): any {
  return ['in', ['get', 'type_code'], ['literal', codes]];
}

/** Label node tampil bertahap sesuai label_zoom masing-masing tipe. */
export function nodeLabelExpr(types: ComponentType[]): any {
  const pts = types.filter((t) => t.geom_kind !== 'line');
  const zooms = Array.from(new Set(pts.map((t) => t.label_zoom))).sort((a, b) => a - b);
  if (zooms.length === 0) return '';
  const expr: any[] = ['step', ['zoom'], ''];
  for (const z of zooms) {
    const codes = pts.filter((t) => t.label_zoom <= z).map((t) => t.code);
    expr.push(z, ['case', ['in', ['get', 'type_code'], ['literal', codes]], ['coalesce', ['get', 'code'], ''], '']);
  }
  return expr;
}

export const baseFilters: Record<string, any> = {
  'edges-open': ['==', ['get', 'status'], 'open'],
  'edges-off': ['!', ['coalesce', ['get', 'energized'], true]],
};

/** Menerapkan mode pewarnaan ke layer yang sudah ada. */
export function applyColorMode(map: MLMap, types: ComponentType[], mode: ColorMode, dark = false) {
  const color = colorExpr(types, mode);
  if (map.getLayer('nodes')) {
    map.setPaintProperty('nodes', 'circle-color', color);
    map.setPaintProperty('nodes', 'circle-stroke-color', nodeStrokeColorExpr(mode, dark));
  }
  if (map.getLayer('edges')) map.setPaintProperty('edges', 'line-color', color);
  if (map.getLayer('buildings-fill')) map.setPaintProperty('buildings-fill', 'fill-color', color);
  if (map.getLayer('buildings-outline')) map.setPaintProperty('buildings-outline', 'line-color', color);
  if (map.getLayer('edges-off')) map.setLayoutProperty('edges-off', 'visibility', mode === 'status' ? 'visible' : 'none');
}

export function buildLayers(types: ComponentType[], font: string, mode: ColorMode = 'type'): any[] {
  const color = colorExpr(types, mode);
  const dColor = densityColorExpr(types);
  const pSize = sizeExpr(types, ['point', 'polygon']);
  const lSize = sizeExpr(types, ['line']);
  const textFont = [font];

  return [
    // ---- kepadatan (zoom rendah)
    {
      id: 'density',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'density',
      paint: {
        'circle-color': dColor,
        'circle-opacity': 0.45,
        'circle-stroke-color': dColor,
        'circle-stroke-width': 1,
        'circle-radius': ['interpolate', ['linear'], ['get', 'cnt'], 1, 6, 100, 11, 10000, 20, 1000000, 34],
      },
    },
    {
      id: 'density-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'density',
      layout: { 'text-field': ['to-string', ['get', 'cnt']], 'text-font': textFont, 'text-size': 10, 'text-allow-overlap': true },
      paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
    },
    // ---- bangunan (footprint GI/GH/GD)
    {
      id: 'buildings-fill',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'buildings',
      paint: { 'fill-color': color, 'fill-opacity': 0.3 },
    },
    {
      id: 'buildings-outline',
      type: 'line',
      source: SOURCE,
      'source-layer': 'buildings',
      paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, 2.5] },
    },
    // ---- garis
    {
      id: 'edges',
      type: 'line',
      source: SOURCE,
      'source-layer': 'edges',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, ['*', lSize, 0.35], 13, ['*', lSize, 0.8], 18, ['*', lSize, 1.6]],
        'line-opacity': 0.95,
      },
    },
    {
      id: 'edges-open',
      type: 'line',
      source: SOURCE,
      'source-layer': 'edges',
      filter: baseFilters['edges-open'],
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 18, 3], 'line-dasharray': [2, 2] },
    },
    // ---- garis padam (garis putus-putus, hanya pada mode status)
    {
      id: 'edges-off',
      type: 'line',
      source: SOURCE,
      'source-layer': 'edges',
      filter: baseFilters['edges-off'],
      layout: { visibility: mode === 'status' ? 'visible' : 'none' },
      paint: { 'line-color': '#fecaca', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 18, 2], 'line-dasharray': [1.5, 2.5] },
    },
    {
      id: 'edge-labels',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'edges',
      minzoom: 16,
      layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'code'], ''], 'text-font': textFont, 'text-size': 10, 'text-offset': [0, 1] },
      paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
    },
    // ---- hasil trace (garis)
    {
      id: 'trace-edges',
      type: 'line',
      source: 'trace',
      filter: ['==', ['get', 'kind'], 'edge'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f59e0b', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6, 18, 10], 'line-opacity': 0.75 },
    },
    {
      id: 'selected-building',
      type: 'line',
      source: 'selected',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': '#0ea5e9', 'line-width': 4, 'line-opacity': 0.9 },
    },
    {
      id: 'selected-edge',
      type: 'line',
      source: 'selected',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0ea5e9', 'line-width': 9, 'line-opacity': 0.55 },
    },
    // ---- titik
    {
      id: 'nodes',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'nodes',
      paint: {
        'circle-color': color,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['*', pSize, 0.5], 13, ['*', pSize, 0.9], 18, ['*', pSize, 1.7]],
        'circle-stroke-color': nodeStrokeColorExpr(mode),
        'circle-stroke-width': nodeStrokeWidthExpr(),
      },
    },
    {
      id: 'trace-nodes',
      type: 'circle',
      source: 'trace',
      filter: ['all', ['==', ['get', 'kind'], 'node'], ['!=', ['get', 'is_start'], true]],
      paint: { 'circle-color': '#f59e0b', 'circle-radius': 7, 'circle-opacity': 0.5, 'circle-stroke-color': '#b45309', 'circle-stroke-width': 1.5 },
    },
    {
      id: 'trace-start',
      type: 'circle',
      source: 'trace',
      filter: ['==', ['get', 'is_start'], true],
      paint: { 'circle-color': '#fde68a', 'circle-radius': 12, 'circle-stroke-color': '#b45309', 'circle-stroke-width': 3 },
    },
    {
      id: 'selected-node',
      type: 'circle',
      source: 'selected',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-color': 'rgba(14,165,233,0.15)', 'circle-radius': 14, 'circle-stroke-color': '#0ea5e9', 'circle-stroke-width': 3 },
    },
    {
      id: 'node-labels',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'nodes',
      layout: { 'text-field': nodeLabelExpr(types), 'text-font': textFont, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
    },
    // ---- alat gambar
    {
      id: 'draw-fill',
      type: 'fill',
      source: 'draw',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.2 },
    },
    {
      id: 'draw-line',
      type: 'line',
      source: 'draw',
      filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
      paint: { 'line-color': '#111827', 'line-width': 2, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'draw-vertices',
      type: 'circle',
      source: 'draw',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-color': '#111827', 'circle-radius': 4.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
    },
    {
      id: 'snap-point',
      type: 'circle',
      source: 'snap',
      paint: { 'circle-color': 'rgba(22,163,74,0.2)', 'circle-radius': 9, 'circle-stroke-color': '#16a34a', 'circle-stroke-width': 2.5 },
    },
    // ---- sesi edit vertex
    {
      id: 'edit-conn',
      type: 'line',
      source: 'edit',
      filter: ['==', ['get', 'role'], 'conn'],
      paint: { 'line-color': '#0ea5e9', 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.9 },
    },
    {
      id: 'edit-line',
      type: 'line',
      source: 'edit',
      filter: ['==', ['get', 'role'], 'line'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0ea5e9', 'line-width': 4 },
    },
    {
      id: 'edit-midpoints',
      type: 'circle',
      source: 'edit',
      filter: ['==', ['get', 'role'], 'mid'],
      paint: { 'circle-color': '#ffffff', 'circle-radius': 5, 'circle-opacity': 0.9, 'circle-stroke-color': '#0ea5e9', 'circle-stroke-width': 1.5 },
    },
    {
      id: 'edit-vertices',
      type: 'circle',
      source: 'edit',
      filter: ['==', ['get', 'role'], 'vertex'],
      paint: { 'circle-color': '#0ea5e9', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    },
    {
      id: 'edit-node',
      type: 'circle',
      source: 'edit',
      filter: ['==', ['get', 'role'], 'node'],
      paint: { 'circle-color': '#0ea5e9', 'circle-radius': 10, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
    },
    // ---- alat ukur
    {
      id: 'measure-fill',
      type: 'fill',
      source: 'measure',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#f97316', 'fill-opacity': 0.18 },
    },
    {
      id: 'measure-line',
      type: 'line',
      source: 'measure',
      filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f97316', 'line-width': 3 },
    },
    {
      id: 'measure-vertices',
      type: 'circle',
      source: 'measure',
      filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'label']]],
      paint: { 'circle-color': '#f97316', 'circle-radius': 4.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
    },
    {
      id: 'measure-labels',
      type: 'symbol',
      source: 'measure',
      filter: ['has', 'label'],
      layout: { 'text-field': ['get', 'label'], 'text-font': textFont, 'text-size': 12, 'text-offset': [0, -1.2], 'text-allow-overlap': true },
      paint: { 'text-color': '#7c2d12', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    },
  ];
}

export const typeFilteredLayers = ['density', 'density-label', 'buildings-fill', 'buildings-outline', 'edges', 'edges-open', 'edges-off', 'edge-labels', 'nodes', 'node-labels'];
