'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { API_BASE, api, getToken } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { Badge, Button, PageHeader, Spinner, useToast } from '@/components/ui';
import type { ComponentType } from '@/lib/types';

// ---------------------------------------------------------------- kamus

const ID = {
  title: 'Integrasi Kafka — Energize / De-energize',
  subtitle: 'Sistem eksternal (SCADA, DMS, AMI, ...) membuka / menutup objek jaringan dengan mengirim pesan JSON ke Kafka',
  status: 'Status integrasi',
  kafka: 'Kafka server',
  integration: 'Terima perintah',
  on: 'aktif',
  off: 'nonaktif',
  topic: 'Topik',
  group: 'Consumer group',
  actor: 'Dicatat sebagai',
  last24: '24 jam terakhir',
  format: 'Format pesan',
  field: 'Kolom',
  aliases: 'Nama lain',
  required: 'Wajib',
  desc: 'Keterangan',
  yes: 'ya',
  cond_open: 'untuk open',
  one_of: 'salah satu',
  f_code: 'Kode / nama objek (juga kode SSOT atau IDPEL pelanggan).',
  f_type: 'Jenis objek: kode tipe atau nama tipe (daftar di bawah). Membantu bila kode sama dipakai beberapa objek.',
  f_status: 'open = buka / de-energize (padam), close = tutup / energize (nyala). Diterima juga buka / tutup, off / on, trip, deenergize / energize.',
  f_category: 'Kategori pemadaman: {cats}. Wajib untuk open; untuk close mengikuti kejadian padam aktif.',
  f_time: 'Tanggal kejadian: ISO 8601 (2026-09-29T10:15:00+07:00), "YYYY-MM-DD HH:MM:SS" (WIB), atau epoch detik / milidetik. Kosong = waktu terima.',
  f_event: 'Id unik pesan — pesan dengan id yang sama tidak diproses dua kali.',
  f_note: 'Catatan (masuk ke SOE & riwayat manuver).',
  f_source: 'Nama sistem pengirim (dicatat sebagai pelaku).',
  f_id: 'Id objek QuadranGIS (alternatif kode).',
  notes: 'Catatan integrasi',
  note1: 'Gunakan kode objek sebagai kunci (key) pesan Kafka agar urutan perintah satu objek terjaga.',
  note2: 'Diproses lewat jalur yang sama dengan operator: kejadian padam, SAIDI / SAIFI, SOE (kanal Kafka), notifikasi, audit. Perintah dengan status yang sudah sama diabaikan (dicatat "dilewati").',
  note3: 'Tanggal dipakai sebagai waktu mulai / selesai padam; tanggal lebih dari {sec} detik di masa depan diganti waktu terima.',
  example: 'Contoh',
  copy: 'Salin',
  copied: 'Disalin',
  test: 'Kirim perintah uji',
  tpl_open: 'Contoh open (padam)',
  tpl_close: 'Contoh close (nyala)',
  send_kafka: 'Kirim ke Kafka',
  send_direct: 'Proses langsung',
  direct_hint: 'Proses langsung = tanpa Kafka (uji format & pencarian objek). Keduanya benar-benar membuka / menutup objek di jaringan.',
  sent_kafka: 'Pesan dikirim ke topik {topic}; hasil muncul di log dalam beberapa detik.',
  log: 'Log pesan masuk',
  all: 'Semua',
  applied: 'Diterapkan',
  skipped: 'Dilewati',
  duplicate: 'Duplikat',
  error: 'Galat',
  received: 'Diterima',
  event_at: 'Waktu kejadian',
  object: 'Objek',
  action: 'Aksi',
  category: 'Kategori',
  result: 'Hasil',
  message: 'Pesan',
  empty: 'Belum ada pesan.',
  more: 'Muat lebih lama',
  auto: 'Segarkan otomatis',
  payload: 'Pesan asli',
  maneuver: 'manuver',
  outage: 'kejadian padam',
  ch_kafka: 'Kafka',
  ch_uji: 'uji langsung',
  types: 'Kode tipe objek',
  types_hint: 'Nilai kolom type: kode tipe (disarankan) atau nama tipe. Semua tipe bertopologi bisa dibuka / ditutup, tidak hanya alat switching.',
  feeder_hint: 'Penyulang tidak punya tipe sendiri. Kirim kubikel keluar di GI: type kubikel_20kv dan code = nama penyulang (mis. ABIMANYU).',
  t_code: 'Kode tipe',
  t_name: 'Nama tipe',
  t_cat: 'Kategori',
  switching: 'switching',
  feeder_head: 'kepala penyulang',
  cat_sumber: 'Sumber',
  cat_bangunan: 'Bangunan',
  cat_peralatan: 'Peralatan',
  cat_pengaman: 'Pengaman',
  cat_jaringan: 'Jaringan',
  cat_pelanggan: 'Pelanggan',
  cat_topologi: 'Topologi',
};
type Dict = typeof ID;
const EN: Dict = {
  title: 'Kafka Integration — Energize / De-energize',
  subtitle: 'External systems (SCADA, DMS, AMI, ...) open / close network objects by sending JSON messages to Kafka',
  status: 'Integration status',
  kafka: 'Kafka on server',
  integration: 'Accept commands',
  on: 'enabled',
  off: 'disabled',
  topic: 'Topic',
  group: 'Consumer group',
  actor: 'Recorded as',
  last24: 'Last 24 hours',
  format: 'Message format',
  field: 'Field',
  aliases: 'Aliases',
  required: 'Required',
  desc: 'Description',
  yes: 'yes',
  cond_open: 'for open',
  one_of: 'one of',
  f_code: 'Object code / name (also SSOT code or customer IDPEL).',
  f_type: 'Object type: type code or type name (list below). Helps when several objects share a code.',
  f_status: 'open = open / de-energize (outage), close = close / energize (restore). Also accepts buka / tutup, off / on, trip, deenergize / energize.',
  f_category: 'Outage category: {cats}. Required for open; close follows the active outage.',
  f_time: 'Event time: ISO 8601 (2026-09-29T10:15:00+07:00), "YYYY-MM-DD HH:MM:SS" (WIB), or epoch seconds / milliseconds. Empty = time received.',
  f_event: 'Unique message id — a message with the same id is never processed twice.',
  f_note: 'Note (stored in the SOE and switching history).',
  f_source: 'Sending system name (recorded as the actor).',
  f_id: 'QuadranGIS object id (alternative to code).',
  notes: 'Integration notes',
  note1: 'Use the object code as the Kafka message key so commands for one object stay in order.',
  note2: 'Processed through the same path as operators: outage events, SAIDI / SAIFI, SOE (Kafka channel), notifications, audit. Commands for an object already in that state are ignored ("skipped").',
  note3: 'The event time is used as outage start / end; a time more than {sec} seconds in the future is replaced by the time received.',
  example: 'Example',
  copy: 'Copy',
  copied: 'Copied',
  test: 'Send a test command',
  tpl_open: 'Open example (outage)',
  tpl_close: 'Close example (restore)',
  send_kafka: 'Send to Kafka',
  send_direct: 'Process directly',
  direct_hint: 'Process directly = without Kafka (test format & object lookup). Both really open / close the object in the network.',
  sent_kafka: 'Message sent to topic {topic}; the result appears in the log within seconds.',
  log: 'Incoming messages',
  all: 'All',
  applied: 'Applied',
  skipped: 'Skipped',
  duplicate: 'Duplicate',
  error: 'Error',
  received: 'Received',
  event_at: 'Event time',
  object: 'Object',
  action: 'Action',
  category: 'Category',
  result: 'Result',
  message: 'Message',
  empty: 'No messages yet.',
  more: 'Load older',
  auto: 'Auto refresh',
  payload: 'Original message',
  maneuver: 'switching',
  outage: 'outage',
  ch_kafka: 'Kafka',
  ch_uji: 'direct test',
  types: 'Object type codes',
  types_hint: 'Value of the type field: type code (recommended) or type name. Every topology type can be opened / closed, not only switching devices.',
  feeder_hint: 'Feeders have no type of their own. Send the outgoing cubicle at the substation: type kubikel_20kv and code = feeder name (e.g. ABIMANYU).',
  t_code: 'Type code',
  t_name: 'Type name',
  t_cat: 'Category',
  switching: 'switching',
  feeder_head: 'feeder head',
  cat_sumber: 'Source',
  cat_bangunan: 'Building',
  cat_peralatan: 'Equipment',
  cat_pengaman: 'Protection',
  cat_jaringan: 'Network',
  cat_pelanggan: 'Customer',
  cat_topologi: 'Topology',
};

