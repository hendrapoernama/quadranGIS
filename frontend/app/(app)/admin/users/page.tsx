'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { Role, User } from '@/lib/types';
import { Badge, Button, Confirm, EmptyState, Field, Modal, PageHeader, useToast } from '@/components/ui';
import { fmtDate } from '@/lib/format';

const empty = { username: '', email: '', full_name: '', password: '', role_id: '', is_active: true };

export default function UsersPage() {
  const { t } = useT();
  const toast = useToast();
  const [items, setItems] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [roles, setRoles] = useState<Role[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const size = 20;
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<User | null | 'new'>(null);
  const [form, setForm] = useState({ ...empty });
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<User | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: User[]; total: number }>(`/api/admin/users?q=${encodeURIComponent(q)}&page=${page}&size=${size}`);
      setItems(r.items);
      setTotal(r.total);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [q, page, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api<{ items: Role[] }>('/api/admin/roles').then((r) => setRoles(r.items)).catch(() => {});
  }, []);

  function openNew() {
    setForm({ ...empty });
    setEditing('new');
  }
  function openEdit(u: User) {
    setForm({ username: u.username, email: u.email, full_name: u.full_name, password: '', role_id: u.role_id || '', is_active: u.is_active });
    setEditing(u);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body: any = { ...form, role_id: form.role_id || null };
      if (!body.password) delete body.password;
      if (editing === 'new') await api('/api/admin/users', { method: 'POST', body });
      else if (editing) await api(`/api/admin/users/${editing.id}`, { method: 'PUT', body });
      toast.push(t('users.saved'), 'success');
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
      await api(`/api/admin/users/${del.id}`, { method: 'DELETE' });
      toast.push(t('users.deleted'), 'success');
      setDel(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle', { n: total })}
        actions={
          <>
            <input
              className="input w-64"
              placeholder={t('users.search_placeholder')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
            <Button icon="plus" onClick={openNew}>
              {t('common.add')}
            </Button>
          </>
        }
      />
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="th">{t('users.username')}</th>
              <th className="th">{t('common.name')}</th>
              <th className="th">{t('users.email')}</th>
              <th className="th">{t('users.role')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('users.last_login')}</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="td font-medium">{u.username}</td>
                <td className="td">{u.full_name || '-'}</td>
                <td className="td">{u.email || '-'}</td>
                <td className="td">{u.role_name ? <Badge tone="blue">{u.role_name}</Badge> : '-'}</td>
                <td className="td">{u.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge tone="red">{t('common.inactive')}</Badge>}</td>
                <td className="td text-gray-500">{fmtDate(u.last_login_at)}</td>
                <td className="td text-right">
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => openEdit(u)} title={t('common.edit')} />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(u)} title={t('common.delete')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && <EmptyState text={t('users.empty')} />}
        <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs text-gray-600">
          <span>{t('common.page_of', { page, pages })}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t('common.prev')}
            </Button>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {t('common.next')}
            </Button>
          </div>
        </div>
      </div>

      <Modal open={editing !== null} title={editing === 'new' ? t('users.add_title') : t('users.edit_title')} onClose={() => setEditing(null)}>
        <form onSubmit={submit} className="space-y-3" id="user-form">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('users.username')}>
              <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
            </Field>
            <Field label={t('users.full_name')}>
              <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </Field>
            <Field label={t('users.email')}>
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label={t('users.role')}>
              <select className="input" value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })}>
                <option value="">{t('users.no_role')}</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={editing === 'new' ? t('users.password') : t('users.new_password')} hint={t('users.password_hint')}>
              <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={editing === 'new'} />
            </Field>
            <Field label={t('common.status')}>
              <label className="flex items-center gap-2 py-1.5 text-sm text-gray-800">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> {t('common.active')}
              </label>
            </Field>
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
      <Confirm open={!!del} title={t('users.delete_title')} message={t('users.delete_msg', { name: del?.username || '' })} onCancel={() => setDel(null)} onConfirm={confirmDelete} />
    </div>
  );
}
