'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { realtime } from '@/lib/ws';
import { fmtDate } from '@/lib/format';
import type { ComponentType } from '@/lib/types';
import { Badge, Button, PageHeader, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { OP_TONE, STATUS_TONE, type ChangeItem, type ChangeLog, type Changeset, type Conflict, type CsStatus } from './types';
import { useCsT } from './i18n';

type Filter = 'todo' | CsStatus | 'all';

interface Detail {
  changeset: Changeset;
  items: ChangeItem[];
  log: ChangeLog[];
  conflicts?: Conflict[];
}

export default function Changes() {
  const C = useCsT();
  const { t, pick } = useT();
  const { has, user } = useAuth();
  const toast = useToast();
  const canApprove = has('gis.approve');
  const canRelease = has('gis.release');
  const canEdit = has('gis.edit');
  const [filter, setFilter] = useState<Filter>('todo');
  const [list, setList] = useState<Changeset[] | null>(null);
  const [meta, setMeta] = useState<{ submitted: number; approved: number; allow_self: boolean; enabled: boolean } | null>(null);
  const [sel, setSel] = useState<number>(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [types, setTypes] = useState<ComponentType[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('id') || 0);
    if (q) {
      setSel(q);
      setFilter('all');
    }
    api<{ types: ComponentType[] }>('/api/config/public')
      .then((r) => setTypes(r.types))
      .catch(() => {});
  }, []);

  const statusFor = (f: Filter): string => {
    if (f === 'all') return '';
    if (f !== 'todo') return f;
    const s: string[] = [];
    if (canApprove) s.push('submitted');
    if (canRelease) s.push('approved');
    if (canEdit) s.push('draft', 'rejected');
    return s.join(',');
  };

  const loadList = useCallback(async () => {
    try {
      const mine = filter === 'todo' && !canApprove && !canRelease ? '&mine=1' : '';
      const r = await api<{ items: Changeset[]; submitted: number; approved: number; allow_self: boolean; enabled: boolean }>(
        `/api/gis/changesets?status=${statusFor(filter)}${mine}`,
      );
      // "perlu tindakan": draf/ditolak hanya milik sendiri
      const items = filter === 'todo' ? r.items.filter((x) => x.status === 'submitted' || x.status === 'approved' || x.created_by === user?.id) : r.items;
      setList(items);
      setMeta({ submitted: r.submitted, approved: r.approved, allow_self: r.allow_self, enabled: r.enabled });
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, toast, user?.id, canApprove, canRelease]);

  const loadDetail = useCallback(async () => {
    if (!sel) return setDetail(null);
    try {
      setDetail(await api<Detail>(`/api/gis/changesets/${sel}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setDetail(null);
    }
  }, [sel, toast]);

  useEffect(() => {
    loadList();
  }, [loadList, tick]);
  useEffect(() => {
    loadDetail();
    setNote('');
  }, [loadDetail, tick]);
  useEffect(() => {
    realtime.connect();
    const off = realtime.subscribe((ev) => {
      if (ev.type.startsWith('changeset.')) setTick((x) => x + 1);
    });
    return () => {
      off();
    };
  }, []);

  const act = async (action: string) => {
    if (!detail) return;
    if (action === 'reject' && !note.trim()) {
      toast.push(C('reject_need_note'), 'warning');
      return;
    }
    setBusy(action);
    try {
      const r = await api<{ applied?: number; failed?: number }>(`/api/gis/changesets/${detail.changeset.id}/${action}`, { method: 'POST', body: { note } });
      if (action === 'release') toast.push(C('released_msg', { a: r.applied ?? 0, f: r.failed ?? 0 }), (r.failed ?? 0) > 0 ? 'warning' : 'success');
      else toast.push(C(`done_${action}`, { id: detail.changeset.id }), 'success');
      setNote('');
      setTick((x) => x + 1);
    } catch (e: any) {
      toast.push(e.message, 'error');
      setTick((x) => x + 1);
    } finally {
      setBusy('');
    }
  };

  const typeName = (c: string) => {
    const x = types.find((y) => y.code === c);
    return x ? pick(x.name, x.name_en) : c;
  };

  const chips: [Filter, string, number?][] = [
    ['todo', C('f_todo')],
    ['submitted', t('cs.st_submitted'), meta?.submitted],
    ['approved', t('cs.st_approved'), meta?.approved],
    ['released', t('cs.st_released')],
    ['rejected', t('cs.st_rejected')],
    ['draft', t('cs.st_draft')],
    ['cancelled', t('cs.st_cancelled')],
    ['all', C('f_all')],
  ];

  const cs = detail?.changeset;
  const isAuthor = !!cs && cs.created_by === user?.id;
  const selfBlocked = isAuthor && !meta?.allow_self;

  return (
    <div className="h-full overflow-y-auto p-3 md:p-6">
      <PageHeader title={C('title')} subtitle={C('subtitle')} />
      {meta && !meta.enabled && <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{C('disabled')}</div>}
      <Flow />
      <div className="mb-3 flex flex-wrap gap-1">
        {chips.map(([k, label, n]) => (
          <button key={k} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700 hover:border-gray-500'}`} onClick={() => setFilter(k)}>
            {label}
            {n ? <span className="ml-1 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{n}</span> : null}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[340px,1fr]">
        <div className="card p-2">
          {list === null ? (
            <Spinner size={16} />
          ) : list.length === 0 ? (
            <p className="p-3 text-center text-xs text-gray-500">{C('empty')}</p>
          ) : (
            <ul className="max-h-[70vh] space-y-1 overflow-y-auto">
              {list.map((x) => (
                <li key={x.id}>
                  <button className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${sel === x.id ? 'border-brand-600 bg-brand-50' : 'border-gray-200 hover:border-gray-400'}`} onClick={() => setSel(x.id)}>
                    <div className="flex items-center gap-1.5">
                      <b className="text-gray-900">#{x.id}</b>
                      <Badge tone={STATUS_TONE[x.status]}>{t(`cs.st_${x.status}` as any)}</Badge>
                      {x.source === 'import' && <Badge tone="purple">{C('src_import')}</Badge>}
                      <span className="ml-auto text-[10px] text-gray-500">{fmtDate(x.updated_at)}</span>
                    </div>
                    <div className="mt-0.5 truncate font-medium text-gray-900">{x.title}</div>
                    <div className="flex flex-wrap gap-x-2 text-[10px] text-gray-500">
                      <span>{x.created_by_name}</span>
                      {Object.entries(x.counts || {}).map(([op, n]) => (
                        <span key={op}>
                          {C(`op_${op}`)} {n}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          {!cs ? (
            <div className="card p-10 text-center text-sm text-gray-500">{C('pick')}</div>
          ) : (
            <div className="space-y-3">
              <div className="card space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-gray-900">
                    #{cs.id} · {cs.title}
                  </h2>
                  <Badge tone={STATUS_TONE[cs.status]}>{t(`cs.st_${cs.status}` as any)}</Badge>
                  {cs.source === 'import' && <Badge tone="purple">{C('src_import')}</Badge>}
                  <Link href={`/map?cs=${cs.id}`} className="ml-auto flex items-center gap-1 text-xs text-brand-700 hover:underline">
                    <Icon name="map" size={14} /> {t('cs.show_on_map')}
                  </Link>
                </div>
                {cs.description && <p className="text-sm text-gray-700">{cs.description}</p>}
                <Steps cs={cs} />
                {cs.review_note && (
                  <div className={`rounded-md px-3 py-2 text-xs ${cs.status === 'rejected' ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-700'}`}>
                    {t('cs.review_note')} ({cs.reviewed_by}): {cs.review_note}
                  </div>
                )}
                {cs.status === 'released' && (
                  <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{C('release_summary', { a: cs.applied, f: cs.failed, by: cs.released_by, at: fmtDate(cs.released_at) })}</div>
                )}
                {detail!.conflicts && detail!.conflicts.length > 0 && (
                  <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                    <b>{t('cs.conflicts', { n: detail!.conflicts.length })}</b>
                    <ul className="mt-1 list-disc pl-4">
                      {detail!.conflicts.map((c) => (
                        <li key={c.item_id}>
                          {c.kind} #{c.target_id} {c.code} — {c.reason}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1">{C('conflict_hint')}</div>
                  </div>
                )}

                {/* tindakan sesuai status & jenjang */}
                <Actions
                  cs={cs}
                  isAuthor={isAuthor}
                  canEdit={canEdit}
                  canApprove={canApprove}
                  canRelease={canRelease}
                  selfBlocked={selfBlocked}
                  note={note}
                  setNote={setNote}
                  busy={busy}
                  act={act}
                />
              </div>

              <div className="card overflow-x-auto p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-900">{C('items_title', { n: detail!.items.length })}</h3>
                <table className="w-full min-w-[640px] text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                      <th className="w-8 py-1">#</th>
                      <th className="w-24 py-1">{C('col_op')}</th>
                      <th className="py-1">{C('col_object')}</th>
                      <th className="py-1">{C('col_detail')}</th>
                      <th className="w-20 py-1">{C('col_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail!.items.map((it) => (
                      <tr key={it.id} className="border-b border-gray-100 align-top">
                        <td className="py-1.5 text-gray-500">{it.seq}</td>
                        <td className="py-1.5">
                          <Badge tone={OP_TONE[it.op]}>{C(`op_${it.op}`)}</Badge>
                        </td>
                        <td className="py-1.5">
                          <Link href={`/map?cs=${cs.id}&select=${it.kind}:${it.op === 'create' ? -it.id : it.target_id}`} className="font-medium text-brand-700 hover:underline">
                            {it.code || (it.target_id ? `#${it.target_id}` : C('new_object'))}
                          </Link>
                          <div className="text-gray-500">
                            {typeName(it.type_code)} · {it.kind === 'node' ? t('map.node') : t('map.edge')}
                            {it.target_id ? ` #${it.target_id}` : ''}
                          </div>
                          <div className="text-[10px] text-gray-400">
                            {it.created_by_name} · {fmtDate(it.updated_at)}
                          </div>
                        </td>
                        <td className="py-1.5">
                          <ItemDiff it={it} typeName={typeName} />
                        </td>
                        <td className="py-1.5">
                          <Badge tone={it.status === 'applied' ? 'green' : it.status === 'failed' ? 'red' : 'gray'}>{C(`it_${it.status}`)}</Badge>
                          {it.error && <div className="mt-0.5 text-red-700">{it.error}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-900">{C('log_title')}</h3>
                <ol className="space-y-1.5 border-l-2 border-gray-200 pl-3 text-xs">
                  {detail!.log.map((l, i) => (
                    <li key={i}>
                      <span className="font-mono text-[11px] text-gray-500">{fmtDate(l.at)}</span> <b className="text-gray-900">{C(`log_${l.action}`)}</b> · {l.full_name || l.username}
                      {l.role && <span className="text-gray-500"> ({l.role})</span>}
                      {l.note && <div className="italic text-gray-600">“{l.note}”</div>}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Alur & jenjang persetujuan. */
function Flow() {
  const C = useCsT();
  const steps: [string, string, string][] = [
    ['edit', C('step_draft'), C('who_draft')],
    ['send', C('step_submit'), C('who_draft')],
    ['check', C('step_approve'), C('who_approve')],
    ['bolt', C('step_release'), C('who_release')],
  ];
  return (
    <div className="card mb-3 flex flex-wrap items-stretch gap-2 p-3 text-xs">
      {steps.map(([icon, label, who], i) => (
        <div key={label} className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5">
            <Icon name={icon} size={15} />
            <div>
              <div className="font-semibold text-gray-900">{label}</div>
              <div className="text-[10px] text-gray-500">{who}</div>
            </div>
          </div>
          {i < steps.length - 1 && <span className="text-gray-400">→</span>}
        </div>
      ))}
      <div className="self-center text-[11px] text-gray-500">{C('flow_note')}</div>
    </div>
  );
}

function Steps({ cs }: { cs: Changeset }) {
  const C = useCsT();
  const order: CsStatus[] = ['draft', 'submitted', 'approved', 'released'];
  const reached = cs.status === 'rejected' ? 1 : cs.status === 'cancelled' ? 0 : order.indexOf(cs.status);
  const info = [
    `${cs.created_by_name} · ${fmtDate(cs.created_at)}`,
    cs.submitted_at ? `${cs.submitted_by} · ${fmtDate(cs.submitted_at)}` : '',
    cs.reviewed_at && cs.status !== 'rejected' ? `${cs.reviewed_by} · ${fmtDate(cs.reviewed_at)}` : '',
    cs.released_at ? `${cs.released_by} · ${fmtDate(cs.released_at)}` : '',
  ];
  return (
    <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      {order.map((st, i) => (
        <li key={st} className={`rounded-md border px-2 py-1.5 ${i <= reached ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200'}`}>
          <div className={`font-semibold ${i <= reached ? 'text-emerald-800' : 'text-gray-500'}`}>
            {i <= reached ? '✓ ' : ''}
            {C(`st_${st}`)}
          </div>
          <div className="truncate text-[10px] text-gray-500">{info[i] || '—'}</div>
        </li>
      ))}
      {(cs.status === 'rejected' || cs.status === 'cancelled') && (
        <li className="col-span-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-red-800 sm:col-span-4">
          <b>{C(`st_${cs.status}`)}</b>
          {cs.status === 'rejected' && ` · ${cs.reviewed_by} · ${fmtDate(cs.reviewed_at)}`}
        </li>
      )}
    </ol>
  );
}

function Actions(props: {
  cs: Changeset;
  isAuthor: boolean;
  canEdit: boolean;
  canApprove: boolean;
  canRelease: boolean;
  selfBlocked: boolean;
  note: string;
  setNote: (v: string) => void;
  busy: string;
  act: (a: string) => void;
}) {
  const C = useCsT();
  const { cs, isAuthor, canEdit, canApprove, canRelease, selfBlocked, note, setNote, busy, act } = props;
  const editable = cs.status === 'draft' || cs.status === 'rejected';
  const buttons: React.ReactNode[] = [];
  if (editable && isAuthor && canEdit) {
    buttons.push(
      <Button key="submit" size="sm" icon="send" loading={busy === 'submit'} disabled={cs.items === 0} onClick={() => act('submit')}>
        {C('btn_submit')}
      </Button>,
      <Link key="edit" href={`/map?cs=${cs.id}`} className="btn-secondary inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100">
        <Icon name="edit" size={13} /> {C('btn_edit_map')}
      </Link>,
      <Button key="cancel" size="sm" variant="ghost" icon="trash" loading={busy === 'cancel'} onClick={() => act('cancel')}>
        {C('btn_cancel')}
      </Button>,
    );
  }
  if (cs.status === 'submitted' && canApprove) {
    buttons.push(
      <Button key="approve" size="sm" icon="check" loading={busy === 'approve'} disabled={selfBlocked} onClick={() => act('approve')}>
        {C('btn_approve')}
      </Button>,
    );
  }
  if ((cs.status === 'submitted' && canApprove) || (cs.status === 'approved' && (canApprove || canRelease))) {
    buttons.push(
      <Button key="reject" size="sm" variant="danger" icon="x" loading={busy === 'reject'} onClick={() => act('reject')}>
        {C('btn_reject')}
      </Button>,
    );
  }
  if (cs.status === 'approved' && canRelease) {
    buttons.push(
      <Button key="release" size="sm" icon="bolt" loading={busy === 'release'} onClick={() => act('release')}>
        {C('btn_release')}
      </Button>,
    );
  }
  if (buttons.length === 0) {
    const hint =
      cs.status === 'submitted' ? C('wait_approve') : cs.status === 'approved' ? C('wait_release') : editable && !isAuthor ? C('wait_author') : '';
    return hint ? <p className="text-xs text-gray-500">{hint}</p> : null;
  }
  return (
    <div className="space-y-2 border-t border-gray-200 pt-3">
      <textarea className="input min-h-[52px] text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder={C('note_ph')} aria-label={C('note_ph')} />
      {selfBlocked && cs.status === 'submitted' && canApprove && <p className="text-[11px] text-amber-700">{C('self_blocked')}</p>}
      <div className="flex flex-wrap gap-2">{buttons}</div>
    </div>
  );
}

/** Perbandingan sebelum / sesudah untuk satu item. */
function ItemDiff({ it, typeName }: { it: ChangeItem; typeName: (c: string) => string }) {
  const C = useCsT();
  const rows = useMemo(() => {
    const out: [string, string, string][] = [];
    const b = it.before?.properties || {};
    const body = it.body || {};
    const show = (v: any) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (it.op === 'create') {
      if (body.code) out.push([C('f_code'), '', show(body.code)]);
      if (body.name) out.push([C('f_name'), '', show(body.name)]);
      for (const [k, v] of Object.entries(body.properties || {})) out.push([k, '', show(v)]);
      if (body.unit_id) out.push([C('f_unit'), '', `#${body.unit_id}`]);
      out.push([C('f_geom'), '', body.geometry?.type || '']);
      return out;
    }
    if (it.op !== 'update') return out;
    if (body.type_code && body.type_code !== b.type_code) out.push([C('f_type'), typeName(b.type_code), typeName(body.type_code)]);
    if (body.code !== undefined && body.code !== b.code) out.push([C('f_code'), show(b.code), show(body.code)]);
    if (body.name !== undefined && body.name !== b.name) out.push([C('f_name'), show(b.name), show(body.name)]);
    if (body.status && body.status !== b.status) out.push([C('f_status'), show(b.status), show(body.status)]);
    if (body.unit_id !== undefined && (body.unit_id || null) !== (b.unit_id || null)) out.push([C('f_unit'), b.unit_id ? `#${b.unit_id}` : '—', body.unit_id ? `#${body.unit_id}` : C('auto')]);
    if (body.properties) {
      const before = b.properties || {};
      const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(body.properties)]));
      for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(body.properties[k])) out.push([k, show(before[k]), show(body.properties[k])]);
    }
    if (body.geometry) out.push([C('f_geom'), C('geom_old'), C('geom_new')]);
    return out;
  }, [it, typeName, C]);
  if (it.op === 'delete') return <span className="text-red-700">{C('del_note')}</span>;
  if (it.op === 'split') return <span>{C('split_note', { lng: it.body?.lng?.toFixed?.(6), lat: it.body?.lat?.toFixed?.(6) })}</span>;
  if (it.op === 'merge') return <span>{C('merge_note')}</span>;
  if (rows.length === 0) return <span className="text-gray-500">{C('no_diff')}</span>;
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map(([k, a, b]) => (
          <tr key={k}>
            <td className="w-28 pr-2 align-top text-gray-500">{k}</td>
            {it.op === 'update' && <td className="pr-2 align-top text-red-700 line-through decoration-red-300">{a}</td>}
            <td className="align-top text-emerald-700">{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
