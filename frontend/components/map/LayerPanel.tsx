'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { ComponentType } from '@/lib/types';
import { Button, useToast } from '@/components/ui';
import { fmtNum } from '@/lib/format';
import type { BasemapPref, ColorMode } from './types';
import { OFF_STATUS, ON_STATUS } from './mapStyle';
import { SymbolSwatch, isSymbol } from './symbols';

interface Props {
  types: ComponentType[];
  visible: Set<string>;
  onVisible: (s: Set<string>) => void;
  basemap: BasemapPref;
  onBasemap: (v: BasemapPref) => void;
  labels: boolean;
  onLabels: (v: boolean) => void;
  colorMode?: ColorMode;
  onColorMode?: (m: ColorMode) => void;
  onReload: () => void;
  graph: Record<string, any> | null;
  canEdit: boolean;
  zoom: number;
  overlay?: React.ReactNode; // kontrol overlay (batas wilayah)
}

export function LayerPanel({ types, visible, onVisible, basemap, onBasemap, labels, onLabels, colorMode = 'type', onColorMode, onReload, graph, canEdit, zoom, overlay }: Props) {
  const { t, pick } = useT();
  const toast = useToast();
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ summary: Record<string, number>; items: any[] } | null>(null);

  const cats = Array.from(new Set(types.map((x) => x.category)));
  const toggle = (code: string) => {
    const s = new Set(visible);
    if (s.has(code)) s.delete(code);
    else s.add(code);
    onVisible(s);
  };

  async function rebuild() {
    try {
      await api('/api/gis/topology/rebuild', { method: 'POST' });
      toast.push(t('layers.graph_reload_started'), 'info');
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  async function validate() {
    setValidating(true);
    try {
      setValidation(await api('/api/gis/topology/validate?limit=50'));
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setValidating(false);
    }
  }

  const basemapOptions: { v: BasemapPref; label: string }[] = [
    { v: 'auto', label: t('layers.basemap_auto') },
    { v: 'light', label: t('layers.basemap_light') },
    { v: 'dark', label: t('layers.basemap_dark') },
    { v: 'none', label: t('layers.basemap_none') },
  ];

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => onVisible(new Set(types.map((x) => x.code)))}>
          {t('layers.all')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onVisible(new Set())}>
          {t('layers.none')}
        </Button>
        <Button size="sm" variant="secondary" icon="refresh" onClick={onReload}>
          {t('layers.reload')}
        </Button>
      </div>
      <div className="space-y-2 rounded-md border border-gray-200 p-2">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{t('layers.basemap')}</div>
          <div className="grid grid-cols-2 gap-1">
            {basemapOptions.map((o) => (
              <button
                key={o.v}
                className={`rounded-md border px-2 py-1 text-xs ${basemap === o.v ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                onClick={() => onBasemap(o.v)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-gray-800">
          <input type="checkbox" checked={labels} onChange={(e) => onLabels(e.target.checked)} /> {t('layers.labels')}
        </label>
        {onColorMode && (
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{t('layers.color_mode')}</div>
            <div className="grid grid-cols-2 gap-1">
              {(['type', 'status'] as ColorMode[]).map((m) => (
                <button
                  key={m}
                  className={`rounded-md border px-2 py-1 text-xs ${colorMode === m ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                  onClick={() => onColorMode(m)}
                >
                  {m === 'type' ? t('layers.color_type') : t('layers.color_status')}
                </button>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-gray-600">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorMode === 'status' ? ON_STATUS : '#6b7280' }} /> {t('layers.legend_on')}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full border border-red-700" style={{ background: colorMode === 'status' ? OFF_STATUS : '#9ca3af' }} /> {t('layers.legend_off')}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-red-600 bg-white" /> {t('layers.legend_open')}
              </span>
            </div>
          </div>
        )}
      </div>
      {overlay}
      {cats.map((cat) => (
        <div key={cat}>
          <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{cat}</div>
          <div className="space-y-0.5">
            {types
              .filter((x) => x.category === cat)
              .map((x) => {
                const hidden = x.min_zoom > zoom;
                return (
                  <label key={x.code} className={`flex items-center gap-2 rounded px-1 py-0.5 text-gray-800 hover:bg-gray-50 ${!x.is_active ? 'opacity-50' : ''}`}>
                    <input type="checkbox" checked={visible.has(x.code)} onChange={() => toggle(x.code)} />
                    {x.geom_kind === 'line' ? (
                      <span className="inline-block h-1 w-4 rounded" style={{ background: x.color }} />
                    ) : isSymbol(x.icon) ? (
                      <SymbolSwatch icon={x.icon!} color={x.color} size={16} />
                    ) : x.geom_kind === 'polygon' ? (
                      <span className="inline-block h-3 w-3 border border-gray-500" style={{ background: x.color, opacity: 0.8 }} />
                    ) : x.is_sink ? (
                      <span className="inline-flex h-3.5 w-3.5 items-center justify-center" style={{ color: x.color }} aria-hidden>
                        <svg viewBox="0 0 48 48" width="14" height="14" fill="currentColor">
                          <path d="M5 23 24 6l19 17h-6v18H11V23z" />
                          <rect x="21" y="29" width="7" height="12" fill="#fff" />
                        </svg>
                      </span>
                    ) : (
                      <span className="inline-block h-3 w-3 rounded-full border border-white shadow" style={{ background: x.color }} />
                    )}
                    <span className="flex-1 truncate" title={pick(x.name, x.name_en)}>
                      {pick(x.name, x.name_en)}
                    </span>
                    <span className={`text-[10px] ${hidden ? 'text-amber-600' : 'text-gray-400'}`} title={t('layers.min_zoom_hint')}>
                      z≥{x.min_zoom}
                    </span>
                  </label>
                );
              })}
          </div>
        </div>
      ))}
      <div className="rounded-md border border-gray-200 p-2">
        <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{t('layers.topology')}</div>
        {graph ? (
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs text-gray-800">
            <dt className="text-gray-500">{t('layers.nodes')}</dt>
            <dd>{fmtNum(graph.nodes)}</dd>
            <dt className="text-gray-500">{t('layers.edges')}</dt>
            <dd>{fmtNum(graph.edges)}</dd>
            <dt className="text-gray-500">{t('layers.sources')}</dt>
            <dd>{fmtNum(graph.sources)}</dd>
            <dt className="text-gray-500">{t('layers.open_switch')}</dt>
            <dd>{fmtNum(graph.open_switch)}</dd>
            <dt className="text-gray-500">{t('layers.unreachable')}</dt>
            <dd className={graph.unreachable > 0 ? 'text-amber-700' : ''}>{fmtNum(graph.unreachable)}</dd>
            <dt className="text-gray-500">{t('layers.status')}</dt>
            <dd>{graph.loading ? t('layers.loading') : graph.dist_dirty ? t('layers.computing') : t('layers.ready')}</dd>
          </dl>
        ) : (
          <div className="text-xs text-gray-500">-</div>
        )}
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={validate} loading={validating}>
            {t('layers.validate')}
          </Button>
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={rebuild}>
              {t('layers.reload_graph')}
            </Button>
          )}
        </div>
        {validation && (
          <div className="mt-2 text-xs text-gray-800">
            <div className="flex flex-wrap gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5">
                {t('layers.isolated')}: {validation.summary.isolated}
              </span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5">
                {t('layers.unreachable').toLowerCase()}: {validation.summary.unreachable}
              </span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5">
                {t('layers.dangling')}: {validation.summary.dangling_junction}
              </span>
            </div>
            {validation.items.length > 0 && (
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                {validation.items.map((it: any) => (
                  <li key={`${it.kind}-${it.id}`} className="text-gray-600">
                    #{it.id} {it.type_code}: {it.problem}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
