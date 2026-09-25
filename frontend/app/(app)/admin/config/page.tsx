'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { AppConfig } from '@/lib/types';
import { Button, Confirm, Field, Modal, PageHeader, useToast } from '@/components/ui';
import { fmtDate } from '@/lib/format';

const GROUP_KEYS: Record<string, string> = {
  general: 'config.group_general',
  auth: 'config.group_auth',
  loading: 'config.group_loading',
  topology: 'config.group_topology',
  trace: 'config.group_trace',
  monitoring: 'config.group_monitoring',
};

export default function ConfigPage() {
  const { t } = useT();
  const toast = useToast();
  const [items, setItems] = useState<AppConfig[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newCfg, setNewCfg] = useState({ key: '', value: '', value_type: 'string', group: 'general', description: '' });
  const [del, setDel] = useState<AppConfig | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: AppConfig[] }>('/api/admin/configs');
      setItems(r.items);
      setDraft({});
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => Array.from(new Set(items.map((i) => i.group))), [items]);
  const changed = Object.keys(draft).filter((k) => draft[k] !== items.find((i) => i.key === k)?.value);

  async function saveAll() {
    if (changed.length === 0) return;
    setSaving(true);
    try {
      await api('/api/admin/configs', { method: 'PUT', body: { items: changed.map((k) => ({ key: k, value: draft[k] })) } });
      toast.push(t('config.saved', { n: changed.length }), 'success');
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function addNew(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/configs', { method: 'PUT', body: { items: [newCfg] } });
      toast.push(t('config.added'), 'success');
      setAdding(false);
      setNewCfg({ key: '', value: '', value_type: 'string', group: 'general', description: '' });
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  async function confirmDelete() {
    if (!del) return;
    try {
      await api(`/api/admin/configs/${encodeURIComponent(del.key)}`, { method: 'DELETE' });
      toast.push(t('config.deleted'), 'success');
      setDel(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  const valueInput = (c: AppConfig) => {
    const v = draft[c.key] ?? c.value;
    const set = (val: string) => setDraft({ ...draft, [c.key]: val });
    if (c.value_type === 'bool')
      return (
        <select className="input" value={v} onChange={(e) => set(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    if (c.value_type === 'secret')
      return (
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={draft[c.key] ?? ''}
          placeholder={c.has_value ? t('config.secret_saved') : t('config.secret_empty')}
          onChange={(e) => set(e.target.value)}
        />
      );
    if (c.value_type === 'int' || c.value_type === 'float') return <input className="input" type="number" step={c.value_type === 'float' ? 'any' : 1} value={v} onChange={(e) => set(e.target.value)} />;
    return <input className="input" value={v} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t('config.title')}
        subtitle={t('config.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>
              {t('config.add_key')}
            </Button>
            <Button onClick={saveAll} loading={saving} disabled={changed.length === 0} icon="check">
              {t('config.save_changes', { n: changed.length })}
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g} className="card overflow-hidden">
            <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800">{GROUP_KEYS[g] ? t(GROUP_KEYS[g] as any) : g}</div>
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {items
                  .filter((i) => i.group === g)
                  .map((c) => (
                    <tr key={c.key} className={draft[c.key] !== undefined && draft[c.key] !== c.value ? 'bg-amber-50' : ''}>
                      <td className="td w-1/3">
                        <div className="font-mono text-xs font-medium text-gray-900">{c.key}</div>
                        <div className="text-xs text-gray-500">{c.description}</div>
                      </td>
                      <td className="td w-1/3">{valueInput(c)}</td>
                      <td className="td text-xs text-gray-500">
                        {c.value_type} · {fmtDate(c.updated_at)}
                      </td>
                      <td className="td text-right">
                        <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(c)} title={t('common.delete')} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <Modal open={adding} title={t('config.add_title')} onClose={() => setAdding(false)}>
        <form onSubmit={addNew} className="space-y-3">
          <Field label={t('config.key')}>
            <input className="input font-mono" value={newCfg.key} onChange={(e) => setNewCfg({ ...newCfg, key: e.target.value })} required placeholder="group.key_name" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('config.value_type')}>
              <select className="input" value={newCfg.value_type} onChange={(e) => setNewCfg({ ...newCfg, value_type: e.target.value })}>
                {['string', 'int', 'float', 'bool', 'json'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label={t('config.group')}>
              <input className="input" value={newCfg.group} onChange={(e) => setNewCfg({ ...newCfg, group: e.target.value })} />
            </Field>
          </div>
          <Field label={t('config.value')}>
            <input className="input" value={newCfg.value} onChange={(e) => setNewCfg({ ...newCfg, value: e.target.value })} />
          </Field>
          <Field label={t('config.description')}>
            <input className="input" value={newCfg.description} onChange={(e) => setNewCfg({ ...newCfg, description: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit">{t('common.save')}</Button>
          </div>
        </form>
      </Modal>
      <Confirm open={!!del} title={t('config.delete_title')} message={t('config.delete_msg', { key: del?.key || '' })} onCancel={() => setDel(null)} onConfirm={confirmDelete} />
    </div>
  );
}
