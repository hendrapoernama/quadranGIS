'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE, api, getToken } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { Badge, Button, Confirm, Spinner, useToast } from '@/components/ui';
import { useLoadT } from './i18n';
import { fmtDT } from './common';
import type { LPoint } from './types';

interface Unmapped {
  code: string;
  kind: string;
  first_seen: string;
  last_seen: string;
  messages: number;
}

const SAMPLE = `{"point":"KBK-GMB-02","type":"feeder","ts":"2026-09-27T10:30:00+07:00",
 "i_r":182,"i_s":175,"i_t":190,"v_r":20.3,"v_s":20.4,"v_t":20.2,
 "p_mw":6.1,"q_mvar":1.9,"s_mva":6.39,"pf":0.95,"f_hz":50.01,
 "kwh_imp":3050,"kwh_exp":0,"kvarh_imp":950,"kvarh_exp":0,"quality":"good"}`;

export function Points({ canManage, overview, onChanged }: { canManage: boolean; overview: any; onChanged: () => void }) {
  const L = useLoadT();
  const toast = useToast();
  const [data, setData] = useState<{ items: LPoint[]; unmapped: Unmapped[] } | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [form, setForm] = useState<Partial<LPoint> & { rating?: string }>({ kind: 'feeder', active: true });
  const [busy, setBusy] = useState('');
  const [del, setDel] = useState<LPoint | null>(null);
  const [bf, setBf] = useState({ days: 30, bulk_days: 0 });
  const [gdFeeders, setGdFeeders] = useState(15);
  const [ingest, setIngest] = useState(SAMPLE);

  const load = useCallback(async () => {
    try {
      setData(await api('/api/load/points'));
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.items || []).filter(
      (p) =>
        (!kind || p.kind === kind) &&
        (!s || p.code.toLowerCase().includes(s) || (p.up3 || '').toLowerCase().includes(s) || (p.gi_code || '').toLowerCase().includes(s) || (p.feeder_code || '').toLowerCase().includes(s)),
    );
  }, [data, q, kind]);

  const run = async (key: string, fn: () => Promise<any>, ok?: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast.push(ok(r), 'success');
      load();
      onChanged();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const save = () =>
    run(
      'save',
      () =>
        api('/api/load/points', {
          method: 'POST',
          body: {
            code: form.code,
            kind: form.kind,
            name: form.name || '',
            active: form.active !== false,
            kv: form.kind === 'gd' ? 0.4 : 20,
            rating_a: form.kind === 'feeder' && form.rating ? Number(form.rating) : null,
            rating_mva: form.kind === 'trafo_gi' && form.rating ? Number(form.rating) : form.kind === 'gd' && form.rating ? Number(form.rating) / 1000 : null,
          },
        }),
      () => L('saved'),
    );

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="card space-y-2 p-3 text-xs">
            <h3 className="text-sm font-semibold text-gray-900">{L('pt_add')}</h3>
            <div className="grid grid-cols-2 gap-2">
              <input className="input text-xs" placeholder={L('pt_code')} value={form.code || ''} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              <select className="input text-xs" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as any })}>
                <option value="feeder">{L('level_feeder')}</option>
                <option value="trafo_gi">{L('level_trafo_gi')}</option>
                <option value="gd">{L('level_gd')}</option>
              </select>
              <input className="input text-xs" placeholder={L('pt_name')} value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input
                className="input text-xs"
                placeholder={form.kind === 'feeder' ? `${L('pt_rating')} (A)` : form.kind === 'gd' ? L('pt_rating_kva') : `${L('pt_rating')} (MVA)`}
                inputMode="decimal"
                value={form.rating || ''}
                onChange={(e) => setForm({ ...form, rating: e.target.value })}
              />
            </div>
            <p className="text-[11px] text-gray-500">
              {L('pt_code_hint')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon="check" loading={busy === 'save'} disabled={!form.code} onClick={save}>
                {L('pt_add')}
              </Button>
              <Button size="sm" variant="secondary" icon="refresh" loading={busy === 'auto'} onClick={() => run('auto', () => api<{ created: number }>('/api/load/points/automap', { method: 'POST' }), (r) => L('pt_automapped', { n: r.created }))}>
                {L('pt_automap')}
              </Button>
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  icon="refresh"
                  loading={busy === 'autogd'}
                  onClick={() => run('autogd', () => api<{ created: number }>('/api/load/points/automap', { method: 'POST', body: { gd_feeders: gdFeeders } }), (r) => L('pt_automapped', { n: r.created }))}
                >
                  {L('pt_automap_gd')}
                </Button>
                <input className="input !w-16 text-xs" type="number" min={0} max={200} value={gdFeeders} onChange={(e) => setGdFeeders(Number(e.target.value))} aria-label={L('pt_gd_feeders')} />
                <span className="text-gray-500">{L('pt_gd_feeders')}</span>
              </span>
            </div>
          </div>
          <div className="card space-y-2 p-3 text-xs">
            <h3 className="text-sm font-semibold text-gray-900">{L('pt_backfill')}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">
                {L('pt_backfill_days')}
                <input className="input !w-20 text-xs" type="number" min={1} max={800} value={bf.days} onChange={(e) => setBf({ ...bf, days: Number(e.target.value) })} />
              </label>
              <label className="flex items-center gap-1">
                {L('pt_backfill_bulk')}
                <input className="input !w-20 text-xs" type="number" min={0} max={120} value={bf.bulk_days} onChange={(e) => setBf({ ...bf, bulk_days: Number(e.target.value) })} />
              </label>
              <Button size="sm" variant="secondary" loading={busy === 'bf'} onClick={() => run('bf', () => api('/api/load/simulator/backfill', { method: 'POST', body: bf }), () => L('pt_backfill_started'))}>
                {L('pt_backfill')}
              </Button>
              <Button size="sm" variant="ghost" loading={busy === 'rc'} onClick={() => run('rc', () => api('/api/load/recompute', { method: 'POST', body: { days: 7 } }), () => L('saved'))}>
                {L('pt_recompute')}
              </Button>
            </div>
            {overview?.simulator?.backfill && (
              <p className="text-[11px] text-gray-600">
                {L('backfill')}: {overview.simulator.backfill.phase} {overview.simulator.backfill.total ? `${fmtNum((overview.simulator.backfill.done / overview.simulator.backfill.total) * 100, 0)}%` : ''}
              </p>
            )}
            <h3 className="pt-1 text-sm font-semibold text-gray-900">{L('pt_contract')}</h3>
            <p className="text-[11px] text-gray-500">
              {L('pt_topic')} <code className="rounded bg-gray-100 px-1">{overview?.topic || 'scada.load.30m'}</code> · {L('pt_c_msg')} · <code>type</code> feeder / trafo_gi / gd · <code>ts</code> {L('pt_c_ts')} ·{' '}
              <code>v_r/v_s/v_t</code> {L('pt_c_v')} · {L('pt_c_energy')} <code className="rounded bg-gray-100 px-1">{overview?.energy_mode || 'interval'}</code>; <code>cumulative</code>{' '}
              {L('pt_c_cum')}
            </p>
            <textarea className="input min-h-[80px] w-full font-mono text-[11px]" value={ingest} onChange={(e) => setIngest(e.target.value)} />
            <Button
              size="sm"
              variant="secondary"
              icon="send"
              loading={busy === 'ing'}
              onClick={() =>
                run(
                  'ing',
                  async () => {
                    JSON.parse(ingest);
                    const token = getToken();
                    const res = await fetch(`${API_BASE}/api/load/ingest`, {
                      method: 'POST',
                      body: ingest,
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    });
                    const j = await res.json();
                    if (!res.ok) throw new Error(j.error || res.statusText);
                    return j;
                  },
                  (r) => `${r.readings} ${L('readings')} · ${r.unmapped} ${L('unmapped')}`,
                )
              }
            >
              {L('pt_ingest')}
            </Button>
          </div>
        </div>
      )}

      {data && data.unmapped.length > 0 && (
        <div className="card p-3 text-xs">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{L('pt_unmapped')}</h3>
          <ul className="space-y-1">
            {data.unmapped.map((u) => (
              <li key={u.code} className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-amber-50 px-1 text-amber-800">{u.code}</code>
                <span className="text-gray-500">
                  {u.kind || '-'} · {fmtNum(u.messages)} {L('messages')} · {fmtDT(u.last_seen)}
                </span>
                {canManage && (
                  <Button size="sm" variant="ghost" onClick={() => setForm({ code: u.code, kind: u.kind === 'trafo_gi' || u.kind === 'gd' ? u.kind : 'feeder', active: true })}>
                    {L('pt_map_this')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <input className="input !w-48 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('search')} />
          <select className="input !w-auto text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{L('all')}</option>
            <option value="feeder">{L('level_feeder')}</option>
            <option value="trafo_gi">{L('level_trafo_gi')}</option>
            <option value="gd">{L('level_gd')}</option>
          </select>
          {!data && <Spinner size={14} />}
          <span className="ml-auto text-gray-500">{fmtNum(list.length)}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <th className="py-1">{L('pt_code')}</th>
                <th className="py-1">{L('pt_kind')}</th>
                <th className="py-1">GI / Trafo / {L('pt_feeder')}</th>
                <th className="py-1">UP3 · UID</th>
                <th className="py-1 pr-4 text-right">{L('pt_rating')}</th>
                <th className="py-1">{L('pt_last')}</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 400).map((p) => {
                const late = !p.last_ts || Date.now() - new Date(p.last_ts).getTime() > 3600_000;
                return (
                  <tr key={p.id} className="border-b border-gray-100">
                    <td className="py-1">
                      <div className="font-medium text-gray-900">{p.code}</div>
                      {p.node_id ? <div className="text-[10px] text-gray-500">#{p.node_id}</div> : <div className="text-[10px] text-amber-700">{L('pt_no_obj')}</div>}
                    </td>
                    <td className="py-1">{L(`level_${p.kind}`)}</td>
                    <td className="py-1 text-gray-700">
                      {p.gi_code || '-'}
                      {p.kind !== 'trafo_gi' && p.trafo_gi_code ? ` · ${p.trafo_gi_code}` : ''}
                      {p.kind === 'gd' && p.feeder_code ? ` · ${p.feeder_code}` : ''}
                    </td>
                    <td className="py-1 text-gray-700">
                      {p.up3 || '-'} · {p.uid}
                    </td>
                    <td className="py-1 pr-4 text-right tabular-nums">
                      {p.kind === 'feeder' ? `${fmtNum(p.rating_a || 0)} A` : p.kind === 'gd' ? `${fmtNum((p.rating_mva || 0) * 1000)} kVA` : `${fmtNum(p.rating_mva || 0)} MVA`}
                    </td>
                    <td className="py-1">
                      {!p.active ? <Badge tone="gray">{L('pt_inactive')}</Badge> : <span className={late ? 'text-amber-700' : 'text-gray-700'}>{fmtDT(p.last_ts)}</span>}
                    </td>
                    <td className="py-1 text-right">
                      {canManage && (
                        <button className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600" onClick={() => setDel(p)} title={L('pt_delete')} aria-label={L('pt_delete')}>
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <Confirm
        open={!!del}
        title={L('pt_delete')}
        message={del ? `${del.code}` : ''}
        danger
        onCancel={() => setDel(null)}
        onConfirm={() => del && run('del', () => api(`/api/load/points/${del.id}`, { method: 'DELETE' }), () => L('saved')).then(() => setDel(null))}
      />
    </div>
  );
}
