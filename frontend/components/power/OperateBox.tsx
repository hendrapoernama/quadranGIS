'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { ComponentType, GeoFeature } from '@/lib/types';
import { Badge, Button, Confirm } from '@/components/ui';

/** Kategori pemadaman (wajib saat membuka / deenergize). */
export const OUTAGE_KINDS = ['GANGGUAN', 'PEMELIHARAAN', 'MLS', 'MANUVER'];
/** Izin operasi (lihat backend OperatePermissions). */
export const OPERATE_PERMS = ['power.switch_tm', 'power.switch_tr', 'power.energize_tm', 'power.energize_tr'];

export interface ManeuverBody {
  action: 'open' | 'close';
  kind?: string; // kosong saat menutup: mengikuti kejadian padam aktif
  note: string;
  way_edge_id?: number;
  target?: 'node' | 'edge';
}

interface Props {
  feature: GeoFeature;
  types: ComponentType[];
  submit: (body: ManeuverBody) => Promise<void>;
}

/**
 * Operasi objek jaringan: buka / tutup alat switching (termasuk per arah LBS 3 way) atau
 * energize / deenergize objek non-switch & saluran. Hak akses per role:
 * power.switch_{tm|tr} untuk alat switching, power.energize_{tm|tr} untuk lainnya.
 */
export function OperateBox({ feature, types, submit }: Props) {
  const { t } = useT();
  const { has } = useAuth();
  const p = feature.properties;
  const kind: 'node' | 'edge' = p.kind === 'edge' ? 'edge' : 'node';
  const ct = types.find((x) => x.code === p.type_code);
  const isSwitch = kind === 'node' && !!ct?.is_switch;
  const ways = ct?.ways || 0;
  const domain: 'tm' | 'tr' = p.operate_domain === 'tr' ? 'tr' : 'tm';
  const perm = `${isSwitch ? 'power.switch_' : 'power.energize_'}${domain}`;
  const allowed = has(perm);
  const graph = p.graph;
  const inGraph = !!graph?.in_graph;
  const isOpen = !!graph?.open;

  const [cat, setCat] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { wayEdgeId?: number; label: string }>(null);
  const [neighbors, setNeighbors] = useState<any[]>([]);

  useEffect(() => {
    setCat('');
    setNote('');
    setNeighbors([]);
    if (isSwitch && ways >= 3) {
      api<{ items: any[] }>(`/api/gis/nodes/${feature.id}/neighbors`)
        .then((r) => setNeighbors(r.items))
        .catch(() => setNeighbors([]));
    }
  }, [feature.id, isSwitch, ways]);

  // objek pendukung (tiang) bukan bagian topologi: tidak dapat dioperasikan
  if (!ct || (kind === 'node' && ct.topology === false)) return null;

  const run = async (action: 'open' | 'close', wayEdgeId?: number) => {
    setBusy(true);
    try {
      await submit({ action, kind: action === 'open' ? cat : undefined, note, way_edge_id: wayEdgeId, target: kind });
      setNote('');
      setCat('');
      setConfirm(null);
    } catch {
      /* pesan kesalahan ditampilkan pemanggil */
    } finally {
      setBusy(false);
    }
  };

  const stateLabel = isSwitch ? (isOpen ? t('op.state_open') : t('op.state_closed')) : isOpen ? t('op.state_deenergized') : t('op.state_energized');
  const openLabel = isSwitch ? t('op.open') : t('op.deenergize');
  const closeLabel = isSwitch ? t('op.close') : t('op.energize');
  const code = p.code || `#${feature.id}`;

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold uppercase text-amber-800">{isSwitch ? t('op.title_switch') : t('op.title_energize')}</span>
        <span className="flex items-center gap-1">
          <span className="rounded bg-white/70 px-1 text-[10px] uppercase text-gray-600" title={t('op.domain_hint')}>
            {domain === 'tr' ? 'TR' : 'TM'}
          </span>
          {inGraph && (isOpen ? <Badge tone="red">{stateLabel}</Badge> : <Badge tone="green">{stateLabel}</Badge>)}
        </span>
      </div>
      {!allowed && <div className="text-gray-600">{t('op.no_perm', { perm })}</div>}
      {allowed && !inGraph && <div className="text-gray-500">{t('feature.not_in_graph')}</div>}
      {allowed && inGraph && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2">
            <div>
              <label className="label">
                {t('op.category')} {!isOpen && <span className="text-red-600">*</span>}
              </label>
              <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} aria-required={!isOpen}>
                <option value="">{isOpen ? t('op.category_auto') : t('op.category_pick')}</option>
                {OUTAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('feature.maneuver_note')}</label>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="-" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {isOpen ? (
              <Button size="sm" icon="check" loading={busy} onClick={() => run('close')}>
                {closeLabel}
              </Button>
            ) : (
              <Button size="sm" variant="danger" icon="alert" loading={busy} disabled={!cat} onClick={() => setConfirm({ label: code })}>
                {openLabel}
              </Button>
            )}
            {!isOpen && !cat && <span className="text-[11px] text-gray-500">{t('op.category_required')}</span>}
          </div>
          {isSwitch && ways >= 3 && neighbors.length > 0 && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase text-gray-500">{t('feature.maneuver_ways')}</div>
              <ul className="space-y-0.5">
                {neighbors.map((n, i) => {
                  const wayOpen = (graph?.open_ways || []).includes(n.edge_id);
                  return (
                    <li key={n.edge_id} className="flex items-center gap-1 rounded bg-white/70 px-1 py-0.5">
                      <span className="w-4 text-gray-400">{i + 1}</span>
                      <span className="flex-1 truncate">
                        {n.edge_code || `#${n.edge_id}`} <span className="text-gray-400">→ {n.node_code || `#${n.node_id}`}</span>
                      </span>
                      {wayOpen ? <Badge tone="red">{t('feature.way_state_open')}</Badge> : <Badge tone="green">{t('feature.way_state_closed')}</Badge>}
                      {wayOpen ? (
                        <button className="text-brand-700 hover:underline disabled:opacity-50" disabled={busy} onClick={() => run('close', n.edge_id)}>
                          {t('feature.way_close')}
                        </button>
                      ) : (
                        <button
                          className="text-red-700 hover:underline disabled:opacity-50"
                          disabled={busy || !cat}
                          title={!cat ? t('op.category_required') : undefined}
                          onClick={() => setConfirm({ wayEdgeId: n.edge_id, label: n.edge_code || `#${n.edge_id}` })}
                        >
                          {t('feature.way_open')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      <Confirm
        open={!!confirm}
        title={openLabel}
        message={isSwitch ? t('op.confirm_open', { code: confirm?.label || '', kind: cat }) : t('op.confirm_deenergize', { code: confirm?.label || '', kind: cat })}
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('open', confirm?.wayEdgeId)}
        loading={busy}
      />
    </div>
  );
}
