'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import type { ComponentType } from '@/lib/types';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { OP_TONE, STATUS_TONE, itemFeatureId, type ChangeItem, type Changeset } from '@/components/changes/types';

interface Props {
  types: ComponentType[];
  /** paket yang sedang ditampilkan (aktif milik sendiri, atau pratinjau paket lain) */
  csId: number;
  /** true = paket milik pengguna & bisa diubah */
  editable: boolean;
  /** naik setiap ada perubahan (muat ulang daftar) */
  refresh: number;
  onSelect: (kind: 'node' | 'edge', id: number) => void;
  onChanged: () => void;
  onSwitch: (id: number) => void;
  onCloseView?: () => void;
}

/** Panel paket perubahan di editor peta: daftar usulan, ubah judul, ajukan untuk disetujui. */
export function ChangesPanel({ types, csId, editable, refresh, onSelect, onChanged, onSwitch, onCloseView }: Props) {
  const { t, pick } = useT();
  const toast = useToast();
  const [cs, setCs] = useState<Changeset | null>(null);
  const [items, setItems] = useState<ChangeItem[]>([]);
  const [mine, setMine] = useState<Changeset[]>([]);
  const [busy, setBusy] = useState('');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [note, setNote] = useState('');

  const typeName = (c: string) => {
    const x = types.find((y) => y.code === c);
    return x ? pick(x.name, x.name_en) : c;
  };

  const load = useCallback(async () => {
    try {
      const own = await api<{ items: Changeset[] }>('/api/gis/changesets?mine=1&status=draft,rejected');
      setMine(own.items);
      if (!csId) {
        setCs(null);
        setItems([]);
        return;
      }
      const r = await api<{ changeset: Changeset; items: ChangeItem[] }>(`/api/gis/changesets/${csId}`);
      setCs(r.changeset);
      setItems(r.items);
      setTitle(r.changeset.title);
      setDesc(r.changeset.description);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [csId, toast]);
  useEffect(() => {
    load();
  }, [load, refresh]);

  const run = async (key: string, fn: () => Promise<any>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) toast.push(msg, 'success');
      await load();
      onChanged();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const newSet = () =>
    run('new', async () => {
      const r = await api<Changeset>('/api/gis/changesets', { method: 'POST', body: {} });
      onSwitch(r.id);
    });

  const canEdit = editable && cs && (cs.status === 'draft' || cs.status === 'rejected');

  return (
    <div className="space-y-3 text-sm text-gray-800">
      {!editable && csId > 0 && (
        <div className="flex items-center justify-between rounded-md bg-brand-50 px-2 py-1.5 text-xs text-brand-800">
          <span>{t('cs.view_only', { id: csId })}</span>
          {onCloseView && (
            <button className="underline" onClick={onCloseView}>
              {t('cs.close_view')}
            </button>
          )}
        </div>
      )}
      {editable && (
        <div className="flex items-center gap-2 text-xs">
          <label className="shrink-0 text-gray-500">{t('cs.active')}</label>
          <select className="input flex-1 text-xs" value={csId || ''} onChange={(e) => onSwitch(Number(e.target.value) || 0)} aria-label={t('cs.switch')}>
            <option value="">—</option>
            {mine.map((m) => (
              <option key={m.id} value={m.id}>
                #{m.id} {m.title} ({t(`cs.st_${m.status}` as any)})
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" icon="plus" loading={busy === 'new'} onClick={newSet} title={t('cs.new')} />
        </div>
      )}
      {!cs ? (
        <p className="text-xs text-gray-500">{t('cs.none')}</p>
      ) : (
        <>
          <div className="rounded-md border border-gray-200 p-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <b className="text-gray-900">#{cs.id}</b>
              <Badge tone={STATUS_TONE[cs.status]}>{t(`cs.st_${cs.status}` as any)}</Badge>
              <span className="ml-auto text-gray-500">{t('cs.items', { n: cs.items })}</span>
            </div>
            {canEdit ? (
              <div className="space-y-1.5">
                <input className="input text-xs" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('cs.title')} aria-label={t('cs.title')} />
                <textarea className="input min-h-[48px] text-xs" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('cs.description')} aria-label={t('cs.description')} />
                {(title !== cs.title || desc !== cs.description) && (
                  <Button size="sm" variant="secondary" loading={busy === 'save'} onClick={() => run('save', () => api(`/api/gis/changesets/${cs.id}`, { method: 'PUT', body: { title, description: desc } }), t('cs.saved'))}>
                    {t('common.save')}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="font-medium text-gray-900">{cs.title}</div>
                {cs.description && <div className="text-gray-600">{cs.description}</div>}
                <div className="text-gray-500">
                  {cs.created_by_name} · {fmtDate(cs.created_at)}
                </div>
              </>
            )}
            {cs.status === 'rejected' && cs.review_note && (
              <div className="mt-1 rounded bg-red-50 px-2 py-1 text-red-800">
                {t('cs.review_note')} ({cs.reviewed_by}): {cs.review_note}
              </div>
            )}
          </div>
          <div className="text-[11px] text-gray-500">{t('cs.legend')}</div>
          {items.length === 0 ? (
            <p className="text-xs text-gray-500">-</p>
          ) : (
            <ul className="max-h-[40vh] space-y-1 overflow-y-auto">
              {items.map((it) => (
                <li key={it.id} className="flex items-start gap-1.5 rounded border border-gray-200 px-2 py-1 text-xs">
                  <Badge tone={OP_TONE[it.op]}>{t(`cs.short_${it.op}` as any)}</Badge>
                  <button className="min-w-0 flex-1 text-left hover:underline" onClick={() => itemFeatureId(it) && onSelect(it.kind, itemFeatureId(it))}>
                    <span className="font-medium text-gray-900">{it.code || (it.target_id ? `#${it.target_id}` : `#${it.seq}`)}</span>{' '}
                    <span className="text-gray-500">{typeName(it.type_code)}</span>
                    {it.changes && it.changes.length > 0 && <span className="text-gray-600"> · {it.changes.join(', ')}</span>}
                    {it.status !== 'pending' && <span className={it.status === 'failed' ? 'text-red-700' : 'text-emerald-700'}> · {it.status}</span>}
                    {it.error && <div className="text-red-700">{it.error}</div>}
                  </button>
                  {canEdit && (
                    <button
                      className="px-1 text-gray-400 hover:text-red-600"
                      title={t('cs.remove_item')}
                      aria-label={t('cs.remove_item')}
                      onClick={() => run(`rm${it.id}`, () => api(`/api/gis/changesets/${cs.id}/items/${it.id}`, { method: 'DELETE' }))}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && cs.items > 0 && (
            <div className="space-y-1.5 border-t border-gray-200 pt-2">
              <input className="input text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cs.submit_note')} aria-label={t('cs.submit_note')} />
              <Button size="sm" icon="send" className="w-full" loading={busy === 'submit'} onClick={() => run('submit', () => api(`/api/gis/changesets/${cs.id}/submit`, { method: 'POST', body: { note } }), t('cs.submitted', { id: cs.id }))}>
                {t('cs.submit')}
              </Button>
            </div>
          )}
          <Link href={`/changes?id=${cs.id}`} className="block text-center text-xs text-brand-700 hover:underline">
            {t('cs.open_page')} →
          </Link>
        </>
      )}
      {busy && busy !== 'submit' && busy !== 'new' && <Spinner size={14} />}
    </div>
  );
}
