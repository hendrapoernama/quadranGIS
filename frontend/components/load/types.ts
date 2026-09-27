export type PointKind = 'feeder' | 'trafo_gi' | 'gd';

export interface LPoint {
  id: number;
  code: string;
  kind: PointKind;
  node_id: number | null;
  name: string;
  rating_a: number | null;
  rating_mva: number | null; // gardu: kVA ÷ 1000
  kv: number;
  active: boolean;
  gi_id: number | null;
  trafo_gi_id: number | null;
  feeder_id: number | null;
  up3: string;
  ulp: string;
  uid: string;
  last_ts: string | null;
  gi_code?: string;
  trafo_gi_code?: string;
  feeder_code?: string;
}

/** Deret gabungan per slot 30 menit — beban utama dalam MW. */
export interface SeriesPoint {
  ts: string;
  p: number;
  q: number;
  s: number;
  i: number;
  e: number;
  util: number;
  n: number;
}

export interface Reading {
  point_id: number;
  ts: string;
  i_r: number | null;
  i_s: number | null;
  i_t: number | null;
  i_avg: number | null;
  v_r: number | null;
  v_s: number | null;
  v_t: number | null;
  v_kv: number | null;
  p_mw: number | null;
  q_mvar: number | null;
  s_mva: number | null;
  pf: number | null;
  f_hz: number | null;
  kwh_imp: number | null;
  kwh_exp: number | null;
  kvarh_imp: number | null;
  kvarh_exp: number | null;
  util: number | null;
  quality: number;
}

export interface DayStat {
  day: string;
  peak_mw: number;
  peak_ts: string | null;
  wbp_peak_mw: number;
  lwbp_peak_mw: number;
  min_mw: number;
  avg_mw: number;
  energy_mwh: number;
  energy_exp_mwh: number;
  load_factor: number;
  peak_util: number;
  samples: number;
  hours_over80: number;
  hours_over100: number;
}

export interface PeriodStats {
  peak_mw: number;
  peak_ts: string | null;
  peak_util: number;
  min_mw: number;
  avg_mw: number;
  energy_mwh: number;
  energy_exp_mwh: number;
  load_factor: number;
  wbp_peak_mw: number;
  lwbp_peak_mw: number;
  hours_over80: number;
  hours_over100: number;
  samples: number;
  expected: number;
}

export interface MonthStat {
  month: string;
  peak_mw: number;
  peak_ts: string | null;
  peak_util: number;
  energy_mwh: number;
  energy_exp_mwh: number;
  load_factor: number;
  hours_over80: number;
  hours_over100: number;
  days: number;
  completeness: number;
}

export interface Entity {
  level: string;
  id: string;
  name: string;
  parent?: string;
  cap_mw: number;
  cap_mva: number;
  members: number;
  point_id?: number;
}

export interface ForecastPoint {
  ts: string;
  p: number;
  lo: number;
  hi: number;
}

export interface ForecastInfo {
  method: string;
  trend: number;
  mape: number;
  peak_mw: number;
  peak_ts: string | null;
  peak_util: number;
  history_days: number;
}

export interface Profile {
  class: string;
  peak_hour: number;
  day_evening_ratio: number;
  weekend_ratio: number;
  load_factor: number;
  weekday?: number[];
  weekend?: number[];
}

export interface Anomaly {
  id: number;
  point_id: number;
  kind: string;
  severity: 'info' | 'warning' | 'serious' | 'critical';
  start_ts: string;
  end_ts: string;
  slots: number;
  value: number | null;
  expected: number | null;
  detail: Record<string, any>;
  explanation: string;
  status: 'open' | 'ack' | 'closed';
  note: string;
  handled_by: string;
  point_code?: string;
  point_kind?: string;
}

export interface RankItem {
  point_id: number;
  code: string;
  kind: string;
  up3: string;
  parent?: string;
  cap_mw: number;
  peak_mw: number;
  peak_ts: string | null;
  peak_mva: number;
  peak_util: number;
  peak_i: number;
  avg_mw: number;
  energy_mwh: number;
  energy_exp_mwh: number;
  mvarh_imp: number;
  load_factor: number;
  hours_over80: number;
  hours_over100: number;
  max_imbalance: number;
  min_pf: number;
  avg_pf: number;
  min_v: number;
  max_v: number;
  samples: number;
  metered_slots: number;
  days: number;
}

/** Neraca energi (susut) satu periode. */
export interface BalanceResult {
  e_in: number;
  e_out: number;
  e_out_measured: number;
  loss: number;
  pct: number;
  coverage: number;
  days: number;
  valid_days: number;
  metered: number;
  members: number;
  included?: number;
  status: 'ok' | 'estimasi' | 'cakupan_kurang' | 'tanpa_data';
  daily?: { day: string; e_in: number; e_out: number; loss: number; pct: number; coverage: number; valid: boolean }[];
}

export interface LossRow extends BalanceResult {
  point_id: number;
  code: string;
  kind: string;
  up3: string;
  ulp: string;
}

export const DATA_KINDS = ['missing', 'stale', 'out_of_range', 'zero_load', 'spike', 'drop', 'energy', 'mismatch'];
export const NET_KINDS = ['overload', 'imbalance', 'low_pf', 'voltage', 'frequency', 'level_shift', 'losses'];