function useS() {
  const { locale } = useT();
  return useCallback(
    (key: keyof Dict | string, params?: Record<string, string | number>) => {
      const d = (locale === 'en' ? EN : ID) as Record<string, string>;
      let s = d[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
    [locale],
  );
}

// ---------------------------------------------------------------- tipe

interface Ev {
  id: number;
  received_at: string;
  event_id: string;
  source: string;
  channel: string;
  topic: string;
  partition: number | null;
  offset: number | null;
  payload: any;
  code: string;
  type_text: string;
  action: string;
  category: string;
  event_at: string | null;
  target_kind: string;
  target_id: number | null;
  target_code: string;
  target_type: string;
  result: 'applied' | 'skipped' | 'duplicate' | 'error';
  message: string;
  maneuver_id: number | null;
  outage_id: number | null;
  duration_ms: number;
}
interface Cfg {
  kafka_enabled: boolean;
  enabled: boolean;
  topic: string;
  group: string;
  username: string;
  categories: string[];
}

const TONE: Record<string, 'green' | 'gray' | 'amber' | 'red'> = { applied: 'green', skipped: 'gray', duplicate: 'amber', error: 'red' };

function nowLocalISO() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tz = `${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

function template(action: 'open' | 'close') {
  const base: Record<string, string> = { event_id: `UJI-${Date.now()}`, code: 'REC-GMB-02-05', type: 'recloser', status: action };
  if (action === 'open') base.outage_category = 'GANGGUAN';
  base.timestamp = nowLocalISO();
  base.note = action === 'open' ? 'trip OCR (uji)' : 'normal kembali (uji)';
  base.source = 'SCADA-UJI';
  return JSON.stringify(base, null, 2);
}

function fmtWhen(s: string | null | undefined, locale: string) {
  if (!s) return '-';
  return new Date(s).toLocaleString(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'short', timeStyle: 'medium' });
}

// ---------------------------------------------------------------- halaman

export default function SwitchEvents() {
  const S = useS();
  const { locale } = useT();
  const toast = useToast();
  const [items, setItems] = useState<Ev[] | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('');
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const [body, setBody] = useState(() => template('open'));
  const [busy, setBusy] = useState('');
  const [more, setMore] = useState(false);
  const [types, setTypes] = useState<ComponentType[] | null>(null);

  useEffect(() => {
    // tipe yang diterima kolom type = tipe bertopologi (lihat switchTypes di backend)
    api<{ items: ComponentType[] }>('/api/gis/types')
      .then((r) => setTypes(r.items.filter((t) => t.topology !== false).sort((a, b) => a.sort_order - b.sort_order)))
      .catch(() => setTypes([]));
  }, []);

  const load = useCallback(
    async (beforeId = 0) => {
      try {
        const qs = new URLSearchParams({ limit: '100', result: filter });
        if (beforeId) qs.set('before_id', String(beforeId));
        const r = await api<{ items: Ev[]; counts_24h: Record<string, number>; config: Cfg }>(`/api/admin/switch-events?${qs}`);
        setCfg(r.config);
        setCounts(r.counts_24h);
        setItems((cur) => (beforeId && cur ? [...cur, ...r.items] : r.items));
        setMore(r.items.length === 100);
      } catch (e: any) {
        toast.push(e.message, 'error');
        setItems((cur) => cur || []);
      }
    },
    [filter, toast],
  );

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => load(), 5000);
    return () => clearInterval(id);
  }, [auto, load]);

  const send = async (mode: 'kafka' | 'direct') => {
    try {
      JSON.parse(body);
    } catch {
      toast.push('JSON tidak valid', 'error');
      return;
    }
    setBusy(mode);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/admin/switch-events/test?mode=${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lang': locale, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
        body,
      });
      const j = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(j.error || res.statusText);
      if (mode === 'kafka') toast.push(S('sent_kafka', { topic: j.topic }), 'success');
      else {
        const ev: Ev = j.event;
        toast.push(`${S(ev.result)}: ${ev.message}`, ev.result === 'applied' ? 'success' : ev.result === 'error' ? 'error' : 'warning');
      }
      setTimeout(() => load(), mode === 'kafka' ? 2500 : 0);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const cats = (cfg?.categories || ['GANGGUAN', 'PEMELIHARAAN', 'MLS', 'MANUVER', 'BENCANA ALAM']).join(' / ');
  const fields: [string, string, string, string][] = [
    ['code', 'kode, name, nama, object', S('one_of'), S('f_code')],
    ['id', 'object_id, feature_id', S('one_of'), S('f_id')],
    ['type', 'jenis, type_code, object_type', '', S('f_type')],
    ['status', 'action, aksi, state', S('yes'), S('f_status')],
    ['outage_category', 'kategori, category, kind', S('cond_open'), S('f_category', { cats })],
    ['timestamp', 'tanggal, date, datetime, waktu', '', S('f_time')],
    ['event_id', 'message_id', '', S('f_event')],
    ['note', 'catatan, keterangan', '', S('f_note')],
    ['source', 'sumber, sistem', '', S('f_source')],
  ];
  const example = `{
  "event_id": "SCADA-2026-000123",
  "code": "REC-GMB-02-05",
  "type": "recloser",
  "status": "open",
  "outage_category": "GANGGUAN",
  "timestamp": "2026-09-29T10:15:00+07:00",
  "note": "trip OCR fasa R",
  "source": "SCADA-UP2D"
}`;

  return (
    <div className="space-y-4">
      <PageHeader title={S('title')} subtitle={S('subtitle')} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* status & format */}
        <div className="space-y-4">
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">{S('status')}</h3>
            {!cfg ? (
              <Spinner />
            ) : (
              <>
                <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-gray-500">{S('kafka')}</dt>
                  <dd>
                    <Badge tone={cfg.kafka_enabled ? 'green' : 'red'}>{cfg.kafka_enabled ? S('on') : S('off')}</Badge>
                  </dd>
                  <dt className="text-gray-500">{S('integration')}</dt>
                  <dd>
                    <Badge tone={cfg.enabled ? 'green' : 'red'}>{cfg.enabled ? S('on') : S('off')}</Badge>
                    <span className="ml-2 font-mono text-[11px] text-gray-500">scada.switch_enabled</span>
                  </dd>
                  <dt className="text-gray-500">{S('topic')}</dt>
                  <dd className="font-mono text-gray-900">{cfg.topic}</dd>
                  <dt className="text-gray-500">{S('group')}</dt>
                  <dd className="font-mono text-gray-700">{cfg.group}</dd>
                  <dt className="text-gray-500">{S('actor')}</dt>
                  <dd className="font-mono text-gray-700">{cfg.username}</dd>
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                  <span>{S('last24')}:</span>
                  {(['applied', 'skipped', 'duplicate', 'error'] as const).map((k) => (
                    <Badge key={k} tone={TONE[k]}>
                      {S(k)} {fmtNum(counts[k] || 0)}
                    </Badge>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="card p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">{S('format')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                    <th className="py-1 pr-2">{S('field')}</th>
                    <th className="py-1 pr-2">{S('aliases')}</th>
                    <th className="py-1 pr-2">{S('required')}</th>
                    <th className="py-1">{S('desc')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(([f, a, r, d]) => (
                    <tr key={f} className="border-b border-gray-100 align-top">
                      <td className="py-1 pr-2 font-mono text-gray-900">{f}</td>
                      <td className="py-1 pr-2 font-mono text-[11px] text-gray-500">{a}</td>
                      <td className="whitespace-nowrap py-1 pr-2 text-gray-700">{r}</td>
                      <td className="py-1 text-gray-700">{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-700">{S('example')}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="check"
                  onClick={() => {
                    navigator.clipboard?.writeText(example).then(() => toast.push(S('copied'), 'success'));
                  }}
                >
                  {S('copy')}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] text-gray-800">{example}</pre>
            </div>
            <h4 className="mb-1 mt-3 text-xs font-semibold text-gray-700">{S('notes')}</h4>
            <ul className="list-disc space-y-1 pl-4 text-xs text-gray-600">
              <li>{S('note1')}</li>
              <li>{S('note2')}</li>
              <li>{S('note3', { sec: 120 })}</li>
            </ul>
          </div>

          <div className="card p-4">
            <h3 className="mb-1 text-sm font-semibold text-gray-900">{S('types')}</h3>
            <p className="text-xs text-gray-600">{S('types_hint')}</p>
            <p className="mb-2 mt-1 text-xs text-gray-600">{S('feeder_hint')}</p>
            {!types ? (
              <Spinner />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                      <th className="py-1 pr-2">{S('t_code')}</th>
                      <th className="py-1 pr-2">{S('t_name')}</th>
                      <th className="py-1">{S('t_cat')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((t) => (
                      <tr key={t.code} className="border-b border-gray-100 align-top">
                        <td className="whitespace-nowrap py-1 pr-2 font-mono text-gray-900">{t.code}</td>
                        <td className="py-1 pr-2 text-gray-700">
                          {(locale === 'en' && t.name_en) || t.name}
                          {t.code === 'kubikel_20kv' && <span className="ml-1 text-[10px] text-gray-500">· {S('feeder_head')}</span>}
                        </td>
                        <td className="whitespace-nowrap py-1 text-gray-700">
                          {S(`cat_${t.category}`)}
                          {t.is_switch && (
                            <span className="ml-1">
                              <Badge tone="blue">{S('switching')}</Badge>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* uji kirim */}
        <div className="card h-fit space-y-3 p-4">
          <h3 className="text-sm font-semibold text-gray-900">{S('test')}</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setBody(template('open'))}>
              {S('tpl_open')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setBody(template('close'))}>
              {S('tpl_close')}
            </Button>
          </div>
          <textarea className="input h-72 font-mono text-xs" spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} aria-label={S('test')} />
          <div className="flex flex-wrap items-center gap-2">
            <Button icon="send" loading={busy === 'kafka'} disabled={!!busy || cfg?.kafka_enabled === false} onClick={() => send('kafka')}>
              {S('send_kafka')}
            </Button>
            <Button variant="secondary" icon="bolt" loading={busy === 'direct'} disabled={!!busy} onClick={() => send('direct')}>
              {S('send_direct')}
            </Button>
          </div>
          <p className="text-xs text-gray-500">{S('direct_hint')}</p>
        </div>
      </div>

      {/* log */}
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">{S('log')}</h3>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {['', 'applied', 'skipped', 'duplicate', 'error'].map((k) => (
              <button key={k || 'all'} className={`rounded-md px-2 py-1 text-xs ${filter === k ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`} onClick={() => setFilter(k)}>
                {S(k || 'all')}
              </button>
            ))}
            <label className="ml-2 flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              {S('auto')}
            </label>
          </div>
        </div>
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">{S('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1 pr-2">{S('received')}</th>
                  <th className="py-1 pr-2">{S('event_at')}</th>
                  <th className="py-1 pr-2">{S('object')}</th>
                  <th className="py-1 pr-2">{S('action')}</th>
                  <th className="py-1 pr-2">{S('category')}</th>
                  <th className="py-1 pr-2">{S('result')}</th>
                  <th className="py-1">{S('message')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer border-b border-gray-100 align-top hover:bg-gray-50" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums text-gray-700">
                        {fmtWhen(e.received_at, locale)}
                        <div className="text-[10px] text-gray-500">
                          {S(`ch_${e.channel}`)}
                          {e.source && ` · ${e.source}`}
                        </div>
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums text-gray-700">{fmtWhen(e.event_at, locale)}</td>
                      <td className="py-1.5 pr-2">
                        <span className="font-mono text-gray-900">{e.target_code || e.code || '-'}</span>
                        {(e.target_type || e.type_text) && <div className="text-[10px] text-gray-500">{e.target_type || e.type_text}</div>}
                      </td>
                      <td className="py-1.5 pr-2">{e.action && <Badge tone={e.action === 'open' ? 'red' : 'green'}>{e.action.toUpperCase()}</Badge>}</td>
                      <td className="py-1.5 pr-2 text-gray-700">{e.category || '-'}</td>
                      <td className="py-1.5 pr-2">
                        <Badge tone={TONE[e.result]}>{S(e.result)}</Badge>
                      </td>
                      <td className="py-1.5 text-gray-700">
                        {e.message}
                        {(e.maneuver_id || e.outage_id) && (
                          <div className="text-[10px] text-gray-500">
                            {e.maneuver_id && `${S('maneuver')} #${e.maneuver_id}`}
                            {e.outage_id && ` · ${S('outage')} #${e.outage_id}`}
                            {e.event_id && ` · ${e.event_id}`}
                          </div>
                        )}
                      </td>
                    </tr>
                    {open === e.id && (
                      <tr className="border-b border-gray-100">
                        <td colSpan={7} className="py-2">
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
                            {S('payload')}
                            {e.topic && ` · ${e.topic}`}
                            {e.partition !== null && ` · p${e.partition}`}
                            {e.offset !== null && ` @${e.offset}`} · {e.duration_ms} ms
                          </div>
                          <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] text-gray-800">{JSON.stringify(e.payload, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {more && (
              <div className="mt-2 text-center">
                <Button size="sm" variant="secondary" onClick={() => load(items[items.length - 1].id)}>
                  {S('more')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
