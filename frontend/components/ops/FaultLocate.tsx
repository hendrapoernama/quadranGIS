'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtLength, fmtNum } from '@/lib/format';
import type { FeatureCollection, GeoFeature } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';

// Estimasi lokasi gangguan dari arus gangguan relai (distance-to-fault) di tab FLISR.

const ID = {
  title: 'Lokasi gangguan dari arus relai',
  intro: 'Masukkan arus gangguan yang terbaca relai pada alat yang trip. Sistem menghitung arus hubung singkat di sepanjang jaringan TM hilirnya dan menandai titik yang cocok.',
  device: 'Alat trip',
  device_pick: 'Pakai objek terpilih',
  device_none: 'Pilih alat (PMT / recloser / kubikel) di peta, atau pilih kejadian padam.',
  type: 'Jenis gangguan',
  t_auto: 'Otomatis (dari arus per fasa)',
  t_3ph: '3 fasa',
  t_2ph: 'Fasa-fasa',
  t_1ph: 'Fasa-tanah',
  mode_single: 'Satu nilai',
  mode_phase: 'Per fasa',
  current: 'Arus gangguan (A)',
  advanced: 'Parameter sumber & saluran',
  source_mva: 'Daya hubung singkat busbar (MVA)',
  source_xr: 'X/R sumber',
  ngr: 'NGR (ohm)',
  rf: 'Tahanan gangguan (ohm)',
  z0: 'Z0/Z1 saluran',
  tol: 'Toleransi (%)',
  src_asset: 'dari atribut {c}',
  src_config: 'dari konfigurasi',
  run: 'Hitung lokasi',
  measured: 'Arus terukur',
  detected: 'terdeteksi',
  imax: 'Arus hitungan di alat',
  imin: 'Terkecil (ujung {d})',
  cand: 'Kandidat lokasi ({n})',
  none: 'Tidak ada titik yang cocok.',
  dist: '{d} dari alat',
  band: 'rentang ±{d}',
  zone: 'zona',
  gd: 'gardu',
  show: 'Lihat',
  analyze: 'Analisa FLISR',
  w_type_assumed: 'Jenis gangguan tidak diketahui: dianggap 3 fasa. Pilih jenis gangguan atau isi arus per fasa.',
  w_above_max: 'Arus terukur melebihi arus gangguan hitungan tepat di alat. Periksa daya hubung singkat sumber, atau gangguan berada sangat dekat alat.',
  w_below_min: 'Arus terukur lebih kecil dari arus hitungan di ujung jaringan TM. Kemungkinan tahanan gangguan besar (isi tahanan gangguan) atau gangguan di sisi TR.',
  w_at_device: 'Gangguan diperkirakan sangat dekat dengan alat.',
  w_low_sensitivity: 'Arus gangguan hampir tidak berubah menurut jarak (umumnya gangguan fasa-tanah yang dibatasi NGR): estimasi jarak kurang andal, gunakan sebagai petunjuk awal.',
  w_multiple: 'Jaringan bercabang: arus yang sama cocok di beberapa cabang. Gunakan laporan pelanggan atau inspeksi untuk memilih kandidat.',
  legend: 'Peta: merah = kandidat, oranye = saluran dalam toleransi, biru = alat trip.',
};
type Dict = typeof ID;
const EN: Dict = {
  title: 'Fault location from relay current',
  intro: 'Enter the fault current read by the relay of the tripped device. The system computes the short-circuit current along its downstream MV network and marks matching points.',
  device: 'Tripped device',
  device_pick: 'Use selected object',
  device_none: 'Select a device (CB / recloser / cubicle) on the map, or pick an outage.',
  type: 'Fault type',
  t_auto: 'Automatic (from phase currents)',
  t_3ph: 'Three-phase',
  t_2ph: 'Phase-to-phase',
  t_1ph: 'Phase-to-ground',
  mode_single: 'Single value',
  mode_phase: 'Per phase',
  current: 'Fault current (A)',
  advanced: 'Source & line parameters',
  source_mva: 'Busbar short-circuit power (MVA)',
  source_xr: 'Source X/R',
  ngr: 'NGR (ohm)',
  rf: 'Fault resistance (ohm)',
  z0: 'Line Z0/Z1',
  tol: 'Tolerance (%)',
  src_asset: 'from {c} attributes',
  src_config: 'from configuration',
  run: 'Locate',
  measured: 'Measured current',
  detected: 'detected',
  imax: 'Computed current at device',
  imin: 'Lowest (end at {d})',
  cand: 'Candidate locations ({n})',
  none: 'No matching point.',
  dist: '{d} from device',
  band: 'range ±{d}',
  zone: 'zone',
  gd: 'substation',
  show: 'Show',
  analyze: 'FLISR analysis',
  w_type_assumed: 'Fault type unknown: assumed three-phase. Pick the fault type or enter per-phase currents.',
  w_above_max: 'The measured current exceeds the computed fault current right at the device. Check the source short-circuit power, or the fault is very close to the device.',
  w_below_min: 'The measured current is below the computed current at the end of the MV network. A high fault resistance (enter it) or an LV-side fault is likely.',
  w_at_device: 'The fault is estimated very close to the device.',
  w_low_sensitivity: 'The fault current barely changes with distance (typically a ground fault limited by the NGR): the distance estimate is less reliable, use it as a first hint.',
  w_multiple: 'Branched network: the same current matches several branches. Use customer reports or patrols to choose.',
  legend: 'Map: red = candidates, orange = lines within tolerance, blue = tripped device.',
};

