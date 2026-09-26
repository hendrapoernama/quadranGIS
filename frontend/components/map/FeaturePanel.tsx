'use client';

import { OperateBox, type ManeuverBody } from '@/components/power/OperateBox';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { AttrField, ComponentType, GeoFeature, GraphInfo } from '@/lib/types';
import { Badge, Button, Confirm, useToast } from '@/components/ui';
import { fmtDate, fmtLength, fmtVA } from '@/lib/format';
import { fmtArea } from '@/lib/geo';
import { SectionRecap } from '@/components/power/SectionRecap';

export type { ManeuverBody } from '@/components/power/OperateBox';

interface Props {
  feature: GeoFeature | null;
  loading: boolean;
  types: ComponentType[];
  canEdit: boolean;
  canTrace: boolean;
  canManeuver?: boolean;
  onSave: (kind: 'node' | 'edge', id: number, body: any) => Promise<void>;
  onDelete: (kind: 'node' | 'edge', id: number) => Promise<void>;
  onMove: (nodeId: number) => void;
  onReshape: (edgeId: number, typeCode: string) => void;
  onReshapePolygon: (nodeId: number) => void;
  onVertex: (target: 'edge' | 'node', id: number) => void;
  onSplit: (edgeId: number) => void;
  onMerge: (nodeId: number) => void;
  onTrace: (nodeId: number, direction: 'down' | 'up' | 'connected') => void;
  onSelect: (kind: 'node' | 'edge', id: number) => void;
  onFlyTo: () => void;
  onManeuver?: (nodeId: number, body: ManeuverBody) => Promise<void>;
}

type KV = { k: string; v: string };

