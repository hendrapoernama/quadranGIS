'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { fmtNum, fmtVA } from '@/lib/format';
import { realtime } from '@/lib/ws';
import type { ReliabilityGroup } from '@/lib/types';
import { Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { fmtIdx, fmtRp } from './common';
import { custLabelZoom, GI_COLOR, InfographicMap, KIND_COLOR, NET_COLOR, OFF_COLOR, ON_COLOR, type InfoGI, type InfoPoint, type InfoTarget, type OffNetwork } from './InfographicMap';
import { useInfoT } from './infographicI18n';
import { usePageBanner } from '@/components/PageBanner';
import { BigTile, CardTitle, Pill, SectionTitle, SplitCard } from './InfoWidgets';

interface Count {
  terdampak: number;
  padam: number;
  nyala: number;
}
interface InfoEvent {
  id: number;
  root_id: number;
  parent_id: number | null;
  kind: string;
  level: string;
  cause_code: string;
  cause_type: string;
  started_at: string;
  ended_at: string | null;
  customers: number;
  load_mw: number;
  momentary: boolean;
}
interface InfoObj {
  event_id: number;
  id: number;
  code: string;
  name: string;
  up3: string;
  started_at: string;
  ended_at: string | null;
  minutes: number;
  active: boolean;
  type?: string;
  priority?: string;
  address?: string;
  gd_code?: string;
  feeder_code?: string;
  /** daya pelanggan / kapasitas trafo (VA) */
  power_va?: number;
}
interface InfoUP3 {
  id: number;
  name: string;
  customers: number;
  gd: Count;
  rel: ReliabilityGroup;
}
interface InfoResp {
  from: string;
  to: string;
  at: string;
  org: { uid: string; up2d: string };
  roots: {
    id: number;
    kind: string;
    cause_code: string;
    started_at: string;
    active: boolean;
  }[];
  kinds: Record<string, number>;
  levels: Record<'beban' | 'gi' | 'trafo_gi' | 'penyulang' | 'zona' | 'gd' | 'pelanggan', Count>;
  rel: ReliabilityGroup;
  events: InfoEvent[];
  priority: Record<string, Count>;
  up3: InfoUP3[];
  /** jumlah baris log sebelum dibatasi 300 */
  log_totals?: Record<string, number>;
  customers_total: number;
  map: {
    gd: InfoPoint[];
    tgi?: InfoPoint[];
    causes: InfoPoint[];
    gi: InfoGI[];
    truncated: boolean;
  } & OffNetwork;
  pending_regions: number;
}

const KINDS = ['GANGGUAN', 'PEMELIHARAAN', 'BENCANA ALAM', 'MLS', 'MANUVER'];
const KIND_BOX: Record<string, string> = {
  GANGGUAN: 'bg-red-50 text-red-700',
  PEMELIHARAAN: 'bg-blue-50 text-blue-800',
  'BENCANA ALAM': 'bg-amber-50 text-amber-800',
  MLS: 'bg-purple-100 text-purple-800',
  MANUVER: 'bg-gray-100 text-gray-700',
};
const PRIORITY_STYLE: Record<string, string> = {
  VVIP: 'bg-rose-600',
  VIP: 'bg-orange-500',
  KTT: 'bg-blue-600',
  Prioritas: 'bg-emerald-600',
};
const LOG_TABS = ['gi', 'trafo_gi', 'penyulang', 'zona', 'gd', 'trafo', 'pelanggan'] as const;
type LogTab = (typeof LOG_TABS)[number];
const REFRESH_KEY = 'qgis_info_refresh';
/** muat ulang otomatis: 0 = mati, -1 = saat ada perubahan, n = tiap n menit (+ saat ada perubahan) */
const REFRESH_CHANGE = -1;
const REFRESH_OPTIONS = [0, REFRESH_CHANGE, 1, 2, 5, 10];
/** jeda pemeriksaan penanda perubahan (detik) & jenis event realtime yang memicu pemeriksaan seketika */
const CHANGE_POLL_S = 30;
const CHANGE_EVENTS = ['maneuver', 'switch.event', 'topology.rebuilt', 'changeset.release'];

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Durasi menit → H:JJ:MM (hari:jam:menit). */
function fmtDHM(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return `${d}:${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const pct = (c: Count) => (c.terdampak > 0 ? (c.nyala / c.terdampak) * 100 : 0);

export default function Infographic() {
  const it = useInfoT();
  const { locale } = useT();
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const { appName, pageBanner, org } = useAuth();
  const toast = useToast();
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState(() => localDate());
  const [to, setTo] = useState(() => localDate());
  const [outage, setOutage] = useState(0);
  const [refreshMin, setRefreshMin] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(REFRESH_KEY);
      const v = Number(raw);
      return raw !== null && REFRESH_OPTIONS.includes(v) ? v : REFRESH_CHANGE;
    } catch {
      return REFRESH_CHANGE;
    }
  });
  const [data, setData] = useState<InfoResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [configs, setConfigs] = useState<Record<string, string> | null>(null);
  const [logTab, setLogTab] = useState<LogTab>('gi');
  const loc = locale === 'en' ? 'en-GB' : 'id-ID';
  const fmtDT = (s: string | null | undefined) =>
    s
      ? new Date(s).toLocaleString(loc, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';

  useEffect(() => {
    api<{ configs: Record<string, string> }>('/api/config/public')
      .then((r) => setConfigs(r.configs))
      .catch(() => setConfigs({}));
  }, []);

  const query = useMemo(
    () =>
      new URLSearchParams({
        from,
        to,
        kind,
        outage: String(outage),
      }).toString(),
    [from, to, kind, outage],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<InfoResp>(`/api/exec/infographic?${query}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [query, toast]);
  useEffect(() => {
    load();
  }, [load, locale]);

  // muat ulang otomatis. "Saat ada perubahan": penanda perubahan server (kejadian baru / berakhir / wilayah selesai
  // dihitung, versi jaringan) diperiksa tiap 30 detik dan seketika sesudah manuver / perubahan jaringan; data dimuat
  // ulang hanya bila penandanya berganti. Pilihan menit: dimuat ulang berkala dan juga saat ada perubahan.
  const lastVersion = useRef('');
  useEffect(() => {
    if (refreshMin === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ version: string }>('/api/exec/infographic/version');
        if (!alive) return;
        const changed = lastVersion.current !== '' && r.version !== lastVersion.current;
        lastVersion.current = r.version;
        if (changed) load();
      } catch {
        /* koneksi putus: dicoba lagi pada pemeriksaan berikutnya */
      }
    };
    realtime.connect();
    const unsub = realtime.subscribe((ev) => {
      if (!CHANGE_EVENTS.includes(ev.type) || timer) return;
      // beri waktu backend menutup / membuka kejadian sesudah manuver
      timer = setTimeout(() => {
        timer = null;
        check();
      }, 3000);
    });
    const onVisible = () => !document.hidden && check();
    document.addEventListener('visibilitychange', onVisible);
    check();
    const poll = setInterval(check, CHANGE_POLL_S * 1000);
    const iv = refreshMin > 0 ? setInterval(load, refreshMin * 60000) : null;
    return () => {
      alive = false;
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(poll);
      if (iv) clearInterval(iv);
      if (timer) clearTimeout(timer);
    };
  }, [load, refreshMin]);

  const setRefresh = (v: number) => {
    setRefreshMin(v);
    try {
      window.localStorage.setItem(REFRESH_KEY, String(v));
    } catch {
      /* penyimpanan browser tidak tersedia */
    }
  };

  const print = () => {
    const at = data ? new Date(data.at) : new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const prev = document.title;
    document.title = `Infografis-Pemulihan-${localDate(at)}_${p(at.getHours())}${p(at.getMinutes())}`;
    document.body.classList.add('exec-printing');
    setTimeout(() => {
      window.print();
      document.body.classList.remove('exec-printing');
      document.title = prev;
    }, 300);
  };

  // header bersama (layout): judul infografis + waktu kondisi; selalu ikut tercetak
  const conditionText = `${it('condition_at')}: ${data ? new Date(data.at).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'medium' }) : '-'}`;
  // judul laporan infografis tetap memuat nama UID (seperti contoh PDF)
  usePageBanner({ title: [it('title'), org.uid].filter(Boolean).join(' '), subtitle: conditionText, print: true });

  const kindTabs = ['', ...KINDS.filter((k) => k === 'GANGGUAN' || k === 'PEMELIHARAAN' || k === 'BENCANA ALAM' || (data?.kinds[k] || 0) > 0 || kind === k)];

  return (
    <div className="exec-scroll h-full overflow-y-auto bg-gray-100 p-3 md:p-4">
      <div className="space-y-3">
        {/* filter */}
        <div className="no-print flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap rounded-md border border-gray-300 bg-white p-0.5 text-xs">
            {kindTabs.map((k) => (
              <button
                key={k || 'all'}
                className={`rounded px-3 py-1 font-medium ${kind === k ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`}
                onClick={() => {
                  setKind(k);
                  setOutage(0);
                }}
              >
                {k ? it(`kind_${k}`) : it('kind_all')}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {/* header disembunyikan (Konfigurasi): waktu kondisi tetap terlihat di baris filter */}
          {!pageBanner && <span className="text-xs text-gray-500">{conditionText}</span>}
          <label className="flex items-center gap-1 text-xs text-gray-600">
            {it('auto_refresh')}
            <select className="input w-auto py-1 text-xs" value={refreshMin} onChange={(e) => setRefresh(Number(e.target.value))} title={it('refresh_hint')}>
              {REFRESH_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? it('refresh_off') : n === REFRESH_CHANGE ? it('refresh_change') : it('refresh_min', { n })}
                </option>
              ))}
            </select>
          </label>
          <input type="date" className="input w-36 py-1 text-xs" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="from" />
          <span className="text-xs text-gray-500">{it('date_to')}</span>
          <input type="date" className="input w-36 py-1 text-xs" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="to" />
          <select className="input w-56 py-1 text-xs" value={outage} onChange={(e) => setOutage(Number(e.target.value))}>
            <option value={0}>{it('outage_all')}</option>
            {(data?.roots || []).map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id} · {it(`kind_${r.kind}`)} · {r.cause_code} · {fmtDT(r.started_at)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" icon="refresh" loading={loading} onClick={load}>
            {it('refresh')}
          </Button>
          <Button size="sm" variant="secondary" icon="download" onClick={print}>
            {it('print')}
          </Button>
        </div>

        {!data ? (
          <div className="py-24 text-center">
            <Spinner size={24} />
          </div>
        ) : (
          <InfoBody data={data} query={query} it={it} fmtDT={fmtDT} configs={configs} dark={dark} logTab={logTab} setLogTab={setLogTab} appName={appName} />
        )}
      </div>
    </div>
  );
}

