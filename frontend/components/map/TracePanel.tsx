'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { ComponentType, TraceResponse } from '@/lib/types';
import { Badge, Button, useToast } from '@/components/ui';
import { fmtLength, fmtNum } from '@/lib/format';
import { downloadJSON } from '@/lib/geo';

export interface TraceSeed {
  nodeId: number;
  direction: 'down' | 'up' | 'connected';
  nonce: number;
}

interface Props {
  types: ComponentType[];
  seed: TraceSeed | null;
  selectedNodeId: number | null;
  result: TraceResponse | null;
  onResult: (r: TraceResponse | null) => void;
  onSelect: (kind: 'node' | 'edge', id: number) => void;
}

export function TracePanel({ types, seed, selectedNodeId, result, onResult, onSelect }: Props) {
  const { t, pick } = useT();
  const toast = useToast();
  const [nodeId, setNodeId] = useState<string>('');
  const [direction, setDirection] = useState<'down' | 'up' | 'connected'>('down');
  const [maxDepth, setMaxDepth] = useState(1000);
  const [stopTypes, setStopTypes] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  const dirLabel: Record<string, string> = { down: t('trace.down'), up: t('trace.up'), connected: t('trace.connected') };

  useEffect(() => {
    if (selectedNodeId) setNodeId(String(selectedNodeId));
  }, [selectedNodeId]);

  useEffect(() => {
    if (!seed) return;
    setNodeId(String(seed.nodeId));
    setDirection(seed.direction);
    run(seed.nodeId, seed.direction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  async function run(id = Number(nodeId), dir = direction) {
    if (!id) {
      toast.push(t('trace.pick_start'), 'warning');
      return;
    }
    setRunning(true);
    try {
      const r = await api<TraceResponse>('/api/gis/trace', {
        method: 'POST',
        body: { node_id: id, direction: dir, max_depth: maxDepth, stop_types: Array.from(stopTypes) },
      });
      onResult(r);
      if (r.result.warnings.length) r.result.warnings.forEach((w) => toast.push(w, 'warning'));
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  const typeName = (c: string) => {
    const x = types.find((y) => y.code === c);
    return x ? pick(x.name, x.name_en) : c;
  };
  const res = result?.result;
  const nodeFeats = result?.geojson.features.filter((f) => f.properties.kind === 'node') || [];

  return (
    <div className="space-y-3 text-sm text-gray-800">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">{t('trace.start_node')}</label>
          <input className="input" value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder={t('trace.start_placeholder')} />
        </div>
        <div>
          <label className="label">{t('trace.max_depth')}</label>
          <input className="input" type="number" min={1} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
        </div>
        <div className="col-span-2">
          <label className="label">{t('trace.direction')}</label>
          <div className="flex gap-1">
            {(['down', 'up', 'connected'] as const).map((d) => (
              <button
                key={d}
                className={`flex-1 rounded-md border px-2 py-1 text-xs ${direction === d ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-gray-300 hover:bg-gray-50'}`}
                onClick={() => setDirection(d)}
              >
                {dirLabel[d]}
              </button>
            ))}
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">{t('trace.stop_types')}</label>
          <div className="flex flex-wrap gap-1">
            {types
              .filter((x) => x.geom_kind === 'point' && x.code !== 'junction')
              .map((x) => (
                <button
                  key={x.code}
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${stopTypes.has(x.code) ? 'border-amber-500 bg-amber-50 text-amber-800' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => {
                    const s = new Set(stopTypes);
                    if (s.has(x.code)) s.delete(x.code);
                    else s.add(x.code);
                    setStopTypes(s);
                  }}
                  title={pick(x.name, x.name_en)}
                >
                  {x.code}
                </button>
              ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => run()} loading={running} icon="bolt">
          {t('trace.run')}
        </Button>
        {result && (
          <>
            <Button variant="secondary" onClick={() => onResult(null)}>
              {t('common.clear')}
            </Button>
            <Button variant="secondary" icon="download" onClick={() => downloadJSON(`trace-${res?.direction}-${res?.start_node}.geojson`, result.geojson)} title={t('trace.download_geojson')} />
          </>
        )}
      </div>

      {res && (
        <div className="space-y-2 rounded-md border border-gray-200 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue">{dirLabel[res.direction] || res.direction}</Badge>
            <span className="text-xs text-gray-500">{fmtNum(res.duration_ms, 1)} ms</span>
            {res.truncated && <Badge tone="amber">{t('trace.truncated')}</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
            <dt className="text-gray-500">{t('trace.nodes')}</dt>
            <dd>{fmtNum(res.nodes.length)}</dd>
            <dt className="text-gray-500">{t('trace.edges')}</dt>
            <dd>{fmtNum(res.edges.length)}</dd>
            <dt className="text-gray-500">{t('trace.depth')}</dt>
            <dd>{res.depth}</dd>
            <dt className="text-gray-500">{t('trace.total_length')}</dt>
            <dd>{fmtLength(result!.total_length_m)}</dd>
            <dt className="text-gray-500">{t('trace.customers')}</dt>
            <dd>{fmtNum(res.sinks)}</dd>
            <dt className="text-gray-500">{t('trace.sources')}</dt>
            <dd>{res.sources.length ? res.sources.map((s) => `#${s}`).join(', ') : '-'}</dd>
            <dt className="text-gray-500">{t('trace.open_switches')}</dt>
            <dd>{res.open_switches.length ? res.open_switches.map((s) => `#${s}`).join(', ') : '-'}</dd>
          </dl>
          <div>
            <div className="text-xs font-semibold uppercase text-gray-500">{t('trace.per_type')}</div>
            <table className="mt-1 w-full text-xs">
              <tbody>
                {Object.entries(res.count_by_type)
                  .sort((a, b) => b[1] - a[1])
                  .map(([tc, n]) => (
                    <tr key={tc}>
                      <td className="py-0.5 pr-2">
                        <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: types.find((x) => x.code === tc)?.color }} />
                        {typeName(tc)}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">{fmtNum(n)}</td>
                    </tr>
                  ))}
                {Object.entries(result!.length_by_type).map(([tc, l]) => (
                  <tr key={'len-' + tc}>
                    <td className="py-0.5 pr-2">
                      <span className="mr-1 inline-block h-1 w-3 rounded" style={{ background: types.find((x) => x.code === tc)?.color }} />
                      {typeName(tc)}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{fmtLength(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase text-gray-500">
              {t('trace.result_nodes', { n: fmtNum(nodeFeats.length), partial: result!.geojson.meta?.truncated ? t('trace.partial') : '' })}
            </div>
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs">
              {nodeFeats.slice(0, 300).map((f) => (
                <li key={f.id}>
                  <button className="text-brand-700 hover:underline" onClick={() => onSelect('node', f.id)}>
                    {f.properties.code || `#${f.id}`}
                  </button>{' '}
                  <span className="text-gray-500">{f.properties.type_code}</span>
                  {f.properties.status === 'open' && <Badge tone="red">open</Badge>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
