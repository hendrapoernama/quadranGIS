'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { Badge, Button, Confirm, Spinner, useToast } from '@/components/ui';
import { AiOpsPanel, RichText } from '@/components/ai/AiOpsPanel';
import { useExecT } from './i18n';
import { Delta, csvRow, downloadText, fmtIdx, fmtMin, fmtRp } from './common';
import type { PeriodicReportMeta, PeriodReport } from './types';

type Kind = '' | 'daily' | 'weekly' | 'monthly';

export function PeriodicReports() {
  const e = useExecT();
  const { has } = useAuth();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('');
  const [items, setItems] = useState<PeriodicReportMeta[] | null>(null);
  const [sel, setSel] = useState<PeriodicReportMeta | null>(null);
  const [genKind, setGenKind] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [genDate, setGenDate] = useState(() => {
    const d = new Date(Date.now() - 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [busy, setBusy] = useState('');
  const canManage = has('exec.report');

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: PeriodicReportMeta[] }>(`/api/exec/reports?kind=${kind}`);
      setItems(r.items);
    } catch (err: any) {
      toast.push(err.message, 'error');
    }
  }, [kind, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const open = async (id: number) => {
    setBusy(`open-${id}`);
    try {
      setSel(await api<PeriodicReportMeta>(`/api/exec/reports/${id}`));
    } catch (err: any) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const generate = async (k = genKind, date = genDate) => {
    setBusy('gen');
    try {
      const r = await api<{ id: number }>('/api/exec/reports', { method: 'POST', body: { kind: k, date } });
      await load();
      await open(r.id);
    } catch (err: any) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const kindLabel = (k: string) => e(`rep_kind_${k}` as any);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
      <div className="no-print space-y-3">
        {canManage && (
          <div className="card space-y-2 p-3 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('rep_generate')}</div>
            <div className="flex gap-2">
              <select className="input flex-1 text-xs" value={genKind} onChange={(ev) => setGenKind(ev.target.value as any)}>
                {(['daily', 'weekly', 'monthly'] as const).map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </select>
              <input className="input flex-1 text-xs" type="date" value={genDate} onChange={(ev) => setGenDate(ev.target.value)} title={e('rep_date')} />
            </div>
            <Button size="sm" icon="plus" loading={busy === 'gen'} onClick={() => generate()} className="w-full">
              {e('rep_generate')}
            </Button>
          </div>
        )}
        <div className="card p-2">
          <div className="mb-2 flex flex-wrap gap-1 text-xs">
            {(['', 'daily', 'weekly', 'monthly'] as Kind[]).map((k) => (
              <button key={k || 'all'} className={`rounded px-2 py-0.5 ${kind === k ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setKind(k)}>
                {k ? kindLabel(k) : e('rep_all')}
              </button>
            ))}
          </div>
          {items === null ? (
            <div className="py-4 text-center">
              <Spinner size={16} />
            </div>
          ) : items.length === 0 ? (
            <p className="p-2 text-xs text-gray-500">{e('rep_none')}</p>
          ) : (
            <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
              {items.map((it) => (
                <li key={it.id}>
                  <button
                    className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${sel?.id === it.id ? 'border-brand-600 bg-brand-50' : 'border-gray-200 hover:border-gray-400'}`}
                    onClick={() => open(it.id)}
                  >
                    <div className="flex items-center gap-2">
                      <Badge tone={it.kind === 'monthly' ? 'purple' : it.kind === 'weekly' ? 'blue' : 'gray'}>{kindLabel(it.kind)}</Badge>
                      {it.narrative && <span className="text-[10px] text-emerald-700">✓ {e('rep_narrative')}</span>}
                      {busy === `open-${it.id}` && <Spinner size={12} />}
                    </div>
                    <div className="mt-0.5 font-medium text-gray-900">{it.title}</div>
                    <div className="text-[10px] text-gray-500">
                      {e('rep_generated_by')} {it.generated_by === 'system' ? e('rep_system') : it.generated_by} · {new Date(it.generated_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="min-w-0">
        {sel?.data ? (
          <ReportView
            rep={sel}
            canManage={canManage}
            onChanged={(r) => {
              setSel(r);
              load();
            }}
            onDeleted={() => {
              setSel(null);
              load();
            }}
            onRegenerate={() => generate(sel.kind, localDate(sel.period_start))}
            regenerating={busy === 'gen'}
          />
        ) : (
          <div className="card p-10 text-center text-sm text-gray-500">{e('rep_pick')}</div>
        )}
      </div>
    </div>
  );
}

function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ReportView({
  rep,
  canManage,
  onChanged,
  onDeleted,
  onRegenerate,
  regenerating,
}: {
  rep: PeriodicReportMeta;
  canManage: boolean;
  onChanged: (r: PeriodicReportMeta) => void;
  onDeleted: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const e = useExecT();
  const { locale } = useT();
  const { has, appName } = useAuth();
  const toast = useToast();
  const d = rep.data as PeriodReport;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rep.narrative);
  const [showAi, setShowAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    setText(rep.narrative);
    setEditing(false);
    setShowAi(false);
  }, [rep.id, rep.narrative]);

  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const fmtD = (s: string) => new Date(s).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
  const t = d.total;
  const p = d.previous?.total;
  const kinds = Object.entries(d.by_kind || {}).sort((a, b) => b[1].customer_minutes - a[1].customer_minutes);
  const up3 = d.regions.filter((r) => r.level === 'up3' && (r.customers > 0 || r.rel.outages > 0));
  const outside = d.regions.find((r) => r.level === 'outside');
  const slaPct = d.ops.reports > 0 ? ((d.ops.reports - d.ops.reports_overdue) / d.ops.reports) * 100 : null;

  const saveNarrative = async (value: string) => {
    setSaving(true);
    try {
      await api(`/api/exec/reports/${rep.id}/narrative`, { method: 'PUT', body: { text: value } });
      onChanged({ ...rep, narrative: value });
      setEditing(false);
      setShowAi(false);
      toast.push('OK', 'success');
    } catch (err: any) {
      toast.push(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const print = () => {
    const html = document.documentElement;
    const wasDark = html.classList.contains('dark');
    document.body.classList.add('exec-printing');
    if (wasDark) html.classList.remove('dark'); // cetak selalu terang
    const after = () => {
      document.body.classList.remove('exec-printing');
      if (wasDark) html.classList.add('dark');
      window.removeEventListener('afterprint', after);
    };
    window.addEventListener('afterprint', after);
    setTimeout(() => window.print(), 50);
  };

  const csv = () => {
    const rows: string[] = [];
    rows.push(csvRow([rep.title]));
    rows.push(csvRow([e('rep_period'), fmtD(rep.period_start), fmtD(rep.period_end)]));
    rows.push('');
    rows.push(csvRow([e('rep_indicator'), e('rep_this'), e('rep_prev'), e('rep_target')]));
    rows.push(csvRow(['SAIDI', t.saidi, p?.saidi, d.targets.saidi_period]));
    rows.push(csvRow(['SAIFI', t.saifi, p?.saifi, d.targets.saifi_period]));
    rows.push(csvRow([e('rep_ens_kwh'), t.ens_kwh, p?.ens_kwh]));
    rows.push(csvRow([e('rep_ens_rp'), Math.round(t.ens_rp), p ? Math.round(p.ens_rp) : '']));
    rows.push(csvRow([e('outages'), t.outages, p?.outages]));
    rows.push(csvRow([e('rep_customers_out'), t.customers_out, p?.customers_out]));
    rows.push(csvRow([e('mttr') + ' (min)', d.mttr_min.toFixed(1), d.previous?.mttr_min?.toFixed(1)]));
    rows.push('');
    rows.push(csvRow([e('rep_by_region'), 'level', e('reg_customers'), e('events'), 'SAIDI', 'SAIFI', e('rep_ens_rp')]));
    for (const r of d.regions) if (r.rel.outages > 0 || r.customers > 0) rows.push(csvRow([r.level === 'outside' ? e('rep_outside') : r.name, r.level, r.customers, r.rel.outages, r.rel.saidi, r.rel.saifi, Math.round(r.rel.ens_rp)]));
    rows.push('');
    rows.push(csvRow([e('feeder'), e('events'), e('faults'), e('cust_min'), e('rep_ens_rp')]));
    for (const f of d.top_feeders) rows.push(csvRow([f.code, f.outages, f.faults, f.customer_minutes.toFixed(1), Math.round(f.ens_rp)]));
    rows.push('');
    rows.push(csvRow(['#', e('rep_kind'), e('rep_cause'), e('feeder'), e('rep_start'), e('rep_duration') + ' (min)', e('rep_customers'), e('cust_min'), e('rep_ens_rp')]));
    for (const o of d.top_outages) rows.push(csvRow([o.id, o.kind, o.cause_code, o.feeder, fmtD(o.started_at), o.duration_min.toFixed(1), o.customers, o.customer_minutes.toFixed(1), Math.round(o.ens_rp)]));
    if (d.daily?.length) {
      rows.push('');
      rows.push(csvRow(['date', e('outages'), e('faults'), e('rep_customers_out'), e('cust_min'), e('rep_ens_rp')]));
      for (const x of d.daily) rows.push(csvRow([x.date, x.outages, x.faults, x.customers_out, x.customer_minutes.toFixed(1), Math.round(x.ens_rp)]));
    }
    if (rep.narrative) {
      rows.push('');
      rows.push(csvRow([e('rep_narrative'), rep.narrative]));
    }
    downloadText(`${rep.title.replace(/[^\w-]+/g, '_')}.csv`, rows.join('\r\n'));
  };

  const del = async () => {
    try {
      await api(`/api/exec/reports/${rep.id}`, { method: 'DELETE' });
      setConfirmDel(false);
      onDeleted();
    } catch (err: any) {
      toast.push(err.message, 'error');
    }
  };

  const th = 'px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-gray-500';
  const td = 'px-2 py-1 tabular-nums';

  return (
    <div className="space-y-3">
      <div className="no-print flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon="download" onClick={print}>
          {e('rep_print')}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={csv}>
          {e('rep_csv')}
        </Button>
        {canManage && (
          <>
            <Button size="sm" variant="secondary" icon="refresh" loading={regenerating} onClick={onRegenerate}>
              {e('rep_regenerate')}
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmDel(true)}>
              {e('rep_delete')}
            </Button>
          </>
        )}
      </div>

      <article className="exec-report card space-y-4 p-5 text-sm">
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-200 pb-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">{appName} · {e(`rep_kind_${rep.kind}` as any)}</div>
            <h2 className="text-lg font-semibold text-gray-900">{rep.title}</h2>
            <div className="text-xs text-gray-500">
              {e('rep_period')}: {fmtD(rep.period_start)} – {fmtD(rep.period_end)}
            </div>
          </div>
          <div className="text-right text-[11px] text-gray-500">
            {e('rep_generated')}: {fmtD(rep.generated_at)}
            <br />
            {e('rep_generated_by')} {rep.generated_by === 'system' ? e('rep_system') : rep.generated_by} · {e('customers_served')} {fmtNum(d.customers_served)}
          </div>
        </header>

        {/* ringkasan eksekutif */}
        <section>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{e('rep_narrative')}</h3>
            {canManage && !editing && (
              <div className="no-print flex gap-1">
                <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>
                  {e('rep_narrative_edit')}
                </Button>
                {has('ai.use') && (
                  <Button size="sm" variant="ghost" icon="sparkles" onClick={() => setShowAi((v) => !v)}>
                    {e('rep_narrative_ai')}
                  </Button>
                )}
              </div>
            )}
          </div>
          {editing ? (
            <div className="no-print space-y-2">
              <textarea className="input min-h-[160px] w-full text-xs" value={text} onChange={(ev) => setText(ev.target.value)} />
              <div className="flex gap-2">
                <Button size="sm" icon="check" loading={saving} onClick={() => saveNarrative(text)}>
                  {e('rep_narrative_save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setText(rep.narrative))}>
                  ✕
                </Button>
              </div>
            </div>
          ) : rep.narrative ? (
            <div className="rounded-md bg-gray-50 p-3">
              <RichText text={rep.narrative} />
              {rep.narrative_by && <div className="mt-1 text-[10px] text-gray-500">— {rep.narrative_by}</div>}
            </div>
          ) : (
            <p className="text-xs text-gray-500">{e('rep_narrative_empty')}</p>
          )}
          {showAi && !editing && (
            <div className="no-print mt-2 rounded-md border border-gray-200 p-2">
              <AiOpsPanel task="report" params={{ report_id: rep.id }} autoStart compact onUse={(v) => saveNarrative(v)} useLabel={e('rep_use_ai')} />
            </div>
          )}
        </section>

        {/* indikator */}
        <section>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={th}>{e('rep_indicator')}</th>
                <th className={`${th} text-right`}>{e('rep_this')}</th>
                <th className={`${th} text-right`}>{e('rep_prev')}</th>
                <th className={`${th} text-right`}>{e('rep_change')}</th>
                <th className={`${th} text-right`}>{e('rep_target')}</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [`SAIDI (${e('unit_saidi')})`, t.saidi, p?.saidi, fmtIdx, d.targets.saidi_period],
                  [`SAIFI (${e('unit_saifi')})`, t.saifi, p?.saifi, fmtIdx, d.targets.saifi_period],
                  [e('rep_ens_kwh'), t.ens_kwh, p?.ens_kwh, (v: number) => fmtNum(v, 1), 0],
                  [e('rep_ens_rp'), t.ens_rp, p?.ens_rp, fmtRp, 0],
                  [e('outages'), t.outages, p?.outages, (v: number) => fmtNum(v), 0],
                  [`· ${e('momentary')}`, t.momentary, p?.momentary, (v: number) => fmtNum(v), 0],
                  [e('rep_customers_out'), t.customers_out, p?.customers_out, (v: number) => fmtNum(v), 0],
                  [e('mttr'), d.mttr_min, d.previous?.mttr_min, fmtMin, 0],
                ] as [string, number, number | undefined, (v: number) => string, number][]
              ).map(([label, cur, prev, fmt, target]) => (
                <tr key={label} className="border-b border-gray-100">
                  <td className="px-2 py-1 text-gray-800">{label}</td>
                  <td className={`${td} text-right font-semibold text-gray-900`}>{fmt(cur)}</td>
                  <td className={`${td} text-right text-gray-600`}>{prev === undefined ? '-' : fmt(prev)}</td>
                  <td className={`${td} text-right`}>
                    <Delta cur={cur} prev={prev} />
                  </td>
                  <td className={`${td} text-right text-gray-600`}>
                    {target ? (
                      <span className={cur > target ? 'font-semibold text-red-600' : 'text-emerald-700'}>
                        {cur > target ? '▲ ' : '✓ '}
                        {fmt(target)}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {kinds.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-gray-900">{e('by_kind')}</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={th}>{e('rep_kind')}</th>
                  <th className={`${th} text-right`}>{e('events')}</th>
                  <th className={`${th} text-right`}>{e('rep_customers_out')}</th>
                  <th className={`${th} text-right`}>SAIDI</th>
                  <th className={`${th} text-right`}>SAIFI</th>
                  <th className={`${th} text-right`}>{e('rep_ens_rp')}</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map(([k, g]) => (
                  <tr key={k} className="border-b border-gray-100">
                    <td className="px-2 py-1 font-medium text-gray-800">{k}</td>
                    <td className={`${td} text-right`}>{fmtNum(g.outages)}</td>
                    <td className={`${td} text-right`}>{fmtNum(g.customers_out)}</td>
                    <td className={`${td} text-right`}>{fmtIdx(g.saidi)}</td>
                    <td className={`${td} text-right`}>{fmtIdx(g.saifi)}</td>
                    <td className={`${td} text-right`}>{fmtRp(g.ens_rp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-900">{e('rep_by_region')}</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={th}>{e('region')}</th>
                <th className={`${th} text-right`}>{e('reg_customers')}</th>
                <th className={`${th} text-right`}>{e('events')}</th>
                <th className={`${th} text-right`}>SAIDI</th>
                <th className={`${th} text-right`}>SAIFI</th>
                <th className={`${th} text-right`}>{e('rep_ens_rp')}</th>
              </tr>
            </thead>
            <tbody>
              {up3.map((u) => (
                <RegionRows key={u.id} up3={u} ulps={d.regions.filter((r) => r.parent_id === u.id && (r.customers > 0 || r.rel.outages > 0))} target={d.targets.saidi_period} />
              ))}
              {outside && (outside.customers > 0 || outside.rel.outages > 0) && (
                <tr className="border-b border-gray-100 text-gray-600">
                  <td className="px-2 py-1 italic">{e('rep_outside')}</td>
                  <td className={`${td} text-right`}>{fmtNum(outside.customers)}</td>
                  <td className={`${td} text-right`}>{fmtNum(outside.rel.outages)}</td>
                  <td className={`${td} text-right`}>{fmtIdx(outside.rel.saidi)}</td>
                  <td className={`${td} text-right`}>{fmtIdx(outside.rel.saifi)}</td>
                  <td className={`${td} text-right`}>{fmtRp(outside.rel.ens_rp)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {d.top_feeders.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-gray-900">{e('top_feeders')}</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={th}>{e('feeder')}</th>
                  <th className={`${th} text-right`}>{e('events')}</th>
                  <th className={`${th} text-right`}>{e('faults')}</th>
                  <th className={`${th} text-right`}>{e('momentary')}</th>
                  <th className={`${th} text-right`}>{e('cust_min')}</th>
                  <th className={`${th} text-right`}>{e('rep_ens_rp')}</th>
                </tr>
              </thead>
              <tbody>
                {d.top_feeders.map((f) => (
                  <tr key={f.id} className="border-b border-gray-100">
                    <td className="px-2 py-1 font-medium text-gray-800">{f.code}</td>
                    <td className={`${td} text-right`}>{fmtNum(f.outages)}</td>
                    <td className={`${td} text-right`}>{fmtNum(f.faults)}</td>
                    <td className={`${td} text-right`}>{fmtNum(f.momentary)}</td>
                    <td className={`${td} text-right`}>{fmtNum(f.customer_minutes, 0)}</td>
                    <td className={`${td} text-right`}>{fmtRp(f.ens_rp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {d.top_outages.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-gray-900">{e('rep_top_outages')}</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={th}>#</th>
                  <th className={th}>{e('rep_kind')}</th>
                  <th className={th}>{e('rep_cause')}</th>
                  <th className={th}>{e('rep_start')}</th>
                  <th className={`${th} text-right`}>{e('rep_duration')}</th>
                  <th className={`${th} text-right`}>{e('rep_customers')}</th>
                  <th className={`${th} text-right`}>{e('cust_min')}</th>
                </tr>
              </thead>
              <tbody>
                {d.top_outages.map((o) => (
                  <tr key={o.id} className="border-b border-gray-100">
                    <td className={`${td} text-gray-500`}>{o.id}</td>
                    <td className="px-2 py-1">
                      {o.kind}
                      {o.continuation && <span className="ml-1 text-[10px] text-gray-500">({e('rep_continuation')})</span>}
                      {o.momentary && <span className="ml-1 text-[10px] text-gray-500">({e('momentary')})</span>}
                    </td>
                    <td className="px-2 py-1">
                      <div className="font-medium text-gray-800">{o.cause_code}</div>
                      <div className="text-[10px] text-gray-500">{o.feeder}</div>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{fmtD(o.started_at)}</td>
                    <td className={`${td} text-right`}>{fmtMin(o.duration_min)}</td>
                    <td className={`${td} text-right`}>{fmtNum(o.customers)}</td>
                    <td className={`${td} text-right`}>{fmtNum(o.customer_minutes, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-900">{e('rep_ops')}</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
            {(
              [
                [e('rep_maneuvers'), `${fmtNum(d.ops.maneuvers)} (${fmtNum(d.ops.maneuvers_open)} / ${fmtNum(d.ops.maneuvers_close)})`],
                [e('rep_plans_done'), `${fmtNum(d.ops.plans_done)} (FLISR ${fmtNum(d.ops.plans_flisr)})`],
                [e('rep_soe_serious'), fmtNum(d.ops.soe_serious)],
                [e('rep_reports'), `${fmtNum(d.ops.reports)} · ${fmtNum(d.ops.reports_resolved)} ${e('rep_reports_resolved')}`],
                [e('report_sla'), slaPct === null ? '-' : `${fmtNum(slaPct, 0)}% (${fmtNum(d.ops.reports_overdue)} ${e('overdue')})`],
                [e('rep_avg_resolve'), d.ops.reports_resolved ? fmtMin(d.ops.report_avg_resolve_min) : '-'],
                [e('rep_linked'), fmtNum(d.ops.reports_linked)],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-gray-100 py-0.5">
                <dt className="text-gray-600">{k}</dt>
                <dd className="tabular-nums text-gray-900">{v}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(d.ops.report_categories || {}).length > 0 && (
            <div className="mt-1 text-[11px] text-gray-600">
              {Object.entries(d.ops.report_categories)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
            </div>
          )}
        </section>

        {d.daily && d.daily.length > 1 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-gray-900">{e('rep_daily')}</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={th}>{e('rep_start')}</th>
                  <th className={`${th} text-right`}>{e('outages')}</th>
                  <th className={`${th} text-right`}>{e('faults')}</th>
                  <th className={`${th} text-right`}>{e('rep_customers_out')}</th>
                  <th className={`${th} text-right`}>{e('cust_min')}</th>
                  <th className={`${th} text-right`}>{e('rep_ens_rp')}</th>
                </tr>
              </thead>
              <tbody>
                {d.daily.map((x) => (
                  <tr key={x.date} className="border-b border-gray-100">
                    <td className={td}>{new Date(x.date).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                    <td className={`${td} text-right`}>{fmtNum(x.outages)}</td>
                    <td className={`${td} text-right`}>{fmtNum(x.faults)}</td>
                    <td className={`${td} text-right`}>{fmtNum(x.customers_out)}</td>
                    <td className={`${td} text-right`}>{fmtNum(x.customer_minutes, 0)}</td>
                    <td className={`${td} text-right`}>{fmtRp(x.ens_rp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </article>
      <Confirm open={confirmDel} title={e('rep_delete')} message={e('rep_delete_confirm')} danger onCancel={() => setConfirmDel(false)} onConfirm={del} />
    </div>
  );
}

function RegionRows({ up3, ulps, target }: { up3: PeriodReport['regions'][number]; ulps: PeriodReport['regions']; target: number }) {
  const td = 'px-2 py-1 tabular-nums text-right';
  const warn = (v: number) => (target > 0 && v > target ? 'font-semibold text-red-600' : '');
  return (
    <>
      <tr className="border-b border-gray-100 bg-gray-50">
        <td className="px-2 py-1 font-semibold text-gray-900">UP3 {up3.name}</td>
        <td className={td}>{fmtNum(up3.customers)}</td>
        <td className={td}>{fmtNum(up3.rel.outages)}</td>
        <td className={`${td} ${warn(up3.rel.saidi)}`}>{fmtIdx(up3.rel.saidi)}</td>
        <td className={td}>{fmtIdx(up3.rel.saifi)}</td>
        <td className={td}>{fmtRp(up3.rel.ens_rp)}</td>
      </tr>
      {ulps.map((u) => (
        <tr key={u.id} className="border-b border-gray-100">
          <td className="px-2 py-1 pl-6 text-gray-700">ULP {u.name}</td>
          <td className={td}>{fmtNum(u.customers)}</td>
          <td className={td}>{fmtNum(u.rel.outages)}</td>
          <td className={`${td} ${warn(u.rel.saidi)}`}>{fmtIdx(u.rel.saidi)}</td>
          <td className={td}>{fmtIdx(u.rel.saifi)}</td>
          <td className={td}>{fmtRp(u.rel.ens_rp)}</td>
        </tr>
      ))}
    </>
  );
}
