'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, api, getToken } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtNum, fmtVA } from '@/lib/format';
import { Badge, Button, Confirm, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { LoadChart } from '@/components/charts/LoadChart';
import { BarChart } from '@/components/charts/BarChart';
import { StatCard, fmtDT, fmtPct, lossClass } from './common';
import { useCLT } from './i18nCustomer';

interface GRow {
  gd_id: number;
  code: string;
  name: string;
  feeder_id?: number;
  feeder_code?: string;
  up3?: string;
  ulp?: string;
  point_id?: number;
  energy_kwh: number;
  energy_measured_kwh: number;
  days: number;
  valid_days: number;
  sold_kwh: number;
  billed: number;
  customers: number;
  billed_pct: number;
  zero_kwh: number;
  loss_kwh: number;
  pct: number;
  status: string;
  flag?: string;
}
interface FRow {
  feeder_id: number;
  code: string;
  up3?: string;
  gds: number;
  gds_valid: number;
  energy_kwh: number;
  sold_kwh: number;
  loss_kwh: number;
  pct: number;
  high: number;
}
interface Resp {
  period: string;
  energy_period: string;
  lag: number;
  partial: boolean;
  summary: Record<string, number | null>;
  feeders: FRow[];
  items: GRow[];
  total: number;
  offset: number;
  limit: number;
  unmatched: number;
  unmatched_kwh: number;
  no_gd: number;
  no_gd_kwh: number;
  up3s: string[];
  ulps: string[];
  settings: {
    high: number;
    min_billed: number;
    min_days: number;
    low_hours: number;
  };
}
interface Imp {
  id: number;
  period: string;
  file_name: string;
  rows: number;
  matched: number;
  unmatched: number;
  errors: number;
  total_kwh: number;
  replaced: boolean;
  imported_by: string;
  imported_at: string;
}
interface Preview {
  format: string;
  columns: string[];
  lines: number;
  rows: number;
  merged: number;
  n_errors: number;
  errors: { line: number; idpel?: string; reason: string }[];
  periods: {
    period: string;
    rows: number;
    kwh: number;
    matched: number;
    unmatched: number;
    existing: number;
    gds: number;
  }[];
  matched_by: Record<string, number>;
  unmatched: { line: number; idpel: string; kwh: number; name?: string }[];
  total_kwh: number;
  applied: boolean;
}

const STATUS_TONE: Record<string, 'green' | 'blue' | 'amber' | 'gray' | 'red'> = {
  ok: 'green',
  estimasi: 'blue',
  tagihan_kurang: 'amber',
  energi_kurang: 'amber',
  tanpa_meter: 'gray',
};
const PAGE = 100;

const kwh = (v: number | null | undefined) =>
  v === null || v === undefined ? '-' : Math.abs(v) >= 1e6 ? `${fmtNum(v / 1e6, 2)} GWh` : Math.abs(v) >= 1e4 ? `${fmtNum(v / 1e3, 1)} MWh` : `${fmtNum(v, 0)} kWh`;

function prevMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function download(path: string, name: string) {
  const buf = await api<ArrayBuffer>(path, { raw: true });
  const url = URL.createObjectURL(new Blob([buf], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function CustomerLosses({ canManage, onOpenPoint }: { canManage: boolean; onOpenPoint: (id: string) => void }) {
  const C = useCLT();
  const { locale } = useT();
  const toast = useToast();
  const [periods, setPeriods] = useState<{ period: string; rows: number; matched: number; kwh: number }[] | null>(null);
  const [imports, setImports] = useState<Imp[]>([]);
  const [period, setPeriod] = useState('');
  const [up3, setUp3] = useState('');
  const [ulp, setUlp] = useState('');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [status, setStatus] = useState('all');
  const [lag, setLag] = useState(''); // '' = bawaan konfigurasi load.lv_billing_lag_months
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({
    key: 'pct',
    desc: true,
  });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [allFeeders, setAllFeeders] = useState(false);
  const [sel, setSel] = useState<GRow | null>(null);
  const [showImport, setShowImport] = useState(false);
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const monthName = (p: string) =>
    new Date(`${p}-01T00:00:00`).toLocaleDateString(loc, {
      month: 'long',
      year: 'numeric',
    });

  const loadMeta = useCallback(async () => {
    try {
      const r = await api<{
        periods: {
          period: string;
          rows: number;
          matched: number;
          kwh: number;
        }[];
        imports: Imp[];
      }>('/api/load/customer-kwh');
      setPeriods(r.periods);
      setImports(r.imports);
      setPeriod((p) => (p && r.periods.some((x) => x.period === p) ? p : r.periods[0]?.period || ''));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setPeriods([]);
    }
  }, [toast]);
  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const qs = new URLSearchParams({
        period,
        sort: sort.key,
        dir: sort.desc ? 'desc' : 'asc',
        offset: String(offset),
        limit: String(PAGE),
        ...extra,
      });
      if (up3) qs.set('up3', up3);
      if (ulp) qs.set('ulp', ulp);
      if (qApplied) qs.set('q', qApplied);
      if (status !== 'all') qs.set('status', status);
      if (lag !== '') qs.set('lag', lag);
      return qs;
    },
    [period, sort, offset, up3, ulp, qApplied, status, lag],
  );

  const load = useCallback(async () => {
    if (!period) return setData(null);
    setBusy(true);
    try {
      setData(await api<Resp>(`/api/load/losses/customers?${query()}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [period, query, toast]);
  useEffect(() => {
    load();
  }, [load]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOffset(0);
  }, [period, up3, ulp, qApplied, status, sort, lag]);

  const s = data?.summary;
  const high = data?.settings.high ?? 10;
  const sortHead = (key: string, label: string, right = true) => (
    <th
      className={`cursor-pointer select-none py-1.5 ${right ? 'text-right' : ''}`}
      onClick={() =>
        setSort((x) => ({
          key,
          desc: x.key === key ? !x.desc : key !== 'code',
        }))
      }
    >
      {label} {sort.key === key ? (sort.desc ? '↓' : '↑') : ''}
    </th>
  );
  const feeders = data ? (allFeeders ? data.feeders : data.feeders.slice(0, 10)) : [];

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600">
        {C('hint', {
          d: data?.settings.min_days ?? 80,
          b: data?.settings.min_billed ?? 90,
        })}
      </p>

      <div className="card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-gray-600">{C('period')}</label>
          <select className="input !w-auto text-xs" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label={C('period')} disabled={!periods?.length}>
            {(periods || []).map((p) => (
              <option key={p.period} value={p.period}>
                {monthName(p.period)} · {fmtNum(p.rows)}
              </option>
            ))}
          </select>
          <label className="text-gray-600">{C('lag')}</label>
          <select className="input !w-auto text-xs" value={lag !== '' ? lag : String(data?.lag ?? 0)} onChange={(e) => setLag(e.target.value)} aria-label={C('lag')}>
            {[0, 1, 2].map((n) => (
              <option key={n} value={String(n)}>
                {C(`lag_${n}`)}
              </option>
            ))}
          </select>
          <select className="input !w-auto text-xs" value={up3} onChange={(e) => (setUp3(e.target.value), setUlp(''))} aria-label="UP3">
            <option value="">{C('all_up3')}</option>
            {(data?.up3s || []).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select className="input !w-auto text-xs" value={ulp} onChange={(e) => setUlp(e.target.value)} aria-label="ULP">
            <option value="">{C('all_ulp')}</option>
            {(data?.ulps || []).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQApplied(q.trim());
            }}
          >
            <input className="input !w-52 text-xs" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setQApplied(q.trim())} placeholder={C('search')} aria-label={C('search')} />
          </form>
          <select className="input !w-auto text-xs" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={C('status')}>
            {['all', 'valid', 'tinggi', 'negatif', 'ok', 'estimasi', 'tagihan_kurang', 'energi_kurang', 'tanpa_meter'].map((k) => (
              <option key={k} value={k}>
                {C(`st_${k}`)}
              </option>
            ))}
          </select>
          {busy && <Spinner size={14} />}
          <span className="ml-auto" />
          {data && (
            <Button
              size="sm"
              variant="ghost"
              icon="download"
              onClick={() => download(`/api/load/losses/customers?${query({ format: 'csv' })}`, `susut-gardu-pelanggan-${period}.csv`).catch((e) => toast.push(e.message, 'error'))}
            >
              {C('csv')}
            </Button>
          )}
          {canManage && (
            <Button size="sm" variant={showImport ? 'secondary' : 'primary'} icon="plus" onClick={() => setShowImport((v) => !v)}>
              {showImport ? C('imp_close') : C('imp_open')}
            </Button>
          )}
        </div>
      </div>

      {canManage && showImport && (
        <ImportPanel
          imports={imports}
          defPeriod={period || prevMonth()}
          onDone={(p) => {
            loadMeta().then(() => p && setPeriod(p));
            setOffset(0);
            setTimeout(load, 300);
          }}
        />
      )}

      {periods && periods.length === 0 && <div className="card p-6 text-center text-sm text-gray-500">{C('no_period')}</div>}

      {data?.partial && <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{C('partial')}</div>}

      {s && data && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
            <StatCard label={C('c_loss')} value={s.pct !== null ? <span className={lossClass(s.pct as number, high)}>{fmtPct(s.pct as number)}</span> : '-'} sub={kwh(s.loss_kwh)} />
            <StatCard label={C('c_energy')} value={kwh(s.energy_kwh)} sub={data.energy_period ? C('energy_of', { m: monthName(data.energy_period) }) : undefined} />
            <StatCard label={C('c_sold')} value={kwh(s.sold_kwh)} sub={`Σ ${kwh(s.sold_all_kwh)}`} />
            <StatCard
              label={C('c_gds')}
              value={`${fmtNum(s.gds_valid)} / ${fmtNum(s.gds)}`}
              sub={`${C('c_estimated', { n: fmtNum(s.gds_estimated) })} · ${C('c_no_meter', { a: fmtNum(s.gds_no_meter), b: fmtNum(s.gds_low_billing), c: fmtNum(s.gds_low_energy) })}`}
            />
            <StatCard
              label={C('c_flags')}
              value={
                <span>
                  <span className={s.gds_high ? 'text-red-600' : ''}>{fmtNum(s.gds_high)}</span> / <span className={s.gds_negative ? 'text-amber-600' : ''}>{fmtNum(s.gds_negative)}</span>
                </span>
              }
              sub={`≥ ${fmtNum(high)}% · < 0%`}
            />
            <StatCard label={C('c_billing')} value={`${fmtNum(s.billed)} / ${fmtNum(s.customers)}`} sub={C('c_zero', { n: fmtNum(s.zero_kwh) })} />
            <StatCard
              label={C('c_unmatched')}
              value={fmtNum(data.unmatched)}
              sub={
                <span>
                  {kwh(data.unmatched_kwh)}
                  {data.unmatched > 0 && (
                    <button
                      className="ml-1 text-brand-700 hover:underline"
                      onClick={() => download(`/api/load/customer-kwh/unmatched?period=${period}&format=csv`, `idpel-tidak-ditemukan-${period}.csv`).catch((e) => toast.push(e.message, 'error'))}
                    >
                      {C('unmatched_csv')}
                    </button>
                  )}
                </span>
              }
            />
          </div>
          {data.no_gd > 0 && <p className="text-[11px] text-gray-500">{C('c_no_gd', { n: fmtNum(data.no_gd), k: kwh(data.no_gd_kwh) })}</p>}

          {sel && <GarduDetail period={period} lag={data.lag} row={sel} onClose={() => setSel(null)} onOpenPoint={onOpenPoint} />}

          <div className="grid gap-4 2xl:grid-cols-[1fr,520px]">
            <div className="card p-3">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">{C('gds')}</h3>
                <span className="ml-auto text-xs text-gray-500">{fmtNum(data.total)}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                      {sortHead('code', C('gd'), false)}
                      <th className="py-1.5">{C('feeder')}</th>
                      <th className="py-1.5">{C('ulp')}</th>
                      {sortHead('energy', C('energy'))}
                      {sortHead('sold', C('sold'))}
                      {sortHead('billed', C('billed'))}
                      <th className="py-1.5 text-right">{C('zero')}</th>
                      {sortHead('loss', C('loss'))}
                      {sortHead('pct', C('pct'))}
                      <th className="py-1.5 pl-3">{C('status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((r) => (
                      <tr key={r.gd_id} className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${sel?.gd_id === r.gd_id ? 'bg-brand-50' : ''}`} onClick={() => setSel(r)}>
                        <td className="py-1.5">
                          <div className="font-mono text-[11px] font-medium text-gray-900">{r.code || `#${r.gd_id}`}</div>
                          <div className="max-w-[14rem] truncate text-gray-500" title={r.name}>
                            {r.name}
                          </div>
                        </td>
                        <td className="py-1.5 font-mono text-[11px] text-gray-700">{r.feeder_code || '-'}</td>
                        <td className="max-w-[9rem] truncate py-1.5 text-gray-700" title={r.ulp}>
                          {r.ulp || '-'}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          <div className="text-gray-900">{r.point_id ? kwh(r.energy_kwh) : '-'}</div>
                          {r.point_id ? <div className="text-[10px] text-gray-500">{C('days', { v: r.valid_days, d: r.days })}</div> : null}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-gray-900">{kwh(r.sold_kwh)}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          <div className={r.billed_pct < (data.settings.min_billed ?? 90) ? 'text-amber-700' : 'text-gray-900'}>{fmtPct(r.billed_pct)}</div>
                          <div className="text-[10px] text-gray-500">
                            {fmtNum(r.billed)} / {fmtNum(r.customers)}
                          </div>
                        </td>
                        <td className={`py-1.5 text-right tabular-nums ${r.zero_kwh ? 'text-amber-700' : 'text-gray-500'}`}>{fmtNum(r.zero_kwh)}</td>
                        <td className="py-1.5 text-right tabular-nums text-gray-900">{r.point_id && r.energy_kwh > 0 ? kwh(r.loss_kwh) : '-'}</td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">
                          {r.point_id && r.energy_kwh > 0 ? <span className={r.status === 'ok' || r.status === 'estimasi' ? lossClass(r.pct, high) : 'text-gray-400'}>{fmtPct(r.pct)}</span> : '-'}
                        </td>
                        <td className="py-1.5 pl-3">
                          <span className="flex flex-wrap items-center gap-1">
                            <Badge tone={STATUS_TONE[r.status] || 'gray'}>{C(`st_${r.status}`)}</Badge>
                            {r.flag && <Badge tone={r.flag === 'tinggi' ? 'red' : 'amber'}>{C(`fl_${r.flag}`)}</Badge>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.items.length === 0 && <p className="py-8 text-center text-sm text-gray-500">{C('empty')}</p>}
              </div>
              {data.total > PAGE && (
                <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-600">
                  <span>
                    {C('rows', {
                      from: fmtNum(offset + 1),
                      to: fmtNum(Math.min(offset + PAGE, data.total)),
                      total: fmtNum(data.total),
                    })}
                  </span>
                  <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    {C('prev')}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                    {C('next')}
                  </Button>
                </div>
              )}
            </div>

            <div className="card h-fit p-3">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">{C('feeders')}</h3>
                {data.feeders.length > 10 && (
                  <button className="ml-auto text-xs text-brand-700 hover:underline" onClick={() => setAllFeeders((v) => !v)}>
                    {allFeeders ? C('show_less') : C('show_all')} ({fmtNum(data.feeders.length)})
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                      <th className="py-1">{C('feeder')}</th>
                      <th className="py-1 text-right">{C('n_gds')}</th>
                      <th className="py-1 text-right">{C('energy')}</th>
                      <th className="py-1 text-right">{C('pct')}</th>
                      <th className="py-1 text-right">{C('high_n')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feeders.map((f) => (
                      <tr key={f.feeder_id} className="border-b border-gray-100">
                        <td className="py-1 font-mono text-[11px] text-gray-900">{f.code || `#${f.feeder_id}`}</td>
                        <td className="py-1 text-right tabular-nums text-gray-700">
                          {fmtNum(f.gds_valid)} / {fmtNum(f.gds)}
                        </td>
                        <td className="py-1 text-right tabular-nums text-gray-700">{kwh(f.energy_kwh)}</td>
                        <td className="py-1 text-right font-semibold tabular-nums">
                          <span className={lossClass(f.pct, high)}>{fmtPct(f.pct)}</span>
                        </td>
                        <td className={`py-1 text-right tabular-nums ${f.high ? 'text-red-600' : 'text-gray-500'}`}>{fmtNum(f.high)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- impor

function ImportPanel({ imports, defPeriod, onDone }: { imports: Imp[]; defPeriod: string; onDone: (period?: string) => void }) {
  const C = useCLT();
  const { locale } = useT();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [period, setPeriod] = useState(defPeriod);
  const [replace, setReplace] = useState(false);
  const [prev, setPrev] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [del, setDel] = useState<Imp | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (apply: boolean) => {
    if (!file) return;
    setBusy(apply ? 'apply' : 'preview');
    try {
      const qs = new URLSearchParams({
        period,
        apply: apply ? '1' : '0',
        replace: replace ? '1' : '0',
        name: file.name,
      });
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/load/customer-kwh/import?${qs}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Lang': locale,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: file,
      });
      const j = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(j.error || res.statusText);
      setPrev(j);
      if (apply) {
        toast.push(C('imp_saved', { n: fmtNum(j.rows) }), 'success');
        onDone(j.periods?.[0]?.period);
        setFile(null);
        setPrev(null);
        if (fileRef.current) fileRef.current.value = '';
      }
    } catch (e: any) {
      toast.push(e.message, 'error');
      if (!apply) setPrev(null);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="card space-y-3 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{C('imp_title')}</h3>
        <button
          className="ml-auto text-brand-700 hover:underline"
          onClick={() => download('/api/load/customer-kwh/template', 'template-kwh-pelanggan.csv').catch((e) => toast.push(e.message, 'error'))}
        >
          <Icon name="download" size={12} className="mr-1 inline" />
          {C('imp_template')}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">{C('imp_hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.xlsx"
          className="text-xs text-gray-700 file:mr-2 file:rounded-md file:border file:border-gray-300 file:bg-white file:px-2 file:py-1 file:text-xs file:text-gray-800"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setPrev(null);
          }}
          aria-label={C('imp_file')}
        />
        <label className="flex items-center gap-1 text-gray-600">
          {C('imp_period')}
          <input type="month" className="input !w-auto text-xs" value={period} onChange={(e) => (setPeriod(e.target.value), setPrev(null))} />
        </label>
        <label className="flex items-center gap-1 text-gray-700">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          {C('imp_replace')}
        </label>
        <Button size="sm" variant="secondary" icon="eye" disabled={!file} loading={busy === 'preview'} onClick={() => send(false)}>
          {C('imp_preview')}
        </Button>
        {prev && prev.rows > 0 && (
          <Button size="sm" icon="check" loading={busy === 'apply'} onClick={() => send(true)}>
            {C('imp_apply', { n: fmtNum(prev.rows) })}
          </Button>
        )}
      </div>

      {prev && (
        <div className="space-y-2 rounded-md border border-gray-200 p-2">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <StatCard label={C('imp_lines')} value={fmtNum(prev.lines)} sub={prev.format.toUpperCase()} />
            <StatCard label={C('imp_valid')} value={fmtNum(prev.rows)} sub={prev.merged ? `${C('imp_merged')}: ${fmtNum(prev.merged)}` : undefined} />
            <StatCard label={C('imp_errors')} value={<span className={prev.n_errors ? 'text-red-600' : ''}>{fmtNum(prev.n_errors)}</span>} />
            <StatCard label={C('imp_total')} value={kwh(prev.total_kwh)} />
            <StatCard
              label={C('imp_matched')}
              value={fmtNum(Object.values(prev.matched_by).reduce((a, b) => a + b, 0))}
              sub={C('imp_by', {
                v:
                  Object.entries(prev.matched_by)
                    .map(([k, v]) => `${k} ${fmtNum(v)}`)
                    .join(' · ') || '-',
              })}
            />
          </div>
          <div className="text-[10px] text-gray-500">{prev.columns.join(' · ')}</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <th className="py-1">{C('imp_periods')}</th>
                <th className="py-1 text-right">{C('imp_valid')}</th>
                <th className="py-1 text-right">kWh</th>
                <th className="py-1 text-right">{C('imp_matched')}</th>
                <th className="py-1 text-right">{C('imp_unmatched')}</th>
                <th className="py-1 text-right">{C('imp_gds')}</th>
                <th className="py-1 text-right">{C('imp_existing')}</th>
              </tr>
            </thead>
            <tbody>
              {prev.periods.map((p) => (
                <tr key={p.period} className="border-b border-gray-100">
                  <td className="py-1 font-medium text-gray-900">{p.period}</td>
                  <td className="py-1 text-right tabular-nums">{fmtNum(p.rows)}</td>
                  <td className="py-1 text-right tabular-nums">{kwh(p.kwh)}</td>
                  <td className="py-1 text-right tabular-nums text-emerald-700">{fmtNum(p.matched)}</td>
                  <td className={`py-1 text-right tabular-nums ${p.unmatched ? 'text-amber-700' : ''}`}>{fmtNum(p.unmatched)}</td>
                  <td className="py-1 text-right tabular-nums">{fmtNum(p.gds)}</td>
                  <td className={`py-1 text-right tabular-nums ${p.existing ? 'text-amber-700' : 'text-gray-500'}`}>{fmtNum(p.existing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-2 md:grid-cols-2">
            {prev.errors.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-gray-800">
                  {C('imp_err_list')} ({fmtNum(prev.n_errors)})
                </div>
                <div className="max-h-40 overflow-y-auto">
                  {prev.errors.map((e, i) => (
                    <div key={i} className="border-b border-gray-100 py-0.5 text-red-700">
                      {C('imp_line')} {e.line}
                      {e.idpel ? ` · ${e.idpel}` : ''}: {e.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {prev.unmatched.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-gray-800">{C('imp_unmatched_list')}</div>
                <div className="max-h-40 overflow-y-auto">
                  {prev.unmatched.map((u, i) => (
                    <div key={i} className="flex justify-between border-b border-gray-100 py-0.5 text-gray-700">
                      <span className="font-mono">{u.idpel}</span>
                      <span className="tabular-nums">{fmtNum(u.kwh)} kWh</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {imports.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-gray-800">{C('imp_history')}</div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1">{C('period')}</th>
                  <th className="py-1">{C('imp_file_col')}</th>
                  <th className="py-1 text-right">{C('imp_valid')}</th>
                  <th className="py-1 text-right">{C('imp_matched')}</th>
                  <th className="py-1 text-right">kWh</th>
                  <th className="py-1 pl-3">{C('imp_by_col')}</th>
                  <th className="py-1">{C('imp_at')}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {imports.map((m) => (
                  <tr key={m.id} className="border-b border-gray-100">
                    <td className="py-1 text-gray-900">{m.period.slice(0, 7)}</td>
                    <td className="max-w-[12rem] truncate py-1 text-gray-700" title={m.file_name}>
                      {m.file_name || '-'}
                      {m.replaced ? ' ↻' : ''}
                    </td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(m.rows)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(m.matched)}</td>
                    <td className="py-1 text-right tabular-nums">{kwh(m.total_kwh)}</td>
                    <td className="py-1 pl-3 text-gray-700">{m.imported_by}</td>
                    <td className="py-1 text-gray-500">{fmtDT(m.imported_at)}</td>
                    <td className="py-1 text-right">
                      <button className="text-gray-400 hover:text-red-600" title={C('imp_delete')} aria-label={C('imp_delete')} onClick={() => setDel(m)}>
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <Confirm
        open={!!del}
        title={C('imp_delete')}
        message={
          del
            ? C('imp_delete_msg', {
                f: del.file_name || `#${del.id}`,
                p: del.period.slice(0, 7),
              })
            : ''
        }
        loading={busy === 'del'}
        onCancel={() => setDel(null)}
        onConfirm={async () => {
          if (!del) return;
          setBusy('del');
          try {
            const r = await api<{ deleted: number }>(`/api/load/customer-kwh/imports/${del.id}`, { method: 'DELETE' });
            toast.push(C('imp_deleted', { n: fmtNum(r.deleted) }), 'success');
            setDel(null);
            onDone();
          } catch (e: any) {
            toast.push(e.message, 'error');
          } finally {
            setBusy('');
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- rincian gardu

interface Detail {
  gardu: GRow;
  customers: {
    id: number;
    code: string;
    name: string;
    idpel: string;
    tarif: string;
    daya_va: number;
    kwh: number | null;
    hours: number | null;
    flag?: string;
  }[];
  trend: {
    period: string;
    energy_kwh: number | null;
    sold_kwh: number | null;
    pct: number | null;
    valid_days: number;
    days: number;
  }[];
  settings: { high: number; low_hours: number };
}

function GarduDetail({ period, lag, row, onClose, onOpenPoint }: { period: string; lag: number; row: GRow; onClose: () => void; onOpenPoint: (id: string) => void }) {
  const C = useCLT();
  const { locale } = useT();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => {
    setD(null);
    api<Detail>(`/api/load/losses/customers/gd?period=${period}&gd=${row.gd_id}&lag=${lag}`)
      .then(setD)
      .catch((e) => toast.push(e.message, 'error'));
  }, [period, lag, row.gd_id, toast]);
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const t = (p: string) => new Date(`${p}-01T00:00:00`).getTime();
  const flagged = useMemo(() => (d ? d.customers.filter((c) => c.flag).length : 0), [d]);

  return (
    <div className="card space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{C('d_title', { c: row.code })}</h3>
        <span className="text-xs text-gray-500">
          {row.name} · {row.feeder_code} · {row.ulp}
        </span>
        <span className="ml-auto flex gap-1">
          <a className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:bg-gray-50" href={`/monitoring?select=node:${row.gd_id}`}>
            <Icon name="map" size={12} /> {C('d_map')}
          </a>
          {row.point_id ? (
            <Button size="sm" variant="secondary" icon="chart" onClick={() => onOpenPoint(String(row.point_id))}>
              AMR
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="x" onClick={onClose} title={C('d_close')} />
        </span>
      </div>
      {!d ? (
        <Spinner size={18} />
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <LoadChart
              title={C('d_trend')}
              lines={[
                {
                  name: C('d_energy_line'),
                  points: d.trend.map((p) => ({
                    t: t(p.period),
                    v: p.energy_kwh === null ? null : p.energy_kwh / 1000,
                  })),
                  color: 'var(--series-1)',
                  width: 2.5,
                },
                {
                  name: C('d_sold_line'),
                  points: d.trend.map((p) => ({
                    t: t(p.period),
                    v: p.sold_kwh === null ? null : p.sold_kwh / 1000,
                  })),
                  color: 'var(--series-2)',
                  dashed: true,
                },
              ]}
              unit=" MWh"
              height={200}
              maxGap={40 * 86400000}
              snap={15 * 86400000}
              xFormat={(v) => new Date(v).toLocaleDateString(loc, { month: 'short' })}
              tipFormat={(v) =>
                new Date(v).toLocaleDateString(loc, {
                  month: 'long',
                  year: 'numeric',
                })
              }
              format={(v) => fmtNum(v, 2)}
            />
            <BarChart
              title={C('d_trend_pct')}
              labels={d.trend.map((p) => p.period)}
              values={d.trend.map((p) => (p.pct === null ? 0 : Math.round(p.pct * 10) / 10))}
              reference={{
                value: d.settings.high,
                label: `${fmtNum(d.settings.high)}%`,
              }}
              height={200}
              format={(v) => `${fmtNum(v, 1)}%`}
              tickLabel={(l) =>
                new Date(`${l}-01T00:00:00`).toLocaleDateString(loc, {
                  month: 'short',
                })
              }
            />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs">
              <span className="font-semibold text-gray-900">{C('d_customers', { n: fmtNum(d.customers.length) })}</span>
              {flagged > 0 && <Badge tone="amber">{fmtNum(flagged)}</Badge>}
              <span className="text-[11px] text-gray-500">{C('d_flag_hint', { h: fmtNum(d.settings.low_hours) })}</span>
            </div>
            <div className="max-h-80 overflow-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                    <th className="py-1">{C('d_code')}</th>
                    <th className="py-1">{C('d_idpel')}</th>
                    <th className="py-1">{C('d_tarif')}</th>
                    <th className="py-1 text-right">{C('d_daya')}</th>
                    <th className="py-1 text-right">{C('d_kwh')}</th>
                    <th className="py-1 text-right">{C('d_hours')}</th>
                    <th className="py-1 pl-3">{C('d_flag')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.customers.map((c) => (
                    <tr key={c.id} className="border-b border-gray-100">
                      <td className="py-1">
                        <span className="font-mono text-[11px] text-gray-900">{c.code}</span> <span className="text-gray-500">{c.name}</span>
                      </td>
                      <td className="py-1 font-mono text-[11px] text-gray-700">{c.idpel || '-'}</td>
                      <td className="py-1 text-gray-700">{c.tarif || '-'}</td>
                      <td className="py-1 text-right tabular-nums text-gray-700">{c.daya_va ? fmtVA(c.daya_va) : '-'}</td>
                      <td className="py-1 text-right tabular-nums text-gray-900">{c.kwh === null ? '-' : fmtNum(c.kwh, 0)}</td>
                      <td className="py-1 text-right tabular-nums text-gray-700">{c.hours === null ? '-' : fmtNum(c.hours, 0)}</td>
                      <td className="py-1 pl-3">{c.flag && <Badge tone={c.flag === 'rendah' || c.flag === 'melebihi_daya' ? 'amber' : 'red'}>{C(`f_${c.flag}`)}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
