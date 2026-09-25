'use client';

import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { Icon } from '@/components/Icon';
import type { DrawMode } from './types';

interface Props {
  types: ComponentType[];
  mode: DrawMode;
  onMode: (m: DrawMode) => void;
  canEdit: boolean;
}

function groupBy(types: ComponentType[]) {
  const g = new Map<string, ComponentType[]>();
  for (const t of types) {
    if (!g.has(t.category)) g.set(t.category, []);
    g.get(t.category)!.push(t);
  }
  return Array.from(g.entries());
}

export function DrawToolbar({ types, mode, onMode, canEdit }: Props) {
  const { t, pick } = useT();
  const [open, setOpen] = useState<'point' | 'line' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const btn = (active: boolean) =>
    `flex h-9 w-9 items-center justify-center rounded-md transition ${active ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`;

  const points = types.filter((x) => x.geom_kind !== 'line' && x.is_active && x.code !== 'junction');
  const lines = types.filter((x) => x.geom_kind === 'line' && x.is_active);
  const isPointish = mode.kind === 'point' || mode.kind === 'polygon';
  const isMeasureLen = mode.kind === 'measure' && mode.what === 'length';
  const isMeasureArea = mode.kind === 'measure' && mode.what === 'area';

  const palette = (kind: 'point' | 'line', list: ComponentType[]) => (
    <div className="absolute left-12 top-0 z-20 w-72 rounded-lg border border-gray-200 bg-white p-2 shadow-xl">
      <div className="mb-1 px-1 text-xs font-semibold uppercase text-gray-500">{kind === 'point' ? t('map.point_components') : t('map.line_components')}</div>
      <div className="max-h-96 overflow-y-auto">
        {groupBy(list).map(([cat, items]) => (
          <div key={cat} className="mb-1">
            <div className="px-1 py-0.5 text-[11px] font-medium capitalize text-gray-400">{cat}</div>
            {items.map((x) => (
              <button
                key={x.code}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-100"
                onClick={() => {
                  if (kind === 'line') onMode({ kind: 'line', typeCode: x.code });
                  else if (x.geom_kind === 'polygon') onMode({ kind: 'polygon', typeCode: x.code });
                  else onMode({ kind: 'point', typeCode: x.code });
                  setOpen(null);
                }}
              >
                <span className={`inline-block h-3 w-3 shrink-0 ${x.geom_kind === 'polygon' ? 'rounded-none border border-gray-500' : 'rounded-full'}`} style={{ background: x.color }} />
                <span className="truncate">{pick(x.name, x.name_en)}</span>
                {x.geom_kind === 'polygon' && <span className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500">{t('map.polygon_badge')}</span>}
                {x.voltage_kv > 0 && <span className="ml-auto shrink-0 text-[10px] text-gray-400">{x.voltage_kv} kV</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={ref} className="relative flex flex-col gap-1 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
      <button className={btn(mode.kind === 'select')} title={t('map.tool_select')} onClick={() => onMode({ kind: 'select' })}>
        <Icon name="cursor" />
      </button>
      {canEdit && (
        <>
          <div className="relative">
            <button className={btn(isPointish)} title={t('map.tool_point')} onClick={() => setOpen(open === 'point' ? null : 'point')}>
              <Icon name="point" />
            </button>
            {open === 'point' && palette('point', points)}
          </div>
          <div className="relative">
            <button className={btn(mode.kind === 'line' || mode.kind === 'reshape')} title={t('map.tool_line')} onClick={() => setOpen(open === 'line' ? null : 'line')}>
              <Icon name="line" />
            </button>
            {open === 'line' && palette('line', lines)}
          </div>
          <div className={btn(mode.kind === 'move' || mode.kind === 'vertex')} title={t('map.tool_move')}>
            <Icon name="move" className={mode.kind === 'move' || mode.kind === 'vertex' ? '' : 'text-gray-300'} />
          </div>
        </>
      )}
      <div className="my-0.5 border-t border-gray-200" />
      <button className={btn(isMeasureLen)} title={t('map.tool_measure_length')} onClick={() => onMode(isMeasureLen ? { kind: 'select' } : { kind: 'measure', what: 'length' })}>
        <Icon name="ruler" />
      </button>
      <button className={btn(isMeasureArea)} title={t('map.tool_measure_area')} onClick={() => onMode(isMeasureArea ? { kind: 'select' } : { kind: 'measure', what: 'area' })}>
        <Icon name="area" />
      </button>
    </div>
  );
}
