import type { ReliabilityGroup } from '@/lib/types';

export interface Targets {
  saidi_year: number;
  saifi_year: number;
  saidi_period: number;
  saifi_period: number;
}

export interface Region {
  id: number;
  level: 'up3' | 'ulp' | 'outside';
  code: string;
  name: string;
  parent: string;
  parent_id?: number;
  customers: number;
  customers_off: number;
  area_km2: number;
}

export interface RegionRel extends Region {
  rel: ReliabilityGroup;
  active: number;
}

export interface FeederAgg {
  id: number;
  code: string;
  name: string;
  outages: number;
  faults: number;
  momentary: number;
  customers_out: number;
  customer_minutes: number;
  ens_kwh: number;
  ens_rp: number;
  last_at: string;
}

export interface OutageBrief {
  id: number;
  kind: string;
  level: string;
  cause_code: string;
  cause_type: string;
  feeder: string;
  started_at: string;
  ended_at: string | null;
  duration_min: number;
  customers: number;
  customer_minutes: number;
  ens_kwh: number;
  ens_rp: number;
  momentary: boolean;
  continuation: boolean;
}

export interface DayPoint {
  date: string;
  outages: number;
  faults: number;
  customers_out: number;
  customer_minutes: number;
  ens_rp: number;
}

export interface OpsStats {
  maneuvers: number;
  maneuvers_open: number;
  maneuvers_close: number;
  maneuver_kinds: Record<string, number>;
  plans_created: number;
  plans_done: number;
  plans_flisr: number;
  soe_serious: number;
  reports: number;
  reports_resolved: number;
  reports_open: number;
  reports_overdue: number;
  reports_linked: number;
  report_avg_resolve_min: number;
  report_categories: Record<string, number>;
  report_channels: Record<string, number>;
}

export interface PeriodReport {
  kind: string;
  from: string;
  to: string;
  generated_at: string;
  customers_served: number;
  targets: Targets;
  total: ReliabilityGroup;
  mttr_min: number;
  by_kind: Record<string, ReliabilityGroup>;
  by_level: Record<string, ReliabilityGroup>;
  regions: RegionRel[];
  top_feeders: FeederAgg[];
  top_outages: OutageBrief[];
  ops: OpsStats;
  previous: { from?: string; to?: string; total?: ReliabilityGroup; mttr_min?: number; reports?: number; maneuvers?: number };
  daily?: DayPoint[];
}

export interface MonthPoint extends ReliabilityGroup {
  month: string;
}

export interface Dashboard {
  period: string;
  report: PeriodReport;
  trend: MonthPoint[];
  ytd: { from: string; rel: ReliabilityGroup; elapsed: number; targets: Targets; saidi_projection: number; saifi_projection: number };
  now: {
    at: string;
    customers: { total: number; off: number };
    feeders: { on: number; partial: number; off: number };
    load_va: number;
    load_off_va: number;
    active_outages: number;
    reports_open: number;
    reports_overdue: number;
    plans_active: number;
    feeders_high_load: number;
    ready: boolean;
  };
}

export interface PeriodicReportMeta {
  id: number;
  kind: 'daily' | 'weekly' | 'monthly';
  period_start: string;
  period_end: string;
  title: string;
  narrative: string;
  narrative_by: string;
  generated_by: string;
  generated_at: string;
  data?: PeriodReport;
}

export interface Insight {
  code: string;
  severity: 'critical' | 'serious' | 'warning' | 'info';
  title: string;
  detail: string;
  target?: { kind: 'node' | 'edge' | 'outage' | 'region' | 'report' | 'plan'; id: number; code: string };
  value: number;
}