export function FeaturePanel(props: Props) {
  const { feature, loading, types, canEdit, canTrace, canManeuver = false } = props;
  const { t, pick, locale } = useT();
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('closed');
  const [typeCode, setTypeCode] = useState('');
  const [attrs, setAttrs] = useState<Record<string, any>>({});
  const [props_, setProps] = useState<KV[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [neighbors, setNeighbors] = useState<any[]>([]);
  const [history, setHistory] = useState<any[] | null>(null);

  const kind = feature?.properties.kind as 'node' | 'edge' | undefined;
  const id = feature?.id;
  const ct = types.find((x) => x.code === feature?.properties.type_code);
  const isBuilding = !!feature?.properties.footprint;
  const schema: AttrField[] = (types.find((x) => x.code === typeCode)?.attributes as AttrField[] | undefined) || [];

  useEffect(() => {
    if (!feature) return;
    const p = feature.properties;
    const sch: AttrField[] = (types.find((x) => x.code === p.type_code)?.attributes as AttrField[] | undefined) || [];
    const keys = new Set(sch.map((f) => f.key));
    const raw: Record<string, any> = p.properties || {};
    setCode(p.code || '');
    setName(p.name || '');
    setStatus(p.status || 'closed');
    setTypeCode(p.type_code || '');
    setAttrs(Object.fromEntries(sch.map((f) => [f.key, raw[f.key] ?? (f.type === 'bool' ? false : '')])));
    setProps(
      Object.entries(raw)
        .filter(([k]) => !keys.has(k))
        .map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) })),
    );
    setHistory(null);
    setNeighbors([]);
    if (p.kind === 'node') {
      api<{ items: any[] }>(`/api/gis/nodes/${feature.id}/neighbors`)
        .then((r) => setNeighbors(r.items))
        .catch(() => setNeighbors([]));
    }
  }, [feature, types]);

  if (loading) return <div className="py-6 text-center text-sm text-gray-500">{t('feature.loading')}</div>;
  if (!feature || !kind || !id) return <div className="py-6 text-center text-sm text-gray-500">{t('feature.empty')}</div>;

  const p = feature.properties;
  const graph: GraphInfo | undefined = p.graph;
  const isSwitch = !!ct?.is_switch;
  const ways = ct?.ways || 0;
  const inGraph = !!graph?.in_graph;
  const label = (f: AttrField) => (locale === 'en' && f.label_en ? f.label_en : f.label) + (f.unit ? ` (${f.unit})` : '');

  async function save() {
    setSaving(true);
    try {
      const properties: Record<string, any> = {};
      for (const { k, v } of props_) {
        if (!k.trim()) continue;
        const n = Number(v);
        properties[k.trim()] = v !== '' && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(v) ? n : v === 'true' ? true : v === 'false' ? false : v;
      }
      for (const f of schema) {
        const v = attrs[f.key];
        if (f.type === 'bool') {
          if (v === true || v === false) properties[f.key] = v;
          continue;
        }
        if (v === '' || v === undefined || v === null) continue;
        if (f.type === 'number') {
          const n = Number(v);
          if (!Number.isNaN(n)) properties[f.key] = n;
        } else properties[f.key] = String(v);
      }
      await props.onSave(kind!, id!, { type_code: typeCode, code, name, status, properties });
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    setDeleting(true);
    try {
      await props.onDelete(kind!, id!);
      setConfirmDel(false);
    } finally {
      setDeleting(false);
    }
  }

  async function loadHistory() {
    try {
      const r = await api<{ items: any[] }>(`/api/gis/features/${kind}/${id}/history`);
      setHistory(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  const sameKindTypes = types.filter((x) => (kind === 'node' ? x.geom_kind !== 'line' : x.geom_kind === 'line') && x.is_active);

  return (
    <div className="space-y-3 text-sm text-gray-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-3 w-3 ${ct?.geom_kind === 'polygon' ? 'rounded-none' : 'rounded-full'}`} style={{ background: ct?.color || '#999' }} />
            <span className="font-semibold text-gray-900">{ct ? pick(ct.name, ct.name_en) : p.type_code}</span>
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {kind === 'node' ? (isBuilding ? t('feature.building') : t('map.node')) : t('map.edge')} #{id}
            {kind === 'edge' && <> · {fmtLength(p.length_m)}</>}
            {isBuilding && p.area_m2 > 0 && <> · {fmtArea(p.area_m2)}</>}
            {kind === 'node' && <> · {t('feature.connections', { n: p.degree })}</>}
          </div>
          {p.properties?.kode_ssot && (
            <div className="mt-0.5 font-mono text-[11px] text-gray-600" title={t('feature.ssot')}>
              SSOT: {String(p.properties.kode_ssot)}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon="target" onClick={props.onFlyTo} title={t('feature.zoom_to')} />
          {p.status === 'open' && <Badge tone="red">OPEN</Badge>}
        </div>
      </div>

      {/* ---- kondisi kelistrikan & group */}
      <div className="rounded-md border border-gray-200 p-2 text-xs">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold uppercase text-gray-500">{t('feature.energized')}</span>
          {inGraph ? (
            <span className="flex items-center gap-1">
              {graph!.energized ? <Badge tone="green">{t('feature.on')}</Badge> : <Badge tone="red">{t('feature.off')}</Badge>}
              {graph!.open && <Badge tone="amber">{t('feature.device_open')}</Badge>}
            </span>
          ) : (
            <span className="text-gray-500">{t('feature.not_in_graph')}</span>
          )}
        </div>
        {inGraph && (
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
            {p.feeder && (
              <>
                <dt className="text-gray-500">{t('feature.feeder')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.feeder.id)}>
                    {p.feeder.code || `#${p.feeder.id}`}
                  </button>
                  {p.feeder_gi && (
                    <span className="text-gray-500">
                      {' '}
                      · {t('feature.feeder_gi')}{' '}
                      <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.feeder_gi.id)}>
                        {p.feeder_gi.code}
                      </button>
                    </span>
                  )}
                </dd>
              </>
            )}
            {p.zone && (
              <>
                <dt className="text-gray-500">{t('feature.zone')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.zone.id)}>
                    {p.zone.code || `#${p.zone.id}`}
                  </button>
                </dd>
              </>
            )}
            {p.gd && (
              <>
                <dt className="text-gray-500">{t('power.gd_short')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.gd.id)}>
                    {p.gd.code || `#${p.gd.id}`}
                  </button>
                </dd>
              </>
            )}
            {p.trafo_gd && (
              <>
                <dt className="text-gray-500">{t('power.trafo_gd_short')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.trafo_gd.id)}>
                    {p.trafo_gd.code || `#${p.trafo_gd.id}`}
                  </button>
                </dd>
              </>
            )}
            {p.route && (
              <>
                <dt className="text-gray-500">{t('feature.route')}</dt>
                <dd>
                  <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('edge', p.route.id)}>
                    {p.route.code || `#${p.route.id}`}
                  </button>
                </dd>
              </>
            )}
            {graph!.load_va > 0 && (
              <>
                <dt className="text-gray-500">{t('feature.load')}</dt>
                <dd>{fmtVA(graph!.load_va)}</dd>
              </>
            )}
          </dl>
        )}
        {inGraph && p.section && (
          <SectionRecap sec={p.section} />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">{t('common.type')}</label>
          <select className="input" value={typeCode} onChange={(e) => setTypeCode(e.target.value)} disabled={!canEdit}>
            {sameKindTypes.map((x) => (
              <option key={x.code} value={x.code}>
                {pick(x.name, x.name_en)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">{t('common.code')}</label>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} disabled={!canEdit} />
        </div>
        <div>
          <label className="label">{t('common.status')}</label>
          {ct?.topology !== false && !isBuilding ? (
            <div className="input flex items-center justify-between bg-gray-50 text-xs" title={t('feature.status_switch_hint')}>
              <span>{status === 'open' ? (isSwitch ? t('feature.status_open') : t('op.state_deenergized')) : isSwitch ? t('feature.status_closed') : t('op.state_energized')}</span>
              <span className="text-gray-400">⚡</span>
            </div>
          ) : (
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} disabled={!canEdit}>
              <option value="closed">{t('feature.status_closed')}</option>
              <option value="open">{t('feature.status_open')}</option>
            </select>
          )}
        </div>
        <div className="col-span-2">
          <label className="label">{t('common.name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        </div>
      </div>

      {/* ---- operasi: buka / tutup alat switching, energize / deenergize objek & saluran */}
      {props.onManeuver && <OperateBox feature={feature} types={types} submit={(body) => props.onManeuver!(id!, body)} />}

      {kind === 'edge' && (
        <div className="rounded-md border border-gray-200 p-2 text-xs">
          <div className="mb-1 font-semibold uppercase text-gray-500">{t('feature.connectivity')}</div>
          <div className="flex items-center justify-between">
            <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.from_node_id)}>
              {p.from_code || `#${p.from_node_id}`} <span className="text-gray-400">({p.from_type})</span>
            </button>
            <span className="text-gray-400">→</span>
            <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('node', p.to_node_id)}>
              {p.to_code || `#${p.to_node_id}`} <span className="text-gray-400">({p.to_type})</span>
            </button>
          </div>
        </div>
      )}

      {kind === 'node' && (ct?.topology ?? true) && (
        <div className="rounded-md border border-gray-200 p-2 text-xs">
          <div className="mb-1 font-semibold uppercase text-gray-500">{t('feature.connected_lines', { n: neighbors.length })}</div>
          {neighbors.length === 0 && <div className="text-gray-500">{t('feature.no_lines')}</div>}
          <ul className="max-h-32 space-y-0.5 overflow-y-auto">
            {neighbors.map((n) => (
              <li key={n.edge_id} className="flex items-center gap-1">
                <button className="text-brand-700 hover:underline" onClick={() => props.onSelect('edge', n.edge_id)}>
                  {n.edge_code || `#${n.edge_id}`}
                </button>
                <span className="text-gray-400">
                  ({n.edge_type}, {n.length_m} m) →
                </span>
                <button className="truncate text-brand-700 hover:underline" onClick={() => props.onSelect('node', n.node_id)}>
                  {n.node_code || `#${n.node_id}`}
                </button>
                {n.node_status === 'open' && <Badge tone="red">open</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- atribut SSOT */}
      {schema.length > 0 && (
        <div>
          <label className="label mb-1" title={t('feature.ssot_hint')}>
            {t('feature.ssot')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            {schema.map((f) => (
              <div key={f.key} className={f.type === 'text' && !f.options ? 'col-span-2' : ''}>
                <label className="text-[11px] text-gray-500">{label(f)}</label>
                {f.type === 'select' ? (
                  <select className="input" value={attrs[f.key] ?? ''} disabled={!canEdit} onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.value })}>
                    <option value="">-</option>
                    {(f.options || []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                    {attrs[f.key] && !(f.options || []).includes(String(attrs[f.key])) && <option value={String(attrs[f.key])}>{String(attrs[f.key])}</option>}
                  </select>
                ) : f.type === 'bool' ? (
                  <label className="input flex items-center gap-2">
                    <input type="checkbox" checked={!!attrs[f.key]} disabled={!canEdit} onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.checked })} />
                    <span className="text-xs">{attrs[f.key] ? t('common.yes') : t('common.no')}</span>
                  </label>
                ) : (
                  <input
                    className="input"
                    type={f.type === 'number' ? 'number' : 'text'}
                    step="any"
                    value={attrs[f.key] ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.value })}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="label mb-0">{t('feature.extra_attrs')}</label>
          {canEdit && (
            <button className="text-xs text-brand-700 hover:underline" onClick={() => setProps([...props_, { k: '', v: '' }])}>
              {t('feature.add_attr')}
            </button>
          )}
        </div>
        <div className="space-y-1">
          {props_.length === 0 && <div className="text-xs text-gray-400">-</div>}
          {props_.map((kv, i) => (
            <div key={i} className="flex gap-1">
              <input className="input w-2/5" placeholder={t('feature.key')} value={kv.k} disabled={!canEdit} onChange={(e) => setProps(props_.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
              <input className="input flex-1" placeholder={t('feature.value')} value={kv.v} disabled={!canEdit} onChange={(e) => setProps(props_.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              {canEdit && (
                <button className="px-1 text-gray-400 hover:text-red-600" onClick={() => setProps(props_.filter((_, j) => j !== i))} aria-label={t('feature.remove_attr')}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {canTrace && kind === 'node' && inGraph && (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="secondary" icon="arrow-down" onClick={() => props.onTrace(id!, 'down')}>
            {t('feature.trace_down')}
          </Button>
          <Button size="sm" variant="secondary" icon="arrow-up" onClick={() => props.onTrace(id!, 'up')}>
            {t('feature.trace_up')}
          </Button>
          <Button size="sm" variant="secondary" icon="link" onClick={() => props.onTrace(id!, 'connected')}>
            {t('feature.trace_connected')}
          </Button>
          <Button size="sm" variant="secondary" icon="diagram" onClick={() => router.push(`/sld?focus=${kind}:${id}`)}>
            {t('sld.open_sld')}
          </Button>
        </div>
      )}

      {canEdit && (
        <div className="space-y-2 border-t border-gray-200 pt-3">
          <div className="text-[11px] font-semibold uppercase text-gray-500">{t('feature.geometry_tools')}</div>
          <div className="flex flex-wrap gap-1">
            {kind === 'node' ? (
              <>
                <Button size="sm" variant="secondary" icon="move" onClick={() => props.onVertex('node', id!)} title={t('feature.drag_node_hint')}>
                  {t('feature.drag_node')}
                </Button>
                <Button size="sm" variant="secondary" icon="target" onClick={() => props.onMove(id!)}>
                  {t('feature.move')}
                </Button>
                {(isBuilding || ct?.geom_kind === 'polygon') && (
                  <Button size="sm" variant="secondary" icon="edit" onClick={() => props.onReshapePolygon(id!)}>
                    {t('feature.redraw_building')}
                  </Button>
                )}
                {p.type_code === 'junction' && neighbors.length === 2 && (
                  <Button size="sm" variant="secondary" icon="link" onClick={() => props.onMerge(id!)} title={t('feature.merge_hint')}>
                    {t('feature.merge')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button size="sm" variant="secondary" icon="vertices" onClick={() => props.onVertex('edge', id!)} title={t('feature.vertex_hint')}>
                  {t('feature.vertex_edit')}
                </Button>
                <Button size="sm" variant="secondary" icon="scissors" onClick={() => props.onSplit(id!)} title={t('feature.split_hint')}>
                  {t('feature.split')}
                </Button>
                <Button size="sm" variant="secondary" icon="edit" onClick={() => props.onReshape(id!, typeCode)}>
                  {t('feature.reshape')}
                </Button>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" onClick={save} loading={saving} icon="check">
              {t('common.save')}
            </Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirmDel(true)}>
              {t('common.delete')}
            </Button>
          </div>
        </div>
      )}

      <div className="text-[11px] text-gray-400">
        {t('feature.created_at')} {fmtDate(p.created_at)} · {t('feature.updated_at')} {fmtDate(p.updated_at)} ·{' '}
        <button className="text-brand-700 hover:underline" onClick={loadHistory}>
          {t('feature.history')}
        </button>
      </div>
      {history && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-gray-200 p-2 text-xs">
          {history.length === 0 && <li className="text-gray-500">{t('feature.no_history')}</li>}
          {history.map((h, i) => (
            <li key={i}>
              <span className="text-gray-500">{fmtDate(h.time)}</span> <b>{h.action}</b> {t('map.by')} {h.username || '-'}
              <span className="ml-1 font-mono text-[10px] text-gray-400">{JSON.stringify(h.data)}</span>
            </li>
          ))}
        </ul>
      )}

      <Confirm
        open={confirmDel}
        title={t('feature.delete_title')}
        message={kind === 'node' ? t('feature.delete_node_msg', { id: id! }) : t('feature.delete_edge_msg', { id: id! })}
        onCancel={() => setConfirmDel(false)}
        onConfirm={del}
        loading={deleting}
      />
    </div>
  );
}
