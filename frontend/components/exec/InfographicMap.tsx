'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import maplibregl, { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface InfoPoint {
  id: number;
  code: string;
  name?: string;
  lng: number;
  lat: number;
  active: boolean;
  kind?: string;
  event_id?: number;
  /** edge: titik penyebab berupa saluran */
  target_kind?: string;
}

/** Objek peta yang diklik (untuk popup info). */
export interface InfoTarget {
  layer: string;
  id: number;
  code: string;
  name?: string;
  role?: InfoGI['role'];
  kind?: string;
  event_id?: number;
  target_kind?: string;
  cls?: string;
  active?: boolean;
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
export const NET_COLOR = {
  jtm: '#dc2626',
  jtr: '#f97316',
  sr: '#db2777',
  pelanggan: '#be123c',
};
/** Tipe pelanggan; masing-masing punya zoom minimum sendiri (Pengaturan Layer). */
export const CUST_TYPES = ['pelanggan_tt', 'pelanggan_tm', 'pelanggan_bulk', 'pelanggan_tr'] as const;

export interface OffNetwork {
  lines: { type: 'FeatureCollection'; features: any[] };
  customers: {
    id: number;
    code: string;
    name?: string;
    type_code: string;
    lng: number;
    lat: number;
  }[];
  /** trafo distribusi padam */
  trafo: {
    id: number;
    code: string;
    type_code: string;
    lng: number;
    lat: number;
  }[];
  /** zoom minimum tampil: jtm / jtr / sr dan per tipe pelanggan */
  zoom: Record<string, number>;
  /** zoom minimum label per tipe pelanggan (label_zoom Pengaturan Layer) */
  label_zoom?: Record<string, number>;
}

/** Zoom mulai label pelanggan: label_zoom tipenya, tidak lebih awal dari titiknya. */
export function custLabelZoom(net: Pick<OffNetwork, 'zoom' | 'label_zoom'>, t: string): number {
  return Math.max(net.label_zoom?.[t] ?? (t === 'pelanggan_tr' ? 18 : 16), net.zoom?.[t] ?? 15);
}

/** Label pelanggan: kode (IDPEL) mulai zoom label tipenya, nama pelanggan ikut di baris kedua satu tingkat sesudahnya. */
function custLabelExpr(lz: number): any {
  const code: any = ['case', ['!=', ['coalesce', ['get', 'code'], ''], ''], ['get', 'code'], ['coalesce', ['get', 'name'], '']];
  const name: any = ['coalesce', ['get', 'name'], ''];
  return ['step', ['zoom'], code, lz + 1, ['case', ['all', ['!=', name, ''], ['!=', name, code]], ['format', code, {}, '\n', {}, name, { 'font-scale': 0.85 }], code]];
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
export const GI_COLOR: Record<InfoGI['role'], string> = {
  padam: '#e11d48',
  pulih: '#16a34a',
  induk: '#1d4ed8',
  lain: '#64748b',
};

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

/** Ikon trafo GI: kotak berwarna dengan simbol trafo putih (beda dari kotak "GI" dan trafo distribusi). */
function tgiIcon(color: string): ImageData | null {
  const s = 40;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(1, 1, s - 2, s - 2, 20);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(4, 4, s - 8, s - 8, 16);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2.6;
  for (const cx of [15.5, 24.5]) {
    g.beginPath();
    g.arc(cx, s / 2, 7, 0, Math.PI * 2);
    g.stroke();
  }
  return g.getImageData(0, 0, s, s);
}

/** warna label gardu: padam / nyala, terang / gelap */
const gdLabelColor = (dark: boolean): any => ['case', ['get', 'active'], dark ? '#fda4af' : '#9f1239', dark ? '#86efac' : '#166534'];
/** kode gardu (nama bila kode kosong); mulai zoom 16 nama gardu di baris kedua */
const GD_CODE: any = ['case', ['!=', ['coalesce', ['get', 'code'], ''], ''], ['get', 'code'], ['coalesce', ['get', 'name'], '']];
const GD_NAME: any = ['coalesce', ['get', 'name'], ''];
const GD_LABEL: any = [
  'step',
  ['zoom'],
  '',
  12,
  GD_CODE,
  16,
  ['case', ['all', ['!=', GD_NAME, ''], ['!=', GD_NAME, GD_CODE]], ['format', GD_CODE, {}, '\n', {}, GD_NAME, { 'font-scale': 0.85 }], GD_CODE],
];

/** layer yang bisa diklik, dari yang paling atas (yang teratas di titik klik yang dipakai) */
const CLICK_LAYERS = ['causes', 'gi', 'tgi', 'gd', 'trafo', ...CUST_TYPES.map((t) => `cust-${t}`), 'net-jtm', 'net-jtr', 'net-sr'];

interface Props {
  configs: Record<string, string>;
  dark: boolean;
  gd: InfoPoint[];
  causes: InfoPoint[];
  /** saluran JTM / JTR / SR & pelanggan yang sedang padam */
  net: OffNetwork;
  gi: InfoGI[];
  /** trafo GI terdampak (active = masih padam) */
  tgi: InfoPoint[];
  /** isi popup objek yang diklik; relayout dipanggil sesudah isi berubah ukuran agar popup tetap di dalam peta */
  /** isi popup objek-objek di titik klik (urut prioritas); relayout dipanggil sesudah isi berubah ukuran agar popup tetap di dalam peta */
  renderInfo?: (targets: InfoTarget[], relayout: () => void) => ReactNode;
}

/**
 * Peta kejadian infografis: gardu induk & trafo GI, jaringan & pelanggan padam (JTR / SR / pelanggan mengikuti zoom
 * minimum tipenya), gardu terdampak (padam berkedip / nyala), titik penyebab per jenis kejadian. Klik objek → popup info.
 */
export function InfographicMap({ configs, dark, gd, causes, net, gi, tgi, renderInfo }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const fitKey = useRef('');
  const offGD = useRef<InfoPoint[]>([]);
  const blinkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const renderRef = useRef(renderInfo);
  renderRef.current = renderInfo;

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const lightUrl = configs['app.basemap_light_url'] || configs['app.basemap_url'] || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const darkUrl = configs['app.basemap_dark_url'] || lightUrl;
    const darkInvert = (configs['app.basemap_dark_invert'] || 'true') !== 'false';
    const attribution = configs['app.basemap_attribution'] || '&copy; OpenStreetMap contributors';
    const darkPaint = darkInvert
      ? {
          'raster-brightness-min': 1,
          'raster-brightness-max': 0,
          'raster-hue-rotate': 180,
          'raster-saturation': -0.45,
          'raster-contrast': 0.1,
        }
      : { 'raster-brightness-min': 0.06, 'raster-contrast': 0.05 };
    const kindColor: any = ['match', ['get', 'kind'], ...Object.entries(KIND_COLOR).flat(), '#64748b'];
    const map = new maplibregl.Map({
      container: ref.current,
      preserveDrawingBuffer: true, // agar ikut tercetak
      style: {
        version: 8,
        glyphs: configs['app.glyphs_url'] || 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'basemap-light': {
            type: 'raster',
            tiles: [lightUrl],
            tileSize: 256,
            maxzoom: 19,
            attribution,
          },
          'basemap-dark': {
            type: 'raster',
            tiles: [darkUrl],
            tileSize: 256,
            maxzoom: 19,
            attribution,
          },
          gi: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          tgi: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          gd: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          causes: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          net: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          cust: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          trafo: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
        },
        layers: [
          {
            id: 'basemap-light',
            type: 'raster',
            source: 'basemap-light',
            layout: { visibility: dark ? 'none' : 'visible' },
          },
          {
            id: 'basemap-dark',
            type: 'raster',
            source: 'basemap-dark',
            layout: { visibility: dark ? 'visible' : 'none' },
            paint: darkPaint as any,
          },
          {
            // SR putus-putus di layer sendiri (line-dasharray belum bisa per fitur di MapLibre 4); zoom minimum diatur sesudah data datang
            id: 'net-sr',
            type: 'line',
            source: 'net',
            filter: ['==', ['get', 'cls'], 'sr'],
            paint: {
              'line-color': NET_COLOR.sr,
              'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 18, 2.5],
              'line-dasharray': [2, 1.5],
            },
          },
          {
            id: 'net-jtr',
            type: 'line',
            source: 'net',
            filter: ['==', ['get', 'cls'], 'jtr'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': NET_COLOR.jtr,
              'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 17, 3.5],
            },
          },
          {
            id: 'net-jtm',
            type: 'line',
            source: 'net',
            filter: ['==', ['get', 'cls'], 'jtm'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': NET_COLOR.jtm,
              'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 16, 5],
            },
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
          // label pelanggan per tipe; zoom mulai & isi diatur sesudah data datang (label_zoom Pengaturan Layer)
          ...CUST_TYPES.map((t) => ({
            id: `cust-label-${t}`,
            type: 'symbol' as const,
            source: 'cust',
            filter: ['==', ['get', 'type_code'], t] as any,
            minzoom: t === 'pelanggan_tr' ? 18 : 16,
            layout: {
              'text-field': custLabelExpr(t === 'pelanggan_tr' ? 18 : 16),
              'text-font': [configs['app.text_font'] || 'Open Sans Semibold'],
              'text-size': 10,
              'text-variable-anchor': ['top', 'bottom', 'right', 'left'] as any,
              'text-radial-offset': 0.6,
              'text-justify': 'auto' as const,
              'text-max-width': 12,
            },
            paint: {
              'text-color': dark ? '#fda4af' : '#9f1239',
              'text-halo-color': dark ? '#111827' : '#ffffff',
              'text-halo-width': 1.3,
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
            // label gardu distribusi (kode; + nama mulai zoom 16); yang padam didahulukan saat label bertabrakan
            id: 'gd-label',
            type: 'symbol',
            source: 'gd',
            layout: {
              'text-field': GD_LABEL,
              'text-font': [configs['app.text_font'] || 'Open Sans Semibold'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9.5, 16, 11],
              'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
              'text-radial-offset': 0.75,
              'text-justify': 'auto',
              'text-max-width': 14,
              'symbol-sort-key': ['case', ['get', 'active'], 0, 1],
            },
            paint: {
              'text-color': gdLabelColor(dark),
              'text-halo-color': dark ? '#111827' : '#ffffff',
              'text-halo-width': 1.4,
            },
          },
          {
            // trafo GI terdampak; di bawah ikon GI, label kode mulai zoom 13
            id: 'tgi',
            type: 'symbol',
            source: 'tgi',
            layout: {
              'icon-image': ['case', ['get', 'active'], 'tgi-off', 'tgi-on'],
              'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 15, 1.1],
              'icon-allow-overlap': true,
              'text-field': ['step', ['zoom'], '', 13, ['get', 'code']],
              'text-font': [configs['app.text_font'] || 'Open Sans Semibold'],
              'text-size': 10,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
              'text-optional': true,
            },
            paint: {
              'text-color': dark ? '#e5e7eb' : '#111827',
              'text-halo-color': dark ? '#111827' : '#ffffff',
              'text-halo-width': 1.3,
            },
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
    // popup info objek: isi dirender React (diambil dari server oleh renderInfo); semua objek di titik klik (mis. trafo di
    // dalam gardu, GI yang juga titik penyebab) bisa dipilih, yang teratas tampil lebih dulu.
    // Tutup-saat-klik ditangani sendiri: closeOnClick bawaan ikut menutup popup baru saat klik objek lain.
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      offset: 10,
      maxWidth: '360px',
      className: 'info-popup',
    });
    let popRoot: Root | null = null;
    const unmount = () => {
      const r = popRoot;
      popRoot = null;
      // jangan melepas root di tengah render React yang sedang berjalan
      if (r) setTimeout(() => r.unmount(), 0);
    };
    popup.on('close', unmount);
    // lebar isi popup ≤ lebar peta dikurangi bantalan popup (peta sempit di ponsel)
    const fitWidth = () => {
      const w = map.getContainer().clientWidth;
      popup.setMaxWidth(`${Math.max(200, w - 16)}px`);
      popup.getElement()?.style.setProperty('--info-pop-w', `${Math.max(180, w - 40)}px`);
    };
    // sesudah isi popup berubah ukuran: tinggi dibatasi tinggi peta (gulir di dalam), lalu peta digeser agar popup utuh terlihat
    const relayout = () => {
      if (!popup.isOpen()) return;
      const box = map.getContainer().getBoundingClientRect();
      fitWidth();
      const content = popup.getElement()?.querySelector<HTMLElement>('.maplibregl-popup-content');
      if (content) {
        content.style.maxHeight = `${Math.max(160, box.height - 40)}px`;
        content.style.overflowY = 'auto';
      }
      popup.setLngLat(popup.getLngLat());
      const r = popup.getElement()?.getBoundingClientRect();
      if (!r) return;
      const m = 8;
      let dx = 0;
      let dy = 0;
      if (r.bottom > box.bottom - m) dy = r.bottom - (box.bottom - m);
      if (r.top - dy < box.top + m) dy = r.top - (box.top + m);
      if (r.right > box.right - m) dx = r.right - (box.right - m);
      if (r.left - dx < box.left + m) dx = r.left - (box.left + m);
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) map.panBy([dx, dy], { duration: 250 });
    };
    map.on('click', (ev) => {
      const layers = CLICK_LAYERS.filter((l) => map.getLayer(l));
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [ev.point.x - 4, ev.point.y - 4],
        [ev.point.x + 4, ev.point.y + 4],
      ];
      const hits = map.queryRenderedFeatures(box, { layers });
      // tutup popup lama dulu (event close melepas isi lamanya), baru buka yang baru
      popup.remove();
      if (hits.length === 0) return;
      // urutan layer klik menentukan prioritas (titik di atas garis), bukan urutan gambar
      const rank = (l: string) => CLICK_LAYERS.indexOf(l);
      hits.sort((a, b) => rank(a.layer.id) - rank(b.layer.id));
      // satu entri per objek: node yang muncul di beberapa layer (GI sekaligus titik penyebab) digabung
      const byKey = new Map<string, InfoTarget>();
      for (const h of hits) {
        const pr = h.properties as any;
        const line = h.layer.id.startsWith('net-') || pr.target_kind === 'edge';
        const t: InfoTarget = {
          layer: h.layer.id,
          id: Number(pr.id ?? h.id),
          code: pr.code || '',
          name: pr.name || undefined,
          role: pr.role || undefined,
          kind: pr.kind || undefined,
          event_id: pr.event_id ? Number(pr.event_id) : undefined,
          target_kind: pr.target_kind || undefined,
          cls: pr.cls || undefined,
          active: pr.active === true || pr.active === 'true',
        };
        const key = `${line ? 'e' : 'n'}${t.id}`;
        const prev = byKey.get(key);
        if (!prev) byKey.set(key, t);
        else for (const [k, v] of Object.entries(t)) if ((prev as any)[k] === undefined || (prev as any)[k] === '') (prev as any)[k] = v;
      }
      const targets = Array.from(byKey.values()).slice(0, 8);
      const f = hits[0];
      const at = f.geometry.type === 'Point' ? ((f.geometry as any).coordinates as [number, number]) : ev.lngLat;
      const el = document.createElement('div');
      popRoot = createRoot(el);
      popRoot.render(renderRef.current ? renderRef.current(targets, relayout) : <b>{targets[0].code || `#${targets[0].id}`}</b>);
      popup.setLngLat(at).setDOMContent(el).addTo(map);
      fitWidth();
    });
    for (const layer of CLICK_LAYERS) {
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
      for (const [name, color] of [
        ['tgi-off', OFF_COLOR],
        ['tgi-on', ON_COLOR],
      ]) {
        const img = tgiIcon(color);
        if (img && !map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 });
      }
      ready.current = true;
      map.fire('qgis:data');
    });
    mapRef.current = map;
    (window as any).__qgisInfoMap = map; // untuk debugging / uji otomatis
    return () => {
      if (blinkTimer.current) clearInterval(blinkTimer.current);
      blinkTimer.current = null;
      delete (window as any).__qgisInfoMap;
      popup.off('close', unmount);
      unmount();
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
        features: pts.map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          properties: { ...p },
        })),
      });
      (map.getSource('gd') as GeoJSONSource).setData(fc(gd));
      (map.getSource('causes') as GeoJSONSource).setData(fc(causes));
      (map.getSource('net') as GeoJSONSource).setData(net.lines as any);
      (map.getSource('cust') as GeoJSONSource).setData(fc(net.customers));
      (map.getSource('trafo') as GeoJSONSource).setData(fc(net.trafo || []));
      (map.getSource('gi') as GeoJSONSource).setData(fc(gi));
      (map.getSource('tgi') as GeoJSONSource).setData(fc(tgi || []));
      // level zoom: JTR, SR, dan pelanggan tampil mulai zoom minimum tipenya (Pengaturan Layer)
      const z = net.zoom || {};
      map.setLayerZoomRange('net-jtr', z.jtr ?? 14, 24);
      map.setLayerZoomRange('net-sr', z.sr ?? 15, 24);
      for (const t of CUST_TYPES) {
        map.setLayerZoomRange(`cust-${t}`, z[t] ?? 15, 24);
        const lz = custLabelZoom(net, t);
        map.setLayerZoomRange(`cust-label-${t}`, lz, 24);
        map.setLayoutProperty(`cust-label-${t}`, 'text-field', custLabelExpr(lz));
        map.setPaintProperty(`cust-label-${t}`, 'text-color', dark ? '#fda4af' : '#9f1239');
        map.setPaintProperty(`cust-label-${t}`, 'text-halo-color', dark ? '#111827' : '#ffffff');
      }
      map.setLayerZoomRange('trafo', z.trafo_distribusi ?? 13, 24);
      map.setPaintProperty('trafo', 'text-color', dark ? '#fecdd3' : '#9f1239');
      map.setPaintProperty('trafo', 'text-halo-color', dark ? '#111827' : '#ffffff');
      map.setPaintProperty('gi', 'text-color', dark ? '#e5e7eb' : '#111827');
      map.setPaintProperty('gi', 'text-halo-color', dark ? '#111827' : '#ffffff');
      map.setPaintProperty('gd-label', 'text-color', gdLabelColor(dark));
      map.setPaintProperty('gd-label', 'text-halo-color', dark ? '#111827' : '#ffffff');
      map.setPaintProperty('tgi', 'text-color', dark ? '#e5e7eb' : '#111827');
      map.setPaintProperty('tgi', 'text-halo-color', dark ? '#111827' : '#ffffff');
      offGD.current = gd.filter((p) => p.active);
      map.fire('qgis:blink');
      const all = [...causes, ...gd, ...net.customers, ...(tgi || []), ...gi.filter((g) => g.role !== 'lain')];
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
  }, [gd, causes, net, gi, tgi, dark]);

  return <div ref={ref} className="h-full w-full" />;
}
