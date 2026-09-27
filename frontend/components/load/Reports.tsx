'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { Badge, Button, Confirm, Spinner, useToast } from '@/components/ui';
import { AiOpsPanel, RichText } from '@/components/ai/AiOpsPanel';
import { LoadChart } from '@/components/charts/LoadChart';
import { BarChart } from '@/components/charts/BarChart';
import { csvRow, downloadText } from '@/components/exec/common';
import { useLoadT } from './i18n';
import { SevBadge, fmtDT, fmtMW, fmtMWh, fmtPct, lossClass, todayISO, utilClass } from './common';
import type { Anomaly, BalanceResult, DayStat, LossRow, PeriodStats, RankItem, SeriesPoint } from './types';

interface Meta {
  id: number;
  kind: 'daily' | 'monthly' | 'yearly';
  period_start: string;
  period_end: string;
  title: string;
  narrative: string;
  narrative_by: string;
  generated_by: string;
  generated_at: string;
  data?: ReportData;
}

interface GroupRow {
  level: string;
  key: string;
  name: string;
  parent?: string;
  peak_mw: number;
  peak_ts: string | null;
  energy_mwh: number;
  cap_mw: number;
  peak_util: number;
  points: number;
}

interface LossPart {
  dist: BalanceResult;
  gi: BalanceResult;
  combined_pct: number;
  coverage: { feeders: number; feeders_metered: number; gd_points: number };
  worst_feeders: LossRow[];
  high: LossRow[];
  negative: LossRow[];
  by_up3: { up3: string; e_in: number; e_out: number; pct: number; feeders: number }[];
  trafos: LossRow[];
  settings: { high: number; gi: number };
}

interface ReportData {
  kind: string;
  from: string;
  to: string;
  cap_mw: number;
  cap_pf: number;
  points: number;
  active: number;
  system: PeriodStats;
  previous: PeriodStats;
  last_year: PeriodStats;
  uid: GroupRow[];
  up3: GroupRow[];
  gi: GroupRow[];
  top_feeders: RankItem[];
  top_trafos: RankItem[];
  overloaded: RankItem[];
  gd_overloaded?: RankItem[];
  gd_count?: number;
  losses?: LossPart;
  completeness: number;
  anomaly_counts: Record<string, Record<string, number>>;
  anomalies: Anomaly[];
  settings: { warn: number; over: number };
  days?: DayStat[];
  series?: SeriesPoint[];
}

