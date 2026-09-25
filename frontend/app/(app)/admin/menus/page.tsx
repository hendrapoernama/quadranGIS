'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { Menu, Role } from '@/lib/types';
import { Icon } from '@/components/Icon';
import { Badge, Button, Confirm, Field, Modal, PageHeader, useToast } from '@/components/ui';

const ICONS = ['map', 'settings', 'users', 'shield', 'menu', 'sliders', 'layers', 'activity', 'home', 'database', 'bolt', 'search', 'key', 'clock', 'info'];

interface Row {
  menu: Menu;
  depth: number;
}

function flatten(items: Menu[]): Row[] {
  const byParent = new Map<string | null, Menu[]>();
  for (const m of items) {
    const k = m.parent_id || null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(m);
  }
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    (byParent.get(parent) || [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach((m) => {
        out.push({ menu: m, depth });
        walk(m.id, depth + 1);
      });
  };
  walk(null, 0);
  return out;
}

const emptyForm = { title: '', title_en: '', path: '', icon: 'menu', parent_id: '', sort_order: 0, is_active: true, role_ids: [] as string[] };

export default function MenusPage() {
  const { t, pick } = useT();
  const toast = useToast();
  const { refresh } = useAuth();
  const [items, setItems] = useState<Menu[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<Menu | null | 'new'>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<Menu | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, r] = await Promise.all([api<{ items: Menu[] }>('/api/admin/menus'), api<{ items: Role[] }>('/api/admin/roles')]);
      setItems(m.items);
      setRoles(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => flatten(items), [items]);

  function open(m: Menu | 'new') {
    if (m === 'new') setForm({ ...emptyForm, sort_order: (items.length + 1) * 10 });
    else setForm({ title: m.title, title_en: m.title_en || '', path: m.path, icon: m.icon, parent_id: m.parent_id || '', sort_order: m.sort_order, is_active: m.is_active, role_ids: [...m.role_ids] });
    setEditing(m);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { ...form, parent_id: form.parent_id || null };
      if (editing === 'new') await api('/api/admin/menus', { method: 'POST', body });
      else if (editing) await api(`/api/admin/menus/${editing.id}`, { method: 'PUT', body });
      toast.push(t('menus.saved'), 'success');
      setEditing(null);
      await load();
      refresh();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!del) return;
    try {
      await api(`/api/admin/menus/${del.id}`, { method: 'DELETE' });
      toast.push(t('menus.deleted'), 'success');
      setDel(null);
      await load();
      refresh();
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name || '?';

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t('menus.title')}
        subtitle={t('menus.subtitle')}
        actions={
          <Button icon="plus" onClick={() => open('new')}>
            {t('menus.add')}
          </Button>
        }
      />
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="th">{t('menus.col_title')}</th>
              <th className="th">{t('menus.path')}</th>
              <th className="th">{t('menus.order')}</th>
              <th className="th">{t('menus.roles')}</th>
              <th className="th">{t('common.active')}</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(({ menu: m, depth }) => (
              <tr key={m.id} className="hover:bg-gray-50">
                <td className="td">
                  <div className="flex items-center gap-2" style={{ paddingLeft: depth * 20 }}>
                    <Icon name={m.icon || 'menu'} size={16} className="text-gray-500" />
                    <span className="font-medium">{pick(m.title, m.title_en)}</span>
                    {m.title_en && <span className="text-xs text-gray-400">({pick(m.title_en, m.title)})</span>}
                  </div>
                </td>
                <td className="td font-mono text-xs text-gray-600">{m.path || <span className="text-gray-400">{t('menus.group')}</span>}</td>
                <td className="td">{m.sort_order}</td>
                <td className="td">
                  <div className="flex flex-wrap gap-1">
                    {m.role_ids.map((r) => (
                      <Badge key={r} tone="blue">
                        {roleName(r)}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="td">{m.is_active ? <Badge tone="green">{t('common.yes')}</Badge> : <Badge tone="red">{t('common.no')}</Badge>}</td>
                <td className="td text-right">
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => open(m)} title={t('common.edit')} />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(m)} title={t('common.delete')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={editing !== null} title={editing === 'new' ? t('menus.add_title') : t('menus.edit_title')} onClose={() => setEditing(null)}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('menus.title_id')}>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </Field>
            <Field label={t('menus.title_en')}>
              <input className="input" value={form.title_en} onChange={(e) => setForm({ ...form, title_en: e.target.value })} />
            </Field>
            <Field label={t('menus.path_hint')}>
              <input className="input" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/admin/..." />
            </Field>
            <Field label={t('menus.icon')}>
              <select className="input" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })}>
                {ICONS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('menus.parent')}>
              <select className="input" value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
                <option value="">{t('menus.top_level')}</option>
                {items
                  .filter((m) => editing === 'new' || m.id !== (editing as Menu)?.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {pick(m.title, m.title_en)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t('menus.order')}>
              <input className="input" type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> {t('common.active')}
          </label>
          <div>
            <label className="label">{t('menus.roles_access')}</label>
            <div className="flex flex-wrap gap-2 rounded-md border border-gray-200 p-2">
              {roles.map((r) => (
                <label key={r.id} className="flex items-center gap-1 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    checked={form.role_ids.includes(r.id)}
                    onChange={() => setForm((f) => ({ ...f, role_ids: f.role_ids.includes(r.id) ? f.role_ids.filter((x) => x !== r.id) : [...f.role_ids, r.id] }))}
                  />
                  {r.name}
                </label>
              ))}
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
      <Confirm open={!!del} title={t('menus.delete_title')} message={t('menus.delete_msg', { name: del ? pick(del.title, del.title_en) : '' })} onCancel={() => setDel(null)} onConfirm={confirmDelete} />
    </div>
  );
}
