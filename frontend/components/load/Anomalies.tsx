'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { Button, Modal, Spinner, useToast } from '@/components/ui';
import { LoadChart } from '@/components/charts/LoadChart';
import { useLoadT } from './i18n';
import { SevBadge, fmtDT, fmtMW } from './common';
import { DATA_KINDS, NET_KINDS, type Anomaly, type Reading } from './types';

export function Anomalies({ canManage, refresh, onOpen }: { canManage: boolean; refresh: number; onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const toast = useToast();
  const [kind, setKind] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('active');
  const [days, setDays] = useState(14);
  const [data, setData] = useState<{ items: Anomaly[]; counts: Record<string, Record<string, number>>; open: number } | null>(null);
  const [sel, setSel] = useState<Anomaly | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/load/anomalies?kind=${kind}&severity=${severity}&status=${status}&days=${days}&limit=500`));
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [kind, severity, status, days, toast]);
  useEffect(() => {
    load();
  }, [load, refresh]);

  const total = (k: string) => Object.values(data?.counts?.[k] || {}).reduce((a, b) => a + b, 0);
  const valueText = (a: Anomaly) => {
    if (a.value === null) return '';
    switch (a.kind) {
      case 'overload':
        return `${fmtNum(a.value, 0)}%`;
      case 'imbalance':
        return `${fmtNum(a.value, 0)}%`;
      case 'low_pf':
        return `pf ${fmtNum(a.value, 2)}`;
      case 'voltage':
        return `${fmtNum(a.value, a.value < 1 ? 3 : 2)} kV`;
      case 'frequency':
        return `${fmtNum(a.value, 2)} Hz`;
      case 'losses':
        return `${fmtNum(a.value, 1)}% (${L('expected')} ${fmtNum(a.expected || 0, 0)}%)`;
      case 'energy':
        return `${fmtNum(a.value, 0)} kWh (${L('expected')} ${fmtNum(a.expected || 0, 0)}${a.detail?.pct !== undefined ? `, ${a.detail.pct > 0 ? '+' : ''}${a.detail.pct}%` : ''})`;
      case 'spike':
      case 'drop':
      case 'level_shift':
      case 'mismatch':
        return `${fmtMW(a.value)} (${L('expected')} ${fmtMW(a.expected || 0)}${a.detail?.pct !== undefined ? `, ${a.detail.pct > 0 ? '+' : ''}${a.detail.pct}%` : ''})`;
      default:
        return fmtNum(a.value, 2);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {[
          [L('cat_data'), DATA_KINDS],
          [L('cat_net'), NET_KINDS],
        ].map(([title, kinds]) => (
          <div key={title as string} className="card p-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title as string}</div>
            <div className="flex flex-wrap gap-1.5">
              {(kinds as string[]).map((k) => (
                <button
                  key={k}
                  className={`rounded-full border px-2.5 py-1 text-xs ${kind === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:border-gray-500'}`}
                  onClick={() => setKind(kind === k ? '' : k)}
                >
                  {L(`k_${k}`)} <b className="tabular-nums">{fmtNum(total(k))}</b>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="input !w-auto text-xs" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label={L('severity')}>
          <option value="">{L('severity')}: {L('all')}</option>
          {['critical', 'serious', 'warning', 'info'].map((s) => (
            <option key={s} value={s}>
              {L(`sev_${s}`)}
            </option>
          ))}
        </select>
        <select className="input !w-auto text-xs" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={L('status')}>
          <option value="active">{L('active')}</option>
          <option value="">{L('all')}</option>
          <option value="open">{L('st_open')}</option>
          <option value="ack">{L('st_ack')}</option>
          <option value="closed">{L('st_closed')}</option>
        </select>
        <select className="input !w-auto text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 14, 30, 90].map((d) => (
            <option key={d} value={d}>
              {d} hari
            </option>
          ))}
        </select>
        {!data && <Spinner size={14} />}
        <span className="ml-auto text-gray-500">{data ? `${fmtNum(data.items.length)} · ${L('st_open')} ${fmtNum(data.open)}` : ''}</span>
      </div>
      {data && data.items.length === 0 && <p className="card p-6 text-center text-sm text-gray-500">{L('none_anomaly')}</p>}
      <ul className="space-y-1.5">
        {(data?.items || []).map((a) => (
          <li key={a.id}>
            <button className="card flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:border-gray-400" onClick={() => setSel(a)}>
              <SevBadge sev={a.severity} />
              <span className="font-semibold text-gray-900">{L(`k_${a.kind}`)}</span>
              <span className="text-gray-800">{a.point_code}</span>
              <span className="text-gray-500">{a.point_kind === 'trafo_gi' ? L('level_trafo_gi') : L('level_feeder')}</span>
              <span className="tabular-nums text-gray-700">{valueText(a)}</span>
              <span className="ml-auto text-gray-500">
                {fmtDT(a.start_ts)}
                {a.slots > 1 && ` · ${L('slots', { n: a.slots })}`}
              </span>
              {a.status !== 'open' && <span className="rounded bg-gray-100 px-1.5 text-[10px] text-gray-600">{L(`st_${a.status}`)}</span>}
              {a.explanation && <span className="w-full text-[11px] text-brand-700">↳ {a.explanation}</span>}
            </button>
          </li>
        ))}
      </ul>
      <Modal open={!!sel} title={sel ? `${L(`k_${sel.kind}`)} · ${sel.point_code}` : ''} onClose={() => setSel(null)} width="max-w-3xl">
        {sel && <AnomalyDetail a={sel} canManage={canManage} onDone={() => (setSel(null), load())} onOpen={onOpen} />}
      </Modal>
    </div>
  );
}

