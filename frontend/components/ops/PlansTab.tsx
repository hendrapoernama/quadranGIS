'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { FeatureCollection, GeoFeature } from '@/lib/types';
import { Badge, Button, Confirm, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { OUTAGE_KINDS } from '@/components/power/OperateBox';
import { useOpsT } from './i18n';
import { SimView } from './SimView';
import type { Codes, Plan, PlanStep, SimResponse } from './types';

interface Props {
  picked: GeoFeature | null;
  canPlan: boolean;
  canApprove: boolean;
  refreshKey: number;
  openId: number | null;
  onOpened: () => void;
  onOverlay: (fc: FeatureCollection | null) => void;
  onSelect: (kind: 'node' | 'edge', id: number, fly?: boolean) => void;
  onAskAI?: (planId: number) => void;
}

const statusTone: Record<string, 'gray' | 'blue' | 'amber' | 'green' | 'red'> = {
  draft: 'gray',
  approved: 'blue',
  executing: 'amber',
  done: 'green',
  cancelled: 'red',
};

type Draft = { id: number | null; title: string; kind: string; note: string; steps: PlanStep[] };

export function PlansTab({ picked, canPlan, canApprove, refreshKey, openId, onOpened, onOverlay, onSelect, onAskAI }: Props) {
  const o = useOpsT();
  const toast = useToast();
  const [filter, setFilter] = useState<'active' | ''>('active');
  const [list, setList] = useState<Plan[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null); // rencana tersimpan yang dibuka
  const [draft, setDraft] = useState<Draft | null>(null); // editor (draft)
  const [sim, setSim] = useState<{ sim: SimResponse['sim']; codes: Codes } | null>(null);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<PlanStep | null>(null);

  const loadList = useCallback(async () => {
    try {
      const r = await api<{ items: Plan[] }>(`/api/ops/plans?status=${filter}`);
      setList(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [filter, toast]);

  const openPlan = useCallback(
    async (id: number) => {
      try {
        const p = await api<Plan>(`/api/ops/plans/${id}`);
        setPlan(p);
        setSim(null);
        onOverlay(null);
        setDraft(p.status === 'draft' ? { id: p.id, title: p.title, kind: p.kind, note: p.note, steps: p.steps || [] } : null);
      } catch (e: any) {
        toast.push(e.message, 'error');
      }
    },
    [toast, onOverlay],
  );

  useEffect(() => {
    loadList();
    if (plan) openPlan(plan.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList, refreshKey]);
  useEffect(() => {
    if (openId) {
      openPlan(openId);
      onOpened();
    }
  }, [openId, openPlan, onOpened]);

  const newPlan = () => {
    setPlan(null);
    setSim(null);
    onOverlay(null);
    setDraft({ id: null, title: '', kind: 'PEMELIHARAAN', note: '', steps: [] });
  };

  const addPicked = (action: 'open' | 'close') => {
    if (!picked || !draft) return;
    const kind = picked.properties.kind === 'edge' ? 'edge' : 'node';
    setDraft({
      ...draft,
      steps: [...draft.steps, { target_kind: kind, target_id: picked.id as number, target_code: picked.properties.code || '', target_type: picked.properties.type_code, action, way_edge_id: null, note: '' }],
    });
    setSim(null);
  };
  const move = (i: number, d: number) => {
    if (!draft) return;
    const s = [...draft.steps];
    const j = i + d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setDraft({ ...draft, steps: s });
    setSim(null);
  };

  const body = (d: Draft) => ({
    title: d.title,
    kind: d.kind,
    note: d.note,
    steps: d.steps.map((s) => ({ target_kind: s.target_kind, target_id: s.target_id, action: s.action, way_edge_id: s.way_edge_id || undefined, note: s.note })),
  });

  const simulate = async () => {
    const steps = draft ? body(draft).steps : (plan?.steps || []).map((s) => ({ target_kind: s.target_kind, target_id: s.target_id, action: s.action, way_edge_id: s.way_edge_id || undefined, note: s.note }));
    if (steps.length === 0) return;
    setBusy('sim');
    try {
      const r = await api<SimResponse>('/api/ops/simulate', { method: 'POST', body: { actions: steps } });
      setSim({ sim: r.sim, codes: r.codes });
      onOverlay(r.geojson);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      const p = await api<Plan>(draft.id ? `/api/ops/plans/${draft.id}` : '/api/ops/plans', { method: draft.id ? 'PUT' : 'POST', body: body(draft) });
      toast.push(o('saved'), 'success');
      await openPlan(p.id);
      loadList();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const act = async (path: string, method: 'POST' | 'DELETE' = 'POST') => {
    if (!plan) return;
    setBusy(path || 'delete');
    try {
      await api(`/api/ops/plans/${plan.id}${path}`, { method });
      if (method === 'DELETE') {
        setPlan(null);
        setDraft(null);
      } else await openPlan(plan.id);
      loadList();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const execute = async (st: PlanStep, skip = false) => {
    if (!plan) return;
    setBusy(`step${st.seq}`);
    try {
      const r = await api<{ message?: string }>(`/api/ops/plans/${plan.id}/steps/${st.seq}/${skip ? 'skip' : 'execute'}`, { method: 'POST' });
      if (r.message) toast.push(r.message, st.action === 'open' ? 'warning' : 'success');
      setConfirm(null);
      await openPlan(plan.id);
      loadList();
    } catch (e: any) {
      toast.push(e.message, 'error');
      await openPlan(plan.id);
    } finally {
      setBusy('');
    }
  };

  // ---------------------------------------------------------------- daftar
  if (!plan && !draft) {
    return (
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-1">
          {(['active', ''] as const).map((f) => (
            <button
              key={f || 'all'}
              className={`rounded-md border px-2 py-1 text-xs ${filter === f ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}
              onClick={() => setFilter(f)}
            >
              {f === 'active' ? o('plans_filter_active') : o('plans_filter_all')}
            </button>
          ))}
          <span className="flex-1" />
          {canPlan && (
            <Button size="sm" icon="plus" onClick={newPlan}>
              {o('plans_new')}
            </Button>
          )}
        </div>
        {!canPlan && <div className="text-[11px] text-gray-500">{o('no_perm_plan')}</div>}
        {list === null ? (
          <div className="py-3 text-center">
            <Spinner size={16} />
          </div>
        ) : list.length === 0 ? (
          <div className="py-4 text-center text-xs text-gray-500">{o('plans_empty')}</div>
        ) : (
          <ul className="space-y-1">
            {list.map((p) => (
              <li key={p.id}>
                <button className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-left text-xs hover:border-brand-600" onClick={() => openPlan(p.id)}>
                  <div className="flex items-center gap-2">
                    <Badge tone={statusTone[p.status]}>{o(`st_${p.status}`)}</Badge>
                    {p.source === 'flisr' && <Badge tone="purple">{o('src_flisr')}</Badge>}
                    <span className="flex-1 truncate font-semibold text-gray-900">{p.title}</span>
                    <span className="text-gray-500">#{p.id}</span>
                  </div>
                  <div className="mt-0.5 flex gap-2 text-[11px] text-gray-500">
                    <span>{p.kind}</span>
                    <span>{o('plan_progress', { done: p.steps_done, total: p.steps_total })}</span>
                    <span>{fmtDate(p.created_at)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- editor / detail
  const steps = draft ? draft.steps : plan?.steps || [];
  const editable = !!draft && canPlan;
  const running = plan && (plan.status === 'approved' || plan.status === 'executing');
  const nextSeq = running ? steps.find((s) => s.status !== 'done' && s.status !== 'skipped')?.seq : undefined;
  // perubahan editor yang belum disimpan (rencana harus disimpan dulu sebelum disetujui)
  const unsaved =
    !!plan && !!draft && JSON.stringify(body(draft)) !== JSON.stringify(body({ id: plan.id, title: plan.title, kind: plan.kind, note: plan.note, steps: plan.steps || [] }));

  return (
    <div className="space-y-3 text-sm">
      <button
        className="flex items-center gap-1 text-xs text-brand-700 hover:underline"
        onClick={() => {
          setPlan(null);
          setDraft(null);
          setSim(null);
          onOverlay(null);
        }}
      >
        <Icon name="chevron-left" size={14} /> {o('plan_back')}
      </button>

      {plan && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={statusTone[plan.status]}>{o(`st_${plan.status}`)}</Badge>
          {plan.source === 'flisr' && <Badge tone="purple">{o('src_flisr')}</Badge>}
          <span className="text-gray-500">
            #{plan.id} · {o('plan_created_by')} {plan.created_by_name} {fmtDate(plan.created_at)}
            {plan.approved_by_name && ` · ${o('plan_approved_by')} ${plan.approved_by_name}`}
          </span>
        </div>
      )}

      {editable ? (
        <div className="space-y-2">
          <label className="block">
            <span className="label">{o('plan_title')}</span>
            <input className="input" value={draft!.title} onChange={(e) => setDraft({ ...draft!, title: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">{o('plan_kind')}</span>
              <select className="input" value={draft!.kind} onChange={(e) => setDraft({ ...draft!, kind: e.target.value })}>
                {OUTAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">{o('plan_note')}</span>
              <input className="input" value={draft!.note} onChange={(e) => setDraft({ ...draft!, note: e.target.value })} />
            </label>
          </div>
        </div>
      ) : (
        plan && (
          <div>
            <div className="text-base font-semibold text-gray-900">{plan.title}</div>
            <div className="text-xs text-gray-600">
              {plan.kind}
              {plan.note && ` · ${plan.note}`}
            </div>
          </div>
        )
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{o('plan_steps')}</span>
          {plan && <span className="text-[11px] text-gray-500">{o('plan_progress', { done: plan.steps_done, total: plan.steps_total })}</span>}
        </div>
        {editable && (
          <div className="mb-2 flex flex-wrap gap-1">
            <Button size="sm" variant="danger" disabled={!picked} onClick={() => addPicked('open')}>
              {o('add_open')}
            </Button>
            <Button size="sm" variant="success" disabled={!picked} onClick={() => addPicked('close')}>
              {o('add_close')}
            </Button>
            {picked && <span className="self-center text-[11px] text-gray-500">{picked.properties.code || `#${picked.id}`}</span>}
          </div>
        )}
        {steps.length === 0 && <div className="rounded-md bg-gray-50 p-2 text-xs text-gray-600">{o('plan_steps_empty')}</div>}
        <ol className="space-y-1">
          {steps.map((s, i) => {
            const seq = s.seq ?? i + 1;
            const isNext = running && nextSeq === seq;
            return (
              <li key={`${seq}-${s.target_id}`} className={`rounded border px-2 py-1 text-xs ${isNext ? 'border-brand-600 bg-brand-50' : 'border-gray-200'}`}>
                <div className="flex items-center gap-2">
                  <span className="w-5 text-right font-semibold tabular-nums text-gray-500">{seq}</span>
                  {editable ? (
                    <select
                      className={`rounded px-1 text-[10px] font-bold ${s.action === 'open' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}
                      value={s.action}
                      onChange={(e) => {
                        const st = [...draft!.steps];
                        st[i] = { ...st[i], action: e.target.value as 'open' | 'close' };
                        setDraft({ ...draft!, steps: st });
                        setSim(null);
                      }}
                      aria-label={o('sim_step')}
                    >
                      <option value="open">{o('open')}</option>
                      <option value="close">{o('close')}</option>
                    </select>
                  ) : (
                    <span className={`rounded px-1.5 text-[10px] font-bold ${s.action === 'open' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>{s.action === 'open' ? o('open') : o('close')}</span>
                  )}
                  <button className="flex-1 truncate text-left font-medium text-brand-700 hover:underline" onClick={() => onSelect(s.target_kind, s.target_id, true)}>
                    {s.target_code || `#${s.target_id}`}
                  </button>
                  {s.status && s.status !== 'pending' && (
                    <Badge tone={s.status === 'done' ? 'green' : s.status === 'failed' ? 'red' : 'gray'}>{o(`step_${s.status}`)}</Badge>
                  )}
                  {editable && (
                    <span className="flex items-center gap-0.5 text-gray-500">
                      <button className="px-0.5 hover:text-gray-900" onClick={() => move(i, -1)} aria-label="naik">
                        <Icon name="arrow-up" size={12} />
                      </button>
                      <button className="px-0.5 hover:text-gray-900" onClick={() => move(i, 1)} aria-label="turun">
                        <Icon name="arrow-down" size={12} />
                      </button>
                      <button
                        className="px-0.5 hover:text-red-700"
                        onClick={() => {
                          setDraft({ ...draft!, steps: draft!.steps.filter((_, k) => k !== i) });
                          setSim(null);
                        }}
                        aria-label={o('plan_delete')}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  )}
                </div>
                {editable ? (
                  <input
                    className="input ml-7 mt-1 !w-[calc(100%-1.75rem)] !py-0.5 text-[11px]"
                    placeholder={o('plan_note')}
                    value={s.note}
                    onChange={(e) => {
                      const st = [...draft!.steps];
                      st[i] = { ...st[i], note: e.target.value };
                      setDraft({ ...draft!, steps: st });
                    }}
                  />
                ) : (
                  s.note && <div className="ml-7 text-[11px] text-gray-500">{s.note}</div>
                )}
                {s.error && <div className="ml-7 text-[11px] text-red-700">{s.error}</div>}
                {s.executed_at && (
                  <div className="ml-7 text-[11px] text-gray-500">
                    {fmtDate(s.executed_at)} · {s.executed_by}
                  </div>
                )}
                {isNext && canPlan && (
                  <div className="ml-7 mt-1 flex gap-1">
                    <Button size="sm" variant={s.action === 'open' ? 'danger' : 'success'} loading={busy === `step${seq}`} onClick={() => setConfirm(s)}>
                      {o('plan_execute')}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => execute(s, true)}>
                      {o('plan_skip')}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex flex-wrap gap-1">
        {steps.length > 0 && (
          <Button size="sm" variant="secondary" icon="activity" loading={busy === 'sim'} onClick={simulate}>
            {o('plan_simulate')}
          </Button>
        )}
        {editable && (
          <Button size="sm" icon="check" loading={busy === 'save'} disabled={!draft!.title.trim() || draft!.steps.length === 0} onClick={save}>
            {o('plan_save')}
          </Button>
        )}
        {plan?.status === 'draft' && canApprove && !unsaved && (plan.steps || []).length > 0 && (
          <Button size="sm" variant="success" loading={busy === '/approve'} onClick={() => act('/approve')}>
            {o('plan_approve')}
          </Button>
        )}
        {plan && canPlan && (plan.status === 'approved' || plan.status === 'cancelled') && (
          <Button size="sm" variant="secondary" loading={busy === '/reopen'} onClick={() => act('/reopen')}>
            {o('plan_reopen')}
          </Button>
        )}
        {plan && canPlan && ['draft', 'approved', 'executing'].includes(plan.status) && (
          <Button size="sm" variant="secondary" loading={busy === '/cancel'} onClick={() => act('/cancel')}>
            {o('plan_cancel')}
          </Button>
        )}
        {plan && canPlan && (plan.status === 'draft' || plan.status === 'cancelled') && (
          <Button size="sm" variant="danger" loading={busy === 'delete'} onClick={() => act('', 'DELETE')}>
            {o('plan_delete')}
          </Button>
        )}
        {plan && !unsaved && onAskAI && (
          <Button size="sm" variant="ghost" icon="sparkles" onClick={() => onAskAI(plan.id)}>
            {o('ai_review')}
          </Button>
        )}
      </div>

      {sim && <SimView sim={sim.sim} codes={sim.codes} />}

      <Confirm
        open={!!confirm}
        title={o('plan_execute')}
        message={confirm ? o('plan_confirm_exec', { n: confirm.seq ?? '', action: confirm.action === 'open' ? o('open') : o('close'), code: confirm.target_code || `#${confirm.target_id}` }) : ''}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && execute(confirm)}
        loading={busy.startsWith('step')}
      />
    </div>
  );
}
