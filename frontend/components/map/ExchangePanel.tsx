'use client';

import { useMemo, useRef, useState } from 'react';
import { API_BASE, getToken } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import type { ComponentType } from '@/lib/types';
import { Badge, Button, useToast } from '@/components/ui';
import type { MapHandle } from './types';

const MAX_BYTES = 10 * 1024 * 1024;

interface Stats {
  features: number;
  bytes: number;
  by_type: Record<string, number>;
  too_large: boolean;
}

interface ImportItem {
  index: number;
  action: 'update' | 'create' | 'unchanged' | 'error';
  kind: string;
  id?: number;
  type_code?: string;
  code?: string;
  changes?: string;
  error?: string;
}

interface ImportReport {
  applied: boolean;
  features: number;
  updates: number;
  creates: number;
  unchanged: number;
  errors: number;
  items: ImportItem[];
}

interface Props {
  mapRef: React.RefObject<MapHandle>;
  types: ComponentType[];
  /** layer yang sedang tampil (pilihan awal) */
  visibleTypes?: string[];
  format: 'geojson' | 'gdb';
  allowImport?: boolean;
  energyFilter?: boolean;
  area: [number, number][] | null;
  drawing: boolean;
  onDrawArea: () => void;
  onClearArea: () => void;
  onImported?: (tileVersion?: number) => void;
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;

async function post(path: string, body: BodyInit, contentType: string, lang: string): Promise<Response> {
  const token = getToken();
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'X-Lang': lang, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    credentials: 'include',
    body,
  });
}

async function errorOf(res: Response): Promise<{ msg: string; stats?: Stats }> {
  try {
    const j = await res.json();
    return { msg: j.error || res.statusText, stats: j.stats };
  } catch {
    return { msg: res.statusText };
  }
}