type T = ReturnType<typeof useInfoT>;

function InfoBody({
  data,
  query,
  it,
  fmtDT,
  configs,
  dark,
  logTab,
  setLogTab,
  appName,
}: {
  data: InfoResp;
  /** filter halaman (from, to, kind, outage) untuk log per halaman */
  query: string;
  it: T;
  fmtDT: (s: string | null | undefined) => string;
  configs: Record<string, string> | null;
  dark: boolean;
  logTab: LogTab;
  setLogTab: (t: LogTab) => void;
  appName: string;
}) {
  const L = data.levels;
  const totalEvents = Object.values(data.kinds).reduce((a, b) => a + b, 0);
  const mw = (v: number) => `${fmtNum(v, v >= 100 ? 0 : 1)} MW`;

  return (
    <div className="space-y-3">
      {data.pending_regions > 0 && <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">{it('pending_regions', { n: data.pending_regions })}</div>}

      {/* kartu per level */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 2xl:grid-cols-8">
        <div className="card flex flex-col gap-2 p-3">
          <CardTitle icon="list" text={it('events')} />
          <div className="rounded-full bg-teal-600 py-1 text-center text-xs font-semibold text-white">
            {it('total')}: {fmtNum(totalEvents)} event
          </div>
          <div className="space-y-1">
            {KINDS.filter((k) => ['GANGGUAN', 'PEMELIHARAAN', 'BENCANA ALAM'].includes(k) || (data.kinds[k] || 0) > 0).map((k) => (
              <div key={k} className={`flex items-center justify-between gap-2 rounded-md px-2 py-0.5 ${KIND_BOX[k]}`}>
                <span className="truncate text-[10px] font-semibold uppercase">{it(`kind_${k}`)}</span>
                <span className="text-sm font-bold tabular-nums">{fmtNum(data.kinds[k] || 0)}</span>
              </div>
            ))}
          </div>
        </div>
        <LevelCard icon="sparkles" title={it('load')} c={L.beban} it={it} fmt={mw} />
        <LevelCard icon="home" title={it('gi')} c={L.gi} it={it} />
        <LevelCard icon="target" title={it('trafo_gi')} c={L.trafo_gi} it={it} />
        <LevelCard icon="diagram" title={it('feeders')} c={L.penyulang} it={it} />
        <LevelCard icon="layers" title={it('zones')} c={L.zona} it={it} />
        <LevelCard icon="database" title={it('gd')} c={L.gd} it={it} />
        <LevelCard icon="users" title={it('customers')} c={L.pelanggan} it={it} />
      </div>

      {totalEvents === 0 && <div className="card py-3 text-center text-sm text-gray-500">{it('no_events')}</div>}

      {/* prioritas & gardu UP3 | peta | log */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1.3fr)]">
        <div className="space-y-3">
          <div className="card p-3">
            <SectionTitle icon="alert" text={it('priority_title')} />
            <div className="grid grid-cols-2 gap-2">
              {['VVIP', 'VIP', 'KTT', 'Prioritas'].map((k) => {
                const c = data.priority[k] || {
                  terdampak: 0,
                  padam: 0,
                  nyala: 0,
                };
                const p = pct(c);
                return (
                  <div key={k} className={`rounded-lg p-2.5 text-white ${PRIORITY_STYLE[k]}`}>
                    <div className="text-sm font-bold">{k}</div>
                    <div className="text-[11px] opacity-90">
                      {it('affected')}: {it('priority_locations', { n: fmtNum(c.terdampak) })}
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/30">
                      <div className="h-full bg-white" style={{ width: `${p}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px]">
                      <span>
                        {it('off')} {fmtNum(c.padam)}
                      </span>
                      <span>
                        {it('on')} {fmtNum(c.nyala)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-gray-500">{it('priority_hint')}</p>
          </div>
          <div className="card p-3">
            <SectionTitle icon="database" text={it('gd_up3_title')} />
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] text-gray-500">
                  <th className="py-1">#</th>
                  <th>{it('up3')}</th>
                  <th className="text-center">{it('affected')}</th>
                  <th className="text-center">{it('off')}</th>
                  <th className="text-center">{it('on')}</th>
                  <th className="text-center">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.up3.map((u, i) => (
                  <tr key={u.id}>
                    <td className="py-1 text-gray-500">{i + 1}</td>
                    <td className="font-medium text-gray-800">{u.name}</td>
                    <td className="text-center">
                      <Pill cls="bg-orange-50 text-orange-700">{fmtNum(u.gd.terdampak)}</Pill>
                    </td>
                    <td className="text-center">
                      <Pill cls="bg-red-50 text-red-700">{fmtNum(u.gd.padam)}</Pill>
                    </td>
                    <td className="text-center">
                      <Pill cls="bg-emerald-50 text-emerald-700">{fmtNum(u.gd.nyala)}</Pill>
                    </td>
                    <td className="text-center">
                      <Pill cls="bg-blue-50 text-blue-800">{u.gd.terdampak > 0 ? `${fmtNum(pct(u.gd))}%` : '-'}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card flex min-h-[28rem] flex-col p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <SectionTitle icon="map" text={it('map_title')} inline />
            <div className="flex flex-wrap gap-3 text-[11px] text-gray-600">
              {KINDS.filter((k) => (data.kinds[k] || 0) > 0 || ['GANGGUAN', 'PEMELIHARAAN', 'BENCANA ALAM'].includes(k)).map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[k] }} />
                  {it(`kind_${k}`)}
                </span>
              ))}
              {(['padam', 'pulih', 'induk', 'lain'] as const)
                .filter((r) => data.map.gi.some((g) => g.role === r))
                .map((r) => (
                  <span key={r} className="flex items-center gap-1">
                    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-[7px] font-bold text-white" style={{ background: GI_COLOR[r] }}>
                      GI
                    </span>
                    {it(`map_gi_${r}`)}
                  </span>
                ))}
              {([true, false] as const)
                .filter((a) => (data.map.tgi || []).some((x) => x.active === a))
                .map((a) => (
                  <span key={String(a)} className="flex items-center gap-1">
                    <TgiMark color={a ? OFF_COLOR : ON_COLOR} />
                    {it(a ? 'map_tgi_off' : 'map_tgi_on')}
                  </span>
                ))}
              {(['jtm', 'jtr', 'sr'] as const)
                .filter((k) => data.map.lines.features.some((f) => f.properties.cls === k))
                .map((k) => (
                  <span key={k} className="flex items-center gap-1">
                    <span
                      className="inline-block w-4 border-t-[3px]"
                      style={{
                        borderColor: NET_COLOR[k],
                        borderStyle: k === 'sr' ? 'dashed' : 'solid',
                      }}
                    />
                    {it(`map_${k}_off`)}
                    {k !== 'jtm' && data.map.zoom?.[k] != null && <span className="text-gray-400">z≥{data.map.zoom[k]}</span>}
                  </span>
                ))}
              {(data.map.trafo || []).length > 0 && (
                <span className="flex items-center gap-1">
                  <svg width="18" height="12" viewBox="0 0 26 18" aria-hidden="true">
                    <circle cx="9" cy="9" r="6" fill="#fff" stroke={OFF_COLOR} strokeWidth="2.2" />
                    <circle cx="17" cy="9" r="6" fill="none" stroke={OFF_COLOR} strokeWidth="2.2" />
                  </svg>
                  {it('map_trafo_off', { n: fmtNum(data.map.trafo.length) })}
                  <span className="text-gray-400">z≥{data.map.zoom?.trafo_distribusi ?? 13}</span>
                </span>
              )}
              {data.map.customers.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: NET_COLOR.pelanggan }} />
                  {it('map_cust_off', { n: fmtNum(data.map.customers.length) })}
                  <span className="text-gray-400">
                    z≥
                    {Math.min(...data.map.customers.map((c) => data.map.zoom?.[c.type_code] ?? 15))}
                    {' · '}
                    {it('map_cust_label', { z: Math.min(...data.map.customers.map((c) => custLabelZoom(data.map, c.type_code))) })}
                  </span>
                </span>
              )}
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: OFF_COLOR }} />
                {it('map_gd_off')}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: ON_COLOR }} />
                {it('map_gd_on')}
              </span>
            </div>
          </div>
          {data.map.truncated && <div className="mb-1 text-[11px] text-amber-700">{it('map_truncated')}</div>}
          <div className="relative min-h-[24rem] flex-1 overflow-hidden rounded-md border border-gray-200">
            {configs && (
              <InfographicMap
                configs={configs}
                dark={dark}
                gd={data.map.gd}
                causes={data.map.causes}
                net={data.map}
                gi={data.map.gi}
                tgi={data.map.tgi || []}
                renderInfo={(ts, relayout) => <ObjectPopup targets={ts} query={query} it={it} relayout={relayout} />}
              />
            )}
          </div>
          <div className="mt-1 text-[11px] text-gray-500">{it('map_click_hint')}</div>
        </div>

        <LogPanel query={query} at={data.at} totals={data.log_totals || {}} it={it} tab={logTab} setTab={setLogTab} />
      </div>

      {/* kurva beban */}
      <div className="card p-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle icon="chart" text={it('curve_title')} inline />
          <div className="flex gap-3 text-[11px] text-gray-600">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: ON_COLOR }} />
              {it('curve_on')}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: '#fb7185' }} />
              {it('curve_off')}
            </span>
          </div>
        </div>
        <LoadCurve events={data.events || []} from={data.from} to={data.to} at={data.at} />
      </div>

      {/* indeks keandalan */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <BigTile cls="bg-rose-600" label={it('saidi')} value={fmtIdx(data.rel.saidi)} unit={it('saidi_unit')} />
        <BigTile cls="bg-cyan-600" label={it('saifi')} value={fmtIdx(data.rel.saifi)} unit={it('saifi_unit')} />
        <BigTile cls="bg-orange-600" label={it('ens')} value={fmtNum(data.rel.ens_kwh, 2)} unit="kWh" />
        <BigTile cls="bg-emerald-600" label={it('rupiah')} value={fmtRp(data.rel.ens_rp)} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Up3Bars
          title={it('per_up3', { m: `${it('saidi')} (${it('saidi_unit')})` })}
          total={`${fmtIdx(data.rel.saidi)}`}
          totalLabel={it('total_up3')}
          up3={data.up3}
          value={(u) => u.rel.saidi}
          fmt={fmtIdx}
          color="#e11d48"
        />
        <Up3Bars
          title={it('per_up3', { m: `${it('saifi')} (${it('saifi_unit')})` })}
          total={`${fmtIdx(data.rel.saifi)}`}
          totalLabel={it('total_up3')}
          up3={data.up3}
          value={(u) => u.rel.saifi}
          fmt={fmtIdx}
          color="#0891b2"
        />
        <Up3Bars
          title={it('per_up3', { m: `${it('ens')} (kWh)` })}
          total={`${fmtNum(data.rel.ens_kwh, 2)} kWh`}
          totalLabel={it('total_up3')}
          up3={data.up3}
          value={(u) => u.rel.ens_kwh}
          fmt={(v) => fmtNum(v, 2)}
          color="#f97316"
        />
        <Up3Bars
          title={it('per_up3', { m: it('rupiah') })}
          total={fmtRp(data.rel.ens_rp)}
          totalLabel={it('total_up3')}
          up3={data.up3}
          value={(u) => u.rel.ens_rp}
          fmt={(v) => fmtNum(v, 0)}
          color="#059669"
        />
      </div>

      {/* detail pelanggan */}
      <CustomersPanel query={query} at={data.at} it={it} fmtDT={fmtDT} />

      <div className="py-2 text-center text-[11px] text-gray-500">
        {it('footer', {
          year: new Date(data.at).getFullYear(),
          org: [appName, data.org.up2d].filter(Boolean).join(' · '),
        })}
      </div>
    </div>
  );
}

interface LogPage {
  items: InfoObj[];
  total: number;
  page: number;
  pages: number;
  size: number;
  truncated: boolean;
}

/** Log event terdampak per tab: pencarian nama / kode objek dan halaman, dimuat dari server. */
function LogPanel({ query, at, totals, it, tab, setTab }: { query: string; at: string; totals: Record<string, number>; it: T; tab: LogTab; setTab: (t: LogTab) => void }) {
  const { q, setQ, qd, res, loading, size, setSize, page, go } = usePaged('/api/exec/infographic/log', query, { level: tab }, at);
  const labels: Record<LogTab, string> = {
    gi: it('gi'),
    trafo_gi: it('trafo_gi'),
    penyulang: it('feeders'),
    zona: it('zones'),
    gd: it('gd'),
    trafo: it('log_trafo'),
    pelanggan: it('customers'),
  };

  const items = res?.items || [];

  return (
    <div className="card flex min-h-[28rem] flex-col p-3">
      <SectionTitle icon="clock" text={it('log_title')} />
      <div className="mb-2 flex flex-wrap gap-1 rounded-md bg-teal-600 p-1 text-[11px]">
        {LOG_TABS.map((k) => (
          <button key={k} className={`flex-1 rounded px-2 py-1 font-semibold ${tab === k ? 'bg-teal-900 text-white shadow' : 'text-white/90 hover:bg-white/15'}`} onClick={() => setTab(k)}>
            {labels[k]} ({fmtNum(totals[k] ?? 0)})
          </button>
        ))}
      </div>
      <div className="relative mb-2">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
          <Icon name="search" size={13} />
        </span>
        <input className="input w-full py-1 pl-7 text-xs" placeholder={it('log_search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={it('log_search')} />
      </div>
      <div className={`max-h-[24rem] flex-1 overflow-auto ${loading ? 'opacity-60' : ''}`}>
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left text-gray-500">
              <th className="py-1">{it('log_object')}</th>
              <th>{it('log_time')}</th>
              <th title={it('log_duration_hint')}>{it('log_duration')}</th>
              <th>{it('log_region')}</th>
              <th>{it('log_status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((r) => (
              <tr key={`${r.event_id}-${r.id}`}>
                <td className="py-1 font-medium text-gray-800" title={r.name}>
                  {tab === 'pelanggan' ? r.name || r.code || `#${r.id}` : r.code || `#${r.id}`}
                  <div className="text-[10px] font-normal text-gray-400">
                    #{r.event_id}
                    {tab === 'pelanggan' && r.name && r.code ? ` · ${r.code}` : ''}
                    {(tab === 'trafo' || tab === 'pelanggan') && r.gd_code ? ` · ${r.gd_code}` : ''}
                    {tab === 'trafo' && r.power_va ? ` · ${fmtNum(r.power_va / 1000)} kVA` : ''}
                    {tab === 'pelanggan' && r.power_va ? ` · ${fmtVA(r.power_va)}` : ''}
                  </div>
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  <div className="text-red-700">{fmtShort(r.started_at)}</div>
                  <div className={r.active ? 'text-gray-400' : 'text-emerald-700'}>{r.active ? '-' : fmtShort(r.ended_at)}</div>
                </td>
                <td className="tabular-nums text-gray-700" title={it('log_duration_hint')}>
                  {fmtDHM(r.minutes)}
                </td>
                <td className="text-gray-600">{r.up3 || '-'}</td>
                <td>
                  <StatusPill active={r.active} it={it} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {res && items.length === 0 && <div className="py-6 text-center text-xs text-gray-500">{qd ? it('log_no_match', { q: qd }) : it('log_empty')}</div>}
        {!res && (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        )}
      </div>
      <Pager res={res} size={size} setSize={setSize} page={page} go={go} it={it} />
    </div>
  );
}

/** Daftar berhalaman dari server (log / detail pelanggan): kata kunci dengan jeda ketik, ukuran & nomor halaman. */
function usePaged(url: string, query: string, extra: Record<string, string>, at: string) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [size, setSize] = useState(10);
  const extraKey = new URLSearchParams(extra).toString();
  // halaman kembali ke 1 bila kata kunci, filter, tab, atau ukuran halaman berubah
  const key = `${query}|${extraKey}|${qd}|${size}`;
  const [pg, setPg] = useState({ key: '', page: 1 });
  const page = pg.key === key ? pg.page : 1;
  const [res, setRes] = useState<LogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const shownKey = useRef('');

  useEffect(() => {
    const tm = setTimeout(() => setQd(q.trim()), 300);
    return () => clearTimeout(tm);
  }, [q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // daftar lain (tab / kata kunci / filter / ukuran): kosongkan daftar lama agar tidak tertukar
    if (shownKey.current !== key) {
      shownKey.current = key;
      setRes(null);
    }
    const p = new URLSearchParams(query);
    new URLSearchParams(extraKey).forEach((v, k) => p.set(k, v));
    p.set('q', qd);
    p.set('page', String(page));
    p.set('size', String(size));
    api<LogPage>(`${url}?${p}`)
      .then((r) => alive && setRes(r))
      .catch((e: any) => alive && toast.push(e.message, 'error'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [url, key, query, extraKey, qd, page, size, at, toast]);

  const go = (n: number) => setPg({ key, page: Math.min(Math.max(1, n), res?.pages || 1) });
  return { q, setQ, qd, res, loading, size, setSize, page, go };
}

/** Navigasi halaman: rentang baris, ukuran halaman, « ‹ hal › ». */
function Pager({ res, size, setSize, page, go, it }: { res: LogPage | null; size: number; setSize: (n: number) => void; page: number; go: (n: number) => void; it: T }) {
  const from = res && res.total > 0 ? (res.page - 1) * res.size + 1 : 0;
  const to = res ? Math.min(res.page * res.size, res.total) : 0;
  const btn = 'rounded border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-100 disabled:opacity-40';
  return (
    <>
      {res?.truncated && <div className="mt-1 text-[11px] text-amber-700">{it('log_truncated')}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2 text-[11px] text-gray-600">
        <span className="flex-1">
          {res
            ? it('log_range', {
                from: fmtNum(from),
                to: fmtNum(to),
                total: fmtNum(res.total),
              })
            : '…'}
        </span>
        <select className="input w-auto py-0.5 text-[11px]" value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label={it('log_page_size')}>
          {[10, 25, 50].map((n) => (
            <option key={n} value={n}>
              {it('log_per_page', { n })}
            </option>
          ))}
        </select>
        <button className={btn} disabled={!res || res.page <= 1} onClick={() => go(1)} aria-label={it('log_first')} title={it('log_first')}>
          «
        </button>
        <button className={btn} disabled={!res || res.page <= 1} onClick={() => go(page - 1)} aria-label={it('log_prev')} title={it('log_prev')}>
          ‹
        </button>
        <span className="tabular-nums">
          {it('log_page', {
            p: fmtNum(res?.page ?? 1),
            n: fmtNum(res?.pages ?? 1),
          })}
        </span>
        <button className={btn} disabled={!res || res.page >= res.pages} onClick={() => go(page + 1)} aria-label={it('log_next')} title={it('log_next')}>
          ›
        </button>
        <button className={btn} disabled={!res || res.page >= res.pages} onClick={() => go(res?.pages || 1)} aria-label={it('log_last')} title={it('log_last')}>
          »
        </button>
      </div>
    </>
  );
}

/** Detail pelanggan terdampak per halaman: prioritas & TT/TM lebih dulu, yang masih padam di atas. */
function CustomersPanel({ query, at, it, fmtDT }: { query: string; at: string; it: T; fmtDT: (s: string | null | undefined) => string }) {
  const { q, setQ, qd, res, loading, size, setSize, page, go } = usePaged('/api/exec/infographic/customers', query, {}, at);
  const items = res?.items || [];
  const base = res ? (res.page - 1) * res.size : 0;
  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle icon="users" text={it('customers_title')} inline />
        <span className="flex-1 text-[11px] text-gray-500">{it('customers_order')}</span>
        <div className="relative w-full sm:w-72">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
            <Icon name="search" size={13} />
          </span>
          <input className="input w-full py-1 pl-7 text-xs" placeholder={it('customers_search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={it('customers_search')} />
        </div>
      </div>
      <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
        <table className="w-full min-w-[60rem] text-[11px]">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-1">#</th>
              <th>{it('col_event')}</th>
              <th>{it('col_name')}</th>
              <th>{it('col_address')}</th>
              <th>{it('col_gd')}</th>
              <th>{it('col_feeder')}</th>
              <th>{it('up3')}</th>
              <th>{it('log_off_at')}</th>
              <th>{it('log_on_at')}</th>
              <th>{it('col_type')}</th>
              <th>{it('log_status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((c, i) => (
              <tr key={`${c.event_id}-${c.id}`}>
                <td className="py-1 tabular-nums text-gray-500">{fmtNum(base + i + 1)}</td>
                <td className="font-mono text-gray-700">#{c.event_id}</td>
                <td className="text-gray-800">
                  {c.name || c.code}
                  <div className="text-[10px] text-gray-400">{c.code}</div>
                </td>
                <td className="max-w-[18rem] truncate text-gray-600" title={c.address}>
                  {c.address || '-'}
                </td>
                <td className="text-gray-600">{c.gd_code || '-'}</td>
                <td className="text-gray-600">{c.feeder_code || '-'}</td>
                <td className="text-gray-600">{c.up3 || '-'}</td>
                <td className="whitespace-nowrap text-gray-600">{fmtDT(c.started_at)}</td>
                <td className="whitespace-nowrap text-gray-600">{c.active ? '-' : fmtDT(c.ended_at)}</td>
                <td>
                  {c.priority ? (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${PRIORITY_STYLE[c.priority] || 'bg-gray-500'}`}>{c.priority}</span>
                  ) : (
                    <span className="text-gray-600">{it(`type_${c.type}`)}</span>
                  )}
                </td>
                <td>
                  <StatusPill active={c.active} it={it} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {res && items.length === 0 && <div className="py-6 text-center text-xs text-gray-500">{qd ? it('log_no_match', { q: qd }) : it('log_empty')}</div>}
        {!res && (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        )}
      </div>
      <Pager res={res} size={size} setSize={setSize} page={page} go={go} it={it} />
    </div>
  );
}

/** Lambang trafo GI di legenda (sama dengan ikon peta: lingkaran berwarna, simbol trafo putih). */
function TgiMark({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9.5" fill={color} stroke="#fff" strokeWidth="1" />
      <circle cx="7.6" cy="10" r="3.6" fill="none" stroke="#fff" strokeWidth="1.4" />
      <circle cx="12.4" cy="10" r="3.6" fill="none" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

interface ObjInfo {
  id: number;
  code: string;
  name: string;
  type_code: string;
  type_name: string;
  address: string;
  power_va: number;
  energized: boolean;
  up3: string;
  gi_code?: string;
  gd_code: string;
  feeder_code: string;
  events: {
    event_id: number;
    kind: string;
    started_at: string;
    ended_at: string | null;
    minutes: number;
    active: boolean;
  }[];
}

/** Kapasitas trafo / gardu (kVA, MVA bila besar). */
function fmtCapacity(va: number): string {
  return va >= 1e6 ? `${fmtNum(va / 1e6, va % 1e6 === 0 ? 0 : 1)} MVA` : `${fmtNum(va / 1000)} kVA`;
}

/** Label jenis objek peta untuk popup. */
function targetLabel(t: InfoTarget, it: T): string {
  if (t.layer.startsWith('cust-')) return it('obj_customer');
  if (t.layer.startsWith('net-')) return it(`map_${t.cls || t.layer.slice(4)}_off`);
  const m: Record<string, string> = { gi: it('gi'), tgi: it('trafo_gi'), gd: it('gd'), trafo: it('log_trafo'), causes: it('obj_cause') };
  return m[t.layer] || t.layer;
}

/** Popup Peta Kejadian: beberapa objek di titik klik (mis. trafo di dalam gardu) dipilih lewat tombol, lalu info objek terpilih. */
function ObjectPopup({ targets, query, it, relayout }: { targets: InfoTarget[]; query: string; it: T; relayout: () => void }) {
  const [sel, setSel] = useState(0);
  const t = targets[Math.min(sel, targets.length - 1)];
  useEffect(() => {
    relayout();
  }, [sel, relayout]);
  // lebar mengikuti lebar peta (--info-pop-w diisi InfographicMap), paling lebar 320 px
  return (
    <div className="w-[min(320px,var(--info-pop-w,320px))]">
      {targets.length > 1 && (
        <div className="mb-1.5 pr-5">
          <div className="mb-1 text-[10px] text-gray-500">{it('obj_here', { n: targets.length })}</div>
          <div className="flex flex-wrap gap-1" role="tablist">
            {targets.map((x, i) => (
              <button
                key={`${x.layer}-${x.id}`}
                type="button"
                role="tab"
                aria-selected={i === sel}
                onClick={() => setSel(i)}
                className={`max-w-[10rem] truncate rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  i === sel ? 'border-teal-600 bg-teal-600 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-100'
                }`}
                title={`${targetLabel(x, it)} ${x.code || x.name || ''}`}
              >
                {targetLabel(x, it)}
                {x.code || x.name ? ` · ${x.code || x.name}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      <ObjectInfo key={`${t.layer}-${t.id}`} target={t} query={query} it={it} relayout={relayout} />
    </div>
  );
}

/**
 * Isi popup objek di Peta Kejadian: identitas, induk (gardu / penyulang), UP3, kapasitas / daya, alamat, kondisi kini,
 * dan riwayat padam–nyala per event seperti baris Log Event Terdampak (periode & filter sama dengan halaman).
 */
function ObjectInfo({ target, query, it, relayout }: { target: InfoTarget; query: string; it: T; relayout: () => void }) {
  const isNode = !target.layer.startsWith('net-') && target.target_kind !== 'edge';
  const [info, setInfo] = useState<ObjInfo | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!isNode) return;
    let alive = true;
    api<ObjInfo>(`/api/exec/infographic/object?${query}&id=${target.id}`)
      .then((r) => alive && setInfo(r))
      .catch((e: any) => alive && setErr(e.message || String(e)));
    return () => {
      alive = false;
    };
  }, [isNode, query, target.id]);
  useEffect(() => {
    relayout();
  }, [info, err, relayout]);

  const isCust = target.layer.startsWith('cust-');
  const label = targetLabel(target, it);
  const code = info?.code || target.code;
  const name = info?.name || target.name || '';
  // pelanggan dikenali dari namanya (seperti log), objek lain dari kodenya
  const title = (isCust ? name || code : code || name) || `#${target.id}`;
  const sub = isCust ? (name ? code : '') : code && name && name !== code ? name : '';
  const rows: [string, React.ReactNode][] = [];
  if (target.role) rows.push([it('obj_role'), it(`map_gi_${target.role}`)]);
  if (target.layer === 'causes' && target.kind) rows.push([it('obj_event'), `#${target.event_id ?? '-'} · ${it(`kind_${target.kind}`)}`]);
  if (info) {
    if (info.type_name) rows.push([it('obj_type'), info.type_name]);
    if (info.gi_code) rows.push([it('gi'), info.gi_code]);
    if (info.gd_code) rows.push([it('obj_gd'), info.gd_code]);
    if (info.feeder_code) rows.push([it('obj_feeder'), info.feeder_code]);
    if (info.up3) rows.push([it('up3'), info.up3]);
    if (info.power_va > 0) rows.push(isCust ? [it('obj_power'), fmtVA(info.power_va)] : [it('obj_capacity'), fmtCapacity(info.power_va)]);
    if (info.address) rows.push([it('obj_address'), info.address]);
    rows.push([it('obj_now'), <StatusPill key="now" active={!info.energized} it={it} />]);
  }

  return (
    <div className="text-xs text-gray-700">
      <div className="pr-5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="break-words pr-5 font-semibold text-gray-900">{title}</div>
      {sub && <div className="break-words text-[11px] text-gray-500">{sub}</div>}
      {rows.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-gray-500">{k}</dt>
              <dd className="break-words text-gray-800">{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {isNode && !info && !err && (
        <div className="mt-2 flex items-center gap-2 text-gray-500">
          <Spinner size={12} /> {it('obj_loading')}
        </div>
      )}
      {err && <div className="mt-2 text-red-700">{err}</div>}
      {info && !(target.layer === 'causes' && info.events.length === 0) && (
        <div className="mt-2 border-t border-gray-200 pt-1.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{it('obj_events', { n: fmtNum(info.events.length) })}</div>
          {info.events.length === 0 ? (
            <div className="text-gray-500">{it('obj_no_events')}</div>
          ) : (
            <div className="max-h-44 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-left text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="py-0.5 font-semibold">{it('obj_event')}</th>
                    <th className="font-semibold">{it('log_time')}</th>
                    <th className="font-semibold" title={it('log_duration_hint')}>
                      {it('log_duration')}
                    </th>
                    <th className="font-semibold">{it('log_status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {info.events.map((e) => (
                    <tr key={e.event_id}>
                      <td className="py-0.5 pr-1">
                        <div className="font-medium text-gray-800">#{e.event_id}</div>
                        <div className="text-[10px] text-gray-500">{it(`kind_${e.kind}`)}</div>
                      </td>
                      <td className="whitespace-nowrap pr-1 tabular-nums">
                        <div className="text-red-700">{fmtShort(e.started_at)}</div>
                        <div className={e.active ? 'text-gray-400' : 'text-emerald-700'}>{e.active ? '-' : fmtShort(e.ended_at)}</div>
                      </td>
                      <td className="pr-1 tabular-nums text-gray-700" title={it('log_duration_hint')}>
                        {fmtDHM(e.minutes)}
                      </td>
                      <td>
                        <StatusPill active={e.active} it={it} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ active, it }: { active: boolean; it: T }) {
  return active ? <Pill cls="bg-red-50 text-red-700">{it('status_off')}</Pill> : <Pill cls="bg-emerald-50 text-emerald-700">{it('status_on')}</Pill>;
}

function LevelCard({ icon, title, c, it, fmt = (v: number) => fmtNum(v) }: { icon: string; title: string; c: Count; it: T; fmt?: (v: number) => string }) {
  const p = pct(c);
  return (
    <SplitCard
      icon={icon}
      title={title}
      head={`${it('affected')}: ${fmt(c.terdampak)}`}
      left={{ label: it('off'), value: fmt(c.padam) }}
      right={{ label: it('on'), value: fmt(c.nyala) }}
      caption={{
        pct: c.terdampak > 0 ? p : 0,
        text: c.terdampak > 0 ? it('recovery_on', { p: fmtNum(p, p > 0 && p < 100 ? 1 : 0) }) : `${it('recovery')}: -`,
      }}
    />
  );
}

/** Tanggal ringkas untuk tabel sempit: dd/MM HH.mm (tahun hanya bila bukan tahun ini). */
function fmtShort(s: string | null | undefined): string {
  if (!s) return '-';
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear() !== new Date().getFullYear() ? `/${String(d.getFullYear()).slice(2)}` : '';
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}${y} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** Kurva bertingkat: beban nyala (pulih) di bawah, beban padam di atasnya; jumlah = beban terdampak kumulatif. */
function LoadCurve({ events, from, to, at }: { events: InfoEvent[]; from: string; to: string; at: string }) {
  const W = 1000;
  const H = 230;
  const pad = { l: 46, r: 12, t: 10, b: 26 };
  const series = useMemo(() => {
    const t0 = new Date(from).getTime();
    const t1 = Math.min(new Date(to).getTime(), new Date(at).getTime());
    const ids = new Set(events.map((e) => e.id));
    const isRoot = (e: InfoEvent) => e.parent_id === null || !ids.has(e.parent_id);
    const times = new Set<number>([t0, t1]);
    for (const e of events) {
      const s = new Date(e.started_at).getTime();
      if (s > t0 && s < t1) times.add(s);
      if (e.ended_at) {
        const x = new Date(e.ended_at).getTime();
        if (x > t0 && x < t1) times.add(x);
      }
    }
    const ts = Array.from(times).sort((a, b) => a - b);
    return {
      t0,
      t1,
      pts: ts.map((t) => {
        let cum = 0;
        let off = 0;
        for (const e of events) {
          const s = new Date(e.started_at).getTime();
          if (s > t) continue;
          if (isRoot(e)) cum += e.load_mw;
          const end = e.ended_at ? new Date(e.ended_at).getTime() : Infinity;
          if (end > t) off += e.load_mw;
        }
        return { t, on: Math.max(0, cum - off), off };
      }),
    };
  }, [events, from, to, at]);
  const { t0, t1, pts } = series;
  const maxV = Math.max(0.001, ...pts.map((p) => p.on + p.off));
  const step = (() => {
    const raw = maxV / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  })();
  const yMax = Math.ceil(maxV / step) * step;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const area = (lo: (p: (typeof pts)[number]) => number, hi: (p: (typeof pts)[number]) => number) => {
    if (pts.length < 2) return '';
    let top = '';
    let bottom = '';
    for (let i = 0; i < pts.length; i++) {
      const xa = x(pts[i].t);
      const xb = x(i + 1 < pts.length ? pts[i + 1].t : t1);
      top += `${i === 0 ? 'M' : 'L'}${xa},${y(hi(pts[i]))} L${xb},${y(hi(pts[i]))} `;
      bottom = `L${xb},${y(lo(pts[i]))} L${xa},${y(lo(pts[i]))} ` + bottom;
    }
    return `${top}${bottom}Z`;
  };
  const sameDay = new Date(t0).toDateString() === new Date(t1 - 1).toDateString();
  const ticksX = Array.from({ length: 7 }, (_, i) => t0 + ((t1 - t0) * i) / 6);
  const fmtT = (t: number) => {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
  };
  const ticksY = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="load curve">
      {ticksY.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--chart-grid)' }} />
          <text x={pad.l - 6} y={y(v) + 3.5} fontSize={10} textAnchor="end" style={{ fill: 'var(--chart-text)' }}>
            {fmtNum(v, v < 10 ? 1 : 0)}
          </text>
        </g>
      ))}
      <path
        d={area(
          () => 0,
          (p) => p.on,
        )}
        fill={ON_COLOR}
        fillOpacity={0.85}
      />
      <path
        d={area(
          (p) => p.on,
          (p) => p.on + p.off,
        )}
        fill="#fb7185"
        fillOpacity={0.7}
      />
      {ticksX.map((t, i) => (
        <text key={i} x={x(t)} y={H - 8} fontSize={10} textAnchor={i === 0 ? 'start' : i === 6 ? 'end' : 'middle'} style={{ fill: 'var(--chart-text)' }}>
          {fmtT(t)}
        </text>
      ))}
    </svg>
  );
}

/** Batang per UP3 dengan nilai di atas batang dan label UP3 miring. */
function Up3Bars({
  title,
  total,
  totalLabel,
  up3,
  value,
  fmt,
  color,
}: {
  title: string;
  total: string;
  totalLabel: string;
  up3: InfoUP3[];
  value: (u: InfoUP3) => number;
  fmt: (v: number) => string;
  color: string;
}) {
  const W = 640;
  const H = 230;
  const pad = { l: 40, r: 8, t: 18, b: 70 };
  const vals = up3.map(value);
  const maxV = Math.max(0, ...vals);
  const yMax = maxV > 0 ? maxV * 1.15 : 1;
  const slot = (W - pad.l - pad.r) / Math.max(1, up3.length);
  const bw = Math.min(26, slot * 0.6);
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  return (
    <div className="card p-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-800">{title}</h3>
        <div className="text-right text-[11px] text-gray-500">
          {totalLabel}
          <div className="text-sm font-bold tabular-nums" style={{ color }}>
            {total}
          </div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} style={{ stroke: 'var(--chart-grid)' }} />
        {up3.map((u, i) => {
          const v = vals[i];
          const cx = pad.l + slot * i + slot / 2;
          return (
            <g key={u.id}>
              {v > 0 && <rect x={cx - bw / 2} y={y(v)} width={bw} height={y(0) - y(v)} rx={3} fill={color} />}
              <text x={cx} y={(v > 0 ? y(v) : y(0)) - 4} fontSize={9.5} textAnchor="middle" fontWeight={v > 0 ? 700 : 400} style={{ fill: 'var(--chart-text)' }}>
                {fmt(v)}
              </text>
              <text x={cx} y={y(0) + 10} fontSize={9.5} textAnchor="end" transform={`rotate(-45 ${cx} ${y(0) + 10})`} style={{ fill: 'var(--chart-text)' }}>
                {u.name.length > 14 ? `${u.name.slice(0, 13)}…` : u.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
