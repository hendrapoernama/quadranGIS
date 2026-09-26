'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { realtime } from '@/lib/ws';
import { fmtDate, fmtLength, fmtNum, fmtVA } from '@/lib/format';
import type { ComponentType, FeederStatus, GDStatus, GeoFeature, RealtimeEvent, SearchHit } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import MapCanvas from '@/components/map/MapCanvas';
import { OFF_STATUS, ON_STATUS } from '@/components/map/mapStyle';
import { isSymbol, symbolDataURL } from '@/components/map/symbols';
import type { BasemapKind, DrawMode, MapHandle } from '@/components/map/types';
import { OperateBox, type ManeuverBody } from '@/components/power/OperateBox';
import { SectionRecap } from '@/components/power/SectionRecap';
import { COL_W, ROW_H, layoutDiagram, type Layout, type Offsets, type Orientation, type PlacedNode, type SLDDiagramData, type SLDNodeData, type SLDSectionData, type SLDTieData } from './layout';

type ScopeMode = 'feeder' | 'gi' | 'gd' | 'node' | 'area';
type Level = 'tm' | 'gd' | 'jurusan' | 'pelanggan';
interface Scope {
  scope: ScopeMode;
  id: number;
  level: Level;
  polygon?: [number, number][];
}
interface Sel {
  kind: 'node' | 'edge';
  id: number;
}
interface PFOverlay {
  vpu: Map<number, number>;
  loading: Map<number, number>;
  feeders: number;
  at: Date;
}

const LEVELS: Level[] = ['tm', 'gd', 'jurusan', 'pelanggan'];
const SYM = 28; // ukuran simbol (px diagram)
const GOOD = '#0ca30c';
const WARN = '#fab219';
const SERIOUS = '#ec835a';
const CRIT = '#d03b3b';
const noop = async () => {};

/** Data diagram dari server dinormalisasi: field daftar yang kosong / null menjadi array kosong. */
function normalizeDiagram(d: SLDDiagramData): SLDDiagramData {
  return {
    ...d,
    roots: d.roots || [],
    nodes: d.nodes || [],
    sections: (d.sections || []).map((s) => ({ ...s, edge_ids: s.edge_ids || [s.id] })),
    ties: d.ties || [],
    warnings: d.warnings || [],
    feeders: d.feeders || [],
    stats: d.stats || { elements: 0, raw_nodes: 0, customers: 0, customers_off: 0, load_va: 0, length_m: 0, build_ms: 0 },
  };
}

function loadingColor(pct: number | undefined): string {
  if (pct === undefined) return '#9ca3af';
  if (pct < 60) return GOOD;
  if (pct < 80) return WARN;
  if (pct < 100) return SERIOUS;
  return CRIT;
}

