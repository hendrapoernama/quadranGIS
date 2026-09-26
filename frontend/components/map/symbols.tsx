'use client';

import { useEffect, useRef } from 'react';
import type { Map as MLMap } from 'maplibre-gl';

/**
 * Simbol peralatan listrik bergaya diagram satu garis (IEC 60617 / SPLN), digambar di canvas
 * 48x48 lalu diubah menjadi signed distance field (SDF) agar warna (tipe / status) dan tepi
 * (halo: padam / terbuka) dapat diatur lewat style peta. Alat switching punya varian terbuka.
 *
 * Konvensi: alat switching tertutup = simbol isi / pisau lurus, terbuka = simbol berongga / pisau miring.
 */
const S = 48;
const LW = 3.6;

type Draw = (g: CanvasRenderingContext2D, open: boolean) => void;

const line = (g: CanvasRenderingContext2D, pts: [number, number][]) => {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.stroke();
};
const circle = (g: CanvasRenderingContext2D, x: number, y: number, r: number, fill = false) => {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  if (fill) g.fill();
  else g.stroke();
};
/** Pisau switch dari titik engsel (bawah) ke kontak atas; terbuka = miring 35°. */
const blade = (g: CanvasRenderingContext2D, px: number, py: number, len: number, open: boolean) => {
  const a = open ? (-35 * Math.PI) / 180 : 0;
  line(g, [
    [px, py],
    [px + Math.sin(a) * len, py - Math.cos(a) * len],
  ]);
};
/** Dua lingkaran bersinggungan: transformator (IEC 60617-06-02-01). */
const transformer = (g: CanvasRenderingContext2D, cx: number, cy: number, r: number) => {
  circle(g, cx, cy - r * 0.62, r);
  circle(g, cx, cy + r * 0.62, r);
};

export const SYMBOLS: Record<string, { draw: Draw; switchable?: boolean; label: string; labelEN: string }> = {
  sym_source: {
    label: 'Sumber (jaringan AC)',
    labelEN: 'Source (AC grid)',
    draw: (g) => {
      circle(g, 24, 24, 16);
      g.beginPath();
      for (let x = -10; x <= 10; x++) {
        const y = 24 - Math.sin((x / 10) * Math.PI) * 6;
        if (x === -10) g.moveTo(24 + x, y);
        else g.lineTo(24 + x, y);
      }
      g.stroke();
    },
  },
  sym_gi: {
    label: 'Gardu induk',
    labelEN: 'Substation',
    draw: (g) => {
      g.strokeRect(6, 6, 36, 36);
      g.lineWidth = 2.4;
      g.strokeRect(11, 11, 26, 26);
      g.lineWidth = LW;
      transformer(g, 24, 24, 6);
    },
  },
  sym_gh: {
    label: 'Gardu hubung (busbar)',
    labelEN: 'Switching substation (busbar)',
    draw: (g) => {
      g.strokeRect(6, 6, 36, 36);
      g.fillRect(12, 17, 24, 4);
      for (const x of [16, 24, 32]) line(g, [[x, 21], [x, 33]]);
    },
  },
  sym_gd: {
    label: 'Gardu distribusi',
    labelEN: 'Distribution substation',
    draw: (g) => {
      g.strokeRect(7, 7, 34, 34);
      transformer(g, 24, 24, 6.5);
    },
  },
  sym_trafo: {
    label: 'Transformator',
    labelEN: 'Transformer',
    draw: (g) => transformer(g, 24, 24, 10),
  },
  sym_cb: {
    label: 'Pemutus tenaga / kubikel (isi = tertutup)',
    labelEN: 'Circuit breaker / cubicle (filled = closed)',
    switchable: true,
    draw: (g, open) => {
      line(g, [[24, 2], [24, 11]]);
      line(g, [[24, 37], [24, 46]]);
      if (open) g.strokeRect(13, 13, 22, 22);
      else g.fillRect(12, 12, 24, 24);
    },
  },
  sym_recloser: {
    label: 'Recloser (isi = tertutup)',
    labelEN: 'Recloser (filled = closed)',
    switchable: true,
    draw: (g, open) => {
      line(g, [[24, 2], [24, 9]]);
      line(g, [[24, 39], [24, 46]]);
      g.font = 'bold 20px Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      if (open) {
        g.strokeRect(11, 11, 26, 26);
        g.fillText('R', 24, 25);
      } else {
        g.fillRect(10, 10, 28, 28);
        g.globalCompositeOperation = 'destination-out';
        g.fillText('R', 24, 25);
        g.globalCompositeOperation = 'source-over';
      }
    },
  },
  sym_lbs: {
    label: 'LBS / saklar pemutus beban',
    labelEN: 'Load break switch',
    switchable: true,
    draw: (g, open) => {
      line(g, [[24, 46], [24, 34]]);
      circle(g, 24, 31, 3, true); // engsel
      blade(g, 24, 31, 20, open);
      line(g, [[24, 11], [24, 2]]);
      line(g, [[17, 11], [31, 11]]); // kontak tetap (pemisah)
    },
  },
  sym_lbs3: {
    label: 'LBS 3 arah',
    labelEN: '3-way load break switch',
    switchable: true,
    draw: (g, open) => {
      line(g, [[24, 46], [24, 34]]);
      line(g, [[24, 40], [44, 40]]); // arah ke-3
      circle(g, 24, 31, 3, true);
      blade(g, 24, 31, 20, open);
      line(g, [[24, 11], [24, 2]]);
      line(g, [[17, 11], [31, 11]]);
    },
  },
  sym_fuse: {
    label: 'Switch jurusan TR (NH fuse)',
    labelEN: 'LV route switch (NH fuse)',
    switchable: true,
    draw: (g, open) => {
      line(g, [[24, 46], [24, 38]]);
      line(g, [[24, 10], [24, 2]]);
      g.save();
      g.translate(24, 38);
      if (open) g.rotate((-32 * Math.PI) / 180);
      g.strokeRect(-6, -26, 12, 24);
      line(g, [[0, 0], [0, -28]]);
      g.restore();
    },
  },
  sym_rak: {
    label: 'Rak TR / PHB-TR (busbar TR)',
    labelEN: 'LV rack / LV board (busbar)',
    draw: (g) => {
      line(g, [[24, 2], [24, 12]]);
      g.fillRect(6, 12, 36, 6); // busbar
      for (const x of [11, 24, 37]) {
        line(g, [[x, 18], [x, 34]]);
        g.fillRect(x - 3.5, 34, 7, 9); // pengaman jurusan
      }
    },
  },
  sym_house: {
    label: 'Pelanggan',
    labelEN: 'Customer',
    draw: (g) => {
      g.beginPath();
      g.moveTo(5, 23);
      g.lineTo(24, 6);
      g.lineTo(43, 23);
      g.closePath();
      g.fill();
      g.fillRect(11, 21, 26, 20);
      g.clearRect(21, 29, 7, 12);
    },
  },
  sym_pole: {
    label: 'Tiang',
    labelEN: 'Pole',
    draw: (g) => {
      g.lineWidth = 5;
      circle(g, 24, 24, 13);
      circle(g, 24, 24, 3.5, true);
    },
  },
};

