'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, api, getToken } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import type { ComponentType } from '@/lib/types';
import { Badge, Button, Confirm, PageHeader, Spinner, useToast } from '@/components/ui';

// ---------------------------------------------------------------- kamus

const ID = {
  title: 'Impor GDB',
  subtitle: 'Impor jaringan dari Esri File Geodatabase PLN (geometric network) ke peta jaringan — ditulis langsung, tanpa alur persetujuan',
  upload: 'Unggah berkas',
  file: 'Berkas ZIP berisi folder .gdb',
  file_hint: 'Kompres folder *.gdb menjadi ZIP (maks. 1 GB).',
  tag: 'Tag batch',
  tag_hint: 'Penanda semua objek hasil impor (untuk hapus / impor ulang). Tag yang sama menggantikan impor sebelumnya.',
  assign_units: 'Tetapkan unit pemilik dari lokasi (ULP / UP3)',
  keep_staging: 'Simpan skema staging (untuk analisis data sumber)',
  start: 'Mulai impor',
  replace_warn: 'Tag {tag} sudah ada ({n} objek) — impor akan menggantikan batch tersebut.',
  uploading: 'Mengunggah… {p}%',
  job: 'Proses impor',
  running: 'Berjalan',
  done: 'Selesai',
  failed: 'Gagal',
  deleted: 'Dihapus',
  replaced: 'Digantikan',
  pending: 'menunggu',
  skipped: 'dilewati',
  st_extract: 'Ekstrak ZIP & periksa layer',
  st_stage: 'Muat layer ke skema staging (ogr2ogr)',
  st_map: 'Petakan tipe, potong garis di simpul, tulis jaringan',
  st_units: 'Tetapkan unit pemilik',
  st_cleanup: 'Hapus skema staging',
  st_reload: 'Bangun ulang topologi',
  result: 'Hasil impor',
  nodes: 'Objek titik',
  edges: 'Saluran',
  customers: 'Pelanggan',
  cuts: 'Potongan garis di simpul',
  synth: 'Sambungan sintesis',
  gaps: 'Ujung JTM terputus di GI',
  units_assigned: 'Aset diberi unit',
  batches: 'Riwayat impor',
  col_tag: 'Tag',
  col_file: 'Berkas',
  col_status: 'Status',
  col_objects: 'Objek / saluran',
  col_by: 'Oleh',
  col_time: 'Waktu',
  staging: 'staging',
  empty: 'Belum ada impor.',
  del: 'Hapus batch',
  del_title: 'Hapus batch {tag}?',
  del_msg: 'Menghapus {nodes} objek dan {edges} saluran hasil impor. Topologi dibangun ulang setelahnya.',
  del_foreign: '{n} saluran lain (digambar manual) tersambung ke objek batch ini dan ikut terhapus.',
  deleted_ok: 'Batch {tag} dihapus.',
  started: 'Impor {tag} dimulai.',
  finished: 'Impor {tag} selesai.',
  mapping: 'Pemetaan layer',
  mapping_rows: [
    'JTM → SUTM / SKTM (XLPE) · MVCABLE → SKTM · JTR → SKUTR · LVCABLE → SKTR · SR → SR',
    'BUSBAR_LINE → rel GI / rel gardu / SKTR (…_TR) · GI (poligon) → GI · TRAFO_GI → trafo GI',
    'MVCELL → FCO (fungsi TRAFO) / PMT (CB, METERING) / LBS · SWITCH → switch jurusan TR (sisi TR) / PMS',
    'GD → gardu (BLOKGARDU = denah) · TRAFO → trafo distribusi · PHBTR → rak TR · PELANGGAN → pelanggan TR',
    'TIANG → tiang TM / TR (objek pendukung, tidak tersambung) · JOINTING & junction → junction',
    'Status INACTIVE → terbuka. Garis dipotong di setiap titik jaringan di tengahnya; kepala penyulang di GI disintesis bila ada celah.',
  ],
  required: 'Layer wajib',
  poll_err: 'Status impor tidak dapat dibaca',
  no_job: 'Tidak ada impor yang berjalan sejak server terakhir dijalankan — lihat riwayat di bawah.',
};
type Dict = typeof ID;
const EN: Dict = {
  title: 'GDB Import',
  subtitle: 'Import a network from a PLN Esri File Geodatabase (geometric network) into the network map — written directly, without the approval workflow',
  upload: 'Upload file',
  file: 'ZIP file containing the .gdb folder',
  file_hint: 'Compress the *.gdb folder into a ZIP (max 1 GB).',
  tag: 'Batch tag',
  tag_hint: 'Marks every imported object (for delete / re-import). Reusing a tag replaces the earlier import.',
  assign_units: 'Assign owner unit from location (ULP / UP3)',
  keep_staging: 'Keep the staging schema (for source-data analysis)',
  start: 'Start import',
  replace_warn: 'Tag {tag} already exists ({n} objects) — the import will replace that batch.',
  uploading: 'Uploading… {p}%',
  job: 'Import progress',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  deleted: 'Deleted',
  replaced: 'Replaced',
  pending: 'pending',
  skipped: 'skipped',
  st_extract: 'Extract ZIP & check layers',
  st_stage: 'Load layers into the staging schema (ogr2ogr)',
  st_map: 'Map types, split lines at nodes, write network',
  st_units: 'Assign owner units',
  st_cleanup: 'Drop staging schema',
  st_reload: 'Rebuild topology',
  result: 'Import result',
  nodes: 'Point objects',
  edges: 'Lines',
  customers: 'Customers',
  cuts: 'Line splits at nodes',
  synth: 'Synthetic links',
  gaps: 'Disconnected MV ends in GI',
  units_assigned: 'Assets assigned a unit',
  batches: 'Import history',
  col_tag: 'Tag',
  col_file: 'File',
  col_status: 'Status',
  col_objects: 'Objects / lines',
  col_by: 'By',
  col_time: 'Time',
  staging: 'staging',
  empty: 'No imports yet.',
  del: 'Delete batch',
  del_title: 'Delete batch {tag}?',
  del_msg: 'Deletes {nodes} objects and {edges} imported lines. The topology is rebuilt afterwards.',
  del_foreign: '{n} other (hand-drawn) lines are connected to this batch and will be deleted too.',
  deleted_ok: 'Batch {tag} deleted.',
  started: 'Import {tag} started.',
  finished: 'Import {tag} finished.',
  mapping: 'Layer mapping',
  mapping_rows: [
    'JTM → overhead MV / MV cable (XLPE) · MVCABLE → MV cable · JTR → LV twisted · LVCABLE → LV cable · SR → service drop',
    'BUSBAR_LINE → GI busbar / substation busbar / LV cable (…_TR) · GI (polygon) → GI · TRAFO_GI → GI transformer',
    'MVCELL → FCO (TRAFO function) / CB (CB, METERING) / LBS · SWITCH → LV route switch (LV side) / disconnector',
    'GD → substation (BLOKGARDU = footprint) · TRAFO → distribution transformer · PHBTR → LV rack · PELANGGAN → LV customer',
    'TIANG → MV / LV pole (support object, not connected) · JOINTING & junction → junction',
    'Status INACTIVE → open. Lines are split at every network point along them; feeder heads in a GI are synthesised when there is a gap.',
  ],
  required: 'Required layers',
  poll_err: 'Cannot read import status',
  no_job: 'No import has run since the server last started — see the history below.',
};

