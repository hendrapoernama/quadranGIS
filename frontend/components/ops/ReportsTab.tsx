'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { fmtDate, fmtNum } from '@/lib/format';
import type { FeatureCollection, GeoFeature } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { useOpsT } from './i18n';
import type { Report, Suspect } from './types';

interface Props {
  picked: GeoFeature | null;
  canManage: boolean;
  refreshKey: number;
  onOverlay: (fc: FeatureCollection | null) => void;
  onSelect: (kind: 'node' | 'edge', id: number, fly?: boolean) => void;
  onFly: (lng: number, lat: number) => void;
  onStats: (s: Record<string, number>) => void;
}

const statusTone: Record<string, 'gray' | 'blue' | 'amber' | 'green' | 'red'> = {
  BARU: 'red',
  DIVERIFIKASI: 'amber',
  DIKERJAKAN: 'blue',
  SELESAI: 'green',
  BATAL: 'gray',
};
const statusColor: Record<string, string> = { BARU: '#d03b3b', DIVERIFIKASI: '#fab219', DIKERJAKAN: '#2563eb', SELESAI: '#0ca30c', BATAL: '#8a94a6' };

function age(min: number) {
  if (min < 60) return `${Math.round(min)} mnt`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} j ${Math.round(min % 60)} mnt`;
  return `${Math.floor(min / 1440)} h ${Math.floor((min % 1440) / 60)} j`;
}

const emptyForm = { channel: 'TELEPON', category: 'PADAM', customer_code: '', reporter_name: '', reporter_phone: '', address: '', description: '', priority: '' };

export function ReportsTab({ picked, canManage, refreshKey, onOverlay, onSelect, onFly, onStats }: Props) {
  const o = useOpsT();
  const toast = useToast();
  const router = useRouter();
  const [filter, setFilter] = useState<'open' | ''>('open');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [items, setItems] = useState<Report[] | null>(null);
  const [meta, setMeta] = useState<{ categories: string[]; channels: string[]; statuses: string[]; priorities: string[]; sla: number }>({ categories: [], channels: [], statuses: [], priorities: [], sla: 120 });
  const [suspects, setSuspects] = useState<Suspect[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<{ id: number; status: string; assigned_to: string; note: string } | null>(null);
  const [expand, setExpand] = useState<number | null>(null);

  useEffect(() => {
    const tm = setTimeout(() => setQd(q.trim()), 300);
    return () => clearTimeout(tm);
  }, [q]);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        api<{ items: Report[]; stats: Record<string, number>; sla_minutes: number; categories: string[]; channels: string[]; statuses: string[]; priorities: string[] }>(
          `/api/ops/reports?status=${filter}&q=${encodeURIComponent(qd)}`,
        ),
        api<{ items: Suspect[] }>('/api/ops/reports/suspects'),
      ]);
      setItems(r.items);
      setMeta({ categories: r.categories, channels: r.channels, statuses: r.statuses, priorities: r.priorities, sla: r.sla_minutes });
      setSuspects(s.items);
      onStats(r.stats);
      // penanda laporan di peta (warna menurut status, disertai teks status di daftar)
      const fc: FeatureCollection = {
        type: 'FeatureCollection',
        features: r.items
          .filter((x) => x.lng != null && x.lat != null)
          .map((x) => ({ type: 'Feature', id: x.id, geometry: { type: 'Point', coordinates: [x.lng!, x.lat!] }, properties: { kind: 'node', color: statusColor[x.status] || '#8a94a6', big: x.status !== 'SELESAI' && x.status !== 'BATAL', code: x.ticket } })) as any,
      };
      onOverlay(fc);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [filter, qd, toast, onOverlay, onStats]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const usePicked = () => {
    if (!picked) return;
    setCustomerId(picked.id as number);
    setForm((f) => ({ ...f, customer_code: picked.properties.code || '' }));
  };

  const submit = async () => {
    setSaving(true);
    try {
      const r = await api<Report>('/api/ops/reports', {
        method: 'POST',
        body: { ...form, priority: form.priority || undefined, customer_id: customerId || undefined },
      });
      toast.push(`${o('saved')}: ${r.ticket}`, 'success');
      setForm({ ...emptyForm });
      setCustomerId(null);
      setFormOpen(false);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const update = async () => {
    if (!edit) return;
    try {
      await api(`/api/ops/reports/${edit.id}`, { method: 'PUT', body: { status: edit.status, assigned_to: edit.assigned_to, note: edit.note } });
      setEdit(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };

  const isPickedCustomer = picked && /^pelanggan/.test(picked.properties.type_code || '');

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-1">
        {(['open', ''] as const).map((f) => (
          <button
            key={f || 'all'}
            className={`rounded-md border px-2 py-1 text-xs ${filter === f ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}
            onClick={() => setFilter(f)}
          >
            {f === 'open' ? o('rep_filter_open') : o('rep_filter_all')}
          </button>
        ))}
        <span className="flex-1" />
        {canManage && (
          <Button size="sm" icon="plus" onClick={() => setFormOpen(!formOpen)}>
            {o('rep_new')}
          </Button>
        )}
      </div>
      {!canManage && <div className="text-[11px] text-gray-500">{o('no_perm_report')}</div>}

      {formOpen && canManage && (
        <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">{o('rep_channel')}</span>
              <select className="input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                {meta.channels.map((c) => (
                  <option key={c} value={c}>
                    {o(`ch_${c}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">{o('rep_category')}</span>
              <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {meta.categories.map((c) => (
                  <option key={c} value={c}>
                    {o(`cat_${c}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="label">{o('rep_customer')}</span>
            <div className="flex gap-1">
              <input
                className="input flex-1"
                value={form.customer_code}
                onChange={(e) => {
                  setForm({ ...form, customer_code: e.target.value });
                  setCustomerId(null);
                }}
              />
              {isPickedCustomer && (
                <Button size="sm" variant="secondary" onClick={usePicked}>
                  {o('rep_use_pick')}
                </Button>
              )}
            </div>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">{o('rep_reporter')}</span>
              <input className="input" value={form.reporter_name} onChange={(e) => setForm({ ...form, reporter_name: e.target.value })} />
            </label>
            <label className="block">
              <span className="label">{o('rep_phone')}</span>
              <input className="input" value={form.reporter_phone} onChange={(e) => setForm({ ...form, reporter_phone: e.target.value })} />
            </label>
          </div>
          <label className="block">
            <span className="label">{o('rep_address')}</span>
            <input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">{o('rep_desc')}</span>
            <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="label">{o('rep_priority')}</span>
              <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="">{o('rep_priority_auto')}</option>
                {meta.priorities.map((p) => (
                  <option key={p} value={p}>
                    {o(`pr_${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" icon="check" loading={saving} onClick={submit}>
              {o('rep_submit')}
            </Button>
          </div>
        </div>
      )}

      {/* dugaan lokasi gangguan */}
      <div className="rounded-lg border border-gray-200 p-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{o('rep_suspects')}</div>
        <div className="mb-1 text-[11px] text-gray-500">{o('rep_suspects_hint')}</div>
        {suspects.length === 0 && <div className="text-xs text-gray-500">{o('rep_suspects_empty')}</div>}
        <ul className="space-y-1">
          {suspects.map((s) => (
            <li key={`${s.node_id}-${s.group}`} className="rounded bg-amber-50 px-2 py-1 text-xs">
              <div className="flex items-center gap-2">
                <Badge tone="amber">{o(`lvl_${s.level}`)}</Badge>
                <button className="flex-1 truncate text-left font-semibold text-brand-700 hover:underline" onClick={() => onSelect('node', s.node_id, true)}>
                  {s.code || `#${s.node_id}`}
                </button>
                <button className="text-[11px] text-brand-700 hover:underline" onClick={() => router.push(`/sld?focus=node:${s.node_id}`)}>
                  {o('rep_open_sld')}
                </button>
              </div>
              <div className="text-[11px] text-gray-700">
                {o('rep_suspect_line', { n: s.reported, total: fmtNum(s.customers), pct: s.ratio })}
                {s.group && ` · ${s.group}`}
              </div>
              <div className="truncate text-[11px] text-gray-500">{s.tickets.join(', ')}</div>
            </li>
          ))}
        </ul>
      </div>

      <input className="input text-xs" placeholder={o('rep_search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {items === null ? (
        <div className="py-3 text-center">
          <Spinner size={16} />
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-xs text-gray-500">{o('rep_empty')}</div>
      ) : (
        <ul className="space-y-1">
          {items.map((r) => {
            const overdue = r.status !== 'SELESAI' && r.status !== 'BATAL' && r.age_minutes > meta.sla;
            return (
              <li key={r.id} className={`rounded border px-2 py-1.5 text-xs ${overdue ? 'border-red-300' : 'border-gray-200'}`} style={{ borderLeft: `4px solid ${statusColor[r.status] || '#8a94a6'}` }}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-gray-900">{r.ticket}</span>
                  <Badge tone={statusTone[r.status] || 'gray'}>{o(`rs_${r.status}`)}</Badge>
                  {r.priority !== 'NORMAL' && <Badge tone={r.priority === 'DARURAT' ? 'red' : 'amber'}>{o(`pr_${r.priority}`)}</Badge>}
                  <span className="flex-1" />
                  <span className={`tabular-nums ${overdue ? 'font-semibold text-red-700' : 'text-gray-500'}`} title={`SLA ${meta.sla} mnt`}>
                    {age(r.age_minutes)}
                    {overdue && ` · ${o('overdue')}`}
                  </span>
                </div>
                <div className="mt-0.5 text-gray-700">
                  {o(`cat_${r.category}`)} · {o(`ch_${r.channel}`)}
                  {r.reporter_name && ` · ${r.reporter_name}`}
                  {r.reporter_phone && ` (${r.reporter_phone})`}
                </div>
                <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-600">
                  {r.customer_code && (
                    <button className="font-medium text-brand-700 hover:underline" onClick={() => r.customer_id && onSelect('node', r.customer_id, true)}>
                      {r.customer_code}
                    </button>
                  )}
                  {r.gd_code && <span>{r.gd_code}</span>}
                  {r.route_code && <span>{r.route_code}</span>}
                  {r.address && <span className="truncate">{r.address}</span>}
                </div>
                <div className="text-[11px]">
                  {r.outage_id ? (
                    <span className="text-red-700">{o('rep_linked', { id: r.outage_id })}</span>
                  ) : r.energized === true ? (
                    <span className="text-amber-700">{o('rep_on_now')}</span>
                  ) : r.energized === false ? (
                    <span className="text-red-700">{o('rep_off_unknown')}</span>
                  ) : null}
                  {r.assigned_to && <span className="ml-2 text-gray-600">→ {r.assigned_to}</span>}
                </div>
                {r.description && <div className="text-[11px] italic text-gray-500">“{r.description}”</div>}
                <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                  {r.lng != null && r.lat != null && (
                    <button className="text-brand-700 hover:underline" onClick={() => onFly(r.lng!, r.lat!)}>
                      {o('rep_show_map')}
                    </button>
                  )}
                  <button className="text-brand-700 hover:underline" onClick={() => setExpand(expand === r.id ? null : r.id)}>
                    {o('rep_history')} ({r.history.length})
                  </button>
                  {canManage && r.status !== 'SELESAI' && r.status !== 'BATAL' && (
                    <button className="text-brand-700 hover:underline" onClick={() => setEdit({ id: r.id, status: r.status, assigned_to: r.assigned_to, note: '' })}>
                      {o('rep_update')}
                    </button>
                  )}
                </div>
                {expand === r.id && (
                  <ol className="mt-1 space-y-0.5 border-l border-gray-200 pl-2 text-[11px] text-gray-600">
                    {r.history.map((h, i) => (
                      <li key={i}>
                        {fmtDate(h.at)} · {h.by} · {o(`rs_${h.status}`)}
                        {h.assigned_to && ` → ${h.assigned_to}`}
                        {h.note && ` · ${h.note}`}
                      </li>
                    ))}
                  </ol>
                )}
                {edit?.id === r.id && (
                  <div className="mt-1 space-y-1 rounded bg-gray-50 p-1.5">
                    <div className="grid grid-cols-2 gap-1">
                      <select className="input !py-0.5 text-xs" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} aria-label={o('rep_status')}>
                        {meta.statuses.map((s) => (
                          <option key={s} value={s}>
                            {o(`rs_${s}`)}
                          </option>
                        ))}
                      </select>
                      <input className="input !py-0.5 text-xs" placeholder={o('rep_assign')} value={edit.assigned_to} onChange={(e) => setEdit({ ...edit, assigned_to: e.target.value })} />
                    </div>
                    <input className="input !py-0.5 text-xs" placeholder={o('plan_note')} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
                    <div className="flex gap-1">
                      <Button size="sm" icon="check" onClick={update}>
                        {o('rep_update')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEdit(null)}>
                        ×
                      </Button>
                    </div>
                  </div>
                )}
                <div className="text-[10px] text-gray-400">{fmtDate(r.received_at)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
