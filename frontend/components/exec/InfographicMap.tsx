'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface InfoPoint {
  id: number;
  code: string;
  lng: number;
  lat: number;
  active: boolean;
  kind?: string;
  event_id?: number;
}

/** Warna jenis kejadian (penanda penyebab di peta & legenda). */
export const KIND_COLOR: Record<string, string> = {
  GANGGUAN: '#dc2626',
  PEMELIHARAAN: '#2563eb',
  'BENCANA ALAM': '#d97706',
  MLS: '#7c3aed',
  MANUVER: '#64748b',
};
export const OFF_COLOR = '#e11d48';
export const ON_COLOR = '#16a34a';
/** Warna jaringan padam per kelas saluran. */
export const NET_COLOR = { jtm: '#dc2626', jtr: '#f97316', sr: '#db2777', pelanggan: '#be123c' };
/** Tipe pelanggan; masing-masing punya zoom minimum sendiri (Pengaturan Layer). */
export const CUST_TYPES = ['pelanggan_tt', 'pelanggan_tm', 'pelanggan_bulk', 'pelanggan_tr'] as const;

export interface OffNetwork {
  lines: { type: 'FeatureCollection'; features: any[] };
  customers: { id: number; code: string; type_code: string; lng: number; lat: number }[];
  /** trafo distribusi padam */
  trafo: { id: number; code: string; type_code: string; lng: number; lat: number }[];
  /** zoom minimum tampil: jtm / jtr / sr dan per tipe pelanggan */
  zoom: Record<string, number>;
}

/** Gardu induk & perannya terhadap kejadian terpilih. */
export interface InfoGI {
  id: number;
  code: string;
  name: string;
  lng: number;
  lat: number;
  energized: boolean;
  role: 'padam' | 'pulih' | 'induk' | 'lain';
}
export const GI_COLOR: Record<InfoGI['role'], string> = { padam: '#e11d48', pulih: '#16a34a', induk: '#1d4ed8', lain: '#64748b' };

/** kedip gardu padam: dua keadaan, tanpa transisi (peta hanya digambar ulang saat keadaan berganti) */
const BLINK_MS = 700;
const NO_FADE = { duration: 0, delay: 0 };