function useG() {
  const { locale } = useT();
  return useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const d = (locale === 'en' ? EN : ID) as unknown as Record<string, string>;
      let s = typeof d[key] === 'string' ? d[key] : key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
    [locale],
  );
}

// ---------------------------------------------------------------- tipe

interface Step {
  key: 'extract' | 'stage' | 'map' | 'units' | 'cleanup' | 'reload';
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  ms?: number;
}
interface TypeCount {
  type: string;
  count: number;
  km?: number;
}
interface Summary {
  nodes?: TypeCount[];
  edges?: TypeCount[];
  line_cuts?: number;
  synthetic_links?: number;
  gi_feeder_gaps?: number;
  gi_feeder_paired?: number;
  units_assigned?: number;
  schema?: string;
}
interface Job {
  id: number;
  tag: string;
  file_name: string;
  status: 'running' | 'done' | 'failed';
  steps: Step[];
  summary?: Summary;
  error?: string;
  started_at: string;
  finished_at?: string;
}
interface Batch {
  id: number;
  tag: string;
  file_name: string;
  file_bytes: number;
  status: 'running' | 'done' | 'failed' | 'replaced' | 'deleted';
  error?: string;
  summary: Summary;
  created_by: string;
  started_at: string;
  finished_at: string | null;
  nodes: number;
  edges: number;
  customers: number;
  staging: boolean;
}
interface DelPreview {
  nodes: number;
  edges: number;
  foreign_edges: number;
}

