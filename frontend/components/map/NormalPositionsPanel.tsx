'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { Badge, Button, Confirm, Spinner, useToast } from '@/components/ui';

/** Alat switching yang posisinya saat ini berbeda dari posisi normal (GET /api/gis/normal-deviations). */
interface Deviation {
  id: number;
  type_code: string;
  normal: 'open' | 'closed';
  actual: 'open' | 'closed';
  multi_way: boolean;
  normal_ways?: number[];
  actual_ways?: number[];
  feeder: number;
  live_feeder: number;
  energized: boolean;
  dead_side: boolean;
  code: string;
  name: string;
  feeder_code: string;
  live_feeder_code: string;
  outage_id?: number;
  suggest: boolean;
}
interface Transfer {
  from: number;
  to: number;
  nodes: number;
  customers: number;
  from_code: string;
  to_code: string;
}
interface ApplyResult {
  applied: number;
  skipped: number;
  failed: { id: number; error: string }[];
  pending: boolean;
  changeset?: { id: number } | null;
}

/**
 * Editor Peta › tab Normal: jadikan posisi switch saat ini (konfigurasi aktual) sebagai posisi normal. Alat yang
 * dicentang mendapat atribut "normal" (dan arah normal LBS multi-arah) = posisi aktual; lewat paket perubahan bila
 * alur persetujuan aktif. Keanggotaan penyulang Normal lalu dihitung ulang.
 */
