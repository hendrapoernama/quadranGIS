/**
 * Tata letak diagram satu garis: pohon skematik ortogonal ala SLD penyulang.
 * Sumbu utama = kedalaman (kolom), sumbu silang = baris daun. Induk berada pada baris anak
 * pertamanya (cabang utama) sehingga saluran utama lurus; cabang lain turun tegak lurus dari
 * satu garis "tap" di sisi hilir induk. Orientasi: sumber di kiri (h) atau di atas (v).
 */

export interface SLDNodeData {
  id: number;
  kind: 'node' | 'customers';
  code: string;
  name: string;
  type_code: string;
  energized: boolean;
  open: boolean;
  open_ways?: number[];
  normal_open?: boolean;
  switch?: boolean;
  source?: boolean;
  sink?: boolean;
  parent: number;
  section: number;
  depth: number;
  feeder?: number;
  zone?: number;
  customers: number;
  customers_off: number;
  load_va: number;
  count?: number;
  kva?: number;
  kode_ssot?: string;
  outside?: boolean;
  collapsed?: number;
  head?: boolean;
}

export interface SLDSectionData {
  id: number;
  edge_ids: number[];
  from: number;
  to: number;
  type_code: string;
  code: string;
  conductor?: string;
  length_m: number;
  energized: boolean;
  open: boolean;
  skipped: number;
  mixed?: boolean;
}

export interface SLDTieData {
  id: number;
  from: number;
  to: number;
  to_code: string;
  to_type: string;
  to_feeder?: number;
  to_feeder_code?: string;
  kind: 'tie' | 'loop' | 'offpage';
  open: boolean;
  energized: boolean;
  customers?: number;
}

export interface SLDDiagramData {
  scope: string;
  scope_id: number;
  scope_key: string;
  level: string;
  title: string;
  roots: number[];
  nodes: SLDNodeData[];
  sections: SLDSectionData[];
  ties: SLDTieData[];
  warnings: string[];
  truncated: boolean;
  stats: { elements: number; raw_nodes: number; customers: number; customers_off: number; load_va: number; length_m: number; build_ms: number };
  gen: number;
  at: string;
  feeders: { head: number; code: string }[];
}

export type Orientation = 'h' | 'v';
export type Offsets = Record<number, { dx: number; dy: number }>;

export const COL_W = 170; // jarak antar kolom (sumbu utama)
export const ROW_H = 68; // jarak antar baris (sumbu silang): cukup untuk kode di atas & keterangan di bawah simbol
export const TAP = 34; // jarak garis tap cabang dari pusat induk

export interface Pt {
  x: number;
  y: number;
}
export interface PlacedNode {
  node: SLDNodeData;
  x: number;
  y: number;
  leaf: boolean;
  rootIndex: number;
}
export interface PlacedSection {
  sec: SLDSectionData;
  points: Pt[];
  /** ruas yang menyeberang baris lipatan: digambar sebagai dua potongan dengan penanda kelanjutan */
  cont?: { label: string; head: Pt[]; tail: Pt[] };
  mid: Pt; // titik label (tengah ruas lurus terpanjang)
  along: 'main' | 'cross';
}
export interface PlacedTie {
  tie: SLDTieData;
  from: Pt;
  to: Pt; // ujung stub
  label: Pt;
  dir: 'main' | 'cross';
}
export interface Layout {
  nodes: Map<number, PlacedNode>;
  sections: PlacedSection[];
  ties: PlacedTie[];
  width: number;
  height: number;
  minX: number;
  minY: number;
}

/** Menyusun posisi elemen. Offsets (geser manual) diterapkan setelah tata letak otomatis.
 *  wrap: saluran utama yang sangat panjang dilipat menjadi beberapa baris (pita) dengan penanda kelanjutan. */