/** Export data GIS terpilih (GeoJSON / File Geodatabase) dan import GeoJSON hasil edit QGIS. */
export function ExchangePanel(props: Props) {
  const { t, pick, locale } = useT();
  const toast = useToast();
  const exportable = useMemo(() => props.types.filter((x) => x.is_active), [props.types]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.visibleTypes?.length ? props.visibleTypes : exportable.map((x) => x.code)));
  const [areaMode, setAreaMode] = useState<'view' | 'polygon'>('view');
  const [energized, setEnergized] = useState<'all' | 'on' | 'off'>('all');
  const [stats, setStats] = useState<Stats | null>(null);
  const [statErr, setStatErr] = useState('');
  const [busy, setBusy] = useState<'' | 'check' | 'download' | 'preview' | 'apply'>('');
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const cats = useMemo(() => Array.from(new Set(exportable.map((x) => x.category))), [exportable]);
  const typeName = (code: string) => {
    const x = props.types.find((y) => y.code === code);
    return x ? pick(x.name, x.name_en) : code;
  };

  function selection(): Record<string, any> | null {
    const body: Record<string, any> = { types: Array.from(selected), format: props.format };
    if (props.energyFilter) body.energized = energized;
    if (areaMode === 'polygon') {
      if (!props.area || props.area.length < 3) return null;
      body.polygon = { type: 'Polygon', coordinates: [[...props.area, props.area[0]]] };
    } else {
      const b = props.mapRef.current?.getBounds();
      if (!b) return null;
      body.bbox = b;
    }
    return body;
  }

  async function check() {
    const sel = selection();
    if (!sel) {
      toast.push(t('xchg.need_area'), 'warning');
      return;
    }
    setBusy('check');
    setStatErr('');
    try {
      const res = await post('/api/exchange/export', JSON.stringify({ ...sel, dry: true }), 'application/json', locale);
      if (!res.ok) {
        const e = await errorOf(res);
        setStats(e.stats ?? null);
        setStatErr(e.msg);
        return;
      }
      setStats((await res.json()).stats);
    } catch (e: any) {
      setStatErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function download() {
    const sel = selection();
    if (!sel) {
      toast.push(t('xchg.need_area'), 'warning');
      return;
    }
    setBusy('download');
    try {
      const res = await post('/api/exchange/export', JSON.stringify(sel), 'application/json', locale);
      if (!res.ok) {
        const e = await errorOf(res);
        if (e.stats) setStats(e.stats);
        setStatErr(e.msg);
        toast.push(e.msg, 'error');
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] || (props.format === 'gdb' ? 'quadrangis.gdb.zip' : 'quadrangis.geojson');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast.push(t('xchg.downloaded', { name, n: fmtNum(Number(res.headers.get('X-Export-Features') || 0)), size: mb(blob.size) }), 'success');
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function runImport(apply: boolean, f: File | null = file) {
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast.push(t('xchg.file_too_big', { size: mb(f.size) }), 'error');
      return;
    }
    setBusy(apply ? 'apply' : 'preview');
    try {
      const res = await post(`/api/exchange/import?apply=${apply ? 1 : 0}`, await f.text(), 'application/geo+json', locale);
      if (!res.ok) {
        toast.push((await errorOf(res)).msg, 'error');
        return;
      }
      const r: ImportReport = await res.json();
      setReport(r);
      if (apply) {
        toast.push(t('xchg.applied', { u: r.updates, c: r.creates, e: r.errors }), r.errors > 0 ? 'warning' : 'success');
        props.onImported?.();
      }
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  const toggle = (code: string) => {
    const s = new Set(selected);
    if (s.has(code)) s.delete(code);
    else s.add(code);
    setSelected(s);
    setStats(null);
  };
  const actionBadge = (a: ImportItem['action']) =>
    a === 'update' ? <Badge tone="blue">{t('xchg.act_update')}</Badge> : a === 'create' ? <Badge tone="green">{t('xchg.act_create')}</Badge> : a === 'error' ? <Badge tone="red">{t('xchg.act_error')}</Badge> : <Badge>{t('xchg.act_same')}</Badge>;

  return (
    <div className="space-y-3 text-sm text-gray-800">
      {/* 1. area */}
      <div className="rounded-md border border-gray-200 p-2">
        <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('xchg.step_area')}</div>
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={areaMode === 'view'} onChange={() => { setAreaMode('view'); setStats(null); }} /> {t('xchg.area_view')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={areaMode === 'polygon'} onChange={() => { setAreaMode('polygon'); setStats(null); }} /> {t('xchg.area_polygon')}
          </label>
        </div>
        {areaMode === 'polygon' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Button size="sm" variant={props.drawing ? 'primary' : 'secondary'} icon="area" onClick={() => { props.onDrawArea(); setStats(null); }}>
              {props.drawing ? t('xchg.drawing') : props.area ? t('xchg.redraw') : t('xchg.draw')}
            </Button>
            {props.area && (
              <>
                <span className="text-gray-600">{t('xchg.polygon_points', { n: props.area.length })}</span>
                <button className="text-brand-700 hover:underline" onClick={() => { props.onClearArea(); setStats(null); }}>
                  {t('common.clear')}
                </button>
              </>
            )}
          </div>
        )}
        {areaMode === 'view' && <div className="mt-1 text-[11px] text-gray-500">{t('xchg.area_view_hint')}</div>}
      </div>

      {/* 2. layer */}
      <div className="rounded-md border border-gray-200 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase text-gray-500">{t('xchg.step_layers', { n: selected.size })}</span>
          <span className="flex gap-2 text-[11px]">
            <button className="text-brand-700 hover:underline" onClick={() => { setSelected(new Set(exportable.map((x) => x.code))); setStats(null); }}>
              {t('layers.all')}
            </button>
            <button className="text-brand-700 hover:underline" onClick={() => { setSelected(new Set()); setStats(null); }}>
              {t('layers.none')}
            </button>
          </span>
        </div>
        <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
          {cats.map((cat) => (
            <div key={cat}>
              <div className="text-[10px] uppercase text-gray-400">{cat}</div>
              <div className="grid grid-cols-2 gap-x-2">
                {exportable
                  .filter((x) => x.category === cat)
                  .map((x) => (
                    <label key={x.code} className="flex items-center gap-1.5 truncate text-xs" title={pick(x.name, x.name_en)}>
                      <input type="checkbox" checked={selected.has(x.code)} onChange={() => toggle(x.code)} />
                      <span className="truncate">{pick(x.name, x.name_en)}</span>
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>
        {props.energyFilter && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-gray-500">{t('xchg.status')}</span>
            <select className="input w-32" value={energized} onChange={(e) => { setEnergized(e.target.value as any); setStats(null); }}>
              <option value="all">{t('power.filter_all')}</option>
              <option value="on">{t('power.filter_on')}</option>
              <option value="off">{t('power.filter_off')}</option>
            </select>
          </div>
        )}
      </div>

      {/* 3. export */}
      <div className="rounded-md border border-gray-200 p-2">
        <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{props.format === 'gdb' ? t('xchg.step_export_gdb') : t('xchg.step_export_geojson')}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon="search" loading={busy === 'check'} onClick={check} disabled={selected.size === 0}>
            {t('xchg.check')}
          </Button>
          <Button size="sm" icon="download" loading={busy === 'download'} onClick={download} disabled={selected.size === 0 || !!stats?.too_large}>
            {props.format === 'gdb' ? t('xchg.download_gdb') : t('xchg.download_geojson')}
          </Button>
        </div>
        {stats && (
          <div className="mt-2 text-xs">
            <div className="flex items-center justify-between">
              <span>
                {fmtNum(stats.features)} {t('xchg.features')} · {mb(stats.bytes)}
              </span>
              {stats.too_large ? <Badge tone="red">{t('xchg.over_limit')}</Badge> : <Badge tone="green">{t('xchg.within_limit')}</Badge>}
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-200" aria-hidden>
              <div className={`h-full ${stats.too_large ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${Math.min(100, (stats.bytes / MAX_BYTES) * 100)}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
              {Object.entries(stats.by_type)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span key={k}>
                    {typeName(k)} {fmtNum(v)}
                  </span>
                ))}
            </div>
            {props.format === 'gdb' && !stats.too_large && <div className="mt-1 text-[11px] text-gray-500">{t('xchg.gdb_note')}</div>}
          </div>
        )}
        {statErr && <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800">{statErr}</div>}
        <div className="mt-2 text-[11px] text-gray-500">{t('xchg.limit_note')}</div>
      </div>

      {/* 4. import (GeoJSON hasil edit QGIS) */}
      {props.allowImport && (
        <div className="rounded-md border border-gray-200 p-2">
          <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('xchg.step_import')}</div>
          <input
            ref={fileRef}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            className="block w-full text-xs text-gray-700 file:mr-2 file:rounded file:border-0 file:bg-gray-100 file:px-2 file:py-1 file:text-xs"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setFile(f);
              setReport(null);
              if (f) runImport(false, f);
            }}
          />
          {busy === 'preview' && <div className="mt-1 text-xs text-gray-500">{t('xchg.previewing')}</div>}
          {report && (
            <div className="mt-2 space-y-1 text-xs">
              <div className="flex flex-wrap gap-x-3">
                <span>{t('xchg.r_features', { n: fmtNum(report.features) })}</span>
                <span className="text-brand-700">{t('xchg.r_update', { n: report.updates })}</span>
                <span className="text-emerald-700">{t('xchg.r_create', { n: report.creates })}</span>
                <span className="text-gray-500">{t('xchg.r_same', { n: report.unchanged })}</span>
                <span className={report.errors > 0 ? 'text-red-700' : 'text-gray-500'}>{t('xchg.r_error', { n: report.errors })}</span>
              </div>
              {report.items.length > 0 && (
                <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-gray-200 p-1">
                  {report.items.slice(0, 200).map((it) => (
                    <li key={it.index} className="flex items-start gap-1">
                      {actionBadge(it.action)}
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-[11px]">{it.code || (it.id ? `#${it.id}` : `#${it.index}`)}</span>{' '}
                        <span className="text-gray-500">{it.type_code ? typeName(it.type_code) : it.kind}</span>
                        {it.changes && <span className="text-gray-600"> · {it.changes}</span>}
                        {it.error && <span className="text-red-700"> · {it.error}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!report.applied && report.updates + report.creates > 0 && (
                <Button size="sm" icon="check" loading={busy === 'apply'} onClick={() => runImport(true)}>
                  {t('xchg.apply', { n: report.updates + report.creates })}
                </Button>
              )}
              {report.applied && <div className="text-emerald-700">{t('xchg.applied_note')}</div>}
            </div>
          )}
          <div className="mt-2 text-[11px] text-gray-500">{t('xchg.qgis_note')}</div>
        </div>
      )}
    </div>
  );
}
