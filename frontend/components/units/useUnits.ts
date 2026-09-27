'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface OrgUnit {
  id: number;
  code: string;
  name: string;
  kind: 'PUSAT' | 'REGION' | 'UID' | 'UP2B' | 'UP3' | 'UP2D' | 'ULP';
  parent_id: number | null;
  address: string;
  lng: number | null;
  lat: number | null;
  phone: string;
  email: string;
  boundary_name: string;
  active: boolean;
  updated_at: string;
  updated_by: string;
  level: number;
  path?: string[];
  assets?: Record<string, number>;
  children: number;
}

export const UNIT_KINDS = ['PUSAT', 'REGION', 'UID', 'UP2B', 'UP3', 'UP2D', 'ULP'] as const;
export const UNIT_LEVEL: Record<string, number> = { PUSAT: 0, REGION: 1, UID: 2, UP2B: 2, UP3: 3, UP2D: 3, ULP: 4 };
/** jenis induk yang sah untuk tiap jenis unit */
export const UNIT_PARENT: Record<string, string[]> = { PUSAT: [], REGION: ['PUSAT'], UID: ['REGION'], UP2B: ['REGION'], UP3: ['UID'], UP2D: ['UID'], ULP: ['UP3'] };

let cache: { at: number; items: OrgUnit[] } | null = null;
let inflight: Promise<OrgUnit[]> | null = null;

export function loadUnits(force = false): Promise<OrgUnit[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.items);
  if (!force && inflight) return inflight;
  inflight = api<{ items: OrgUnit[] }>('/api/units')
    .then((r) => {
      cache = { at: Date.now(), items: r.items };
      return r.items;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateUnits() {
  cache = null;
}

/** Daftar unit aktif (urut pohon) untuk pemilih. */
export function useUnits(): OrgUnit[] {
  const [items, setItems] = useState<OrgUnit[]>(cache?.items || []);
  useEffect(() => {
    let stop = false;
    loadUnits()
      .then((x) => !stop && setItems(x.filter((u) => u.active)))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  return items;
}

/** Label bertingkat untuk <option>: indentasi sesuai jenjang. */
export function unitLabel(u: OrgUnit): string {
  return `${'  '.repeat(u.level)}${u.name} (${u.kind})`;
}