/** Simbol trafo (dua lingkaran bertumpuk, IEC) dengan tepi putih agar terbaca di peta dasar terang & gelap. */
function trafoIcon(color: string): ImageData | null {
  const w = 52;
  const h = 36;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;
  const circles = [
    [18, 18],
    [34, 18],
  ];
  for (const [cx, cy] of circles) {
    g.beginPath();
    g.arc(cx, cy, 13, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
  }
  for (const [lw, col] of [
    [8, '#ffffff'],
    [4, color],
  ] as const) {
    for (const [cx, cy] of circles) {
      g.beginPath();
      g.arc(cx, cy, 11, 0, Math.PI * 2);
      g.lineWidth = lw;
      g.strokeStyle = col;
      g.stroke();
    }
  }
  return g.getImageData(0, 0, w, h);
}

/** Ikon kotak "GI" (kanvas, 2× untuk layar tajam) per peran. */
function giIcon(color: string): ImageData | null {
  const s = 44;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(1, 1, s - 2, s - 2, 9);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(5, 5, s - 10, s - 10, 6);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 17px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('GI', s / 2, s / 2 + 1);
  return g.getImageData(0, 0, s, s);
}

interface Props {
  configs: Record<string, string>;
  dark: boolean;
  gd: InfoPoint[];
  causes: InfoPoint[];
  /** saluran JTM / JTR / SR & pelanggan yang sedang padam */
  net: OffNetwork;
  gi: InfoGI[];
}

/**
 * Peta kejadian infografis: gardu induk, jaringan & pelanggan padam (JTR / SR / pelanggan mengikuti zoom minimum
 * tipenya), gardu terdampak (padam berkedip / nyala), titik penyebab per jenis kejadian.
 */
export function InfographicMap({ configs, dark, gd, causes, net, gi }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const fitKey = useRef('');
  const offGD = useRef<InfoPoint[]>([]);
  const blinkTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const lightUrl = configs['app.basemap_light_url'] || configs['app.basemap_url'] || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const darkUrl = configs['app.basemap_dark_url'] || lightUrl;
    const darkInvert = (configs['app.basemap_dark_invert'] || 'true') !== 'false';
    const attribution = configs['app.basemap_attribution'] || '&copy; OpenStreetMap contributors';
    const darkPaint = darkInvert
      ? { 'raster-brightness-min': 1, 'raster-brightness-max': 0, 'raster-hue-rotate': 180, 'raster-saturation': -0.45, 'raster-contrast': 0.1 }
      : { 'raster-brightness-min': 0.06, 'raster-contrast': 0.05 };
    const kindColor: any = ['match', ['get', 'kind'], ...Object.entries(KIND_COLOR).flat(), '#64748b'];
    const map = new maplibregl.Map({
      container: ref.current,
      preserveDrawingBuffer: true, // agar ikut tercetak
      style: {
        version: 8,
        glyphs: configs['app.glyphs_url'] || 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'basemap-light': { type: 'raster', tiles: [lightUrl], tileSize: 256, maxzoom: 19, attribution },
          'basemap-dark': { type: 'raster', tiles: [darkUrl], tileSize: 256, maxzoom: 19, attribution },
          gi: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          gd: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          causes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          net: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          cust: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          trafo: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'basemap-light', type: 'raster', source: 'basemap-light', layout: { visibility: dark ? 'none' : 'visible' } },
          { id: 'basemap-dark', type: 'raster', source: 'basemap-dark', layout: { visibility: dark ? 'visible' : 'none' }, paint: darkPaint as any },
          {
            // SR putus-putus di layer sendiri (line-dasharray belum bisa per fitur di MapLibre 4); zoom minimum diatur sesudah data datang
            id: 'net-sr',
            type: 'line',
            source: 'net',
            filter: ['==', ['get', 'cls'], 'sr'],
            paint: { 'line-color': NET_COLOR.sr, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 18, 2.5], 'line-dasharray': [2, 1.5] },
          },
          {
            id: 'net-jtr',
            type: 'line',
            source: 'net',
            filter: ['==', ['get', 'cls'], 'jtr'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': NET_COLOR.jtr, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 17, 3.5] },
          },
          {
            id: 'net-jtm',
            type: 'line',
            source: 'net',
            filter: ['==', ['get', 'cls'], 'jtm'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': NET_COLOR.jtm, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 16, 5] },
          },
          ...CUST_TYPES.map((t) => ({
            id: `cust-${t}`,
            type: 'circle' as const,
            source: 'cust',
            filter: ['==', ['get', 'type_code'], t] as any,
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, t === 'pelanggan_tr' ? 1.8 : 3, 17, t === 'pelanggan_tr' ? 4.5 : 6] as any,
              'circle-color': NET_COLOR.pelanggan,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0, 15, 1] as any,
            },
          })),
          {
            // trafo distribusi padam; zoom minimum diatur sesudah data datang
            id: 'trafo',
            type: 'symbol',
            source: 'trafo',
            layout: {
              'icon-image': 'trafo-off',
              'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.75, 17, 1.15],
              'icon-allow-overlap': true,
              'text-field': ['step', ['zoom'], '', 16, ['get', 'code']],
              'text-font': [configs['app.text_font'] || 'Open Sans Semibold'],
              'text-size': 10,
              'text-offset': [0, 1.3],
              'text-anchor': 'top',
              'text-optional': true,
            },
            paint: {
              'text-color': dark ? '#fecdd3' : '#9f1239',
              'text-halo-color': dark ? '#111827' : '#ffffff',
              'text-halo-width': 1.3,
            },
          },
          {
            // cincin gardu padam yang berkedip
            id: 'gd-pulse',
            type: 'circle',
            source: 'gd',
            filter: ['==', ['get', 'active'], true],
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 7, 14, 12],
              'circle-color': OFF_COLOR,
              'circle-opacity': 0,
              'circle-opacity-transition': NO_FADE,
              'circle-stroke-color': OFF_COLOR,
              'circle-stroke-width': 2,
              'circle-stroke-opacity': 0,
              'circle-stroke-opacity-transition': NO_FADE,
            } as any,
          },
          {
            id: 'gd',
            type: 'circle',
            source: 'gd',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 6],
              'circle-color': ['case', ['get', 'active'], OFF_COLOR, ON_COLOR],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1,
              'circle-opacity-transition': NO_FADE,
              'circle-stroke-opacity-transition': NO_FADE,
            } as any,
          },
          {
            id: 'gi',
            type: 'symbol',
            source: 'gi',
            layout: {
              'icon-image': ['concat', 'gi-', ['get', 'role']],
              'icon-size': ['match', ['get', 'role'], 'lain', 0.7, 1.3],
              'icon-allow-overlap': true,
              'symbol-sort-key': ['match', ['get', 'role'], 'padam', 0, 'pulih', 1, 'induk', 2, 3],
              // label GI lain baru tampil saat diperbesar
              'text-field': ['step', ['zoom'], ['case', ['==', ['get', 'role'], 'lain'], '', ['get', 'code']], 12, ['get', 'code']],
              'text-font': [configs['app.text_font'] || 'Open Sans Semibold'],
              'text-size': 11,
              'text-offset': [0, 1.4],
              'text-anchor': 'top',
              'text-optional': true,
            },
            paint: {
              'icon-opacity': ['match', ['get', 'role'], 'lain', 0.75, 1],
              'text-color': dark ? '#e5e7eb' : '#111827',
              'text-halo-color': dark ? '#111827' : '#ffffff',
              'text-halo-width': 1.4,
            },
          },
          {
            id: 'causes',
            type: 'circle',
            source: 'causes',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 14, 8],
              'circle-color': kindColor,
              'circle-stroke-color': ['case', ['get', 'active'], '#111827', '#ffffff'],
              'circle-stroke-width': 2.5,
            },
          },
        ],
      },
      center: (configs['app.map_center'] || '106.8330,-6.1760').split(',').map(Number) as [number, number],
      zoom: 10,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 90 }), 'bottom-left');
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 8 });
    const esc = (v: unknown) =>
      String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;');
    for (const layer of ['net-sr', 'net-jtr', 'net-jtm', ...CUST_TYPES.map((t) => `cust-${t}`), 'trafo', 'gd', 'gi', 'causes']) {
      map.on('click', layer, (ev) => {
        const f = ev.features?.[0];
        if (!f) return;
        const pr = f.properties as any;
        popup
          .setLngLat(ev.lngLat)
          .setHTML(`<div style="font-size:12px"><b>${esc(pr.code || '#' + pr.id)}</b>${layer === 'gi' && pr.name ? ` · ${esc(pr.name)}` : ''}${pr.event_id ? ` · #${pr.event_id}` : ''}</div>`)
          .addTo(map);
      });
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    // kedip gardu padam: hanya selama ada gardu padam di area tampilan (dan gerak tidak dikurangi)
    const frame = (on: boolean) => {
      if (!map.getLayer('gd')) return;
      map.setPaintProperty('gd', 'circle-opacity', ['case', ['get', 'active'], on ? 1 : 0.2, 1]);
      map.setPaintProperty('gd', 'circle-stroke-opacity', ['case', ['get', 'active'], on ? 1 : 0.2, 1]);
      map.setPaintProperty('gd-pulse', 'circle-opacity', on ? 0 : 0.3);
      map.setPaintProperty('gd-pulse', 'circle-stroke-opacity', on ? 0 : 0.9);
    };
    const stop = () => {
      if (blinkTimer.current) clearInterval(blinkTimer.current);
      blinkTimer.current = null;
      if (ready.current) frame(true);
    };
    const update = () => {
      const b = map.getBounds();
      const inView = offGD.current.some((p) => b.contains([p.lng, p.lat]));
      if (!inView || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        stop();
        return;
      }
      if (blinkTimer.current) return;
      let on = true;
      blinkTimer.current = setInterval(() => {
        if (document.hidden) return;
        on = !on;
        frame(on);
      }, BLINK_MS);
    };
    map.on('moveend', update);
    map.on('qgis:blink', update);

    map.on('load', () => {
      for (const [role, color] of Object.entries(GI_COLOR)) {
        const img = giIcon(color);
        if (img && !map.hasImage(`gi-${role}`)) map.addImage(`gi-${role}`, img, { pixelRatio: 2 });
      }
      const ti = trafoIcon(OFF_COLOR);
      if (ti && !map.hasImage('trafo-off')) map.addImage('trafo-off', ti, { pixelRatio: 2 });
      ready.current = true;
      map.fire('qgis:data');
    });
    mapRef.current = map;
    (window as any).__qgisInfoMap = map; // untuk debugging / uji otomatis
    return () => {
      if (blinkTimer.current) clearInterval(blinkTimer.current);
      blinkTimer.current = null;
      delete (window as any).__qgisInfoMap;
      map.remove();
      mapRef.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!ready.current) return;
      map.setLayoutProperty('basemap-light', 'visibility', dark ? 'none' : 'visible');
      map.setLayoutProperty('basemap-dark', 'visibility', dark ? 'visible' : 'none');
      const fc = (pts: { id: number; lng: number; lat: number }[]) => ({
        type: 'FeatureCollection' as const,
        features: pts.map((p) => ({ type: 'Feature' as const, id: p.id, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] }, properties: { ...p } })),
      });
      (map.getSource('gd') as GeoJSONSource).setData(fc(gd));
      (map.getSource('causes') as GeoJSONSource).setData(fc(causes));
      (map.getSource('net') as GeoJSONSource).setData(net.lines as any);
      (map.getSource('cust') as GeoJSONSource).setData(fc(net.customers));
      (map.getSource('trafo') as GeoJSONSource).setData(fc(net.trafo || []));
      (map.getSource('gi') as GeoJSONSource).setData(fc(gi));
      // level zoom: JTR, SR, dan pelanggan tampil mulai zoom minimum tipenya (Pengaturan Layer)
      const z = net.zoom || {};
      map.setLayerZoomRange('net-jtr', z.jtr ?? 14, 24);
      map.setLayerZoomRange('net-sr', z.sr ?? 15, 24);
      for (const t of CUST_TYPES) map.setLayerZoomRange(`cust-${t}`, z[t] ?? 15, 24);
      map.setLayerZoomRange('trafo', z.trafo_distribusi ?? 13, 24);
      map.setPaintProperty('trafo', 'text-color', dark ? '#fecdd3' : '#9f1239');
      map.setPaintProperty('trafo', 'text-halo-color', dark ? '#111827' : '#ffffff');
      map.setPaintProperty('gi', 'text-color', dark ? '#e5e7eb' : '#111827');
      map.setPaintProperty('gi', 'text-halo-color', dark ? '#111827' : '#ffffff');
      offGD.current = gd.filter((p) => p.active);
      map.fire('qgis:blink');
      const all = [...causes, ...gd, ...net.customers, ...gi.filter((g) => g.role !== 'lain')];
      const key = all.map((p) => p.id).join(',');
      if (all.length > 0 && key !== fitKey.current) {
        fitKey.current = key;
        const b = new maplibregl.LngLatBounds([all[0].lng, all[0].lat], [all[0].lng, all[0].lat]);
        for (const p of all) b.extend([p.lng, p.lat]);
        map.fitBounds(b, { padding: 40, maxZoom: 16, duration: 0 });
      }
    };
    apply();
    map.on('qgis:data', apply);
    return () => {
      map.off('qgis:data', apply);
    };
  }, [gd, causes, net, gi, dark]);

  return <div ref={ref} className="h-full w-full" />;
}
