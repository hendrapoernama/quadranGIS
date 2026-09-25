export interface User {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role_id: string | null;
  role_name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  is_system: boolean;
  user_count: number;
}

export interface Permission {
  key: string;
  label: string;
  label_en?: string;
  group: string;
  group_en?: string;
}

export interface Menu {
  id: string;
  parent_id: string | null;
  title: string;
  title_en?: string;
  path: string;
  icon: string;
  sort_order: number;
  is_active: boolean;
  role_ids: string[];
  children?: Menu[];
}

export interface AppConfig {
  key: string;
  value: string;
  value_type: string;
  group: string;
  description: string;
  updated_at?: string;
  /** konfigurasi bertipe secret: nilainya tidak dikirim, hanya penanda sudah terisi */
  has_value?: boolean;
}

export interface ComponentType {
  code: string;
  name: string;
  name_en?: string;
  geom_kind: 'point' | 'line' | 'polygon';
  footprint_size_m?: number;
  category: string;
  is_source: boolean;
  is_switch: boolean;
  is_sink: boolean;
  voltage_kv: number;
  color: string;
  icon: string;
  min_zoom: number;
  label_zoom: number;
  size: number;
  sort_order: number;
  is_active: boolean;
  /** ikut membentuk graf jaringan (false = objek pendukung seperti tiang) */
  topology?: boolean;
  /** jumlah arah alat switching (2 / 3), 0 bila bukan switch */
  ways?: number;
  /** skema atribut SSOT */
  attributes?: AttrField[];
}

/** Satu kolom skema atribut SSOT sebuah tipe komponen. */
export interface AttrField {
  key: string;
  label: string;
  label_en?: string;
  type: 'text' | 'number' | 'select' | 'bool';
  unit?: string;
  options?: string[];
  required?: boolean;
}

export interface CodeName {
  id: number;
  code: string;
  name: string;
  type_code?: string;
}

export interface GraphInfo {
  in_graph: boolean;
  energized: boolean;
  open: boolean;
  switch: boolean;
  source: boolean;
  feeder_id: number;
  zone_id: number;
  route_id: number;
  open_ways: number[];
  load_va: number;
  degree: number;
}

export interface Counter {
  total: number;
  off: number;
}

export interface StateCounter {
  total: number;
  on: number;
  partial: number;
  off: number;
}

export interface PowerSummary {
  at: string;
  gi: Counter;
  trafo_gi: Counter;
  penyulang: StateCounter;
  zona: StateCounter;
  /** gardu distribusi: nyala / sebagian (ada hilir padam) / padam */
  gd_state: StateCounter;
  gd: Counter;
  trafo_gd: Counter;
  pelanggan: Counter;
  beban_va: number;
  beban_off_va: number;
  nodes: Counter;
  edges: Counter;
  open_switches: number;
  dist_dirty: boolean;
}

export interface GDStatus {
  id: number;
  code: string;
  name: string;
  feeder_id: number;
  feeder_code: string;
  gi_id: number;
  gi_code: string;
  state: 'on' | 'partial' | 'off';
  energized: boolean;
  nodes: number;
  nodes_off: number;
  pelanggan: number;
  pelanggan_off: number;
  beban_va: number;
  beban_off_va: number;
}

export interface FeederStatus {
  head_id: number;
  code: string;
  name: string;
  gi_id: number;
  gi_code: string;
  trafo_gi_id: number;
  trafo_gi_code: string;
  state: 'on' | 'partial' | 'off';
  nodes: number;
  nodes_off: number;
  gd: number;
  gd_off: number;
  pelanggan: number;
  pelanggan_off: number;
  beban_va: number;
  beban_off_va: number;
  zona: number;
  zona_off: number;
}

export interface GroupReport {
  nodes: number;
  edges: number;
  count_by_type: Record<string, number>;
  gi: CodeName[];
  trafo_gi: CodeName[];
  parent_gi: CodeName[];
  penyulang: CodeName[];
  zona: CodeName[];
  jurusan: number;
  gd: number;
  trafo_gd: number;
  pelanggan: number;
  beban_va: number;
}

export interface Outage {
  id: number;
  kind: string;
  level: string;
  group_code: string;
  cause_node_id: number;
  cause_node_code: string;
  cause_node_type: string;
  way_edge_id: number | null;
  started_at: string;
  ended_at: string | null;
  summary: GroupReport;
  restored?: GroupReport | null;
  affected_count: number;
  duration_sec: number;
}

export interface ManeuverRecord {
  id: number;
  node_id: number;
  node_code: string;
  node_type: string;
  action: 'open' | 'close';
  way_edge_id: number | null;
  kind: string;
  note: string;
  username: string;
  affected: GroupReport;
  outage_id: number | null;
  created_at: string;
}

export interface GeoFeature {
  type: 'Feature';
  id: number;
  geometry: { type: string; coordinates: any };
  properties: Record<string, any>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
  meta?: { total: number; truncated: boolean };
}

export interface EditResult {
  action: string;
  kind: 'node' | 'edge';
  id: number;
  feature?: GeoFeature;
  touched_nodes: number[];
  touched_edges: number[];
  bbox: [number, number, number, number];
  messages: string[];
}

export interface TraceResult {
  direction: string;
  start_node: number;
  nodes: number[];
  edges: number[];
  depth: number;
  count_by_type: Record<string, number>;
  sources: number[];
  sinks: number;
  open_switches: number[];
  truncated: boolean;
  warnings: string[];
  duration_ms: number;
}

export interface TraceResponse {
  result: TraceResult;
  geojson: FeatureCollection;
  length_by_type: Record<string, number>;
  total_length_m: number;
}

export interface SearchHit {
  kind: 'node' | 'edge';
  id: number;
  type_code: string;
  code: string;
  name: string;
  lng: number;
  lat: number;
}

export interface MetricSample {
  time: string;
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  heap_mb: number;
  goroutines: number;
  db_conns_total: number;
  db_conns_idle: number;
  db_ok: boolean;
  redis_latency_ms: number;
  redis_ok: boolean;
  kafka_ok: boolean;
  http_requests: number;
  http_avg_ms: number;
  http_errors: number;
  ws_clients: number;
}

export interface RealtimeEvent {
  type: string;
  kind?: 'node' | 'edge';
  id?: number;
  type_code?: string;
  bbox?: number[];
  affected?: number[];
  tile_version?: number;
  user_id?: string;
  username?: string;
  at: string;
  data?: any;
}
