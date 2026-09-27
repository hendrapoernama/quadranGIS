import type { FeatureCollection } from '@/lib/types';

export interface SimAction {
  target_kind: 'node' | 'edge';
  target_id: number;
  action: 'open' | 'close';
  way_edge_id?: number;
  note?: string;
}

export interface SimFeederLoad {
  head: number;
  load_va: number;
  capacity_va: number;
  pct: number;
  customers: number;
}

export interface SimWarning {
  code: string;
  feeders?: number[];
  pct?: number;
}

export interface SimStep {
  seq: number;
  action: SimAction;
  type_code: string;
  valid: boolean;
  customers_off: number;
  customers_diff: number;
  load_off_va: number;
  feeders: SimFeederLoad[];
  warnings: SimWarning[];
}

export interface SimResult {
  region_nodes: number;
  base_customers_off: number;
  customers_off_after: number;
  customers_restored: number;
  customers_new_off: number;
  load_restored_va: number;
  load_new_off_va: number;
  steps: SimStep[];
  base_feeders: SimFeederLoad[];
}

export type Codes = Record<string, { id: number; code: string; name: string; type_code: string }>;

export interface SimResponse {
  sim: SimResult;
  codes: Codes;
  geojson: FeatureCollection;
  params: { capacity_va: number; load_factor: number };
}

export interface FlisrTie {
  switch_id: number;
  way_edge_id?: number;
  supporting: number;
  load_before_va: number;
  load_after_va: number;
  capacity_va: number;
  pct_after: number;
}

export interface FlisrIsland {
  boundary: number;
  customers: number;
  load_va: number;
  nodes: number;
  tie: FlisrTie | null;
  alternatives: FlisrTie[];
  reason?: string;
}

export interface FlisrResult {
  fault_kind: 'node' | 'edge';
  fault_id: number;
  section_nodes: number[];
  section_edges: number[];
  section_customers: number;
  section_length_m: number;
  upstream: number;
  tripped: number;
  downstream: number[];
  islands: FlisrIsland[];
  actions: SimAction[];
  sim: SimResult | null;
  warnings: string[];
}

export interface FlisrSection {
  id: number;
  entry: number;
  entry_code: string;
  code: string;
  type_code: string;
  depth: number;
  nodes: number;
  customers: number;
  length_m: number;
  boundaries: number[];
  boundary_codes: string[];
  history: number;
  reports: number;
}

export interface PlanStep {
  id?: number;
  seq?: number;
  target_kind: 'node' | 'edge';
  target_id: number;
  target_code: string;
  target_type: string;
  action: 'open' | 'close';
  way_edge_id: number | null;
  note: string;
  status?: 'pending' | 'done' | 'skipped' | 'failed';
  executed_at?: string | null;
  executed_by?: string;
  error?: string;
}

export interface Plan {
  id: number;
  title: string;
  kind: string;
  status: 'draft' | 'approved' | 'executing' | 'done' | 'cancelled';
  source: 'manual' | 'flisr';
  outage_id: number | null;
  note: string;
  created_by_name: string;
  approved_by_name: string;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  steps_total: number;
  steps_done: number;
  steps?: PlanStep[];
}

export interface Report {
  id: number;
  ticket: string;
  received_at: string;
  channel: string;
  reporter_name: string;
  reporter_phone: string;
  customer_id: number | null;
  customer_code: string;
  address: string;
  lng: number | null;
  lat: number | null;
  category: string;
  description: string;
  priority: string;
  status: string;
  energized: boolean | null;
  outage_id: number | null;
  gd_id: number | null;
  feeder_id: number | null;
  route_id: number | null;
  assigned_to: string;
  note: string;
  history: { at: string; by: string; status: string; note?: string; assigned_to?: string }[];
  created_by_name: string;
  resolved_at: string | null;
  age_minutes: number;
  gd_code?: string;
  feeder_code?: string;
  route_code?: string;
}

export interface Suspect {
  node_id: number;
  level: string;
  reported: number;
  customers: number;
  ratio: number;
  energized: boolean;
  customer_ids: number[];
  code: string;
  name: string;
  type_code: string;
  group: string;
  tickets: string[];
  report_ids: number[];
}