export const SYMBOL_KEYS = Object.keys(SYMBOLS);
export const isSymbol = (icon?: string | null) => !!icon && icon in SYMBOLS;
export const symbolImage = (key: string, open = false) => (open && SYMBOLS[key]?.switchable ? `${key}_open` : key);

function drawOn(g: CanvasRenderingContext2D, key: string, open: boolean, color: string) {
  g.strokeStyle = g.fillStyle = color;
  g.lineWidth = LW;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  SYMBOLS[key].draw(g, open);
}

/** Canvas (alpha) -> SDF RGBA untuk addImage({sdf:true}). */
function toSDF(g: CanvasRenderingContext2D): Uint8Array {
  const px = g.getImageData(0, 0, S, S).data;
  const inside = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) inside[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  const edge: number[] = [];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = inside[y * S + x];
      if ((x > 0 && inside[y * S + x - 1] !== v) || (x < S - 1 && inside[y * S + x + 1] !== v) || (y > 0 && inside[(y - 1) * S + x] !== v) || (y < S - 1 && inside[(y + 1) * S + x] !== v))
        edge.push(x, y);
    }
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let best = 1e9;
      for (let k = 0; k < edge.length; k += 2) {
        const dx = edge[k] - x;
        const dy = edge[k + 1] - y;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      const dist = Math.sqrt(best) * (inside[y * S + x] ? 1 : -1);
      const a = Math.max(0, Math.min(255, Math.round(192 + dist * 16)));
      const o = (y * S + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = a;
    }
  return data;
}

/** Mendaftarkan seluruh simbol (dan varian terbukanya) ke peta sebagai ikon SDF. */
export function registerSymbols(map: MLMap) {
  if (typeof document === 'undefined') return;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g) return;
  for (const key of SYMBOL_KEYS) {
    for (const open of SYMBOLS[key].switchable ? [false, true] : [false]) {
      const name = symbolImage(key, open);
      if (map.hasImage(name)) continue;
      g.clearRect(0, 0, S, S);
      drawOn(g, key, open, '#000');
      map.addImage(name, { width: S, height: S, data: toSDF(g) }, { sdf: true, pixelRatio: 2 });
    }
  }
}

const urlCache = new Map<string, string>();

/** Gambar simbol sebagai data URL PNG (untuk SVG diagram satu garis & ekspor). */
export function symbolDataURL(icon: string, open: boolean, color: string, px = 96): string {
  if (typeof document === 'undefined' || !SYMBOLS[icon]) return '';
  const key = `${icon}|${open}|${color}|${px}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d');
  if (!g) return '';
  g.setTransform(px / S, 0, 0, px / S, 0, 0);
  drawOn(g, icon, open, color);
  const url = cv.toDataURL('image/png');
  urlCache.set(key, url);
  return url;
}

/** Pratinjau simbol untuk legenda / pengaturan layer. */
export function SymbolSwatch({ icon, color, size = 16, open = false, title }: { icon: string; color: string; size?: number; open?: boolean; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const g = cv?.getContext('2d');
    if (!cv || !g || !SYMBOLS[icon]) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    cv.width = cv.height = Math.round(size * dpr);
    g.setTransform((size * dpr) / S, 0, 0, (size * dpr) / S, 0, 0);
    g.clearRect(0, 0, S, S);
    drawOn(g, icon, open, color);
  }, [icon, color, size, open]);
  return <canvas ref={ref} style={{ width: size, height: size }} className="inline-block shrink-0" role="img" aria-label={title} title={title} />;
}