export default function NormalPositionsPanel({
  canEdit,
  csQuery,
  feederIds,
  typeName,
  onSelect,
  onApplied,
}: {
  canEdit: boolean;
  /** ?cs=<paket aktif> bila alur persetujuan aktif */
  csQuery: string;
  /** penyulang yang sedang difilter di peta (kosong = semua) */
  feederIds: number[];
  typeName: (code: string) => string;
  onSelect: (id: number) => void;
  /** setelah diterapkan: id paket (usulan) atau null (langsung) */
  onApplied: (changesetId: number | null) => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [scopeFeeders, setScopeFeeders] = useState(feederIds.length > 0);
  const [items, setItems] = useState<Deviation[] | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [approval, setApproval] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const feederKey = feederIds.join(',');

  useEffect(() => {
    if (feederIds.length === 0) setScopeFeeders(false);
  }, [feederIds.length]);

  const load = useCallback(async () => {
    try {
      const qs = scopeFeeders && feederKey ? `?feeders=${feederKey}` : '';
      const r = await api<{ items: Deviation[]; transfers: Transfer[]; approval: boolean }>(`/api/gis/normal-deviations${qs}`);
      setItems(r.items);
      setTransfers(r.transfers);
      setApproval(r.approval);
      setChecked(new Set(r.items.filter((x) => x.suggest).map((x) => x.id)));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setItems((cur) => cur || []);
    }
  }, [scopeFeeders, feederKey, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const pos = (p: 'open' | 'closed') => (p === 'open' ? t('np.open') : t('np.closed'));
  const nSuggest = useMemo(() => (items || []).filter((x) => x.suggest).length, [items]);
  const toggle = (id: number) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<ApplyResult>(`/api/gis/normal-positions${csQuery}`, { method: 'POST', body: { ids: Array.from(checked) } });
      setConfirm(false);
      const msg = r.pending ? t('np.done_pending', { n: fmtNum(r.applied), id: r.changeset?.id ?? '-' }) : t('np.done_direct', { n: fmtNum(r.applied) });
      toast.push(r.skipped ? `${msg} ${t('np.skipped', { n: fmtNum(r.skipped) })}` : msg, 'success');
      if (r.failed.length > 0) toast.push(t('np.failed', { n: fmtNum(r.failed.length), err: r.failed[0].error }), 'error');
      onApplied(r.pending ? (r.changeset?.id ?? null) : null);
      // langsung: pengelompokan penyulang dihitung ulang di latar (±5 dtk)
      setTimeout(load, r.pending ? 300 : 6000);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-xs text-gray-800">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{t('np.title')}</h3>
        <p className="mt-0.5 text-gray-600">{t('np.hint')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {feederIds.length > 0 && (
          <div className="flex overflow-hidden rounded-md border border-gray-300" role="group" aria-label={t('np.scope')}>
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                className={`px-2 py-0.5 ${scopeFeeders === v ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
                onClick={() => setScopeFeeders(v)}
                aria-pressed={scopeFeeders === v}
              >
                {v ? t('np.scope_feeders', { n: fmtNum(feederIds.length) }) : t('np.scope_all')}
              </button>
            ))}
          </div>
        )}
        <Button size="sm" variant="ghost" icon="refresh" onClick={load}>
          {t('common.refresh')}
        </Button>
      </div>

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-emerald-800">{t('np.none')}</p>
      ) : (
        <>
          {transfers.length > 0 && (
            <div className="rounded-md border border-gray-200 p-2">
              <div className="mb-1 font-medium text-gray-700">{t('np.impact')}</div>
              <ul className="space-y-0.5 text-gray-700">
                {transfers.slice(0, 8).map((x) => (
                  <li key={`${x.from}-${x.to}`}>
                    <span className="font-mono">{x.from_code || (x.from ? `#${x.from}` : t('np.no_feeder'))}</span> → <span className="font-mono">{x.to_code || `#${x.to}`}</span>
                    <span className="text-gray-500"> · {t('np.impact_row', { nodes: fmtNum(x.nodes), cust: fmtNum(x.customers) })}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-[11px] text-gray-500">{t('np.impact_hint')}</div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 text-gray-600">{t('np.count', { n: fmtNum(items.length), c: fmtNum(checked.size) })}</span>
            <button className="text-brand-700 hover:underline disabled:opacity-40" disabled={nSuggest === 0} onClick={() => setChecked(new Set(items.filter((x) => x.suggest).map((x) => x.id)))}>
              {t('np.check_suggested')}
            </button>
            <button className="text-brand-700 hover:underline disabled:opacity-40" disabled={checked.size === 0} onClick={() => setChecked(new Set())}>
              {t('np.uncheck')}
            </button>
          </div>

          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {items.map((d) => (
              <li key={d.id} className="flex items-start gap-2 px-2 py-1.5">
                <input type="checkbox" className="mt-0.5" checked={checked.has(d.id)} disabled={!canEdit} onChange={() => toggle(d.id)} aria-label={d.code || `#${d.id}`} />
                <div className="min-w-0 flex-1">
                  <button className="font-mono font-semibold text-brand-700 hover:underline" onClick={() => onSelect(d.id)}>
                    {d.code || `#${d.id}`}
                  </button>
                  <span className="ml-1 text-gray-500">{typeName(d.type_code)}</span>
                  <div className="text-gray-700">
                    {d.normal !== d.actual
                      ? t('np.pos_change', { from: pos(d.normal), to: pos(d.actual) })
                      : t('np.ways_change', { from: fmtNum(d.normal_ways?.length || 0), to: fmtNum(d.actual_ways?.length || 0) })}
                    {d.multi_way && d.normal !== d.actual && (d.normal_ways?.length || 0) !== (d.actual_ways?.length || 0) && (
                      <span className="text-gray-500"> · {t('np.ways_change', { from: fmtNum(d.normal_ways?.length || 0), to: fmtNum(d.actual_ways?.length || 0) })}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {t('np.feeder', { normal: d.feeder_code || (d.feeder ? `#${d.feeder}` : '-'), live: d.live_feeder_code || (d.live_feeder ? `#${d.live_feeder}` : t('np.dead')) })}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {d.suggest && <Badge tone="green">{t('np.suggested')}</Badge>}
                    {d.dead_side && <Badge tone="amber">{t('np.dead_side')}</Badge>}
                    {d.outage_id && <Badge tone="red">{t('np.outage', { id: d.outage_id })}</Badge>}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="space-y-1.5 border-t border-gray-100 pt-2">
            <Button icon="check" disabled={!canEdit || checked.size === 0 || busy} loading={busy} onClick={() => setConfirm(true)}>
              {approval ? t('np.propose', { n: fmtNum(checked.size) }) : t('np.apply', { n: fmtNum(checked.size) })}
            </Button>
            <p className="text-[11px] text-gray-500">{approval ? t('np.via_changeset') : t('np.direct')}</p>
          </div>
        </>
      )}

      <Confirm
        open={confirm}
        title={approval ? t('np.confirm_title_pending') : t('np.confirm_title')}
        loading={busy}
        message={<p>{t('np.confirm_msg', { n: fmtNum(checked.size) })}</p>}
        onCancel={() => setConfirm(false)}
        onConfirm={apply}
      />
    </div>
  );
}