function AnomalyDetail({ a, canManage, onDone, onOpen }: { a: Anomaly; canManage: boolean; onDone: () => void; onOpen: (level: string, id: string) => void }) {
  const L = useLoadT();
  const toast = useToast();
  const [data, setData] = useState<{ readings: Reading[]; baseline: { ts: string; median: number }[] } | null>(null);
  const [note, setNote] = useState(a.note);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api<{ readings: Reading[]; baseline: { ts: string; median: number }[] }>(`/api/load/anomalies/${a.id}/series`)
      .then(setData)
      .catch(() => setData({ readings: [], baseline: [] }));
  }, [a.id]);
  const save = async (status: string) => {
    setBusy(status);
    try {
      await api(`/api/load/anomalies/${a.id}`, { method: 'PUT', body: { status, note } });
      toast.push(L('saved'), 'success');
      onDone();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const t = (s: string) => new Date(s).getTime();
  const phases = a.kind === 'imbalance';
  const energy = a.kind === 'energy';
  const freq = a.kind === 'frequency';
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <SevBadge sev={a.severity} />
        <span className="text-gray-700">
          {fmtDT(a.start_ts)} – {fmtDT(new Date(new Date(a.end_ts).getTime() + 1800000).toISOString())} · {L('slots', { n: a.slots })}
        </span>
        {Object.entries(a.detail || {}).map(([k, v]) => (
          <span key={k} className="rounded bg-gray-100 px-1.5 text-[11px] text-gray-700">
            {k}: {typeof v === 'number' ? fmtNum(v, 2) : String(v)}
          </span>
        ))}
      </div>
      {a.explanation && <p className="rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-800">↳ {a.explanation}</p>}
      {!data ? (
        <Spinner size={16} />
      ) : (
        <LoadChart
          title={L('detail_chart')}
          lines={
            phases
              ? [
                  { name: 'I R', points: data.readings.map((r) => ({ t: t(r.ts), v: r.i_r })), color: 'var(--series-2)' },
                  { name: 'I S', points: data.readings.map((r) => ({ t: t(r.ts), v: r.i_s })), color: 'var(--series-3)' },
                  { name: 'I T', points: data.readings.map((r) => ({ t: t(r.ts), v: r.i_t })), color: 'var(--series-1)' },
                ]
              : energy
                ? [
                    { name: 'P × 0,5 j (kWh)', points: data.readings.map((r) => ({ t: t(r.ts), v: r.p_mw === null ? null : r.p_mw * 500 })), color: 'var(--series-2)', dashed: true },
                    { name: L('kwh_imp'), points: data.readings.map((r) => ({ t: t(r.ts), v: r.kwh_imp })), color: 'var(--series-1)', width: 2.5 },
                  ]
                : freq
                  ? [{ name: L('freq'), points: data.readings.map((r) => ({ t: t(r.ts), v: r.f_hz })), color: 'var(--series-1)', width: 2.5 }]
                  : [
                      { name: L('baseline'), points: data.baseline.map((b) => ({ t: t(b.ts), v: b.median })), color: 'var(--chart-cursor)', dashed: true },
                      { name: 'MW', points: data.readings.map((r) => ({ t: t(r.ts), v: r.p_mw })), color: 'var(--series-1)', width: 2.5 },
                    ]
          }
          band={[{ t: t(a.start_ts), lo: 0, hi: 0 }]}
          unit={phases ? ' A' : energy ? ' kWh' : freq ? ' Hz' : ' MW'}
          height={200}
          tipFormat={(x) => new Date(x).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}
        />
      )}
      {canManage && (
        <div className="space-y-2">
          <textarea className="input min-h-[60px] w-full text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder={L('note')} />
          <div className="flex flex-wrap gap-2">
            {a.status !== 'ack' && (
              <Button size="sm" variant="secondary" loading={busy === 'ack'} onClick={() => save('ack')}>
                {L('ack')}
              </Button>
            )}
            {a.status !== 'closed' ? (
              <Button size="sm" icon="check" loading={busy === 'closed'} onClick={() => save('closed')}>
                {L('close')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" loading={busy === 'open'} onClick={() => save('open')}>
                {L('reopen')}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon="chart" onClick={() => (onDone(), onOpen('point', String(a.point_id)))}>
              {L('tab_analysis')}
            </Button>
          </div>
          {a.handled_by && <p className="text-[11px] text-gray-500">— {a.handled_by}</p>}
        </div>
      )}
    </div>
  );
}
