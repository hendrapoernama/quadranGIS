'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtLength, fmtNum, fmtVA } from '@/lib/format';
import type { FeatureCollection, GeoFeature, Outage } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { useOpsT } from './i18n';
import { SimView, codeOf } from './SimView';
import type { Codes, FlisrResult, FlisrSection, SimAction } from './types';

interface Props {
  picked: GeoFeature | null;
  canPlan: boolean;
  refreshKey: number;
  onOverlay: (fc: FeatureCollection | null) => void;
  onSelect: (kind: 'node' | 'edge', id: number, fly?: boolean) => void;
  onPlanCreated: (id: number) => void;
  onAskAI?: (outageId: number) => void;
}

export function FlisrTab({ picked, canPlan, refreshKey, onOverlay, onSelect, onPlanCreated, onAskAI }: Props) {
  const o = useOpsT();
  const toast = useToast();
  const [outages, setOutages] = useState<Outage[]>([]);
  const [outage, setOutage] = useState<Outage | null>(null);
  const [sections, setSections] = useState<FlisrSection[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ result: FlisrResult; codes: Codes; label: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const loadOutages = useCallback(async () => {
    try {
      const r = await api<{ items: Outage[] }>('/api/power/outages?active=1&limit=100');
      setOutages(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);
  useEffect(() => {
    loadOutages();
  }, [loadOutages, refreshKey]);

  const pickOutage = async (ot: Outage) => {
    setOutage(ot);
    setResult(null);
    onOverlay(null);
    setSections(null);
    try {
      const r = await api<{ items: FlisrSection[] }>(`/api/ops/flisr/sections?outage_id=${ot.id}`);
      setSections(r.items);
      onSelect(ot.cause_kind === 'edge' ? 'edge' : 'node', ot.cause_node_id, true);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };

  const analyze = async (kind: 'node' | 'edge', id: number, label: string) => {
    setBusy(true);
    try {
      const r = await api<{ result: FlisrResult; codes: Codes; geojson: FeatureCollection }>('/api/ops/flisr', { method: 'POST', body: { fault_kind: kind, fault_id: id } });
      setResult({ result: r.result, codes: r.codes, label });
      onOverlay(r.geojson);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const savePlan = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const cause = outage ? outage.cause_node_code || `#${outage.cause_node_id}` : '';
      const p = await api<{ id: number }>('/api/ops/plans', {
        method: 'POST',
        body: {
          title: `FLISR ${cause ? cause + ' · ' : ''}${result.label}`,
          kind: outage?.kind && outage.kind !== 'MANUVER' ? outage.kind : 'GANGGUAN',
          source: 'flisr',
          outage_id: outage?.id ?? null,
          fault: { kind: result.result.fault_kind, id: result.result.fault_id, label: result.label },
          note: o('flisr_note'),
          steps: result.result.actions.map((a: SimAction) => ({ ...a })),
        },
      });
      toast.push(o('saved'), 'success');
      onPlanCreated(p.id);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const res = result?.result;
  const codes = result?.codes || {};
  const pickedLabel = picked ? picked.properties.code || `#${picked.id}` : '';

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-gray-600">{o('flisr_intro')}</p>

      {/* kejadian padam aktif */}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{o('flisr_outages')}</div>
        {outages.length === 0 && <div className="rounded-md bg-gray-50 p-2 text-xs text-gray-600">{o('flisr_none')}</div>}
        <ul className="space-y-1">
          {outages.map((ot) => (
            <li key={ot.id}>
              <button
                className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${outage?.id === ot.id ? 'border-brand-600 bg-brand-50' : 'border-red-200 bg-red-50/50 hover:border-red-400'}`}
                onClick={() => pickOutage(ot)}
              >
                <div className="flex items-center gap-2">
                  <Badge tone="red">#{ot.id}</Badge>
                  <Badge tone="purple">{ot.kind}</Badge>
                  <span className="flex-1 truncate font-semibold text-gray-900">{ot.cause_node_code || `#${ot.cause_node_id}`}</span>
                  <span className="tabular-nums text-gray-700">
                    {fmtNum(ot.customers ?? (ot.summary as any)?.pelanggan ?? 0)} plg
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-gray-500">{fmtDate(ot.started_at)}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {outage && onAskAI && (
        <Button size="sm" variant="ghost" icon="sparkles" onClick={() => onAskAI(outage.id)}>
          {o('ai_outage')} #{outage.id}
        </Button>
      )}

      {picked && (
        <Button size="sm" variant="secondary" icon="target" loading={busy} onClick={() => analyze(picked.properties.kind === 'edge' ? 'edge' : 'node', picked.id as number, pickedLabel)}>
          {o('flisr_from_pick')}: {pickedLabel}
        </Button>
      )}

      {/* kandidat seksi */}
      {outage && (
        <div>
          <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{o('flisr_sections')}</div>
          <div className="mb-1 text-[11px] text-gray-500">{o('flisr_sections_hint')}</div>
          {sections === null ? (
            <div className="py-2 text-center">
              <Spinner size={16} />
            </div>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {sections.map((s) => {
                const label = s.entry_code ? `${o('flisr_entry')} ${s.entry_code}` : s.code || o('flisr_first');
                return (
                  <li key={s.id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-gray-900">{label}</div>
                      <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                        <span>{fmtNum(s.customers)} plg</span>
                        <span>{fmtLength(s.length_m)}</span>
                        {s.history > 0 && <span className="text-amber-700">{o('flisr_history')} {s.history}</span>}
                        {s.reports > 0 && <span className="text-red-700">{o('flisr_reports')} {s.reports}</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" loading={busy && result === null} onClick={() => analyze('node', s.id, label)}>
                      {o('flisr_analyze')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* hasil */}
      {busy && !res && (
        <div className="py-3 text-center">
          <Spinner size={18} />
        </div>
      )}
      {res && (
        <div className="space-y-2 rounded-lg border border-gray-200 p-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            {o('flisr_section')}: {result!.label}
          </div>
          <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-xs">
            <dt className="text-gray-500">{o('flisr_section')}</dt>
            <dd>
              {fmtNum(res.section_nodes.length)} node · {fmtNum(res.section_customers)} plg · {fmtLength(res.section_length_m)}
            </dd>
            <dt className="text-gray-500">{o('flisr_upstream')}</dt>
            <dd>
              <button className="text-brand-700 hover:underline" onClick={() => onSelect('node', res.upstream, true)}>
                {codeOf(codes, res.upstream)}
              </button>
            </dd>
            {res.tripped > 0 && (
              <>
                <dt className="text-gray-500">{o('flisr_tripped')}</dt>
                <dd>{codeOf(codes, res.tripped)}</dd>
              </>
            )}
            {res.downstream.length > 0 && (
              <>
                <dt className="text-gray-500">{o('flisr_downstream')}</dt>
                <dd className="truncate">{res.downstream.map((d) => codeOf(codes, d)).join(', ')}</dd>
              </>
            )}
          </dl>
          {res.islands.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{o('flisr_islands')}</div>
              <ul className="mt-1 space-y-1">
                {res.islands.map((isl) => (
                  <li key={isl.boundary} className="rounded bg-gray-50 px-2 py-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{codeOf(codes, isl.boundary)}</span>
                      <span className="text-gray-500">
                        {fmtNum(isl.customers)} plg · {fmtVA(isl.load_va)}
                      </span>
                    </div>
                    {isl.tie ? (
                      <div className="text-emerald-700">
                        ✓ {o('flisr_tie')} {codeOf(codes, isl.tie.switch_id)} {o('flisr_from')} {codeOf(codes, isl.tie.supporting)} · {isl.tie.pct_after}%
                      </div>
                    ) : (
                      <div className="text-red-700">✗ {o(`flisr_reason_${isl.reason}`)}</div>
                    )}
                    {isl.alternatives.length > 1 && (
                      <div className="text-[11px] text-gray-500">
                        {o('flisr_alt')}: {isl.alternatives.slice(1).map((a) => `${codeOf(codes, a.switch_id)} (${a.pct_after}%)`).join(', ')}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {res.sim ? <SimView sim={res.sim} codes={codes} section /> : <div className="text-xs text-gray-600">{o('flisr_already')}</div>}
          <p className="text-[11px] text-gray-500">{o('flisr_note')}</p>
          {canPlan && res.actions.length > 0 && (
            <Button size="sm" icon="check" loading={saving} onClick={savePlan}>
              {o('flisr_save_plan')}
            </Button>
          )}
          {!canPlan && <div className="text-[11px] text-gray-500">{o('no_perm_plan')}</div>}
        </div>
      )}
    </div>
  );
}