export function LoadReports({ canManage }: { canManage: boolean }) {
  const L = useLoadT();
  const toast = useToast();
  const [kind, setKind] = useState('');
  const [items, setItems] = useState<Meta[] | null>(null);
  const [sel, setSel] = useState<Meta | null>(null);
  const [gen, setGen] = useState<{ kind: string; date: string }>({ kind: 'daily', date: todayISO() });
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Meta[] }>(`/api/load/reports?kind=${kind}`)).items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [kind, toast]);
  useEffect(() => {
    load();
  }, [load]);
  const open = async (id: number) => {
    setBusy(`o${id}`);
    try {
      setSel(await api<Meta>(`/api/load/reports/${id}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const generate = async () => {
    setBusy('gen');
    try {
      const r = await api<{ id: number }>('/api/load/reports', { method: 'POST', body: gen });
      await load();
      await open(r.id);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
      <div className="no-print space-y-3">
        {canManage && (
          <div className="card space-y-2 p-3 text-xs">
            <div className="flex gap-2">
              <select className="input flex-1 text-xs" value={gen.kind} onChange={(e) => setGen({ ...gen, kind: e.target.value })}>
                {['daily', 'monthly', 'yearly'].map((k) => (
                  <option key={k} value={k}>
                    {L(`rep_${k}`)}
                  </option>
                ))}
              </select>
              <input type="date" className="input flex-1 text-xs" value={gen.date} onChange={(e) => setGen({ ...gen, date: e.target.value })} />
            </div>
            <Button size="sm" icon="plus" className="w-full" loading={busy === 'gen'} onClick={generate}>
              {L('rep_generate')}
            </Button>
          </div>
        )}
        <div className="card p-2">
          <div className="mb-2 flex flex-wrap gap-1 text-xs">
            {['', 'daily', 'monthly', 'yearly'].map((k) => (
              <button key={k || 'all'} className={`rounded px-2 py-0.5 ${kind === k ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setKind(k)}>
                {k ? L(`rep_${k}`) : L('all')}
              </button>
            ))}
          </div>
          {items === null ? (
            <Spinner size={16} />
          ) : items.length === 0 ? (
            <p className="p-2 text-xs text-gray-500">{L('rep_none')}</p>
          ) : (
            <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
              {items.map((it) => (
                <li key={it.id}>
                  <button className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${sel?.id === it.id ? 'border-brand-600 bg-brand-50' : 'border-gray-200 hover:border-gray-400'}`} onClick={() => open(it.id)}>
                    <div className="flex items-center gap-2">
                      <Badge tone={it.kind === 'yearly' ? 'purple' : it.kind === 'monthly' ? 'blue' : 'gray'}>{L(`rep_${it.kind}`)}</Badge>
                      {busy === `o${it.id}` && <Spinner size={12} />}
                    </div>
                    <div className="mt-0.5 font-medium text-gray-900">{it.title}</div>
                    <div className="text-[10px] text-gray-500">
                      {it.generated_by === 'system' ? 'otomatis' : it.generated_by} · {fmtDT(it.generated_at)}
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
          <ReportView rep={sel} canManage={canManage} onChanged={(r) => (setSel(r), load())} onDeleted={() => (setSel(null), load())} />
        ) : (
          <div className="card p-10 text-center text-sm text-gray-500">{L('rep_pick')}</div>
        )}
      </div>
    </div>
  );
}

function ReportView({ rep, canManage, onChanged, onDeleted }: { rep: Meta; canManage: boolean; onChanged: (r: Meta) => void; onDeleted: () => void }) {
  const L = useLoadT();
  const { locale } = useT();
  const { has, appName } = useAuth();
  const toast = useToast();
  const d = rep.data as ReportData;
  const [ai, setAi] = useState(false);
  const [del, setDel] = useState(false);
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const { warn, over } = d.settings;
  const th = 'px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-gray-500';
  const td = 'px-2 py-1 tabular-nums';

  const saveNarrative = async (text: string) => {
    try {
      await api(`/api/load/reports/${rep.id}/narrative`, { method: 'PUT', body: { text } });
      onChanged({ ...rep, narrative: text });
      setAi(false);
      toast.push(L('saved'), 'success');
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };
  const print = () => {
    const html = document.documentElement;
    const dark = html.classList.contains('dark');
    document.body.classList.add('exec-printing');
    if (dark) html.classList.remove('dark');
    const after = () => {
      document.body.classList.remove('exec-printing');
      if (dark) html.classList.add('dark');
      window.removeEventListener('afterprint', after);
    };
    window.addEventListener('afterprint', after);
    setTimeout(() => window.print(), 50);
  };
  const csv = () => {
    const rows: string[] = [csvRow([rep.title]), csvRow(['Periode', fmtDT(rep.period_start), fmtDT(rep.period_end)]), ''];
    rows.push(csvRow(['Indikator', 'Periode ini', 'Sebelumnya', 'Tahun lalu']));
    const s = d.system;
    for (const [k, a, b, c] of [
      ['Beban puncak (MW)', s.peak_mw, d.previous.peak_mw, d.last_year.peak_mw],
      ['Waktu puncak', fmtDT(s.peak_ts), fmtDT(d.previous.peak_ts), fmtDT(d.last_year.peak_ts)],
      ['Pembebanan puncak (%)', s.peak_util, d.previous.peak_util, d.last_year.peak_util],
      ['Energi impor (MWh)', s.energy_mwh, d.previous.energy_mwh, d.last_year.energy_mwh],
      ['Energi ekspor (MWh)', s.energy_exp_mwh, d.previous.energy_exp_mwh, d.last_year.energy_exp_mwh],
      ['Faktor beban', s.load_factor, d.previous.load_factor, d.last_year.load_factor],
    ] as [string, any, any, any][])
      rows.push(csvRow([k, typeof a === 'number' ? a.toFixed(3) : a, typeof b === 'number' ? b.toFixed(3) : b, typeof c === 'number' ? c.toFixed(3) : c]));
    for (const [title, list] of [
      ['UID', d.uid],
      ['UP3', d.up3],
      ['GI', d.gi],
    ] as [string, GroupRow[]][]) {
      rows.push('', csvRow([title, 'Puncak MW', 'Waktu', 'Daya mampu MW', 'Pembebanan %', 'Energi MWh']));
      for (const g of list) rows.push(csvRow([g.name, g.peak_mw.toFixed(3), fmtDT(g.peak_ts), g.cap_mw.toFixed(1), g.peak_util.toFixed(1), g.energy_mwh.toFixed(1)]));
    }
    rows.push('', csvRow(['Titik', 'Jenis', 'UP3 / penyulang', 'Puncak MW', 'Pembebanan %', 'Jam >= warn', 'Jam >= over', 'Faktor beban', 'Energi MWh']));
    for (const r of [...d.top_trafos, ...d.top_feeders, ...(d.gd_overloaded || [])])
      rows.push(csvRow([r.code, r.kind, r.parent || r.up3, r.peak_mw.toFixed(3), r.peak_util.toFixed(1), r.hours_over80, r.hours_over100, r.load_factor.toFixed(2), r.energy_mwh.toFixed(3)]));
    if (d.losses) {
      const l = d.losses;
      rows.push('', csvRow(['Susut', 'Energi masuk MWh', 'Energi keluar MWh', 'Susut MWh', 'Susut %', 'Cakupan %']));
      rows.push(csvRow(['Distribusi (penyulang → gardu)', l.dist.e_in.toFixed(2), l.dist.e_out.toFixed(2), l.dist.loss.toFixed(2), l.dist.pct.toFixed(2), l.dist.coverage.toFixed(1)]));
      rows.push(csvRow(['Trafo GI → penyulang', l.gi.e_in.toFixed(2), l.gi.e_out.toFixed(2), l.gi.loss.toFixed(2), l.gi.pct.toFixed(2), l.gi.coverage.toFixed(1)]));
      rows.push('', csvRow(['Penyulang', 'UP3', 'Energi MWh', 'Gardu MWh', 'Susut MWh', 'Susut %', 'Cakupan %']));
      for (const f of l.worst_feeders) rows.push(csvRow([f.code, f.up3, f.e_in.toFixed(2), f.e_out.toFixed(2), f.loss.toFixed(2), f.pct.toFixed(2), f.coverage.toFixed(1)]));
    }
    rows.push('', csvRow(['Anomali', 'Titik', 'Tingkat', 'Mulai', 'Slot']));
    for (const a of d.anomalies) rows.push(csvRow([a.kind, a.point_code, a.severity, fmtDT(a.start_ts), a.slots]));
    if (rep.narrative) rows.push('', csvRow(['Ringkasan', rep.narrative]));
    downloadText(`${rep.title.replace(/[^\w-]+/g, '_')}.csv`, rows.join('\r\n'));
  };
  const cmp = (cur: number, prev: number) => {
    if (!prev) return null;
    const g = ((cur - prev) / prev) * 100;
    return <span className={g > 0 ? 'text-red-600' : 'text-emerald-600'}>{`${g > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(g), 1)}%`}</span>;
  };
  const groupTable = (title: string, list: GroupRow[]) =>
    list.length > 0 && (
      <section>
        <h3 className="mb-1 text-sm font-semibold text-gray-900">{title}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={th}>Nama</th>
                <th className={`${th} text-right`}>{L('peak')} (MW)</th>
                <th className={`${th} text-right`}>{L('peak_time')}</th>
                <th className={`${th} text-right`}>{L('capacity')} (MW)</th>
                <th className={`${th} text-right`}>{L('util')}</th>
                <th className={`${th} text-right`}>{L('energy')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.key} className="border-b border-gray-100">
                  <td className="px-2 py-1 font-medium text-gray-800">
                    {g.name === '-' ? 'Di luar batas wilayah' : g.name}
                    {g.parent && <span className="ml-1 font-normal text-gray-500">{g.parent}</span>}
                  </td>
                  <td className={`${td} text-right`}>{fmtNum(g.peak_mw, 2)}</td>
                  <td className={`${td} text-right`}>{g.peak_ts ? new Date(g.peak_ts).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' }) : '-'}</td>
                  <td className={`${td} text-right`}>{fmtNum(g.cap_mw, 0)}</td>
                  <td className={`${td} text-right ${utilClass(g.peak_util, warn, over)}`}>{fmtPct(g.peak_util)}</td>
                  <td className={`${td} text-right`}>{fmtNum(g.energy_mwh, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  const rankTable = (title: string, list: RankItem[]) =>
    list.length > 0 && (
      <section>
        <h3 className="mb-1 text-sm font-semibold text-gray-900">{title}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={th}>Kode</th>
                <th className={th}>{list[0]?.kind === 'gd' ? L('pt_feeder') : 'UP3'}</th>
                <th className={`${th} text-right`}>{L('peak')}</th>
                <th className={`${th} text-right`}>{L('util')}</th>
                <th className={`${th} text-right`}>{L('hours80', { p: warn })}</th>
                <th className={`${th} text-right`}>{L('hours100', { p: over })}</th>
                <th className={`${th} text-right`}>{L('lf')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.point_id} className="border-b border-gray-100">
                  <td className="px-2 py-1 font-medium text-gray-800">{r.code}</td>
                  <td className="px-2 py-1 text-gray-600">{(r.kind === 'gd' ? r.parent : r.up3) || '-'}</td>
                  <td className={`${td} text-right`}>{fmtMW(r.peak_mw)}</td>
                  <td className={`${td} text-right ${utilClass(r.peak_util, warn, over)}`}>{fmtPct(r.peak_util)}</td>
                  <td className={`${td} text-right`}>{fmtNum(r.hours_over80, 1)}</td>
                  <td className={`${td} text-right`}>{fmtNum(r.hours_over100, 1)}</td>
                  <td className={`${td} text-right`}>{fmtNum(r.load_factor, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  const anomTotals = Object.entries(d.anomaly_counts || {}).map(([k, m]) => [k, Object.values(m).reduce((a, b) => a + b, 0)] as [string, number]);

  return (
    <div className="space-y-3">
      <div className="no-print flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon="download" onClick={print}>
          Cetak / PDF
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={csv}>
          CSV
        </Button>
        {canManage && has('ai.use') && (
          <Button size="sm" variant="secondary" icon="sparkles" onClick={() => setAi((v) => !v)}>
            {L('rep_ai')}
          </Button>
        )}
        {canManage && (
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(true)}>
            Hapus
          </Button>
        )}
      </div>
      {ai && (
        <div className="no-print card p-3">
          <AiOpsPanel task="report" params={{ report_id: rep.id }} autoStart compact onUse={saveNarrative} />
        </div>
      )}
      <article className="exec-report card space-y-4 p-5 text-sm">
        <header className="border-b border-gray-200 pb-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">{appName} · {L('title')}</div>
          <h2 className="text-lg font-semibold text-gray-900">{rep.title}</h2>
          <div className="text-xs text-gray-500">
            {fmtDT(rep.period_start)} – {fmtDT(rep.period_end)} · {fmtNum(d.active)} titik aktif · {L('rep_completeness')} {fmtPct(d.completeness)}
          </div>
        </header>
        {rep.narrative && (
          <section className="rounded-md bg-gray-50 p-3">
            <RichText text={rep.narrative} />
          </section>
        )}
        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-900">{L('rep_system')}</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={th}></th>
                <th className={`${th} text-right`}>Periode ini</th>
                <th className={`${th} text-right`}>{L('rep_prev')}</th>
                <th className={`${th} text-right`}>{L('rep_yoy')}</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [L('peak'), d.system.peak_mw, d.previous.peak_mw, d.last_year.peak_mw, (v: number) => `${fmtNum(v, 2)} MW`],
                  [L('util'), d.system.peak_util, d.previous.peak_util, d.last_year.peak_util, fmtPct],
                  [L('energy'), d.system.energy_mwh, d.previous.energy_mwh, d.last_year.energy_mwh, (v: number) => `${fmtNum(v, 0)} MWh`],
                  [L('energy_exp'), d.system.energy_exp_mwh, d.previous.energy_exp_mwh, d.last_year.energy_exp_mwh, (v: number) => `${fmtNum(v, 1)} MWh`],
                  [L('lf'), d.system.load_factor, d.previous.load_factor, d.last_year.load_factor, (v: number) => fmtNum(v, 2)],
                  [L('wbp'), d.system.wbp_peak_mw, d.previous.wbp_peak_mw, d.last_year.wbp_peak_mw, (v: number) => `${fmtNum(v, 2)} MW`],
                ] as [string, number, number, number, (v: number) => string][]
              ).map(([k, a, b, c, f]) => (
                <tr key={k} className="border-b border-gray-100">
                  <td className="px-2 py-1 text-gray-800">{k}</td>
                  <td className={`${td} text-right font-semibold text-gray-900`}>{f(a)}</td>
                  <td className={`${td} text-right text-gray-600`}>
                    {b ? f(b) : '-'} {cmp(a, b)}
                  </td>
                  <td className={`${td} text-right text-gray-600`}>
                    {c ? f(c) : '-'} {cmp(a, c)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-2 py-1 text-gray-800">{L('peak_time')}</td>
                <td className={`${td} text-right`}>{fmtDT(d.system.peak_ts)}</td>
                <td className={`${td} text-right text-gray-600`}>{fmtDT(d.previous.peak_ts)}</td>
                <td className={`${td} text-right text-gray-600`}>{fmtDT(d.last_year.peak_ts)}</td>
              </tr>
            </tbody>
          </table>
        </section>
        {d.series && d.series.length > 0 && (
          <LoadChart title={L('rep_system')} lines={[{ name: L('actual'), points: d.series.map((p) => ({ t: new Date(p.ts).getTime(), v: p.p })), color: 'var(--series-1)' }]} unit=" MW" height={180} />
        )}
        {d.days && d.days.length > 1 && (
          <BarChart
            title={L('daily_peaks')}
            name={L('peak')}
            labels={d.days.map((x) => x.day)}
            values={d.days.map((x) => x.peak_mw)}
            format={(v) => fmtNum(v, 1)}
            tickLabel={(l) => (d.kind === 'yearly' ? l.slice(5, 7) : l.slice(8))}
            tooltipLabel={(l) => new Date(l).toLocaleDateString(loc, { dateStyle: 'medium' })}
          />
        )}
        {groupTable(L('rep_by_uid'), d.uid)}
        {groupTable(L('rep_by_up3'), d.up3)}
        {groupTable(L('rep_by_gi'), d.gi)}
        {rankTable(L('rep_top_trafos'), d.top_trafos)}
        {rankTable(L('rep_top_feeders'), d.top_feeders)}
        {rankTable(L('rep_overloaded', { p: warn }), d.overloaded)}
        {d.gd_overloaded && rankTable(`${L('rep_gd_over', { p: warn })} (${fmtNum(d.gd_overloaded.length)} / ${fmtNum(d.gd_count || 0)})`, d.gd_overloaded)}
        {d.losses && <LossSection l={d.losses} />}
        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-900">{L('rep_anom_summary')}</h3>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {anomTotals.length === 0 ? <span className="text-gray-500">{L('none_anomaly')}</span> : anomTotals.map(([k, n]) => <span key={k}>{L(`k_${k}`)}: <b className="tabular-nums">{fmtNum(n)}</b></span>)}
          </div>
          {d.anomalies.length > 0 && (
            <ul className="space-y-1 text-xs">
              {d.anomalies.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 pb-1">
                  <SevBadge sev={a.severity} />
                  <span className="font-medium">{L(`k_${a.kind}`)}</span>
                  <span>{a.point_code}</span>
                  <span className="text-gray-500">
                    {fmtDT(a.start_ts)} · {L('slots', { n: a.slots })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>
      <Confirm open={del} title="Hapus" message="Hapus laporan ini?" danger onCancel={() => setDel(false)} onConfirm={async () => {
        try {
          await api(`/api/load/reports/${rep.id}`, { method: 'DELETE' });
          setDel(false);
          onDeleted();
        } catch (e: any) {
          toast.push(e.message, 'error');
        }
      }} />
    </div>
  );
}

function LossSection({ l }: { l: LossPart }) {
  const L = useLoadT();
  const th = 'px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-gray-500';
  const td = 'px-2 py-1 tabular-nums';
  const high = l.settings.high;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-900">{L('rep_losses')}</h3>
      {l.dist.e_in <= 0 && l.gi.e_in <= 0 ? (
        <p className="text-xs text-gray-500">{L('ls_none')}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200">
              <th className={th}></th>
              <th className={`${th} text-right`}>{L('ls_in')}</th>
              <th className={`${th} text-right`}>{L('ls_out')}</th>
              <th className={`${th} text-right`}>{L('ls_loss')}</th>
              <th className={`${th} text-right`}>%</th>
              <th className={`${th} text-right`}>{L('ls_coverage')}</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                [L('ls_gi'), l.gi, l.settings.gi],
                [L('ls_dist'), l.dist, high],
              ] as [string, BalanceResult, number][]
            ).map(([k, b, lim]) => (
              <tr key={k} className="border-b border-gray-100">
                <td className="px-2 py-1 text-gray-800">{k}</td>
                <td className={`${td} text-right`}>{b.e_in > 0 ? fmtMWh(b.e_in) : '-'}</td>
                <td className={`${td} text-right`}>{b.e_in > 0 ? fmtMWh(b.e_out) : '-'}</td>
                <td className={`${td} text-right`}>{b.e_in > 0 ? fmtMWh(b.loss) : '-'}</td>
                <td className={`${td} text-right ${b.e_in > 0 ? lossClass(Math.abs(b.pct), lim) : ''}`}>{b.e_in > 0 ? fmtPct(b.pct) : '-'}</td>
                <td className={`${td} text-right`}>{b.e_in > 0 ? fmtPct(b.coverage) : '-'}</td>
              </tr>
            ))}
            <tr>
              <td className="px-2 py-1 font-medium text-gray-900">{L('ls_combined')}</td>
              <td colSpan={3}></td>
              <td className={`${td} text-right font-semibold`}>{fmtPct(l.combined_pct)}</td>
              <td className={`${td} text-right text-gray-500`}>{L('ls_feeders_metered', { a: l.coverage.feeders_metered, b: l.coverage.feeders })}</td>
            </tr>
          </tbody>
        </table>
      )}
      {l.by_up3.length > 0 && (
        <div className="overflow-x-auto">
          <h4 className="mb-1 text-xs font-semibold text-gray-800">{L('rep_losses_up3')}</h4>
          <table className="w-full min-w-[420px] text-xs">
            <tbody>
              {l.by_up3.map((u) => (
                <tr key={u.up3} className="border-b border-gray-100">
                  <td className="px-2 py-1 text-gray-800">{u.up3 === '-' ? 'Di luar batas wilayah' : u.up3}</td>
                  <td className={`${td} text-right`}>{fmtMWh(u.e_in)}</td>
                  <td className={`${td} text-right`}>{fmtMWh(u.e_in - u.e_out)}</td>
                  <td className={`${td} text-right ${lossClass(u.pct, high)}`}>{fmtPct(u.pct)}</td>
                  <td className={`${td} text-right text-gray-500`}>{u.feeders} penyulang</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {l.worst_feeders.some((f) => f.valid_days > 0) && (
        <div className="overflow-x-auto">
          <h4 className="mb-1 text-xs font-semibold text-gray-800">{L('rep_losses_high')}</h4>
          <table className="w-full min-w-[520px] text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={th}>{L('level_feeder')}</th>
                <th className={`${th} text-right`}>{L('ls_in')}</th>
                <th className={`${th} text-right`}>{L('ls_out')}</th>
                <th className={`${th} text-right`}>{L('ls_loss')}</th>
                <th className={`${th} text-right`}>%</th>
                <th className={`${th} text-right`}>{L('ls_coverage')}</th>
              </tr>
            </thead>
            <tbody>
              {l.worst_feeders
                .filter((f) => f.valid_days > 0)
                .map((f) => (
                  <tr key={f.point_id} className="border-b border-gray-100">
                    <td className="px-2 py-1 font-medium text-gray-800">
                      {f.code} <span className="font-normal text-gray-500">{f.up3}</span>
                    </td>
                    <td className={`${td} text-right`}>{fmtMWh(f.e_in)}</td>
                    <td className={`${td} text-right`}>{fmtMWh(f.e_out)}</td>
                    <td className={`${td} text-right`}>{fmtMWh(f.loss)}</td>
                    <td className={`${td} text-right ${lossClass(f.pct, high)}`}>{fmtPct(f.pct)}</td>
                    <td className={`${td} text-right`}>{fmtPct(f.coverage)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
