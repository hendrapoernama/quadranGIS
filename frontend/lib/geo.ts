import type { FeatureCollection, GeoFeature } from './types';

export type BBox = [number, number, number, number];

function walk(coords: any, fn: (c: number[]) => void) {
  if (typeof coords[0] === 'number') fn(coords);
  else coords.forEach((c: any) => walk(c, fn));
}

export function bboxOf(fc: FeatureCollection | GeoFeature[] | null | undefined): BBox | null {
  const feats = Array.isArray(fc) ? fc : fc?.features;
  if (!feats || feats.length === 0) return null;
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  for (const f of feats) {
    if (!f.geometry) continue;
    walk(f.geometry.coordinates, (c) => {
      minx = Math.min(minx, c[0]);
      miny = Math.min(miny, c[1]);
      maxx = Math.max(maxx, c[0]);
      maxy = Math.max(maxy, c[1]);
    });
  }
  if (!Number.isFinite(minx)) return null;
  if (minx === maxx && miny === maxy) {
    const d = 0.002;
    return [minx - d, miny - d, maxx + d, maxy + d];
  }
  return [minx, miny, maxx, maxy];
}

/** Titik terdekat pada polyline (koordinat layar). */
export function closestOnPolyline(pt: [number, number], line: [number, number][]): { point: [number, number]; dist: number } {
  let best: [number, number] = line[0];
  let bestD = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx,
      cy = ay + t * dy;
    const d = Math.hypot(pt[0] - cx, pt[1] - cy);
    if (d < bestD) {
      bestD = d;
      best = [cx, cy];
    }
  }
  return { point: best, dist: bestD };
}

export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

const R = 6371008.8;

/** Jarak geodesik (haversine) dalam meter. */
export function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pathLength(coords: [number, number][]): number {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += haversine(coords[i - 1], coords[i]);
  return t;
}

/** Luas poligon pada bola (m²), cincin tidak perlu ditutup. */
export function ringArea(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    total += (toRad(p2[0]) - toRad(p1[0])) * (2 + Math.sin(toRad(p1[1])) + Math.sin(toRad(p2[1])));
  }
  return Math.abs((total * R * R) / 2);
}

export function fmtArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 3 })} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toLocaleString('id-ID', { maximumFractionDigits: 3 })} ha`;
  return `${m2.toLocaleString('id-ID', { maximumFractionDigits: 1 })} m²`;
}

export function fmtDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toLocaleString('id-ID', { maximumFractionDigits: 3 })} km`;
  return `${m.toLocaleString('id-ID', { maximumFractionDigits: 1 })} m`;
}

export function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function downloadJSON(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
