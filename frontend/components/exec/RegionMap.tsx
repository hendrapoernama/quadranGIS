'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from '@/lib/types';

/** Ramp sekuensial satu hue (terang → pekat); tema gelap memakai langkah sendiri (rendah = dekat latar). */
export const RAMP_LIGHT = ['#fde7d9', '#f7bd97', '#ec835a', '#cf5528', '#9b3415'];
export const RAMP_DARK = ['#4a2518', '#7a3a20', '#b4532a', '#e07443', '#f6a878'];
export const NO_DATA_LIGHT = '#e5e7eb';
export const NO_DATA_DARK = '#374151';

interface Props {
  configs: Record<string, string>;
  dark: boolean;
  data: FeatureCollection | null; // batas wilayah (/api/gis/boundaries)
  level: 'up3' | 'ulp';
  /** kelas warna per id wilayah: -1 = tanpa data, 0..4 = langkah ramp */
  classes: Record<number, number>;
  labels: Record<number, string>;
  selected: number | null;
  onSelect: (id: number | null) => void;
  onHover?: (id: number | null) => void;
}

/** Peta koroplet wilayah UP3 / ULP (MapLibre, basemap raster sama dengan peta jaringan). */
export function RegionMap({ configs, dark, data, level, classes, labels, selected, onSelect, onHover }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const p = useRef({ onSelect, onHover });
  p.current = { onSelect, onHover };
  const fitted = useRef(false);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const lightUrl = configs['app.basemap_light_url'] || configs['app.basemap_url'] || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const darkUrl = configs['app.basemap_dark_url'] || lightUrl;
    const darkInvert = (configs['app.basemap_dark_invert'] || 'true') !== 'false';
    const attribution = configs['app.basemap_attribution'] || '&copy; OpenStreetMap contributors';
    const darkPaint = darkInvert
      ? { 'raster-brightness-min': 1, 'raster-brightness-max': 0, 'raster-hue-rotate': 180, 'raster-saturation': -0.45, 'raster-contrast': 0.1 }
      : { 'raster-brightness-min': 0.06, 'raster-contrast': 0.05 };
    const map = new maplibregl.Map({
      container: ref.current,
      style: {
        version: 8,
        glyphs: configs['app.glyphs_url'] || 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'basemap-light': { type: 'raster', tiles: [lightUrl], tileSize: 256, maxzoom: 19, attribution },
          'basemap-dark': { type: 'raster', tiles: [darkUrl], tileSize: 256, maxzoom: 19, attribution },
          regions: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'basemap-light', type: 'raster', source: 'basemap-light', layout: { visibility: dark ? 'none' : 'visible' }, paint: { 'raster-opacity': 0.6 } },
          { id: 'basemap-dark', type: 'raster', source: 'basemap-dark', layout: { visibility: dark ? 'visible' : 'none' }, paint: { ...(darkPaint as any), 'raster-opacity': 0.6 } },
          { id: 'reg-fill', type: 'fill', source: 'regions', filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': '#999', 'fill-opacity': 0.72 } },
          { id: 'reg-line', type: 'line', source: 'regions', filter: ['==', ['get', 'kind'], 'area'], paint: { 'line-color': '#fff', 'line-width': 1.2 } },
          { id: 'reg-sel', type: 'line', source: 'regions', filter: ['==', ['id'], -1], paint: { 'line-color': '#2563eb', 'line-width': 3 } },
          {
            id: 'reg-label',
            type: 'symbol',
            source: 'regions',
            filter: ['==', ['get', 'kind'], 'label'],
            layout: { 'text-field': ['get', 'text'], 'text-font': [configs['app.text_font'] || 'Open Sans Semibold'], 'text-size': 11, 'text-allow-overlap': false },
            paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
          },
        ],
      },
      center: (configs['app.map_center'] || '106.8330,-6.1760').split(',').map(Number) as [number, number],
      zoom: 9.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      ready.current = true;
      map.fire('qgis:refresh');
    });
    map.on('click', 'reg-fill', (ev) => {
      const f = ev.features?.[0];
      p.current.onSelect(f ? Number(f.id) : null);
    });
    map.on('click', (ev) => {
      if (!map.queryRenderedFeatures(ev.point, { layers: ['reg-fill'] }).length) p.current.onSelect(null);
    });
    map.on('mousemove', 'reg-fill', (ev) => {
      map.getCanvas().style.cursor = 'pointer';
      p.current.onHover?.(ev.features?.[0] ? Number(ev.features[0].id) : null);
    });
    map.on('mouseleave', 'reg-fill', () => {
      map.getCanvas().style.cursor = '';
      p.current.onHover?.(null);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // data & gaya
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!ready.current || !data) return;
      const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
      const feats = data.features
        .filter((f: any) => f.properties.level === level)
        .map((f: any) => {
          if (f.properties.kind === 'area') {
            const c = classes[Number(f.id)] ?? -1;
            return { ...f, properties: { ...f.properties, cls: c } };
          }
          return f;
        })
        .filter((f: any) => f.properties.kind === 'area');
      // label dari titik label yang sesuai nama wilayah
      const labelFeats = data.features
        .filter((f: any) => f.properties.kind === 'label' && f.properties.level === level)
        .map((f: any) => {
          const area = feats.find((a: any) => a.properties.name === f.properties.name && a.properties.parent === f.properties.parent);
          return { ...f, properties: { kind: 'label', text: area ? labels[Number(area.id)] || f.properties.name : f.properties.name } };
        });
      (map.getSource('regions') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [...feats, ...labelFeats] } as any);
      const color: any[] = ['match', ['get', 'cls']];
      ramp.forEach((c, i) => color.push(i, c));
      color.push(dark ? NO_DATA_DARK : NO_DATA_LIGHT);
      map.setPaintProperty('reg-fill', 'fill-color', color);
      map.setPaintProperty('reg-line', 'line-color', dark ? '#0f1319' : '#ffffff');
      map.setPaintProperty('reg-label', 'text-color', dark ? '#f3f4f6' : '#111827');
      map.setPaintProperty('reg-label', 'text-halo-color', dark ? '#111827' : '#ffffff');
      map.setLayoutProperty('basemap-light', 'visibility', dark ? 'none' : 'visible');
      map.setLayoutProperty('basemap-dark', 'visibility', dark ? 'visible' : 'none');
      map.setFilter('reg-sel', ['==', ['id'], selected ?? -1]);
      if (!fitted.current && feats.length) {
        fitted.current = true;
        const b = new maplibregl.LngLatBounds();
        const walk = (c: any) => (typeof c[0] === 'number' ? b.extend(c as [number, number]) : c.forEach(walk));
        feats.forEach((f: any) => walk(f.geometry.coordinates));
        map.fitBounds(b, { padding: 30, duration: 0 });
      }
    };
    apply();
    map.on('qgis:refresh', apply);
    return () => {
      map.off('qgis:refresh', apply);
    };
  }, [data, level, classes, labels, selected, dark]);

  return <div ref={ref} className="h-full w-full" />;
}
