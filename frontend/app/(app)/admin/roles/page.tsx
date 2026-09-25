'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { Permission, Role } from '@/lib/types';
import { Badge, Button, Confirm, Field, Modal, PageHeader, useToast } from '@/components/ui';

export default function RolesPage() {
  const { t, pick } = useT();
  const toast = useToast();
  const [items, setItems] = useState<Role[]>([]);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [editing, setEditing] = useState<Role | null | 'new'>(null);
  const [form, setForm] = useState({ name: '', description: '', permissions: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<Role | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([api<{ items: Role[] }>('/api/admin/roles'), api<{ items: Permission[] }>('/api/admin/permissions')]);
      setItems(r.items);
      setPerms(p.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = Array.from(new Set(perms.map((p) => p.group)));

  function open(r: Role | 'new') {
    if (r === 'new') setForm({ name: '', description: '', permissions: [] });
    else setForm({ name: r.name, description: r.description, permissions: [...r.permissions] });
    setEditing(r);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing === 'new') await api('/api/admin/roles', { method: 'POST', body: form });
      else if (editing) await api(`/api/admin/roles/${editing.id}`, { method: 'PUT', body: form });
      toast.push(t('roles.saved'), 'success');
      setEditing(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!del) return;
    try {
      await api(`/api/admin/roles/${del.id}`, { method: 'DELETE' });
      toast.push(t('roles.deleted'), 'success');
      setDel(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  const togglePerm = (k: string) => setForm((f) => ({ ...f, permissions: f.permissions.includes(k) ? f.permissions.filter((x) => x !== k) : [...f.permissions, k] }));

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t('roles.title')}
        subtitle={t('roles.subtitle')}
        actions={
          <Button icon="plus" onClick={() => open('new')}>
            {t('roles.add')}
          </Button>
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((r) => (
          <div key={r.id} className="card p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-gray-900">{r.name}</h3>
                  {r.is_system && <Badge>{t('roles.system')}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{r.description || '-'}</p>
              </div>
              <div className="flex">
                <Button size="sm" variant="ghost" icon="edit" onClick={() => open(r)} title={t('common.edit')} />
                {!r.is_system && <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(r)} title={t('common.delete')} />}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {r.permissions.length === 0 && <span className="text-xs text-gray-400">{t('roles.no_perms')}</span>}
              {r.permissions.map((p) => (
                <span key={p} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700">
                  {p}
                </span>
              ))}
            </div>
            <div className="mt-3 text-xs text-gray-500">{t('roles.users_count', { n: r.user_count })}</div>
          </div>
        ))}
      </div>

      <Modal open={editing !== null} title={editing === 'new' ? t('roles.add_title') : t('roles.edit_title')} onClose={() => setEditing(null)}>
        <form onSubmit={submit} className="space-y-3">
          <Field label={t('common.name')}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required disabled={editing !== 'new' && editing?.is_system} />
          </Field>
          <Field label={t('roles.description')}>
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div>
            <label className="label">{t('roles.permissions')}</label>
            <div className="space-y-3 rounded-md border border-gray-200 p-3">
              {groups.map((g) => {
                const first = perms.find((p) => p.group === g);
                return (
                  <div key={g}>
                    <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{pick(g, first?.group_en)}</div>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {perms
                        .filter((p) => p.group === g)
                        .map((p) => (
                          <label key={p.key} className="flex items-start gap-2 text-sm">
                            <input type="checkbox" className="mt-1" checked={form.permissions.includes(p.key)} onChange={() => togglePerm(p.key)} />
                            <span>
                              <span className="font-mono text-xs text-gray-700">{p.key}</span>
                              <br />
                              <span className="text-xs text-gray-500">{pick(p.label, p.label_en)}</span>
                            </span>
                          </label>
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={saving}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Modal>
      <Confirm open={!!del} title={t('roles.delete_title')} message={t('roles.delete_msg', { name: del?.name || '' })} onCancel={() => setDel(null)} onConfirm={confirmDelete} />
    </div>
  );
}