export default function SLD() {
  const { t, pick } = useT();
  const { has, user } = useAuth();
  const { resolved } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const dark = resolved === 'dark';
  const canEdit = has('gis.edit');

  const [types, setTypes] = useState<ComponentType[]>([]);
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<Scope | null>(null);
  const [diagram, setDiagram] = useState<SLDDiagramData | null>(null);
  const [building, setBuilding] = useState(false);
  const [offsets, setOffsets] = useState<Offsets>({});
  const [dirty, setDirty] = useState(false);
  const [orient, setOrient] = useState<Orientation>('h');
  const [colorMode, setColorMode] = useState<'status' | 'type'>('status');
  const [showTies, setShowTies] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [adjust, setAdjust] = useState(false);
  const [pfOn, setPfOn] = useState(false);
  const [pf, setPf] = useState<PFOverlay | null>(null);
  const [pfBusy, setPfBusy] = useState(false);
  const [selected, setSelected] = useState<Sel | null>(null);
  const [feature, setFeature] = useState<GeoFeature | null>(null);
  const [view, setView] = useState({ k: 1, tx: 40, ty: 40 });
  const [printing, setPrinting] = useState(false);
  const [wsOk, setWsOk] = useState(false);
  // panel cakupan
  const [mode, setMode] = useState<ScopeMode>('feeder');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: number; code: string; name: string; sub?: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mapMode, setMapMode] = useState<DrawMode>({ kind: 'select' });
  const [tileVersion, setTileVersion] = useState(0);
  const mapRef = useRef<MapHandle>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; node?: number; moved: boolean } | null>(null);
  const fitted = useRef<string>('');
  const focusRef = useRef<Sel | null>(null);
  const scopeRef = useRef<Scope | null>(null);
  scopeRef.current = scope;
  const basemap: BasemapKind = dark ? 'dark' : 'light';

  const typeOf = useCallback((code: string) => types.find((x) => x.code === code), [types]);
  const typeName = useCallback(
    (code: string) => {
      const x = typeOf(code);
      return x ? pick(x.name, x.name_en) : code;
    },
    [typeOf, pick],
  );
  const levelLabel = (lv: string) => t(`sld.level_${lv}` as any);

  // ------------------------------------------------------------ muat konfigurasi & parameter URL
  useEffect(() => {
    api<{ configs: Record<string, string>; types: ComponentType[]; tile_version: number }>('/api/config/public')
      .then((r) => {
        setTypes(r.types);
        setConfigs(r.configs);
        setTileVersion(r.tile_version);
        setLoaded(true);
        const p = new URLSearchParams(window.location.search);
        const defLevel = (r.configs['sld.default_level'] as Level) || 'tm';
        const lv = (p.get('level') as Level) || defLevel;
        const focus = p.get('focus');
        const sc = p.get('scope') as ScopeMode | null;
        const id = Number(p.get('id'));
        if (focus) {
          const [k, idStr] = focus.split(':');
          if ((k === 'node' || k === 'edge') && Number(idStr)) {
            focusRef.current = { kind: k, id: Number(idStr) };
            api<{ scope: ScopeMode; id: number }>(`/api/sld/resolve?kind=${k}&id=${idStr}`)
              .then((s) => {
                setMode(s.scope);
                setScope({ scope: s.scope, id: s.id, level: LEVELS.includes(lv) ? lv : defLevel });
              })
              .catch((e) => toast.push(e.message, 'error'));
            return;
          }
        }
        if (sc && sc !== 'area' && id) {
          setMode(sc);
          setScope({ scope: sc, id, level: LEVELS.includes(lv) ? lv : defLevel });
        }
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ susun diagram
  const build = useCallback(
    async (sc: Scope, keepView: boolean) => {
      setBuilding(true);
      try {
        const r = await api<{ diagram: SLDDiagramData; positions: Record<string, { dx: number; dy: number }> }>('/api/sld/build', {
          method: 'POST',
          body: { scope: sc.scope, id: sc.id, level: sc.level, polygon: sc.polygon },
        });
        const dg = normalizeDiagram(r.diagram);
        setDiagram(dg);
        const off: Offsets = {};
        for (const [k, v] of Object.entries(r.positions || {})) off[Number(k)] = v;
        setOffsets(off);
        setDirty(false);
        if (!keepView) fitted.current = '';
        if (dg.warnings.includes('too_many_elements')) toast.push(t('sld.warn_truncated', { n: fmtNum(dg.nodes.length) }), 'warning');
        if (dg.warnings.includes('area_empty')) toast.push(t('sld.warn_area_empty'), 'warning');
        if (dg.warnings.includes('graph_loading')) {
          toast.push(t('sld.warn_graph_loading'), 'warning');
          // susun ulang otomatis setelah graf selesai dimuat & dikelompokkan
          setTimeout(() => scopeRef.current && build(scopeRef.current, true), 8000);
        }
        if (sc.scope !== 'area') {
          const url = `/sld?scope=${sc.scope}&id=${sc.id}&level=${sc.level}`;
          window.history.replaceState(null, '', url);
        }
      } catch (e: any) {
        if (e?.status === 503) {
          // graf masih dimuat setelah server dimulai ulang: coba lagi otomatis
          toast.push(e.message, 'warning');
          setTimeout(() => {
            if (scopeRef.current === sc) build(sc, keepView);
          }, 5000);
        } else toast.push(e.message, 'error');
      } finally {
        setBuilding(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, t],
  );
  useEffect(() => {
    if (scope) build(scope, false);
  }, [scope, build]);

  // realtime: manuver / energisasi / topologi → susun ulang (tanpa mengubah tampilan)
  useEffect(() => {
    realtime.connect();
    const offStatus = realtime.onStatus(setWsOk);
    let tm: any = null;
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type === 'maneuver' || ev.type === 'energized' || ev.type === 'topology.rebuilt') {
        if (ev.tile_version) setTileVersion(ev.tile_version);
        clearTimeout(tm);
        tm = setTimeout(() => {
          if (scopeRef.current) build(scopeRef.current, true);
          setFeature((f) => {
            if (f) api<GeoFeature>(`/api/gis/features/${f.properties.kind}/${f.id}`).then(setFeature).catch(() => {});
            return f;
          });
        }, 700);
      }
    });
    return () => {
      off();
      offStatus();
      clearTimeout(tm);
    };
  }, [build]);

  // ------------------------------------------------------------ tata letak
  const layout: Layout | null = useMemo(() => (diagram ? layoutDiagram(diagram, orient, offsets, wrap) : null), [diagram, orient, offsets, wrap]);

  // tampilan awal terbaca: bila pas layar terlalu kecil, mulai dari kiri atas dengan skala 85%
  const readable = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !layout) return false;
    const W = svg.clientWidth;
    const H = svg.clientHeight;
    const k0 = Math.min(W / (layout.width + COL_W + 160), H / (layout.height + ROW_H + 160));
    if (k0 >= 0.8) return false;
    const k = 0.85;
    setView({ k, tx: 40 - (layout.minX - COL_W / 2) * k, ty: 40 - (layout.minY - ROW_H / 2) * k });
    return true;
  }, [layout]);
  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const W = svg.clientWidth;
    const H = svg.clientHeight;
    const pad = 80;
    const bw = layout.width + pad * 2 + COL_W;
    const bh = layout.height + pad * 2 + ROW_H;
    const k = Math.max(0.05, Math.min(2.5, Math.min(W / bw, H / bh)));
    setView({ k, tx: (W - (layout.width + COL_W) * k) / 2 - (layout.minX - COL_W / 2) * k, ty: (H - (layout.height + ROW_H) * k) / 2 - (layout.minY - ROW_H / 2) * k });
  }, [layout]);
  useEffect(() => {
    if (!layout || !diagram) return;
    const key = `${diagram.scope_key}|${orient}|${wrap}`;
    if (fitted.current !== key) {
      fitted.current = key;
      if (!readable()) fit();
    }
    // fokus dari URL: pilih objek setelah diagram tersedia
    if (focusRef.current) {
      const f = focusRef.current;
      focusRef.current = null;
      setSelected(f);
    }
  }, [layout, diagram, orient, wrap, fit, readable]);

  // ------------------------------------------------------------ objek terpilih
  useEffect(() => {
    if (!selected) {
      setFeature(null);
      return;
    }
    let alive = true;
    api<GeoFeature>(`/api/gis/features/${selected.kind}/${selected.id}`)
      .then((f) => alive && setFeature(f))
      .catch((e) => alive && toast.push(e.message, 'error'));
    return () => {
      alive = false;
    };
  }, [selected, toast]);

  const operate = async (body: ManeuverBody) => {
    if (!selected) return;
    const { target = 'node', ...rest } = body;
    try {
      const res = await api<{ message: string; tile_version: number; feature?: GeoFeature }>('/api/gis/maneuver', {
        method: 'POST',
        body: target === 'edge' ? { edge_id: selected.id, ...rest } : { node_id: selected.id, ...rest },
      });
      toast.push(res.message, body.action === 'open' ? 'warning' : 'success');
      if (res.feature) setFeature(res.feature);
      if (scope) setTimeout(() => build(scope, true), 500);
    } catch (e: any) {
      toast.push(e.message, 'error');
      throw e;
    }
  };

  // ------------------------------------------------------------ overlay aliran daya
  useEffect(() => {
    if (!pfOn || !diagram) {
      setPf(null);
      return;
    }
    const heads = diagram.feeders.map((f) => f.head).slice(0, 6);
    if (heads.length === 0) {
      toast.push(t('sld.pf_no_feeder'), 'warning');
      setPfOn(false);
      return;
    }
    let alive = true;
    setPfBusy(true);
    Promise.all(heads.map((h) => api<{ geojson: { features: any[] } }>('/api/powerflow/feeder', { method: 'POST', body: { head_id: h } }).catch(() => null)))
      .then((rs) => {
        if (!alive) return;
        const vpu = new Map<number, number>();
        const loading = new Map<number, number>();
        let n = 0;
        for (const r of rs) {
          if (!r) continue;
          n++;
          for (const f of r.geojson.features) {
            const p = f.properties || {};
            if (p.kind === 'node' && typeof p.v_pu === 'number') vpu.set(Number(f.id), p.v_pu);
            if (p.kind === 'edge' && typeof p.loading_pct === 'number') loading.set(Number(f.id), p.loading_pct);
          }
        }
        setPf({ vpu, loading, feeders: n, at: new Date() });
        if (n < heads.length) toast.push(t('sld.pf_partial', { n, total: heads.length }), 'warning');
      })
      .finally(() => alive && setPfBusy(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pfOn, diagram?.scope_key, diagram?.gen]);

  // ------------------------------------------------------------ pencarian cakupan
  useEffect(() => {
    if (mode === 'area') return;
    const s = q.trim();
    const tm = setTimeout(async () => {
      setSearching(true);
      try {
        if (mode === 'feeder') {
          const r = await api<{ items: FeederStatus[] }>(`/api/power/feeders?q=${encodeURIComponent(s)}&limit=20`);
          setHits(r.items.map((f) => ({ id: f.head_id, code: f.code || `#${f.head_id}`, name: f.name, sub: f.gi_code })));
        } else if (mode === 'gi') {
          const r = await api<{ items: { id: number; code: string; name: string; feeders: number }[] }>(`/api/power/gi?q=${encodeURIComponent(s)}`);
          setHits(r.items.slice(0, 30).map((g) => ({ id: g.id, code: g.code || `#${g.id}`, name: g.name, sub: `${g.feeders} ${t('power.feeders').toLowerCase()}` })));
        } else if (mode === 'gd') {
          const r = await api<{ items: GDStatus[] }>(`/api/power/gardu?q=${encodeURIComponent(s)}&limit=20`);
          setHits(r.items.map((g) => ({ id: g.id, code: g.code || `#${g.id}`, name: g.name, sub: g.feeder_code })));
        } else if (s.length >= 2) {
          const r = await api<{ items: SearchHit[] }>(`/api/gis/search?q=${encodeURIComponent(s)}&limit=20`);
          setHits(r.items.filter((h) => h.kind === 'node').map((h) => ({ id: h.id, code: h.code || `#${h.id}`, name: h.name, sub: typeName(h.type_code) })));
        } else setHits([]);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(tm);
  }, [mode, q, t, typeName]);

  const pickScope = (id: number) => {
    const lv = scope?.level || ((configs['sld.default_level'] as Level) || 'tm');
    setSelected(null);
    setScope({ scope: mode, id, level: lv });
  };
  const changeLevel = (lv: Level) => scope && setScope({ ...scope, level: lv });

  // ------------------------------------------------------------ pan / zoom / geser elemen
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const k = Math.max(0.05, Math.min(6, v.k * f));
      return { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) };
    });
  };
  const onDown = (e: React.PointerEvent, nodeId?: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, node: adjust && nodeId ? nodeId : undefined, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.node) {
      const id = d.node;
      const k = view.k;
      setOffsets((o) => ({ ...o, [id]: { dx: (o[id]?.dx || 0) + dx / k, dy: (o[id]?.dy || 0) + dy / k } }));
      setDirty(true);
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onUp = () => {
    drag.current = null;
  };
  const clickNode = (n: SLDNodeData) => {
    if (drag.current?.moved) return;
    if (n.kind !== 'node') return;
    setSelected({ kind: 'node', id: n.id });
  };
  const clickSection = (s: SLDSectionData) => {
    if (drag.current?.moved) return;
    setSelected({ kind: 'edge', id: s.id });
  };
  const clickTie = (tie: SLDTieData) => {
    if (drag.current?.moved) return;
    setSelected({ kind: 'node', id: tie.to });
  };

  const savePositions = async () => {
    if (!diagram) return;
    try {
      await api('/api/sld/positions', { method: 'PUT', body: { scope: diagram.scope_key, positions: offsets } });
      setDirty(false);
      toast.push(t('sld.positions_saved'), 'success');
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };
  const resetPositions = async () => {
    if (!diagram) return;
    try {
      await api(`/api/sld/positions?scope=${encodeURIComponent(diagram.scope_key)}`, { method: 'DELETE' });
      setOffsets({});
      setDirty(false);
      toast.push(t('sld.positions_reset'), 'success');
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };

  // ------------------------------------------------------------ ekspor
  const svgString = (forceLight: boolean) => {
    const body = bodyRef.current;
    if (!body || !layout) return '';
    const pad = 60;
    const w = layout.width + COL_W + pad * 2;
    const h = layout.height + ROW_H + pad * 2 + 30;
    const clone = body.cloneNode(true) as SVGGElement;
    clone.setAttribute('transform', `translate(${pad - (layout.minX - COL_W / 2)}, ${pad + 30 - (layout.minY - ROW_H / 2)})`);
    if (forceLight && dark) {
      clone.querySelectorAll('[data-ink]').forEach((el) => el.setAttribute('fill', (el as HTMLElement).dataset.ink === 'muted' ? '#6b7280' : '#111827'));
    }
    const bg = forceLight || !dark ? '#ffffff' : '#111827';
    const ink = forceLight || !dark ? '#111827' : '#f3f4f6';
    const title = diagram ? `${diagram.title} · ${levelLabel(diagram.level)} · ${fmtDate(new Date().toISOString())}` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, Segoe UI, Arial, sans-serif"><rect width="100%" height="100%" fill="${bg}"/><text x="${pad}" y="${pad - 20}" font-size="16" font-weight="600" fill="${ink}">${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>${clone.outerHTML}</svg>`;
  };
  const download = (name: string, blob: Blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const baseName = () => `sld_${(diagram?.scope_key || 'diagram').replace(/[^a-z0-9]+/gi, '_')}_${diagram?.level || ''}`;
  const exportSVG = () => {
    const s = svgString(false);
    if (s) download(`${baseName()}.svg`, new Blob([s], { type: 'image/svg+xml;charset=utf-8' }));
  };
  const exportPNG = () => {
    const s = svgString(false);
    if (!s) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const scale = Math.min(2, 16000 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      const g = cv.getContext('2d')!;
      g.scale(scale, scale);
      g.drawImage(img, 0, 0);
      cv.toBlob((b) => b && download(`${baseName()}.png`, b), 'image/png');
      URL.revokeObjectURL(url);
    };
    img.onerror = () => toast.push(t('sld.export_failed'), 'error');
    img.src = url;
  };
  useEffect(() => {
    if (!printing) return;
    document.body.classList.add('sld-printing');
    const done = () => {
      document.body.classList.remove('sld-printing');
      setPrinting(false);
    };
    window.addEventListener('afterprint', done, { once: true });
    const tm = setTimeout(() => window.print(), 400);
    return () => {
      clearTimeout(tm);
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('sld-printing');
    };
  }, [printing]);

  // ------------------------------------------------------------ warna & label
  const ink = dark ? '#f3f4f6' : '#111827';
  const muted = dark ? '#9ca3af' : '#6b7280';
  const sectionColor = (s: SLDSectionData) => {
    if (pf) {
      let mx: number | undefined;
      for (const id of s.edge_ids) {
        const v = pf.loading.get(id);
        if (v !== undefined) mx = mx === undefined ? v : Math.max(mx, v);
      }
      return loadingColor(mx);
    }
    if (colorMode === 'type') return s.energized ? typeOf(s.type_code)?.color || '#6b7280' : '#9ca3af';
    return s.energized ? ON_STATUS : OFF_STATUS;
  };
  const nodeColor = (n: SLDNodeData) => {
    if (colorMode === 'type') return n.energized ? typeOf(n.type_code)?.color || '#6b7280' : '#9ca3af';
    return n.energized ? ON_STATUS : OFF_STATUS;
  };
  const subLabel = (n: SLDNodeData): string => {
    const parts: string[] = [];
    if (n.head) parts.push(t('sld.head'));
    if (n.kva) parts.push(`${fmtNum(n.kva)} kVA`);
    if (n.customers > 0 && !n.sink) parts.push(`${fmtNum(n.customers)} ${t('sld.cust')}${n.customers_off > 0 ? ` (${fmtNum(n.customers_off)} ${t('power.off').toLowerCase()})` : ''}`);
    if (n.sink && n.load_va > 0 && !n.kva) parts.push(fmtVA(n.load_va));
    if (pf) {
      const v = pf.vpu.get(n.id);
      if (v !== undefined) parts.push(`${v.toFixed(3)} pu`);
    }
    return parts.join(' · ');
  };
  const tieLabel = (tie: SLDTieData) => {
    const target = tie.to_code || `#${tie.to}`;
    if (tie.kind === 'offpage') return `→ ${target}${tie.customers ? ` · ${fmtNum(tie.customers)} ${t('sld.cust')}` : ''}`;
    const fd = tie.to_feeder_code && tie.to_feeder !== undefined ? ` (${tie.to_feeder_code})` : '';
    return `${tie.kind === 'tie' ? 'NO' : t('sld.loop')} → ${target}${fd}`;
  };

  // ------------------------------------------------------------ badan diagram (dipakai layar & cetak)
  const renderBody = (L: Layout, forPrint: boolean) => {
    const inkC = forPrint ? '#111827' : ink;
    const mutedC = forPrint ? '#6b7280' : muted;
    const selId = selected?.id;
    return (
      <g ref={forPrint ? undefined : bodyRef} id="sld-body">
        {L.sections.map((ps) => {
          const s = ps.sec;
          const color = sectionColor(s);
          const isBus = s.type_code === 'busbar';
          const sel = selected?.kind === 'edge' && selId === s.id;
          const pts = ps.points.map((p) => `${p.x},${p.y}`).join(' ');
          if (ps.cont) {
            const c = ps.cont;
            const he = c.head[1];
            const ts = c.tail[0];
            const bg = dark && !forPrint ? '#111827' : '#ffffff';
            const line = (seg: { x: number; y: number }[]) => seg.map((q) => `${q.x},${q.y}`).join(' ');
            const marker = (q: { x: number; y: number }) => (
              <g>
                <circle cx={q.x} cy={q.y} r={9} fill={bg} stroke={color} strokeWidth={1.8} />
                <text x={q.x} y={q.y + 3.2} fontSize={8.5} fontWeight={700} fill={inkC} data-ink="ink" textAnchor="middle">
                  {c.label}
                </text>
              </g>
            );
            return (
              <g key={`s${s.id}`} className="cursor-pointer" onPointerDown={(e) => onDown(e)} onClick={() => clickSection(s)}>
                {[c.head, c.tail].map((seg, i) => (
                  <g key={i}>
                    <polyline points={line(seg)} fill="none" stroke="transparent" strokeWidth={14} />
                    {sel && <polyline points={line(seg)} fill="none" stroke="#0ea5e9" strokeWidth={8} strokeOpacity={0.5} />}
                    <polyline points={line(seg)} fill="none" stroke={color} strokeWidth={2.2} strokeDasharray={s.open ? '6 5' : !s.energized ? '2 4' : undefined} />
                  </g>
                ))}
                {marker(he)}
                {marker(ts)}
                {showLabels && (
                  <text x={(c.head[0].x + he.x) / 2} y={c.head[0].y - 6} fontSize={9.5} fill={mutedC} data-ink="muted" textAnchor="middle">
                    {fmtLength(s.length_m)}
                    {s.conductor ? ` · ${s.conductor}` : ''}
                  </text>
                )}
              </g>
            );
          }
          return (
            <g key={`s${s.id}`} className="cursor-pointer" onPointerDown={(e) => onDown(e)} onClick={() => clickSection(s)}>
              <polyline points={pts} fill="none" stroke="transparent" strokeWidth={14} />
              {sel && <polyline points={pts} fill="none" stroke="#0ea5e9" strokeWidth={isBus ? 12 : 8} strokeOpacity={0.5} strokeLinejoin="round" />}
              <polyline
                points={pts}
                fill="none"
                stroke={color}
                strokeWidth={isBus ? 6 : s.mixed ? 2.6 : 2.2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.open ? '6 5' : !s.energized ? '2 4' : undefined}
              />
              {showLabels && !isBus && (
                <text
                  x={ps.mid.x + (ps.along === 'cross' ? 6 : 0)}
                  y={ps.mid.y - (ps.along === 'main' ? 6 : -4)}
                  fontSize={9.5}
                  fill={mutedC}
                  data-ink="muted"
                  textAnchor={ps.along === 'main' ? 'middle' : 'start'}
                >
                  {fmtLength(s.length_m)}
                  {s.conductor ? ` · ${s.conductor}` : ''}
                  {s.skipped > 0 ? ` · +${s.skipped}` : ''}
                </text>
              )}
            </g>
          );
        })}
        {showTies &&
          L.ties.map((pt, i) => {
            const tie = pt.tie;
            const color = tie.kind === 'offpage' ? '#0ea5e9' : tie.open ? mutedC : sectionColor({ energized: tie.energized } as SLDSectionData);
            return (
              <g key={`t${tie.id}-${i}`} className="cursor-pointer" onPointerDown={(e) => onDown(e)} onClick={() => clickTie(tie)}>
                <line x1={pt.from.x} y1={pt.from.y} x2={pt.to.x} y2={pt.to.y} stroke="transparent" strokeWidth={12} />
                <line x1={pt.from.x} y1={pt.from.y} x2={pt.to.x} y2={pt.to.y} stroke={color} strokeWidth={1.8} strokeDasharray="5 4" />
                {tie.kind === 'offpage' ? (
                  <polygon points={`${pt.to.x - 6},${pt.to.y - 6} ${pt.to.x + 6},${pt.to.y} ${pt.to.x - 6},${pt.to.y + 6}`} fill={color} />
                ) : (
                  <circle cx={pt.to.x} cy={pt.to.y} r={4} fill={dark && !forPrint ? '#111827' : '#ffffff'} stroke={color} strokeWidth={1.8} />
                )}
                {showLabels && (
                  <text x={pt.to.x + (pt.dir === 'main' ? 9 : 4)} y={pt.to.y + (pt.dir === 'main' ? 3.5 : -6)} fontSize={9.5} fill={mutedC} data-ink="muted">
                    {tieLabel(tie)}
                  </text>
                )}
              </g>
            );
          })}
        {Array.from(L.nodes.values()).map((pn: PlacedNode) => {
          const n = pn.node;
          const color = nodeColor(n);
          const sel = selected?.kind === 'node' && selId === n.id;
          const labelUp = orient === 'h';
          if (n.kind === 'customers') {
            return (
              <g key={`c${n.id}`} transform={`translate(${pn.x},${pn.y})`}>
                <rect x={-16} y={-11} width={32} height={22} rx={4} fill={dark && !forPrint ? '#1f2937' : '#f3f4f6'} stroke={color} strokeWidth={1.5} />
                <image href={symbolDataURL('sym_house', false, color, 64)} x={-8} y={-8} width={16} height={16} />
                {showLabels && (
                  <text x={labelUp ? 0 : 22} y={labelUp ? 24 : 4} fontSize={9.5} fill={mutedC} data-ink="muted" textAnchor={labelUp ? 'middle' : 'start'}>
                    {fmtNum(n.count || n.customers)} {t('sld.cust')}
                    {n.customers_off > 0 ? ` (${fmtNum(n.customers_off)} ${t('power.off').toLowerCase()})` : ''} · {fmtVA(n.load_va)}
                  </text>
                )}
              </g>
            );
          }
          const ct = typeOf(n.type_code);
          const isOpen = n.open || (n.open_ways?.length || 0) > 0;
          const icon = ct && isSymbol(ct.icon) ? ct.icon : '';
          const sub = subLabel(n);
          const outsideOp = n.outside ? 0.45 : 1;
          return (
            <g
              key={`n${n.id}`}
              transform={`translate(${pn.x},${pn.y})`}
              className={adjust ? 'cursor-move' : 'cursor-pointer'}
              opacity={outsideOp}
              onPointerDown={(e) => {
                e.stopPropagation();
                onDown(e, n.id);
              }}
              onClick={() => clickNode(n)}
            >
              {sel && <circle r={SYM * 0.85} fill="#0ea5e9" fillOpacity={0.25} stroke="#0ea5e9" strokeWidth={2} />}
              {isOpen && <circle r={SYM * 0.7} fill="none" stroke={OFF_STATUS} strokeWidth={2} strokeDasharray="3 2" />}
              <circle r={SYM * 0.62} fill={dark && !forPrint ? '#111827' : '#ffffff'} />
              {icon ? (
                <image href={symbolDataURL(icon, isOpen, color, 96)} x={-SYM / 2} y={-SYM / 2} width={SYM} height={SYM} />
              ) : (
                <circle r={n.type_code === 'junction' ? 4 : 7} fill={color} stroke={dark && !forPrint ? '#111827' : '#ffffff'} strokeWidth={1.5} />
              )}
              {showLabels && (
                <>
                  <text
                    x={labelUp ? 0 : SYM * 0.8}
                    y={labelUp ? -SYM * 0.72 : -2}
                    fontSize={10.5}
                    fontWeight={600}
                    fill={inkC}
                    data-ink="ink"
                    textAnchor={labelUp ? 'middle' : 'start'}
                  >
                    {n.code || `#${n.id}`}
                  </text>
                  {sub && (
                    <text x={labelUp ? 0 : SYM * 0.8} y={labelUp ? SYM * 0.72 + 8 : 10} fontSize={9} fill={mutedC} data-ink="muted" textAnchor={labelUp ? 'middle' : 'start'}>
                      {sub}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </g>
    );
  };

  // ------------------------------------------------------------ tampilan
  if (error) return <div className="p-6 text-sm text-red-700">{t('map.config_failed', { msg: error })}</div>;
  if (!loaded)
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Spinner size={28} />
      </div>
    );

  const p = feature?.properties;
  const selNode = selected?.kind === 'node' && diagram ? diagram.nodes.find((n) => n.id === selected.id) : undefined;
  const selSection = selected?.kind === 'edge' && diagram ? diagram.sections.find((s) => s.id === selected.id) : undefined;
  const modes: { key: ScopeMode; label: string }[] = [
    { key: 'feeder', label: t('power.feeders') },
    { key: 'gi', label: t('power.gi') },
    { key: 'gd', label: t('power.gd') },
    { key: 'node', label: t('sld.mode_node') },
    { key: 'area', label: t('sld.mode_area') },
  ];

  return (
    <div className="flex h-full w-full flex-col">
      {/* judul */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-200 bg-white px-3 py-1.5 text-[11px] text-gray-600">
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Icon name="diagram" size={16} /> {t('sld.title')}
        </span>
        {diagram && (
          <span className="font-medium text-gray-800">
            {diagram.title} · {levelLabel(diagram.level)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ON_STATUS }} /> {t('power.on')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: OFF_STATUS }} /> {t('power.off')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed border-red-600" /> {t('layers.legend_open')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0 w-5 border-t-2 border-dashed border-gray-500" /> {t('sld.legend_tie')}
        </span>
        {pf && (
          <span className="flex items-center gap-2">
            {t('pf.loading')}:
            {[
              [GOOD, '<60%'],
              [WARN, '60–80%'],
              [SERIOUS, '80–100%'],
              [CRIT, '>100%'],
            ].map(([c, l]) => (
              <span key={l} className="flex items-center gap-1">
                <span className="inline-block h-1 w-4 rounded" style={{ background: c }} /> {l}
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-gray-500">
          {diagram && (
            <span>
              {fmtNum(diagram.stats.elements)} {t('sld.elements')} · {fmtNum(diagram.stats.customers)} {t('sld.cust')} ({fmtNum(diagram.stats.customers_off)} {t('power.off').toLowerCase()}) ·{' '}
              {fmtVA(diagram.stats.load_va)} · {fmtLength(diagram.stats.length_m)}
            </span>
          )}
          <span className="flex items-center gap-1" title={wsOk ? t('map.realtime_on') : t('map.realtime_off')}>
            <span className={`inline-block h-2 w-2 rounded-full ${wsOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
            {t('map.realtime')}
          </span>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* panel cakupan */}
        <aside className={`flex shrink-0 flex-col border-r border-gray-200 bg-white transition-all ${panelOpen ? 'w-[21rem]' : 'w-10'}`}>
          <div className="flex items-center justify-between border-b border-gray-200 px-2 py-1">
            {panelOpen && <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{t('sld.scope')}</span>}
            <button className="p-1 text-gray-500 hover:text-gray-800" onClick={() => setPanelOpen(!panelOpen)} aria-label={t('map.collapse_panel')}>
              <Icon name={panelOpen ? 'chevron-left' : 'chevron-right'} size={16} />
            </button>
          </div>
          {panelOpen && (
            <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
              <div className="flex flex-wrap gap-1">
                {modes.map((m) => (
                  <button
                    key={m.key}
                    className={`rounded-md border px-2 py-1 text-xs ${mode === m.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}
                    onClick={() => {
                      setMode(m.key);
                      setHits([]);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {mode !== 'area' ? (
                <div>
                  <input className="input" placeholder={t(('sld.search_' + mode) as any)} value={q} onChange={(e) => setQ(e.target.value)} />
                  <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
                    {searching && (
                      <li className="py-2 text-center">
                        <Spinner size={14} />
                      </li>
                    )}
                    {!searching && hits.length === 0 && q.trim() && <li className="py-2 text-center text-xs text-gray-500">{t('common.no_data')}</li>}
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-gray-100 ${scope?.scope === mode && scope.id === h.id ? 'bg-brand-50 text-brand-700' : 'text-gray-800'}`}
                          onClick={() => pickScope(h.id)}
                        >
                          <span className="font-medium">{h.code}</span>
                          <span className="flex-1 truncate text-gray-500">{h.name}</span>
                          {h.sub && <span className="text-[10px] text-gray-400">{h.sub}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs text-gray-600">{t('sld.area_hint')}</div>
                  <div className="relative h-64 overflow-hidden rounded-md border border-gray-200">
                    <MapCanvas
                      ref={mapRef}
                      types={types}
                      configs={configs}
                      initialVersion={tileVersion}
                      initialBasemap={basemap}
                      initialColorMode="status"
                      mode={mapMode}
                      onSelect={() => {}}
                      onCreatePoint={noop}
                      onCreatePolygon={noop}
                      onCreateLine={noop}
                      onMove={noop}
                      onReshape={noop}
                      onReshapePolygon={noop}
                      onSplit={noop}
                      onVertexCommit={noop}
                      onMeasure={() => {}}
                      onCursor={() => {}}
                      onCancelMode={() => setMapMode({ kind: 'select' })}
                      onArea={(ring) => {
                        setMapMode({ kind: 'select' });
                        mapRef.current?.setArea(ring);
                        setSelected(null);
                        setScope({ scope: 'area', id: 0, level: scope?.level || 'tm', polygon: ring });
                      }}
                      onReady={() => {
                        mapRef.current?.setVisibleTypes(types.map((x) => x.code));
                        mapRef.current?.setBasemap(basemap);
                        mapRef.current?.setDarkLabels(basemap === 'dark');
                        mapRef.current?.setColorMode('status');
                      }}
                    />
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" icon="area" onClick={() => setMapMode({ kind: 'area' })} disabled={mapMode.kind === 'area'}>
                      {mapMode.kind === 'area' ? t('sld.area_drawing') : t('sld.area_draw')}
                    </Button>
                    {scope?.polygon && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          mapRef.current?.setArea(null);
                          setScope(null);
                          setDiagram(null);
                        }}
                      >
                        {t('sld.area_clear')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="block">
                  <span className="label">{t('sld.level')}</span>
                  <select className="input" value={scope?.level || configs['sld.default_level'] || 'tm'} onChange={(e) => changeLevel(e.target.value as Level)} disabled={!scope || scope.scope === 'gd'}>
                    {LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {levelLabel(lv)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">{t('sld.orientation')}</span>
                  <select className="input" value={orient} onChange={(e) => setOrient(e.target.value as Orientation)}>
                    <option value="h">{t('sld.orient_h')}</option>
                    <option value="v">{t('sld.orient_v')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="label">{t('sld.color')}</span>
                  <select className="input" value={colorMode} onChange={(e) => setColorMode(e.target.value as any)}>
                    <option value="status">{t('layers.color_status')}</option>
                    <option value="type">{t('layers.color_type')}</option>
                  </select>
                </label>
                <div className="space-y-1 pt-4">
                  <label className="flex items-center gap-2 text-gray-800">
                    <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> {t('sld.labels')}
                  </label>
                  <label className="flex items-center gap-2 text-gray-800">
                    <input type="checkbox" checked={showTies} onChange={(e) => setShowTies(e.target.checked)} /> {t('sld.ties')}
                  </label>
                  <label className="flex items-center gap-2 text-gray-800" title={t('sld.wrap_hint')}>
                    <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> {t('sld.wrap')}
                  </label>
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-800">
                <input type="checkbox" checked={pfOn} onChange={(e) => setPfOn(e.target.checked)} disabled={!diagram} /> {t('sld.pf_overlay')}
                {pfBusy && <Spinner size={12} />}
                {pf && <span className="text-[10px] text-gray-500">({pf.feeders} {t('power.feeders').toLowerCase()})</span>}
              </label>

              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="secondary" icon="target" onClick={fit} disabled={!layout}>
                  {t('sld.fit')}
                </Button>
                <Button size="sm" variant="secondary" icon="download" onClick={exportSVG} disabled={!layout}>
                  SVG
                </Button>
                <Button size="sm" variant="secondary" icon="download" onClick={exportPNG} disabled={!layout}>
                  PNG
                </Button>
                <Button size="sm" variant="secondary" icon="download" onClick={() => setPrinting(true)} disabled={!layout}>
                  PDF
                </Button>
              </div>
              {canEdit && (
                <div className="rounded-md border border-gray-200 p-2 text-xs">
                  <label className="flex items-center gap-2 text-gray-800">
                    <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} disabled={!layout} /> {t('sld.adjust')}
                  </label>
                  <div className="mt-0.5 text-[11px] text-gray-500">{t('sld.adjust_hint')}</div>
                  <div className="mt-1 flex gap-1">
                    <Button size="sm" icon="check" onClick={savePositions} disabled={!dirty}>
                      {t('common.save')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={resetPositions} disabled={!diagram || Object.keys(offsets).length === 0}>
                      {t('sld.reset_positions')}
                    </Button>
                  </div>
                </div>
              )}

              {diagram && (
                <div className="rounded-md border border-gray-200 p-2 text-xs text-gray-700">
                  <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('sld.stats')}</div>
                  <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5">
                    <dt className="text-gray-500">{t('sld.elements')}</dt>
                    <dd>
                      {fmtNum(diagram.stats.elements)} <span className="text-gray-400">({fmtNum(diagram.stats.raw_nodes)} {t('sld.raw')})</span>
                    </dd>
                    <dt className="text-gray-500">{t('power.feeders')}</dt>
                    <dd className="truncate" title={diagram.feeders.map((f) => f.code).join(', ')}>
                      {diagram.feeders.length}: {diagram.feeders.map((f) => f.code).join(', ')}
                    </dd>
                    <dt className="text-gray-500">{t('power.customers')}</dt>
                    <dd>
                      {fmtNum(diagram.stats.customers)} <span className="text-red-700">({fmtNum(diagram.stats.customers_off)} {t('power.off').toLowerCase()})</span>
                    </dd>
                    <dt className="text-gray-500">{t('power.load')}</dt>
                    <dd>{fmtVA(diagram.stats.load_va)}</dd>
                    <dt className="text-gray-500">{t('sld.length')}</dt>
                    <dd>{fmtLength(diagram.stats.length_m)}</dd>
                    <dt className="text-gray-500">{t('sld.ties')}</dt>
                    <dd>{diagram.ties.length}</dd>
                    <dt className="text-gray-500">{t('sld.built')}</dt>
                    <dd>
                      {fmtDate(diagram.at)} · {diagram.stats.build_ms} ms
                    </dd>
                  </dl>
                  {diagram.warnings.length > 0 && <div className="mt-1 text-amber-700">{diagram.warnings.map((w) => t(`sld.warn_${w}` as any, { n: fmtNum(diagram.nodes.length) })).join(' ')}</div>}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* kanvas diagram */}
        <div className={`relative min-w-0 flex-1 ${dark ? 'bg-gray-900' : 'bg-gray-50'}`}>
          {!scope && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-gray-500">
              <div>
                <Icon name="diagram" size={40} className="mx-auto mb-2 opacity-40" />
                {t('sld.empty_hint')}
              </div>
            </div>
          )}
          {building && (
            <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded bg-white/90 px-2 py-1 text-xs text-gray-700 shadow">
              <Spinner size={14} /> {t('sld.building')}
            </div>
          )}
          {adjust && (
            <div className="absolute right-3 top-3 z-10 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 shadow">
              {t('sld.adjust_on')}
              {dirty ? ` · ${t('sld.unsaved')}` : ''}
            </div>
          )}
          <svg
            ref={svgRef}
            className="h-full w-full touch-none select-none"
            onWheel={onWheel}
            onPointerDown={(e) => onDown(e)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            role="img"
            aria-label={diagram?.title || t('sld.title')}
          >
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>{layout && renderBody(layout, false)}</g>
          </svg>
          <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded bg-white/90 px-1 py-0.5 text-[11px] text-gray-600 shadow">
            <button className="px-1 hover:text-gray-900" onClick={() => setView((v) => ({ ...v, k: Math.min(6, v.k * 1.25) }))} aria-label="+">
              +
            </button>
            <span className="tabular-nums">{Math.round(view.k * 100)}%</span>
            <button className="px-1 hover:text-gray-900" onClick={() => setView((v) => ({ ...v, k: Math.max(0.05, v.k / 1.25) }))} aria-label="−">
              −
            </button>
          </div>
        </div>

        {/* panel objek terpilih */}
        {selected && (
          <aside className="flex w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-gray-200 bg-white p-3 text-xs text-gray-800">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900">{p ? typeName(p.type_code) : t('common.loading')}</span>
              <button className="text-gray-500 hover:text-gray-800" onClick={() => setSelected(null)} aria-label={t('common.close')}>
                <Icon name="x" size={14} />
              </button>
            </div>
            {p ? (
              <>
                <div className="font-mono text-[11px] text-gray-500">
                  {p.code || `#${feature!.id}`} {p.name && <span className="font-sans text-gray-700">· {p.name}</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {p.graph?.in_graph ? p.energized ? <Badge tone="green">{t('feature.on')}</Badge> : <Badge tone="red">{t('feature.off')}</Badge> : <span className="text-gray-500">{t('feature.not_in_graph')}</span>}
                  {p.graph?.open && <Badge tone="amber">{t('feature.device_open')}</Badge>}
                </div>
                <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5">
                  {p.feeder && (
                    <>
                      <dt className="text-gray-500">{t('feature.feeder')}</dt>
                      <dd>
                        {p.feeder.code}
                        {p.feeder_gi && <span className="text-gray-500"> · {p.feeder_gi.code}</span>}
                      </dd>
                    </>
                  )}
                  {p.zone && (
                    <>
                      <dt className="text-gray-500">{t('feature.zone')}</dt>
                      <dd>{p.zone.code || `#${p.zone.id}`}</dd>
                    </>
                  )}
                  {p.gd && (
                    <>
                      <dt className="text-gray-500">{t('power.gd_short')}</dt>
                      <dd>{p.gd.code || `#${p.gd.id}`}</dd>
                    </>
                  )}
                  {p.route && (
                    <>
                      <dt className="text-gray-500">{t('feature.route')}</dt>
                      <dd>{p.route.code}</dd>
                    </>
                  )}
                  {selected.kind === 'edge' && (
                    <>
                      <dt className="text-gray-500">{t('sld.length')}</dt>
                      <dd>{fmtLength(p.length_m)}</dd>
                    </>
                  )}
                  {selSection && selSection.edge_ids.length > 1 && (
                    <>
                      <dt className="text-gray-500">{t('sld.section')}</dt>
                      <dd>{t('sld.section_merged', { n: selSection.edge_ids.length, len: fmtLength(selSection.length_m) })}</dd>
                    </>
                  )}
                </dl>
                <SectionRecap sec={p.section} />
                {!p.section && selNode && selNode.customers > 0 && (
                  <div className="mt-2 rounded-md border border-gray-200 p-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('sld.downstream')}</div>
                    {fmtNum(selNode.customers)} {t('sld.cust')} · {fmtVA(selNode.load_va)}
                    {selNode.customers_off > 0 && <span className="text-red-700"> · {fmtNum(selNode.customers_off)} {t('power.off').toLowerCase()}</span>}
                  </div>
                )}
                <div className="mt-2">
                  <OperateBox feature={feature!} types={types} submit={operate} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="secondary" icon="map" onClick={() => router.push(`/map?select=${selected.kind}:${selected.id}`)}>
                    {t('sld.open_map')}
                  </Button>
                  <Button size="sm" variant="secondary" icon="activity" onClick={() => router.push(`/monitoring?select=${selected.kind}:${selected.id}`)}>
                    {t('sld.open_monitoring')}
                  </Button>
                  {selected.kind === 'node' && (!diagram || !diagram.nodes.some((n) => n.id === selected.id)) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="diagram"
                      onClick={() =>
                        api<{ scope: ScopeMode; id: number }>(`/api/sld/resolve?kind=node&id=${selected.id}`)
                          .then((s) => {
                            setMode(s.scope);
                            focusRef.current = selected;
                            setScope({ scope: s.scope, id: s.id, level: scope?.level || 'tm' });
                          })
                          .catch((e) => toast.push(e.message, 'error'))
                      }
                    >
                      {t('sld.open_sld_here')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="py-6 text-center">
                <Spinner size={18} />
              </div>
            )}
          </aside>
        )}
      </div>

      {/* halaman cetak (PDF): kop + diagram penuh */}
      {printing && layout && diagram && (
        <div className="sld-print">
          <table className="sld-print-title">
            <tbody>
              <tr>
                <td rowSpan={3} className="sld-print-brand">
                  {configs['app.name'] || 'QuadranGIS'}
                  <div className="sld-print-sub">Single Line Diagram</div>
                </td>
                <th>{t('sld.print_title')}</th>
                <td>{diagram.title}</td>
                <th>{t('sld.level')}</th>
                <td>{levelLabel(diagram.level)}</td>
              </tr>
              <tr>
                <th>{t('sld.print_scope')}</th>
                <td>
                  {diagram.feeders.length} {t('power.feeders').toLowerCase()}: {diagram.feeders.map((f) => f.code).join(', ')}
                </td>
                <th>{t('sld.print_date')}</th>
                <td>{fmtDate(new Date().toISOString())}</td>
              </tr>
              <tr>
                <th>{t('sld.stats')}</th>
                <td>
                  {fmtNum(diagram.stats.elements)} {t('sld.elements')} · {fmtNum(diagram.stats.customers)} {t('sld.cust')} · {fmtVA(diagram.stats.load_va)} · {fmtLength(diagram.stats.length_m)}
                </td>
                <th>{t('sld.print_user')}</th>
                <td>{user?.full_name || user?.username || '-'}</td>
              </tr>
            </tbody>
          </table>
          <svg
            className="sld-print-svg"
            viewBox={`${layout.minX - COL_W / 2 - 20} ${layout.minY - ROW_H / 2 - 20} ${layout.width + COL_W + 40} ${layout.height + ROW_H + 40}`}
            preserveAspectRatio="xMidYMin meet"
            fontFamily="Inter, Segoe UI, Arial, sans-serif"
          >
            {renderBody(layout, true)}
          </svg>
          <div className="sld-print-legend">
            <span style={{ color: ON_STATUS }}>■</span> {t('power.on')} &nbsp; <span style={{ color: OFF_STATUS }}>■</span> {t('power.off')} &nbsp; ○ {t('layers.legend_open')} &nbsp; - - - {t('sld.legend_tie')}
            {pf && (
              <>
                &nbsp; · {t('pf.loading')}: <span style={{ color: GOOD }}>■</span> &lt;60% <span style={{ color: WARN }}>■</span> 60–80% <span style={{ color: SERIOUS }}>■</span> 80–100% <span style={{ color: CRIT }}>■</span> &gt;100%
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
