import type { FeatureCollection, GeoFeature } from '@/lib/types';
import type { BBox } from '@/lib/geo';

export type DrawMode =
  | { kind: 'select' }
  | { kind: 'point'; typeCode: string }
  | { kind: 'polygon'; typeCode: string } // bangunan (GI/GH/GD)
  | { kind: 'line'; typeCode: string }
  | { kind: 'move'; nodeId: number }
  | { kind: 'reshape'; edgeId: number; typeCode: string }
  | { kind: 'reshape-polygon'; nodeId: number }
  | { kind: 'vertex'; target: 'edge' | 'node'; id: number } // edit vertex / geser node secara realtime
  | { kind: 'split'; edgeId: number }
  | { kind: 'measure'; what: 'length' | 'area' }
  | { kind: 'area' }; // gambar poligon area seleksi (export)

export type BasemapKind = 'light' | 'dark' | 'none';
export type BasemapPref = 'auto' | BasemapKind;
export type { ColorMode } from './mapStyle';

export interface ConnectedEdge {
  edgeId: number;
  coords: [number, number][];
  endIndex: 0 | -1; // ujung mana yang menempel pada node
}

export interface MeasureResult {
  what: 'length' | 'area';
  lengthM: number;
  areaM2: number;
  vertices: number;
  segments: number[];
  done: boolean;
}

export interface MapHandle {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  fitBBox: (bbox: BBox) => void;
  refreshTiles: (version?: number) => void;
  setTrace: (fc: FeatureCollection | null) => void;
  /** overlay analisis: fitur dengan properti color (dan big untuk titik besar) */
  setOverlay: (fc: FeatureCollection | null) => void;
  /** pratinjau paket perubahan (properti op: create | update | delete | split | merge, fid = id objek) */
  setDraft: (fc: FeatureCollection | null) => void;
  setSelected: (f: GeoFeature | null) => void;
  setVisibleTypes: (codes: string[]) => void;
  setBasemap: (kind: BasemapKind) => void;
  setLabelsVisible: (v: boolean) => void;
  setDarkLabels: (dark: boolean) => void;
  setColorMode: (mode: 'type' | 'status' | 'feeder') => void;
  /** pewarnaan per penyulang (mode feeder): warna, normal / aktual, penyulang yang disorot */
  setFeederStyle: (s: Partial<FeederStyleInput>) => void;
  /** penyulang yang tampak di layar (dari saluran & titik yang dirender), terbanyak lebih dulu */
  feedersInView: () => { id: number; count: number }[];
  /** penanda penyulang yang beroperasi paralel (di tie penyebab / titik temu; null = sembunyikan) */
  setParallel: (items: ParallelItem[] | null) => void;
  /** filter status kelistrikan: semua / hanya nyala / hanya padam */
  setEnergyFilter: (f: 'all' | 'on' | 'off') => void;
  cancelDraw: () => void;
  getZoom: () => number;
  startVertexEdit: (feature: GeoFeature, connected: ConnectedEdge[]) => void;
  stopVertexEdit: () => void;
  clearMeasure: () => void;
  /** batas tampilan peta [minx,miny,maxx,maxy] */
  getBounds: () => [number, number, number, number] | null;
  /** tampilkan area seleksi (null = hapus) */
  setArea: (ring: [number, number][] | null) => void;
  /** titik GPS pengguna + lingkar akurasi (null = sembunyikan) */
  setUserLocation: (pos: { lng: number; lat: number; accuracy: number } | null) => void;
  getCenter: () => [number, number] | null;
  /** overlay batas wilayah UP3 / ULP (data disimpan bila peta belum siap) */
  setBoundary: (fc: FeatureCollection | null) => void;
  setBoundaryStyle: (s: BoundaryStyle) => void;
  /** penanda objek padam berkedip merah / cluster merah (null = sembunyikan) */
  setOffMarkers: (items: OffMarker[] | null) => void;
}

/** Masukan pewarnaan per penyulang (lihat FeederStyle di mapStyle). */
export interface FeederStyleInput {
  colors: Record<number, number>;
  live: boolean;
  highlight: number | null;
}

/** Dua penyulang yang beroperasi paralel (GET /api/power/parallel). */
export interface ParallelItem {
  a: { id: number; code: string; name: string };
  b: { id: number; code: string; name: string };
  /** switch normally-open yang kini tertutup di antara keduanya */
  ties: { id: number; code: string; type_code: string; lng: number; lat: number }[];
  /** jumlah titik temu suplai kedua penyulang */
  meets: number;
  meet: { edge_id: number; lng: number; lat: number };
}

/** Objek padam untuk penanda peta (GET /api/power/off-markers). */
export interface OffMarker {
  id: number;
  type_code: string;
  code: string;
  name: string;
  lng: number;
  lat: number;
  outage_id: number | null;
  outage_kind: string | null;
  since: string | null;
}

/** Tampilan overlay batas wilayah. opacity = kepekatan isi UP3 (0..1). */
export interface BoundaryStyle {
  show: boolean;
  ulp: boolean;
  labels: boolean;
  opacity: number;
}

type TFn = (key: any, params?: Record<string, string | number>) => string;

export function modeLabel(mode: DrawMode, typeName: (code: string) => string, t: TFn): string {
  switch (mode.kind) {
    case 'select':
      return t('map.mode_select');
    case 'point':
      return t('map.mode_point', { type: typeName(mode.typeCode) });
    case 'polygon':
      return t('map.mode_polygon', { type: typeName(mode.typeCode) });
    case 'line':
      return t('map.mode_line', { type: typeName(mode.typeCode) });
    case 'move':
      return t('map.mode_move', { id: mode.nodeId });
    case 'reshape':
      return t('map.mode_reshape', { id: mode.edgeId });
    case 'reshape-polygon':
      return t('map.mode_reshape_polygon', { id: mode.nodeId });
    case 'vertex':
      return mode.target === 'edge' ? t('map.mode_vertex_edge', { id: mode.id }) : t('map.mode_vertex_node', { id: mode.id });
    case 'split':
      return t('map.mode_split', { id: mode.edgeId });
    case 'measure':
      return mode.what === 'length' ? t('map.mode_measure_length') : t('map.mode_measure_area');
    case 'area':
      return t('xchg.mode_area');
  }
}