export function layoutDiagram(d: SLDDiagramData, orient: Orientation, offsets: Offsets = {}, wrap = true): Layout {
  const byId = new Map<number, SLDNodeData>();
  const children = new Map<number, number[]>();
  for (const n of d.nodes) {
    byId.set(n.id, n);
    if (n.parent) {
      const arr = children.get(n.parent) || [];
      arr.push(n.id);
      children.set(n.parent, arr);
    }
  }
  const roots = d.roots.filter((r) => byId.has(r));
  // node tanpa induk dalam data (mis. terpotong) juga menjadi akar
  for (const n of d.nodes) if (!n.parent && !roots.includes(n.id)) roots.push(n.id);

  const col = new Map<number, number>();
  const row = new Map<number, number>();
  let nextRow = 0;
  const rootOf = new Map<number, number>();
  const place = (id: number, depth: number, ri: number) => {
    col.set(id, depth);
    rootOf.set(id, ri);
    const kids = children.get(id) || [];
    if (kids.length === 0) {
      row.set(id, nextRow++);
      return;
    }
    for (const k of kids) place(k, depth + 1, ri);
    row.set(id, row.get(kids[0])!); // induk sebaris dengan cabang utama
  };
  roots.forEach((r, i) => {
    if (i > 0) nextRow++; // jeda antar pohon
    place(r, 0, i);
  });

  // pita lipatan: jumlah pita dipilih agar proporsi tiap pita mendekati 1,6 : 1
  let maxCol = 0;
  col.forEach((c) => (maxCol = Math.max(maxCol, c)));
  const C = maxCol + 1;
  const R = Math.max(1, nextRow);
  let perBand = C;
  if (wrap && C > 12) {
    const W = C * COL_W;
    const H = (R + 1) * ROW_H;
    const B = Math.max(1, Math.min(Math.ceil(C / 6), Math.round(Math.sqrt(W / (1.6 * H)))));
    perBand = Math.ceil(C / B);
  }
  const bandH = (R + 1.6) * ROW_H;
  const bandOf = (c: number) => Math.floor(c / perBand);
  const main = (c: number) => (c % perBand) * COL_W + COL_W * 0.5;
  const cross = (r: number, c: number) => r * ROW_H + ROW_H + bandOf(c) * bandH;
  const toXY = (m: number, c: number): Pt => (orient === 'h' ? { x: m, y: c } : { x: c, y: m });

  const nodes = new Map<number, PlacedNode>();
  for (const n of d.nodes) {
    const c = col.get(n.id) ?? 0;
    const r = row.get(n.id) ?? 0;
    const p = toXY(main(c), cross(r, c));
    const o = offsets[n.id];
    if (o) {
      p.x += o.dx;
      p.y += o.dy;
    }
    nodes.set(n.id, { node: n, x: p.x, y: p.y, leaf: (children.get(n.id) || []).length === 0, rootIndex: rootOf.get(n.id) ?? 0 });
  }

  // ruas: lurus bila sebaris (pada sumbu silang), selain itu ortogonal lewat garis tap induk
  const sections: PlacedSection[] = [];
  const mainOf = (p: Pt) => (orient === 'h' ? p.x : p.y);
  const crossOf = (p: Pt) => (orient === 'h' ? p.y : p.x);
  const mk = (m: number, c: number) => toXY(m, c);
  let contNo = 0;
  for (const sec of d.sections) {
    const a = nodes.get(sec.from);
    const b = nodes.get(sec.to);
    if (!a || !b) continue;
    const A = { x: a.x, y: a.y };
    const B = { x: b.x, y: b.y };
    if (bandOf(col.get(sec.from) ?? 0) !== bandOf(col.get(sec.to) ?? 0)) {
      // menyeberang pita: potongan keluar di ujung pita + potongan masuk di awal pita berikutnya
      const label = `K${++contNo}`;
      const headEnd = mk(mainOf(A) + COL_W * 0.45, crossOf(A));
      const tailStart = mk(mainOf(B) - COL_W * 0.45, crossOf(B));
      sections.push({ sec, points: [A, headEnd], mid: { x: (A.x + headEnd.x) / 2, y: (A.y + headEnd.y) / 2 }, along: 'main', cont: { label, head: [A, headEnd], tail: [tailStart, B] } });
      continue;
    }
    let points: Pt[];
    if (Math.abs(crossOf(A) - crossOf(B)) < 0.5) {
      points = [A, B];
    } else {
      const tapM = mainOf(A) + TAP;
      points = [A, mk(tapM, crossOf(A)), mk(tapM, crossOf(B)), B];
    }
    // label di tengah ruas terpanjang
    let best = 0;
    let bi = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const len = Math.abs(points[i].x - points[i + 1].x) + Math.abs(points[i].y - points[i + 1].y);
      if (len > best) {
        best = len;
        bi = i;
      }
    }
    const p0 = points[bi];
    const p1 = points[bi + 1];
    const along: 'main' | 'cross' = Math.abs(mainOf(p0) - mainOf(p1)) >= Math.abs(crossOf(p0) - crossOf(p1)) ? 'main' : 'cross';
    sections.push({ sec, points, mid: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, along });
  }

  // tie / loop / penghubung antar-halaman: stub dari elemen. Daun: lanjut sumbu utama; lainnya: ke atas (sumbu silang negatif)
  const ties: PlacedTie[] = [];
  const stubCount = new Map<number, number>();
  for (const tie of d.ties) {
    const a = nodes.get(tie.from);
    if (!a) continue;
    const k = stubCount.get(tie.from) || 0;
    stubCount.set(tie.from, k + 1);
    const A = { x: a.x, y: a.y };
    let to: Pt;
    let dir: 'main' | 'cross';
    if (a.leaf && k === 0) {
      to = mk(mainOf(A) + COL_W * 0.62, crossOf(A));
      dir = 'main';
    } else {
      to = mk(mainOf(A) + 10 + k * 14, crossOf(A) - ROW_H * 0.62);
      dir = 'cross';
    }
    ties.push({ tie, from: A, to, label: to, dir });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (p: Pt) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  nodes.forEach((n) => acc(n));
  ties.forEach((t) => acc(t.to));
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
  return { nodes, sections, ties, minX, minY, width: maxX - minX, height: maxY - minY };
}