interface Cand {
  edge_id: number;
  frac: number;
  distance_m: number;
  i_calc_a: number;
  from_node: number;
  to_node: number;
  zone_id?: number;
  gd_id?: number;
  band_min_m: number;
  band_max_m: number;
}
interface Resp {
  result: {
    fault_type: string;
    auto_type: boolean;
    measured_a: number;
    i_max_a: number;
    i_min_a: number;
    farthest_m: number;
    candidates: Cand[];
    warnings: string[];
    nodes: number;
  };
  codes: Record<string, { code: string; name: string }>;
  edge_codes: Record<string, { code: string; name: string }>;
  geojson: FeatureCollection;
}
interface Params {
  source_mva: number;
  source_xr: number;
  ngr_ohm: number;
  fault_ohm: number;
  z0_ratio: number;
  tol_pct: number;
}

export function FaultLocate({
  deviceId,
  deviceCode,
  picked,
  onOverlay,
  onSelect,
  onAnalyze,
}: {
  deviceId: number | null;
  deviceCode?: string;
  picked: GeoFeature | null;
  onOverlay: (fc: FeatureCollection | null) => void;
  onSelect: (kind: 'node' | 'edge', id: number, fly?: boolean) => void;
  onAnalyze: (kind: 'node' | 'edge', id: number, label: string) => void;
}) {
  const { locale } = useT();
  const F = useCallback(
    (k: keyof Dict | string, p?: Record<string, string | number>) => {
      let s: string = ((locale === 'en' ? EN : ID) as Record<string, string>)[k] ?? k;
      if (p) for (const [a, b] of Object.entries(p)) s = s.replace(`{${a}}`, String(b));
      return s;
    },
    [locale],
  );
  const toast = useToast();
  const [dev, setDev] = useState<{ id: number; code: string } | null>(null);
  const [type, setType] = useState('auto');
  const [mode, setMode] = useState<'single' | 'phase'>('single');
  const [cur, setCur] = useState('');
  const [ph, setPh] = useState({ ia: '', ib: '', ic: '', in: '' });
  const [adv, setAdv] = useState(false);
  const [params, setParams] = useState<Params | null>(null);
  const [src, setSrc] = useState<{ from: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Resp | null>(null);

  useEffect(() => {
    if (deviceId) setDev({ id: deviceId, code: deviceCode || `#${deviceId}` });
  }, [deviceId, deviceCode]);
  useEffect(() => {
    setRes(null);
    api<{ params: Params; source: { from: string; code?: string } }>(`/api/ops/fault-locate/defaults${dev ? `?device_id=${dev.id}` : ''}`)
      .then((r) => {
        setParams(r.params);
        setSrc(r.source);
      })
      .catch(() => {});
  }, [dev]);

  const num = (v: string) => {
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };
  const run = async () => {
    if (!dev) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ...(params || {}), device_id: dev.id, fault_type: type };
      if (mode === 'single') body.current_a = num(cur);
      else Object.assign(body, { ia: num(ph.ia), ib: num(ph.ib), ic: num(ph.ic), in: num(ph.in) });
      const r = await api<Resp>('/api/ops/fault-locate', { method: 'POST', body });
      setRes(r);
      onOverlay(r.geojson);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const pickedOk = picked && picked.properties.kind === 'node';
  const r = res?.result;
  const codeOf = (id?: number) => (id && res?.codes[id] ? res.codes[id].code || `#${id}` : '');
  const setP = (k: keyof Params, v: string) => params && setParams({ ...params, [k]: num(v) });

  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-2 text-xs">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
        <Icon name="target" size={14} /> {F('title')}
      </div>
      <p className="text-[11px] text-gray-500">{F('intro')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-600">{F('device')}:</span>
        {dev ? <Badge tone="blue">{dev.code}</Badge> : <span className="text-gray-500">{F('device_none')}</span>}
        {pickedOk && picked!.id !== dev?.id && (
          <button className="text-brand-700 hover:underline" onClick={() => setDev({ id: picked!.id as number, code: picked!.properties.code || `#${picked!.id}` })}>
            {F('device_pick')}: {picked!.properties.code || `#${picked!.id}`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-0.5">
          <span className="text-gray-600">{F('type')}</span>
          <select className="input text-xs" value={type} onChange={(e) => setType(e.target.value)}>
            {['auto', '3ph', '2ph', '1ph'].map((k) => (
              <option key={k} value={k}>
                {F(`t_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-0.5">
          <span className="text-gray-600">&nbsp;</span>
          <div className="flex rounded-md border border-gray-300 p-0.5">
            {(['single', 'phase'] as const).map((m) => (
              <button key={m} className={`flex-1 rounded px-2 py-1 ${mode === m ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600'}`} onClick={() => setMode(m)}>
                {F(`mode_${m}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === 'single' ? (
        <label className="block space-y-0.5">
          <span className="text-gray-600">{F('current')}</span>
          <input className="input text-xs" inputMode="decimal" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="mis. 2400" />
        </label>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {(['ia', 'ib', 'ic', 'in'] as const).map((k) => (
            <label key={k} className="space-y-0.5">
              <span className="text-gray-600">{k === 'in' ? 'In (3I0)' : k.replace('i', 'I')} (A)</span>
              <input className="input text-xs" inputMode="decimal" value={ph[k]} onChange={(e) => setPh({ ...ph, [k]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <button className="text-[11px] text-brand-700 hover:underline" onClick={() => setAdv((v) => !v)}>
        {adv ? '▾' : '▸'} {F('advanced')} {src && <span className="text-gray-500">· {src.from === 'asset' ? F('src_asset', { c: src.code || '' }) : F('src_config')}</span>}
      </button>
      {adv && params && (
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ['source_mva', 'source_mva'],
              ['source_xr', 'source_xr'],
              ['ngr_ohm', 'ngr'],
              ['fault_ohm', 'rf'],
              ['z0_ratio', 'z0'],
              ['tol_pct', 'tol'],
            ] as [keyof Params, string][]
          ).map(([k, l]) => (
            <label key={k} className="space-y-0.5">
              <span className="text-[10px] text-gray-600">{F(l)}</span>
              <input className="input text-xs" inputMode="decimal" value={String(params[k])} onChange={(e) => setP(k, e.target.value)} />
            </label>
          ))}
        </div>
      )}
      <Button size="sm" icon="target" disabled={!dev || (mode === 'single' ? !num(cur) : !(num(ph.ia) || num(ph.ib) || num(ph.ic) || num(ph.in)))} loading={busy} onClick={run}>
        {F('run')}
      </Button>

      {r && (
        <div className="space-y-2 border-t border-gray-200 pt-2">
          <div className="grid grid-cols-3 gap-1.5">
            <div className="rounded bg-gray-50 px-2 py-1">
              <div className="text-[10px] uppercase text-gray-500">{F('measured')}</div>
              <div className="font-semibold tabular-nums text-gray-900">{fmtNum(r.measured_a)} A</div>
              <div className="text-[10px] text-gray-500">
                {F(`t_${r.fault_type}`)}
                {r.auto_type ? ` · ${F('detected')}` : ''}
              </div>
            </div>
            <div className="rounded bg-gray-50 px-2 py-1">
              <div className="text-[10px] uppercase text-gray-500">{F('imax')}</div>
              <div className="font-semibold tabular-nums text-gray-900">{fmtNum(r.i_max_a)} A</div>
            </div>
            <div className="rounded bg-gray-50 px-2 py-1">
              <div className="text-[10px] uppercase text-gray-500">{F('imin', { d: fmtLength(r.farthest_m) })}</div>
              <div className="font-semibold tabular-nums text-gray-900">{fmtNum(r.i_min_a)} A</div>
            </div>
          </div>
          {r.warnings.map((w) => (
            <div key={w} className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              {F(`w_${w}`)}
            </div>
          ))}
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{F('cand', { n: r.candidates.length })}</div>
          {r.candidates.length === 0 ? (
            <p className="text-gray-500">{F('none')}</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {r.candidates.map((c, i) => {
                const ec = res!.edge_codes[c.edge_id];
                const label = ec?.code || `#${c.edge_id}`;
                return (
                  <li key={`${c.edge_id}-${i}`} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1">
                    <Badge tone="red">{i + 1}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-gray-900">
                        {label} · {F('dist', { d: fmtLength(c.distance_m) })}
                      </div>
                      <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                        <span>{F('band', { d: fmtLength((c.band_max_m - c.band_min_m) / 2) })}</span>
                        {c.zone_id ? (
                          <span>
                            {F('zone')} {codeOf(c.zone_id)}
                          </span>
                        ) : null}
                        {c.gd_id ? (
                          <span>
                            {F('gd')} {codeOf(c.gd_id)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" icon="map" onClick={() => onSelect('edge', c.edge_id, true)}>
                      {F('show')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onAnalyze('edge', c.edge_id, `${label} (${fmtLength(c.distance_m)})`)}>
                      {F('analyze')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[10px] text-gray-500">{F('legend')}</p>
        </div>
      )}
      {busy && !r && <Spinner size={14} />}
    </div>
  );
}
