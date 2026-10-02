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
  subtitle:
    'Impor jaringan dari Esri File Geodatabase PLN (geometric network). GDB dibandingkan dulu dengan data yang sudah ada; perubahan ditinjau lalu diterapkan per objek — tanpa alur persetujuan',
  upload: 'Unggah berkas',
  file: 'Berkas ZIP berisi folder .gdb',
  file_hint: 'Kompres folder *.gdb menjadi ZIP (maks. 1 GB).',
  tag: 'Tag batch',
  tag_hint: 'Penanda semua objek hasil impor. Tag yang sama = pembaruan batch: GDB dibandingkan dengan batch itu dan hanya perbedaannya yang diterapkan.',
  assign_units: 'Tetapkan unit pemilik dari lokasi (ULP / UP3) untuk aset yang belum punya unit',
  keep_staging: 'Simpan skema staging (untuk analisis data sumber)',
  start: 'Unggah & bandingkan',
  update_note: 'Tag {tag} sudah ada ({n} objek): GDB akan dibandingkan dengan batch tersebut dan Anda meninjau perubahannya sebelum diterapkan.',
  uploading: 'Mengunggah… {p}%',
  job: 'Proses impor',
  running: 'Berjalan',
  review: 'Menunggu tinjauan',
  done: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  deleted: 'Dihapus',
  replaced: 'Versi lama',
  pending: 'menunggu',
  skipped: 'dilewati',
  st_extract: 'Ekstrak ZIP & periksa layer',
  st_stage: 'Muat layer ke skema staging (ogr2ogr)',
  st_map: 'Petakan tipe & potong garis di simpul (staging)',
  st_diff: 'Bandingkan dengan data yang sudah ada',
  st_apply: 'Terapkan perubahan per objek',
  st_units: 'Tetapkan unit pemilik',
  st_cleanup: 'Hapus skema staging',
  st_reload: 'Bangun ulang topologi',
  review_wait: 'Menunggu keputusan Anda — lihat pratinjau perubahan di bawah. Peta belum berubah.',
  result: 'Hasil impor',
  nodes: 'Objek titik',
  edges: 'Saluran',
  customers: 'Pelanggan',
  cuts: 'Potongan garis di simpul',
  synth: 'Sambungan sintesis',
  gaps: 'Ujung JTM terputus di GI',
  units_assigned: 'Aset diberi unit',
  applied_title: 'Yang diterapkan',
  f_insert: 'ditambah',
  f_update: 'diubah',
  f_delete: 'dihapus',
  f_keep: 'dipertahankan',
  f_same: 'sama',
  f_skip: 'dilewati (ujung tidak ada)',
  layout_note: 'Denah gardu: {r} dikembalikan ke posisi asli, {g} diperbesar ulang.',
  // pratinjau
  pv_title: 'Pratinjau perubahan',
  pv_hint: 'Belum ada yang ditulis ke peta. Tinjau perbedaan GDB baru dengan data yang sudah ada, lalu terapkan atau batalkan.',
  pv_new_batch: 'Tag baru: semua objek akan ditambahkan.',
  pv_legacy: 'Batch ini diimpor sebelum ada perbandingan: perubahan di QuadranGIS dikenali dari riwayat editor sejak {since}.',
  pv_none: 'Tidak ada perbedaan: GDB sama dengan data yang sudah ada.',
  a_insert: 'Baru',
  a_update: 'Berubah',
  a_delete: 'Dihapus di GDB',
  a_conflict: 'Konflik',
  a_local: 'Diubah lokal',
  a_same: 'Sama',
  h_insert: 'ada di GDB, belum ada di peta',
  h_update: 'berubah di GDB, tidak diubah di QuadranGIS',
  h_delete: 'tidak ada lagi di GDB',
  h_conflict: 'berubah di dua sisi',
  h_local: 'diubah di QuadranGIS, GDB tetap — dipertahankan',
  h_same: 'tidak berubah',
  k_node: 'titik',
  k_edge: 'saluran',
  r_both_changed: 'diubah di QuadranGIS & di GDB',
  r_deleted_local: 'dihapus di QuadranGIS, berubah di GDB',
  r_changed_local: 'diubah di QuadranGIS, tidak ada lagi di GDB',
  r_used_by_local: 'masih dipakai saluran lain (tidak dihapus)',
  r_edited: 'diubah di QuadranGIS',
  r_deleted: 'dihapus di QuadranGIS',
  r_kept: 'sudah tidak ada di GDB, dipertahankan',
  fl_geometry: 'geometri',
  fl_footprint: 'denah',
  fl_type: 'tipe',
  fl_code: 'kode',
  fl_name: 'nama',
  fl_props: 'atribut',
  parts: 'Bagian yang berubah',
  top_attrs: 'Atribut yang paling sering berubah',
  by_type: 'Per tipe',
  col_type: 'Tipe',
  refs_title: '{n} objek yang akan dihapus masih dirujuk data lain:',
  src_maneuvers: 'riwayat manuver',
  src_outages: 'kejadian padam',
  src_photos: 'foto aset',
  src_scada_points: 'titik SCADA',
  src_plan_steps: 'langkah rencana manuver',
  src_customer_kwh: 'data kWh pelanggan',
  overlap: 'GlobalID yang sama sudah ada di batch lain — kemungkinan jaringan ganda:',
  no_tag: '(tanpa tag)',
  list: 'Daftar perbedaan',
  all: 'Semua',
  all_kinds: 'Titik & saluran',
  all_types: 'Semua tipe',
  search: 'Cari kode / nama, Enter',
  more: 'Muat berikutnya',
  shown: '{n} dari {total}',
  col_action: 'Perbedaan',
  col_object: 'Objek',
  col_detail: 'Rincian',
  d_new: 'objek baru',
  d_gone: 'tidak ada di GDB',
  d_move: 'geser {m} m',
  d_fp: 'denah berubah',
  d_more: '+{n} atribut',
  d_refs: '{n} rujukan',
  empty_val: '(kosong)',
  map: 'Peta',
  decide: 'Keputusan',
  decide_hint: 'Rincian per tipe & daftar perbedaan ada di bawah.',
  to_decide: 'Ke keputusan (Terapkan / Batalkan)',
  c_keep: 'Pertahankan data QuadranGIS',
  c_keep_hint: 'disarankan: editan di QuadranGIS tidak ditimpa',
  c_gdb: 'Pakai data GDB',
  c_gdb_hint: 'editan di QuadranGIS ditimpa; objek yang dihapus lokal dibuat lagi',
  conflict_for: 'Untuk {n} konflik:',
  deletes: 'Hapus {n} objek yang tidak ada lagi di GDB',
  apply: 'Terapkan perubahan',
  cancel: 'Batalkan',
  apply_title: 'Terapkan perubahan GDB {tag}?',
  apply_msg: '{ins} baru, {upd} diubah, {del} dihapus; {conf} konflik: {policy}.',
  apply_note:
    'GDB dibandingkan ulang saat diterapkan. Id objek yang sudah ada tetap, sehingga riwayat manuver, foto, dan titik SCADA tetap terhubung. Status buka/tutup, unit, dan atribut isian di luar GDB tidak diubah.',
  p_keep: 'data QuadranGIS dipertahankan',
  p_gdb: 'diganti data GDB',
  cancel_ok: 'Pratinjau dibatalkan; peta tidak berubah.',
  compared: 'Perbandingan {tag} selesai — tinjau perubahannya.',
  applied_ok: 'Perubahan {tag} diterapkan.',
  // riwayat
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
  mapping: 'Pemetaan layer',
  mapping_rows: [
    'JTM → SUTM / SKTM (XLPE) · MVCABLE → SKTM · JTR → SKUTR · LVCABLE → SKTR · SR → SR',
    'BUSBAR_LINE → rel GI / rel gardu / SKTR (…_TR) · GI (poligon) → GI · TRAFO_GI → trafo GI',
    'MVCELL → FCO (fungsi TRAFO) / PMT (CB, METERING) / LBS · SWITCH → switch jurusan TR (sisi TR) / PMS',
    'GD → gardu (BLOKGARDU = denah) · TRAFO → trafo distribusi · PHBTR → rak TR · PELANGGAN → pelanggan TR',
    'TIANG → tiang TM / TR (objek pendukung, tidak tersambung) · JOINTING & junction → junction',
    'Status INACTIVE → terbuka. Garis dipotong di setiap titik jaringan di tengahnya; kepala penyulang di GI disintesis bila ada celah.',
    'Identitas objek untuk perbandingan: GlobalID ESRI; junction & ujung garis menurut posisi (1 cm); GI menurut nama; saluran = GlobalID garis + kedua ujungnya.',
  ],
  required: 'Layer wajib',
  poll_err: 'Status impor tidak dapat dibaca',
  no_job: 'Tidak ada impor yang berjalan sejak server terakhir dijalankan — lihat riwayat di bawah.',
};
type Dict = typeof ID;
const EN: Dict = {
  title: 'GDB Import',
  subtitle:
    'Import a network from a PLN Esri File Geodatabase (geometric network). The GDB is first compared with the existing data; changes are reviewed and then applied per object — without the approval workflow',
  upload: 'Upload file',
  file: 'ZIP file containing the .gdb folder',
  file_hint: 'Compress the *.gdb folder into a ZIP (max 1 GB).',
  tag: 'Batch tag',
  tag_hint: 'Marks every imported object. Reusing a tag updates that batch: the GDB is compared with it and only the differences are applied.',
  assign_units: 'Assign owner unit from location (ULP / UP3) to assets without a unit',
  keep_staging: 'Keep the staging schema (for source-data analysis)',
  start: 'Upload & compare',
  update_note: 'Tag {tag} already exists ({n} objects): the GDB will be compared with that batch and you review the changes before they are applied.',
  uploading: 'Uploading… {p}%',
  job: 'Import progress',
  running: 'Running',
  review: 'Awaiting review',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
  replaced: 'Older version',
  pending: 'pending',
  skipped: 'skipped',
  st_extract: 'Extract ZIP & check layers',
  st_stage: 'Load layers into the staging schema (ogr2ogr)',
  st_map: 'Map types & split lines at nodes (staging)',
  st_diff: 'Compare with the existing data',
  st_apply: 'Apply changes per object',
  st_units: 'Assign owner units',
  st_cleanup: 'Drop staging schema',
  st_reload: 'Rebuild topology',
  review_wait: 'Waiting for your decision — see the change preview below. The map has not changed yet.',
  result: 'Import result',
  nodes: 'Point objects',
  edges: 'Lines',
  customers: 'Customers',
  cuts: 'Line splits at nodes',
  synth: 'Synthetic links',
  gaps: 'Disconnected MV ends in GI',
  units_assigned: 'Assets assigned a unit',
  applied_title: 'Applied',
  f_insert: 'added',
  f_update: 'updated',
  f_delete: 'deleted',
  f_keep: 'kept',
  f_same: 'unchanged',
  f_skip: 'skipped (missing end)',
  layout_note: 'Substation layouts: {r} restored to the original position, {g} enlarged again.',
  pv_title: 'Change preview',
  pv_hint: 'Nothing has been written to the map yet. Review the differences between the new GDB and the existing data, then apply or cancel.',
  pv_new_batch: 'New tag: every object will be added.',
  pv_legacy: 'This batch was imported before comparison existed: QuadranGIS changes are recognised from the editor history since {since}.',
  pv_none: 'No differences: the GDB matches the existing data.',
  a_insert: 'New',
  a_update: 'Changed',
  a_delete: 'Removed in GDB',
  a_conflict: 'Conflict',
  a_local: 'Changed locally',
  a_same: 'Same',
  h_insert: 'in the GDB, not yet on the map',
  h_update: 'changed in the GDB, not edited in QuadranGIS',
  h_delete: 'no longer in the GDB',
  h_conflict: 'changed on both sides',
  h_local: 'edited in QuadranGIS, GDB unchanged — kept',
  h_same: 'unchanged',
  k_node: 'point',
  k_edge: 'line',
  r_both_changed: 'edited in QuadranGIS & changed in the GDB',
  r_deleted_local: 'deleted in QuadranGIS, changed in the GDB',
  r_changed_local: 'edited in QuadranGIS, no longer in the GDB',
  r_used_by_local: 'still used by other lines (not deleted)',
  r_edited: 'edited in QuadranGIS',
  r_deleted: 'deleted in QuadranGIS',
  r_kept: 'no longer in the GDB, kept',
  fl_geometry: 'geometry',
  fl_footprint: 'footprint',
  fl_type: 'type',
  fl_code: 'code',
  fl_name: 'name',
  fl_props: 'attributes',
  parts: 'Changed parts',
  top_attrs: 'Most frequently changed attributes',
  by_type: 'Per type',
  col_type: 'Type',
  refs_title: '{n} objects to be deleted are still referenced by other data:',
  src_maneuvers: 'switching history',
  src_outages: 'outage events',
  src_photos: 'asset photos',
  src_scada_points: 'SCADA points',
  src_plan_steps: 'switching plan steps',
  src_customer_kwh: 'customer kWh data',
  overlap: 'The same GlobalIDs already exist in another batch — possibly a duplicated network:',
  no_tag: '(no tag)',
  list: 'Differences',
  all: 'All',
  all_kinds: 'Points & lines',
  all_types: 'All types',
  search: 'Search code / name, Enter',
  more: 'Load more',
  shown: '{n} of {total}',
  col_action: 'Difference',
  col_object: 'Object',
  col_detail: 'Details',
  d_new: 'new object',
  d_gone: 'not in the GDB',
  d_move: 'moved {m} m',
  d_fp: 'footprint changed',
  d_more: '+{n} attributes',
  d_refs: '{n} references',
  empty_val: '(empty)',
  map: 'Map',
  decide: 'Decision',
  decide_hint: 'Per-type details & the list of differences are below.',
  to_decide: 'Go to decision (Apply / Cancel)',
  c_keep: 'Keep QuadranGIS data',
  c_keep_hint: 'recommended: QuadranGIS edits are not overwritten',
  c_gdb: 'Use GDB data',
  c_gdb_hint: 'QuadranGIS edits are overwritten; objects deleted locally are recreated',
  conflict_for: 'For {n} conflicts:',
  deletes: 'Delete {n} objects that are no longer in the GDB',
  apply: 'Apply changes',
  cancel: 'Cancel',
  apply_title: 'Apply GDB changes {tag}?',
  apply_msg: '{ins} new, {upd} updated, {del} deleted; {conf} conflicts: {policy}.',
  apply_note:
    'The GDB is compared again when applied. Existing object ids are kept, so switching history, photos, and SCADA points stay linked. Open/closed state, units, and attributes outside the GDB are not changed.',
  p_keep: 'QuadranGIS data kept',
  p_gdb: 'replaced by GDB data',
  cancel_ok: 'Preview cancelled; the map is unchanged.',
  compared: 'Comparison of {tag} finished — review the changes.',
  applied_ok: 'Changes of {tag} applied.',
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
  mapping: 'Layer mapping',
  mapping_rows: [
    'JTM → overhead MV / MV cable (XLPE) · MVCABLE → MV cable · JTR → LV twisted · LVCABLE → LV cable · SR → service drop',
    'BUSBAR_LINE → GI busbar / substation busbar / LV cable (…_TR) · GI (polygon) → GI · TRAFO_GI → GI transformer',
    'MVCELL → FCO (TRAFO function) / CB (CB, METERING) / LBS · SWITCH → LV route switch (LV side) / disconnector',
    'GD → substation (BLOKGARDU = footprint) · TRAFO → distribution transformer · PHBTR → LV rack · PELANGGAN → LV customer',
    'TIANG → MV / LV pole (support object, not connected) · JOINTING & junction → junction',
    'Status INACTIVE → open. Lines are split at every network point along them; feeder heads in a GI are synthesised when there is a gap.',
    'Object identity for comparison: ESRI GlobalID; junctions & line ends by position (1 cm); GI by name; lines = line GlobalID + both ends.',
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

type Action = 'insert' | 'update' | 'delete' | 'conflict' | 'local' | 'same';
const ACTIONS: Action[] = ['insert', 'update', 'delete', 'conflict', 'local', 'same'];
const ACTION_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'amber' | 'purple'> = {
  insert: 'green',
  update: 'blue',
  delete: 'red',
  conflict: 'amber',
  local: 'purple',
  same: 'gray',
};

interface Step {
  key: 'extract' | 'stage' | 'map' | 'diff' | 'apply' | 'units' | 'cleanup' | 'reload';
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  ms?: number;
}
interface TypeCount {
  type: string;
  count: number;
  km?: number;
}
interface Applied {
  nodes?: Record<string, number>;
  edges?: Record<string, number>;
  layout?: { restored: number; gardu: number; nodes: number; edges: number };
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
  applied?: Applied;
}
interface TypeDiff {
  kind: 'node' | 'edge';
  type: string;
  insert: number;
  update: number;
  delete: number;
  conflict: number;
  local: number;
  same: number;
}
interface Preview {
  nodes: Record<string, number>;
  edges: Record<string, number>;
  reasons: Record<string, number>;
  fields: Record<string, number>;
  attrs: { key: string; count: number }[];
  by_type: TypeDiff[];
  refs: Record<string, number>;
  ref_objects: number;
  overlap: { tag: string; count: number }[];
  existing: number;
  baseline: boolean;
  since?: string;
}
interface Job {
  id: number;
  tag: string;
  file_name: string;
  status: 'running' | 'review' | 'done' | 'failed' | 'cancelled';
  steps: Step[];
  summary?: Summary;
  preview?: Preview;
  error?: string;
  started_at: string;
  finished_at?: string;
}
interface Change {
  kind: 'node' | 'edge';
  key: string;
  action: Action;
  reason?: string;
  type: string;
  old_type?: string;
  code: string;
  name: string;
  id?: number;
  lng: number;
  lat: number;
  changes?: { type?: [string, string]; code?: [string, string]; name?: [string, string]; move_m?: number; footprint?: boolean; props?: Record<string, [unknown, unknown]> };
  refs?: number;
}
interface Batch {
  id: number;
  tag: string;
  file_name: string;
  file_bytes: number;
  status: 'running' | 'review' | 'done' | 'failed' | 'cancelled' | 'replaced' | 'deleted';
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

const STATUS_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'amber'> = {
  running: 'blue',
  review: 'amber',
  done: 'green',
  failed: 'red',
  cancelled: 'gray',
  deleted: 'gray',
  replaced: 'gray',
};

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

const sumOf = (m?: Record<string, number>, ...keys: string[]) => keys.reduce((a, k) => a + (m?.[k] || 0), 0);

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
        if (r.job.status === 'done') toast.push(G('applied_ok', { tag: r.job.tag }), 'success');
        if (r.job.status === 'review') toast.push(G('compared', { tag: r.job.tag }), 'success');
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
  const reviewing = job?.status === 'review';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [running, poll]);

  const typeName = useCallback(
    (code: string) => {
      const t = types[code];
      if (!t) return code;
      return (locale === 'en' && t.name_en) || t.name;
    },
    [types, locale],
  );

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
              disabled={running || reviewing || progress !== null}
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
            {existing && <p className="mt-1 text-xs text-blue-700">{G('update_note', { tag: existing.tag, n: fmtNum(existing.nodes + existing.edges) })}</p>}
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
            <Button icon="database" disabled={!file || !tagOk || running || reviewing || progress !== null} loading={progress !== null} onClick={start}>
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
                      {s.detail && s.status !== 'failed' && s.key !== 'diff' && <span className="ml-1 font-mono text-xs text-gray-500">{s.detail}</span>}
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-gray-500">{fmtMs(s.ms)}</span>
                  </li>
                ))}
              </ol>
              {reviewing && (
                <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                  <p>{G('review_wait')}</p>
                  <Button size="sm" icon="check" onClick={() => document.getElementById('gdb-keputusan')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                    {G('to_decide')}
                  </Button>
                </div>
              )}
              {job.error && <p className="whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50 p-2 font-mono text-xs text-red-700">{job.error}</p>}
              {summary && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{G('result')}</h4>
                  {summary.applied && <AppliedSummary a={summary.applied} G={G} />}
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

      {reviewing && job?.preview && (
        <PreviewPanel
          job={job}
          pv={job.preview}
          G={G}
          typeName={typeName}
          locale={locale}
          onDone={(j) => {
            lastStatus.current = `${j.id}:${j.status}`;
            setJob(j);
            loadBatches();
          }}
        />
      )}

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
                      {b.status === 'done' && b.summary?.applied && (
                        <div className="mt-0.5 text-[10px] text-gray-500">
                          +{fmtNum(sumOf(b.summary.applied.nodes, 'insert') + sumOf(b.summary.applied.edges, 'insert'))} · ~
                          {fmtNum(sumOf(b.summary.applied.nodes, 'update') + sumOf(b.summary.applied.edges, 'update'))} · −
                          {fmtNum(sumOf(b.summary.applied.nodes, 'delete') + sumOf(b.summary.applied.edges, 'delete'))}
                        </div>
                      )}
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
                      {((b.status === 'done' && (b.nodes > 0 || b.edges > 0)) || (b.status !== 'running' && b.status !== 'review' && b.staging)) && (
                        <Button size="sm" variant="ghost" icon="trash" disabled={running || reviewing} loading={busy === `pre:${b.tag}`} onClick={() => askDelete(b)} aria-label={G('del')}>
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

// ---------------------------------------------------------------- pratinjau

type GFn = (key: string, params?: Record<string, string | number>) => string;

function PreviewPanel({ job, pv, G, typeName, locale, onDone }: { job: Job; pv: Preview; G: GFn; typeName: (c: string) => string; locale: string; onDone: (j: Job) => void }) {
  const toast = useToast();
  const [conflict, setConflict] = useState<'keep' | 'gdb'>('keep');
  const [deletes, setDeletes] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState('');

  const total = (a: string) => (pv.nodes[a] || 0) + (pv.edges[a] || 0);
  const changes = total('insert') + total('update') + total('delete') + total('conflict');
  const policy = conflict === 'gdb' ? G('p_gdb') : G('p_keep');
  const reasonKeys = Object.keys(pv.reasons || {});
  const refKeys = Object.keys(pv.refs || {}).filter((k) => pv.refs[k] > 0);

  const apply = async () => {
    setBusy('apply');
    try {
      const j = await api<Job>('/api/admin/gdb-import/apply', { method: 'POST', body: { conflict, deletes } });
      setConfirm(false);
      onDone(j);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const cancel = async () => {
    setBusy('cancel');
    try {
      const j = await api<Job>('/api/admin/gdb-import/cancel', { method: 'POST' });
      toast.push(G('cancel_ok'), 'success');
      onDone(j);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="card space-y-4 p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">{G('pv_title')}</h3>
          <span className="font-mono text-xs text-gray-700">{job.tag}</span>
        </div>
        <p className="mt-0.5 text-xs text-gray-600">{G('pv_hint')}</p>
        {pv.existing === 0 && <p className="mt-1 text-xs text-blue-700">{G('pv_new_batch')}</p>}
        {pv.existing > 0 && !pv.baseline && pv.since && <p className="mt-1 text-xs text-gray-600">{G('pv_legacy', { since: fmtWhen(pv.since, locale) })}</p>}
        {changes === 0 && <p className="mt-1 text-xs font-medium text-emerald-700">{G('pv_none')}</p>}
      </div>

      {/* ringkasan per aksi */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {ACTIONS.map((a) => (
          <div key={a} className="rounded-md border border-gray-200 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <Badge tone={ACTION_TONE[a]}>{G(`a_${a}`)}</Badge>
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{fmtNum(total(a))}</div>
            <div className="text-[11px] tabular-nums text-gray-500">
              {fmtNum(pv.nodes[a] || 0)} {G('k_node')} · {fmtNum(pv.edges[a] || 0)} {G('k_edge')}
            </div>
            <div className="mt-0.5 text-[10px] leading-tight text-gray-500">{G(`h_${a}`)}</div>
          </div>
        ))}
      </div>

      {/* keputusan */}
      <div id="gdb-keputusan" className="scroll-mt-4 space-y-2 rounded-md border-2 border-brand-600 p-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{G('decide')}</h4>
          <span className="text-xs text-gray-500">{G('decide_hint')}</span>
        </div>
        {total('conflict') > 0 && (
          <fieldset className="space-y-1 text-sm text-gray-800">
            <legend className="mb-1 text-xs text-gray-600">{G('conflict_for', { n: fmtNum(total('conflict')) })}</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="gdb-conflict" className="mt-1" checked={conflict === 'keep'} onChange={() => setConflict('keep')} />
              <span>
                {G('c_keep')} <span className="text-xs text-gray-500">— {G('c_keep_hint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="gdb-conflict" className="mt-1" checked={conflict === 'gdb'} onChange={() => setConflict('gdb')} />
              <span>
                {G('c_gdb')} <span className="text-xs text-gray-500">— {G('c_gdb_hint')}</span>
              </span>
            </label>
          </fieldset>
        )}
        {total('delete') > 0 && (
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={deletes} onChange={(e) => setDeletes(e.target.checked)} />
            {G('deletes', { n: fmtNum(total('delete')) })}
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button icon="check" loading={busy === 'apply'} disabled={!!busy} onClick={() => setConfirm(true)}>
            {G('apply')}
          </Button>
          <Button variant="secondary" loading={busy === 'cancel'} disabled={!!busy} onClick={cancel}>
            {G('cancel')}
          </Button>
        </div>
      </div>

      {/* peringatan */}
      {(refKeys.length > 0 || pv.overlap.length > 0) && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          {refKeys.length > 0 && (
            <p>
              {G('refs_title', { n: fmtNum(pv.ref_objects) })} {refKeys.map((k) => `${G(`src_${k}`)} (${fmtNum(pv.refs[k])})`).join(', ')}
            </p>
          )}
          {pv.overlap.length > 0 && (
            <p>
              {G('overlap')} {pv.overlap.map((o) => `${o.tag || G('no_tag')} (${fmtNum(o.count)})`).join(', ')}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* per tipe */}
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{G('by_type')}</h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1 pr-2">{G('col_type')}</th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="py-1 pl-2 text-right">
                      {G(`a_${a}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pv.by_type.map((t) => (
                  <tr key={`${t.kind}/${t.type}`} className="border-b border-gray-100">
                    <td className="py-0.5 pr-2 text-gray-700">
                      {typeName(t.type)} <span className="text-[10px] text-gray-500">{G(`k_${t.kind}`)}</span>
                    </td>
                    {ACTIONS.map((a) => (
                      <td key={a} className={`py-0.5 pl-2 text-right tabular-nums ${t[a] ? (a === 'same' ? 'text-gray-500' : 'font-medium text-gray-900') : 'text-gray-300'}`}>
                        {t[a] ? fmtNum(t[a]) : '·'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* bagian & alasan */}
        <div className="space-y-3 text-xs">
          {Object.keys(pv.fields || {}).length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{G('parts')}</h4>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(pv.fields).map(([k, n]) => (
                  <Badge key={k} tone="gray">
                    {G(`fl_${k}`)} {fmtNum(n)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {(pv.attrs || []).length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{G('top_attrs')}</h4>
              <table className="w-full">
                <tbody>
                  {pv.attrs.map((a) => (
                    <tr key={a.key} className="border-b border-gray-100">
                      <td className="py-0.5 font-mono text-[11px] text-gray-700">{a.key}</td>
                      <td className="py-0.5 text-right tabular-nums text-gray-900">{fmtNum(a.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {reasonKeys.length > 0 && (
            <ul className="space-y-0.5 text-gray-700">
              {reasonKeys.map((r) => (
                <li key={r}>
                  <span className="tabular-nums font-medium">{fmtNum(pv.reasons[r])}</span> {G(`r_${r}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ChangeList pv={pv} G={G} typeName={typeName} />

      <Confirm
        open={confirm}
        title={G('apply_title', { tag: job.tag })}
        loading={busy === 'apply'}
        message={
          <div className="space-y-2">
            <p>
              {G('apply_msg', {
                ins: fmtNum(total('insert')),
                upd: fmtNum(total('update')),
                del: fmtNum(deletes ? total('delete') : 0),
                conf: fmtNum(total('conflict')),
                policy,
              })}
            </p>
            <p className="text-xs text-gray-600">{G('apply_note')}</p>
          </div>
        }
        onCancel={() => setConfirm(false)}
        onConfirm={apply}
      />
    </div>
  );
}

function ChangeList({ pv, G, typeName }: { pv: Preview; G: GFn; typeName: (c: string) => string }) {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [kind, setKind] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Change[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ action, kind, type, q: query, offset: String(offset), limit: '50' });
        const r = await api<{ items: Change[]; total: number }>(`/api/admin/gdb-import/changes?${qs}`);
        setItems((cur) => (offset > 0 && cur ? [...cur, ...r.items] : r.items));
        setTotal(r.total);
      } catch (e: any) {
        toast.push(e.message, 'error');
        setItems((cur) => cur || []);
      } finally {
        setLoading(false);
      }
    },
    [action, kind, type, query, toast],
  );
  useEffect(() => {
    load(0);
  }, [load]);

  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of pv.by_type) if (!kind || t.kind === kind) seen.set(t.type, typeName(t.type));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [pv.by_type, kind, typeName]);

  const val = (v: unknown) => (v === null || v === undefined || v === '' ? G('empty_val') : typeof v === 'string' ? v : JSON.stringify(v));
  const detail = (c: Change) => {
    const out: string[] = [];
    const ch = c.changes || {};
    if (c.action === 'insert') out.push(G('d_new'));
    if (c.action === 'delete' || (!c.changes && c.action === 'conflict' && c.reason === 'changed_local')) out.push(G('d_gone'));
    if (ch.type) out.push(`${G('fl_type')}: ${typeName(ch.type[0])} → ${typeName(ch.type[1])}`);
    if (ch.code) out.push(`${G('fl_code')}: ${val(ch.code[0])} → ${val(ch.code[1])}`);
    if (ch.name) out.push(`${G('fl_name')}: ${val(ch.name[0])} → ${val(ch.name[1])}`);
    if (ch.move_m !== undefined) out.push(G('d_move', { m: fmtNum(ch.move_m, 2) }));
    if (ch.footprint) out.push(G('d_fp'));
    const props = Object.entries(ch.props || {});
    props.slice(0, 3).forEach(([k, [a, b]]) => out.push(`${k}: ${val(a)} → ${val(b)}`));
    if (props.length > 3) out.push(G('d_more', { n: props.length - 3 }));
    if (c.reason) out.push(G(`r_${c.reason}`));
    if (c.refs) out.push(G('d_refs', { n: fmtNum(c.refs) }));
    return out.join(' · ');
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{G('list')}</h4>
        <div className="flex flex-wrap items-center gap-1">
          {['', 'conflict', 'delete', 'update', 'insert', 'local', 'same'].map((a) => (
            <button key={a || 'all'} className={`rounded-md px-2 py-1 text-xs ${action === a ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`} onClick={() => setAction(a)}>
              {a ? G(`a_${a}`) : G('all')}
            </button>
          ))}
        </div>
        <select className="input h-7 w-auto py-0 text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={G('all_kinds')}>
          <option value="">{G('all_kinds')}</option>
          <option value="node">{G('k_node')}</option>
          <option value="edge">{G('k_edge')}</option>
        </select>
        <select className="input h-7 w-auto py-0 text-xs" value={type} onChange={(e) => setType(e.target.value)} aria-label={G('all_types')}>
          <option value="">{G('all_types')}</option>
          {typeOptions.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <input
          className="input h-7 w-48 py-0 text-xs"
          value={q}
          placeholder={G('search')}
          aria-label={G('search')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setQuery(q.trim())}
        />
        {items && <span className="ml-auto text-xs tabular-nums text-gray-500">{G('shown', { n: fmtNum(items.length), total: fmtNum(total) })}</span>}
      </div>
      {items === null ? (
        <Spinner />
      ) : (
        <div className="max-h-[480px] overflow-auto rounded-md border border-gray-200">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <th className="px-2 py-1">{G('col_action')}</th>
                <th className="px-2 py-1">{G('col_object')}</th>
                <th className="px-2 py-1">{G('col_detail')}</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={`${c.kind}:${c.key}`} className="border-b border-gray-100 align-top">
                  <td className="whitespace-nowrap px-2 py-1">
                    <Badge tone={ACTION_TONE[c.action]}>{G(`a_${c.action}`)}</Badge>
                  </td>
                  <td className="px-2 py-1">
                    {c.code ? <div className="font-mono text-gray-900">{c.code}</div> : <div className="text-gray-900">{c.name || typeName(c.type)}</div>}
                    <div className="text-[10px] text-gray-500">
                      {typeName(c.type)} · {G(`k_${c.kind}`)}
                      {c.code && c.name && ` · ${c.name}`}
                    </div>
                  </td>
                  <td className="break-words px-2 py-1 text-gray-700">{detail(c)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    {(c.id || (c.lng && c.lat)) && (
                      <a className="text-brand-700 hover:underline" href={c.id ? `/map?select=${c.kind}:${c.id}` : `/map?at=${c.lng.toFixed(7)},${c.lat.toFixed(7)}`} target="_blank" rel="noreferrer">
                        {G('map')}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length < total && (
            <div className="p-2 text-center">
              <Button size="sm" variant="secondary" loading={loading} onClick={() => load(items.length)}>
                {G('more')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AppliedSummary({ a, G }: { a: Applied; G: GFn }) {
  const keys = ['insert', 'update', 'delete', 'keep', 'same', 'skip'];
  return (
    <div className="space-y-1 rounded-md border border-gray-200 p-2 text-xs">
      <div className="font-medium text-gray-800">{G('applied_title')}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-gray-700">
        {keys
          .filter((k) => sumOf(a.nodes, k) + sumOf(a.edges, k) > 0)
          .map((k) => (
            <span key={k}>
              <span className="font-semibold tabular-nums text-gray-900">{fmtNum(sumOf(a.nodes, k) + sumOf(a.edges, k))}</span> {G(`f_${k}`)}
              <span className="text-gray-500">
                {' '}
                ({fmtNum(sumOf(a.nodes, k))} {G('k_node')} · {fmtNum(sumOf(a.edges, k))} {G('k_edge')})
              </span>
            </span>
          ))}
      </div>
      {a.layout && (a.layout.restored > 0 || a.layout.gardu > 0) && <div className="text-gray-600">{G('layout_note', { r: a.layout.restored, g: a.layout.gardu })}</div>}
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