const STATUS_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'amber'> = { running: 'blue', done: 'green', failed: 'red', deleted: 'gray', replaced: 'gray' };

function tagFromName(name: string): string {
  return name
    .replace(/\.zip$/i, '')
    .replace(/\.gdb$/i, '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 40)
    .toUpperCase();
}

function fmtMs(ms?: number) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
}

function fmtWhen(s: string | null | undefined, locale: string) {
  if (!s) return '-';
  return new Date(s).toLocaleString(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------- halaman

export default function GdbImport() {
  const G = useG();
  const { locale } = useT();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [tag, setTag] = useState('');
  const [assignUnits, setAssignUnits] = useState(true);
  const [keepStaging, setKeepStaging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [layers, setLayers] = useState<string[]>([]);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [types, setTypes] = useState<Record<string, ComponentType>>({});
  const [del, setDel] = useState<{ b: Batch; p: DelPreview } | null>(null);
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const lastStatus = useRef<string>('');

  const loadBatches = useCallback(async () => {
    try {
      const r = await api<{ items: Batch[] }>('/api/admin/gdb-import/batches');
      setBatches(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
      setBatches([]);
    }
  }, [toast]);

  const poll = useCallback(async () => {
    try {
      const r = await api<{ job: Job | null; layers: string[] }>('/api/admin/gdb-import/status');
      setJob(r.job);
      setLayers(r.layers);
      const st = r.job ? `${r.job.id}:${r.job.status}` : '';
      if (r.job && lastStatus.current && lastStatus.current !== st && lastStatus.current.startsWith(`${r.job.id}:running`)) {
        if (r.job.status === 'done') toast.push(G('finished', { tag: r.job.tag }), 'success');
        loadBatches();
      }
      lastStatus.current = st;
    } catch (e: any) {
      toast.push(`${G('poll_err')}: ${e.message}`, 'error');
    }
  }, [G, loadBatches, toast]);

  useEffect(() => {
    poll();
    loadBatches();
    api<{ items: ComponentType[] }>('/api/gis/types')
      .then((r) => setTypes(Object.fromEntries(r.items.map((t) => [t.code, t]))))
      .catch(() => {});
  }, [poll, loadBatches]);

  const running = job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [running, poll]);

  const typeName = (code: string) => {
    const t = types[code];
    if (!t) return code;
    return (locale === 'en' && t.name_en) || t.name;
  };

  const existing = useMemo(() => batches?.find((b) => b.tag === tag.trim() && b.status === 'done' && b.nodes > 0), [batches, tag]);
  const tagOk = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(tag.trim());

  const start = () => {
    if (!file || !tagOk) return;
    const qs = new URLSearchParams({ tag: tag.trim(), name: file.name, assign_units: assignUnits ? '1' : '0', keep_staging: keepStaging ? '1' : '0' });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/admin/gdb-import?${qs}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.setRequestHeader('X-Lang', locale);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      setProgress(null);
      let j: any = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* abaikan */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        toast.push(G('started', { tag: tag.trim() }), 'success');
        lastStatus.current = `${j.id}:running`;
        setJob(j);
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        loadBatches();
      } else {
        toast.push(j.error || xhr.statusText || `HTTP ${xhr.status}`, 'error');
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      toast.push('network error', 'error');
    };
    setProgress(0);
    xhr.send(file);
  };

  const askDelete = async (b: Batch) => {
    setBusy(`pre:${b.tag}`);
    try {
      const p = await api<DelPreview>(`/api/admin/gdb-import/batches/${encodeURIComponent(b.tag)}?apply=0`, { method: 'DELETE' });
      setDel({ b, p });
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const summary = job?.status === 'done' ? job.summary : undefined;
  const custCount = (s?: Summary) => (s?.nodes || []).filter((n) => n.type.startsWith('pelanggan')).reduce((a, n) => a + n.count, 0);

  return (
    <div className="space-y-4">
      <PageHeader title={G('title')} subtitle={G('subtitle')} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* unggah */}
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-gray-900">{G('upload')}</h3>
          <div>
            <label className="label" htmlFor="gdb-file">
              {G('file')}
            </label>
            <input
              id="gdb-file"
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
              disabled={running || progress !== null}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setFile(f);
                if (f && !tag) setTag(tagFromName(f.name));
              }}
            />
            <p className="mt-1 text-xs text-gray-500">
              {G('file_hint')}
              {file && ` · ${file.name} (${fmtNum(file.size / 1048576, 1)} MB)`}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="gdb-tag">
              {G('tag')}
            </label>
            <input id="gdb-tag" className="input font-mono" value={tag} maxLength={40} onChange={(e) => setTag(e.target.value)} placeholder="KJT-05082026" />
            <p className="mt-1 text-xs text-gray-500">{G('tag_hint')}</p>
            {existing && <p className="mt-1 text-xs text-amber-600">{G('replace_warn', { tag: existing.tag, n: fmtNum(existing.nodes + existing.edges) })}</p>}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={assignUnits} onChange={(e) => setAssignUnits(e.target.checked)} />
            {G('assign_units')}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={keepStaging} onChange={(e) => setKeepStaging(e.target.checked)} />
            {G('keep_staging')}
          </label>
          <div className="flex items-center gap-3">
            <Button icon="database" disabled={!file || !tagOk || running || progress !== null} loading={progress !== null} onClick={start}>
              {G('start')}
            </Button>
            {progress !== null && (
              <div className="flex flex-1 items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded bg-gray-200">
                  <div className="h-full bg-brand-600 transition-all" style={{ width: `${progress}%` }} />
                </div>
                <span className="text-xs tabular-nums text-gray-600">{G('uploading', { p: progress })}</span>
              </div>
            )}
          </div>

          <details className="rounded-md border border-gray-200 p-2 text-xs text-gray-600">
            <summary className="cursor-pointer font-medium text-gray-800">{G('mapping')}</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {(locale === 'en' ? EN : ID).mapping_rows.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {layers.length > 0 && (
              <p className="mt-2">
                <span className="font-medium text-gray-800">{G('required')}:</span> <span className="font-mono text-[11px]">{layers.join(', ')}</span>
              </p>
            )}
          </details>
        </div>

        {/* proses */}
        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{G('job')}</h3>
            {job && (
              <>
                <span className="font-mono text-xs text-gray-700">{job.tag}</span>
                <Badge tone={STATUS_TONE[job.status]}>{G(job.status)}</Badge>
              </>
            )}
          </div>
          {!job ? (
            <p className="text-sm text-gray-500">{G('no_job')}</p>
          ) : (
            <>
              <ol className="space-y-1.5">
                {job.steps.map((s) => (
                  <li key={s.key} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                      {s.status === 'running' ? (
                        <Spinner size={14} className="text-brand-600" />
                      ) : (
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            s.status === 'done' ? 'bg-emerald-500' : s.status === 'failed' ? 'bg-red-500' : s.status === 'skipped' ? 'bg-gray-300' : 'border border-gray-400'
                          }`}
                        />
                      )}
                    </span>
                    <span className={s.status === 'pending' || s.status === 'skipped' ? 'text-gray-500' : 'text-gray-800'}>
                      {G(`st_${s.key}`)}
                      {(s.status === 'pending' || s.status === 'skipped') && <span className="ml-1 text-xs">({G(s.status)})</span>}
                      {s.detail && s.status !== 'failed' && <span className="ml-1 font-mono text-xs text-gray-500">{s.detail}</span>}
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-gray-500">{fmtMs(s.ms)}</span>
                  </li>
                ))}
              </ol>
              {job.error && <p className="whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50 p-2 font-mono text-xs text-red-700">{job.error}</p>}
              {summary && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{G('result')}</h4>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                    <Kv k={G('nodes')} v={fmtNum((summary.nodes || []).reduce((a, n) => a + n.count, 0))} />
                    <Kv
                      k={G('edges')}
                      v={`${fmtNum((summary.edges || []).reduce((a, n) => a + n.count, 0))} · ${fmtNum(
                        (summary.edges || []).reduce((a, n) => a + (n.km || 0), 0),
                        0,
                      )} km`}
                    />
                    <Kv k={G('customers')} v={fmtNum(custCount(summary))} />
                    <Kv k={G('cuts')} v={fmtNum(summary.line_cuts)} />
                    <Kv k={G('synth')} v={fmtNum(summary.synthetic_links)} />
                    <Kv k={G('gaps')} v={`${fmtNum(summary.gi_feeder_gaps)} (${fmtNum(summary.gi_feeder_paired)} ↔ switch)`} />
                    {summary.units_assigned !== undefined && <Kv k={G('units_assigned')} v={fmtNum(summary.units_assigned)} />}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TypeTable rows={summary.nodes || []} name={typeName} />
                    <TypeTable rows={summary.edges || []} name={typeName} km />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* riwayat */}
      <div className="card p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">{G('batches')}</h3>
        {batches === null ? (
          <Spinner />
        ) : batches.length === 0 ? (
          <p className="text-sm text-gray-500">{G('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1">{G('col_tag')}</th>
                  <th className="py-1">{G('col_file')}</th>
                  <th className="py-1">{G('col_status')}</th>
                  <th className="py-1 text-right">{G('col_objects')}</th>
                  <th className="py-1 text-right">{G('customers')}</th>
                  <th className="py-1 pl-3">{G('col_by')}</th>
                  <th className="py-1">{G('col_time')}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b border-gray-100 align-top">
                    <td className="py-1.5 font-mono text-[11px] text-gray-900">
                      {b.tag}
                      {b.staging && (
                        <span className="ml-1">
                          <Badge tone="purple">{G('staging')}</Badge>
                        </span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate py-1.5 text-gray-700" title={b.file_name}>
                      {b.file_name || '-'}
                      {b.file_bytes > 0 && <span className="text-gray-500"> · {fmtNum(b.file_bytes / 1048576, 1)} MB</span>}
                    </td>
                    <td className="py-1.5">
                      <Badge tone={STATUS_TONE[b.status]}>{G(b.status)}</Badge>
                      {b.error && (
                        <div className="mt-0.5 max-w-[260px] truncate text-[10px] text-red-600" title={b.error}>
                          {b.error}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-gray-700">
                      {fmtNum(b.nodes)} / {fmtNum(b.edges)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-gray-700">{fmtNum(b.customers)}</td>
                    <td className="py-1.5 pl-3 text-gray-700">{b.created_by}</td>
                    <td className="py-1.5 text-gray-700">{fmtWhen(b.finished_at || b.started_at, locale)}</td>
                    <td className="py-1.5 text-right">
                      {((b.status === 'done' && (b.nodes > 0 || b.edges > 0)) || (b.status !== 'running' && b.staging)) && (
                        <Button size="sm" variant="ghost" icon="trash" disabled={running} loading={busy === `pre:${b.tag}`} onClick={() => askDelete(b)} aria-label={G('del')}>
                          {G('del')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Confirm
        open={!!del}
        title={del ? G('del_title', { tag: del.b.tag }) : ''}
        loading={busy === 'del'}
        message={
          del && (
            <div className="space-y-2">
              <p>{G('del_msg', { nodes: fmtNum(del.p.nodes), edges: fmtNum(del.p.edges) })}</p>
              {del.p.foreign_edges > 0 && <p className="text-amber-600">{G('del_foreign', { n: fmtNum(del.p.foreign_edges) })}</p>}
            </div>
          )
        }
        onCancel={() => setDel(null)}
        onConfirm={async () => {
          if (!del) return;
          setBusy('del');
          try {
            await api(`/api/admin/gdb-import/batches/${encodeURIComponent(del.b.tag)}?apply=1`, { method: 'DELETE' });
            toast.push(G('deleted_ok', { tag: del.b.tag }), 'success');
            setDel(null);
            loadBatches();
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

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{k}</div>
      <div className="font-semibold tabular-nums text-gray-900">{v}</div>
    </div>
  );
}

function TypeTable({ rows, name, km }: { rows: TypeCount[]; name: (c: string) => string; km?: boolean }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map((r) => (
          <tr key={r.type} className="border-b border-gray-100">
            <td className="py-0.5 text-gray-700">{name(r.type)}</td>
            <td className="py-0.5 text-right tabular-nums text-gray-900">{fmtNum(r.count)}</td>
            {km && <td className="py-0.5 pl-2 text-right tabular-nums text-gray-500">{fmtNum(r.km, 1)} km</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
