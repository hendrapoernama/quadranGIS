'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtNum } from '@/lib/format';
import type { Outage } from '@/lib/types';
import { Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { AiOpsPanel, type AiOpsTask } from '@/components/ai/AiOpsPanel';
import { useExecT } from '@/components/exec/i18n';
import { InsightList } from '@/components/exec/common';
import type { Insight } from '@/components/exec/types';
import type { Plan } from './types';

export interface AiPreset {
  task: AiOpsTask;
  id?: number;
  nonce: number;
}

interface Props {
  preset: AiPreset | null;
  refreshKey: number;
  visible: boolean;
}

type Task = Exclude<AiOpsTask, 'report'>;

/** Tab AI Operasi: analisis kejadian padam, review rencana, serah terima shift, temuan & rekomendasi. */
export function AiOpsTab({ preset, refreshKey, visible }: Props) {
  const e = useExecT();
  const toast = useToast();
  const [task, setTask] = useState<Task>('outage');
  const [outages, setOutages] = useState<Outage[] | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [outageId, setOutageId] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [hours, setHours] = useState(8);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  // analisis dimulai otomatis hanya untuk target yang dikirim tombol di tab lain
  const [autoKey, setAutoKey] = useState('');
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api<{ items: Outage[] }>('/api/power/outages?limit=40'),
        api<{ items: Plan[] }>('/api/ops/plans?status=&limit=40'),
      ]);
      setOutages(a.items);
      setPlans(b.items);
      setOutageId((v) => v ?? a.items.find((x) => !x.ended_at)?.id ?? a.items[0]?.id ?? null);
      setPlanId((v) => v ?? b.items[0]?.id ?? null);
    } catch (err: any) {
      toast.push(err.message, 'error');
    }
  }, [toast]);
  useEffect(() => {
    if (visible) load();
  }, [load, refreshKey, visible]);
  useEffect(() => {
    if (visible && task === 'insights')
      api<{ items: Insight[] }>('/api/ops/insights')
        .then((r) => setInsights(r.items))
        .catch(() => setInsights([]));
  }, [visible, task, refreshKey]);

  useEffect(() => {
    if (!preset) return;
    if (preset.task === 'outage' && preset.id) {
      setTask('outage');
      setOutageId(preset.id);
    } else if (preset.task === 'plan' && preset.id) {
      setTask('plan');
      setPlanId(preset.id);
    } else if (preset.task === 'shift' || preset.task === 'insights') setTask(preset.task);
    setAutoKey(`${preset.task}:${preset.id ?? ''}`);
    setNonce(preset.nonce);
  }, [preset]);

  const tasks: [Task, string, string, string][] = [
    ['outage', e('ai_task_outage'), e('ai_task_outage_hint'), 'bolt'],
    ['plan', e('ai_task_plan'), e('ai_task_plan_hint'), 'list'],
    ['shift', e('ai_task_shift'), e('ai_task_shift_hint'), 'clock'],
    ['insights', e('ai_task_insights'), e('ai_task_insights_hint'), 'sparkles'],
  ];

  const params = task === 'outage' ? { outage_id: outageId ?? undefined } : task === 'plan' ? { plan_id: planId ?? undefined } : task === 'shift' ? { hours } : {};
  const ready = (task !== 'outage' || outageId) && (task !== 'plan' || planId);
  const curKey = `${task}:${task === 'outage' ? outageId ?? '' : task === 'plan' ? planId ?? '' : ''}`;

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-1.5">
        {tasks.map(([k, label, hint, icon]) => (
          <button
            key={k}
            className={`rounded-md border px-2 py-1.5 text-left text-xs ${task === k ? 'border-brand-600 bg-brand-50' : 'border-gray-200 hover:border-gray-400'}`}
            onClick={() => {
              setTask(k);
              setAutoKey('');
            }}
          >
            <div className="flex items-center gap-1.5 font-semibold text-gray-900">
              <Icon name={icon} size={13} />
              {label}
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-gray-500">{hint}</div>
          </button>
        ))}
      </div>

      {task === 'outage' && (
        <label className="block text-xs">
          <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('ai_pick_outage')}</span>
          {outages === null ? (
            <Spinner size={14} />
          ) : outages.length === 0 ? (
            <span className="text-gray-500">{e('ai_none_outage')}</span>
          ) : (
            <select className="input w-full text-xs" value={outageId ?? ''} onChange={(ev) => setOutageId(Number(ev.target.value))}>
              {outages.map((o) => (
                <option key={o.id} value={o.id}>
                  #{o.id} {o.kind} · {o.cause_node_code} · {fmtNum(o.customers ?? (o.summary as any)?.pelanggan ?? 0)} plg · {fmtDate(o.started_at)}
                  {!o.ended_at ? ` · ${e('ai_active').toUpperCase()}` : ''}
                </option>
              ))}
            </select>
          )}
        </label>
      )}
      {task === 'plan' && (
        <label className="block text-xs">
          <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('ai_pick_plan')}</span>
          {plans === null ? (
            <Spinner size={14} />
          ) : plans.length === 0 ? (
            <span className="text-gray-500">{e('ai_none_plan')}</span>
          ) : (
            <select className="input w-full text-xs" value={planId ?? ''} onChange={(ev) => setPlanId(Number(ev.target.value))}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} {p.title} · {p.status} · {p.steps_done}/{p.steps_total}
                </option>
              ))}
            </select>
          )}
        </label>
      )}
      {task === 'shift' && (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{e('ai_hours')}</span>
          <select className="input text-xs" value={hours} onChange={(ev) => setHours(Number(ev.target.value))}>
            {[4, 6, 8, 12, 24].map((h) => (
              <option key={h} value={h}>
                {h} {e('ai_hours_unit')}
              </option>
            ))}
          </select>
        </label>
      )}
      {task === 'insights' && (insights === null ? <Spinner size={14} /> : <InsightList items={insights} max={8} />)}

      {ready && visible && <AiOpsPanel key={`${curKey}-${task === 'shift' ? hours : ''}-${nonce}`} task={task} params={params} autoStart={autoKey === curKey} compact />}
    </div>
  );
}
