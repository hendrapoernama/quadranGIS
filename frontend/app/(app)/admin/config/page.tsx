'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { AppConfig } from '@/lib/types';
import { Button, Confirm, Field, Modal, PageHeader, useToast } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { BrandingForm } from '@/components/BrandingForm';

const GROUP_KEYS: Record<string, string> = {
  general: 'config.group_general',
  auth: 'config.group_auth',
  loading: 'config.group_loading',
  topology: 'config.group_topology',
  trace: 'config.group_trace',
  monitoring: 'config.group_monitoring',
  reliability: 'config.group_reliability',
  powerflow: 'config.group_powerflow',
  load: 'config.group_load',
  mobile: 'config.group_mobile',
  ai: 'config.group_ai',
};
// urutan tab; grup lain (mis. ditambah lewat "Tambah key") menyusul urut abjad
const GROUP_ORDER = ['general', 'auth', 'loading', 'topology', 'trace', 'monitoring', 'reliability', 'powerflow', 'load', 'mobile', 'ai'];
const IDENTITY = '__identity';

function tabFromUrl(): string {
  if (typeof window === 'undefined') return IDENTITY;
  return new URLSearchParams(window.location.search).get('tab') || IDENTITY;
}

export default function ConfigPage() {
  const { t } = useT();
  const toast = useToast();
  const [items, setItems] = useState<AppConfig[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newCfg, setNewCfg] = useState({ key: '', value: '', value_type: 'string', group: 'general', description: '' });
  const [del, setDel] = useState<AppConfig | null>(null);
  const [tab, setTabState] = useState<string>(IDENTITY);
  const [q, setQ] = useState('');

  useEffect(() => setTabState(tabFromUrl()), []);
  const setTab = (g: string) => {
    setTabState(g);
    setQ('');
    try {
      const u = new URL(window.location.href);
      if (g === IDENTITY) u.searchParams.delete('tab');
      else u.searchParams.set('tab', g);
      window.history.replaceState(null, '', u.toString());
    } catch {
      /* abaikan */
    }
  };

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

  // grup branding dikelola lewat tab Identitas Aplikasi
  const groups = useMemo(() => {
    const set = Array.from(new Set(items.map((i) => i.group))).filter((g) => g !== 'branding');
    const rank = (g: string) => (GROUP_ORDER.indexOf(g) < 0 ? GROUP_ORDER.length : GROUP_ORDER.indexOf(g));
    return set.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [items]);
  const changed = Object.keys(draft).filter((k) => draft[k] !== items.find((i) => i.key === k)?.value);
  const changedByGroup = useMemo(() => {
    const m: Record<string, number> = {};
    for (const k of changed) {
      const g = items.find((i) => i.key === k)?.group;
      if (g) m[g] = (m[g] || 0) + 1;
    }
    return m;
  }, [changed, items]);
  const groupLabel = (g: string) => (GROUP_KEYS[g] ? t(GROUP_KEYS[g] as any) : g);
  const needle = q.trim().toLowerCase();
  const matches = (c: AppConfig) =>
    !needle || c.key.toLowerCase().includes(needle) || (c.description || '').toLowerCase().includes(needle) || (c.value_type !== 'secret' && (c.value || '').toLowerCase().includes(needle));
  const matchByGroup = useMemo(() => {
    const m: Record<string, number> = {};
    if (!needle) return m;
    for (const c of items) if (c.group !== 'branding' && matches(c)) m[c.group] = (m[c.group] || 0) + 1;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, needle]);
  // grup yang ditampilkan: hasil pencarian (semua grup) atau tab aktif
  const shown = needle ? groups.filter((g) => matchByGroup[g]) : groups.includes(tab) ? [tab] : [];
  const activeTab = needle ? '' : groups.includes(tab) || tab === IDENTITY ? tab : IDENTITY;

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
      setTab(newCfg.group || 'general');
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
    if (c.value_type === 'int' || c.value_type === 'float')
      return <input className="input" type="number" step={c.value_type === 'float' ? 'any' : 1} value={v} onChange={(e) => set(e.target.value)} />;
    return <input className="input" value={v} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t('config.title')}
        subtitle={t('config.subtitle')}
        actions={
          <>
            <input className="input !w-56" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('config.search_placeholder')} aria-label={t('config.search_placeholder')} />
            <Button
              variant="secondary"
              icon="plus"
              onClick={() => {
                setNewCfg((n) => ({ ...n, group: groups.includes(activeTab) ? activeTab : 'general' }));
                setAdding(true);
              }}
            >
              {t('config.add_key')}
            </Button>
            <Button onClick={saveAll} loading={saving} disabled={changed.length === 0} icon="check">
              {t('config.save_changes', { n: changed.length })}
            </Button>
          </>
        }
      />
      {/* tab kelompok (membungkus ke baris berikut bila tidak muat); pencarian lintas kelompok ada di header */}
      <div className="config-tabs sticky -top-6 z-10 -mx-6 mb-4 border-b border-gray-200 px-6 pt-1 backdrop-blur">
        <div role="tablist" aria-label={t('config.title')} className="flex flex-wrap gap-x-1">
          {[IDENTITY, ...groups].map((g) => {
            const on = activeTab === g;
            const n = g === IDENTITY ? 0 : items.filter((i) => i.group === g).length;
            const hits = matchByGroup[g];
            return (
              <button
                key={g}
                role="tab"
                aria-selected={on}
                onClick={() => setTab(g)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
                  on ? 'border-brand-600 font-semibold text-brand-700' : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
                } ${needle && !hits ? 'opacity-40' : ''}`}
              >
                {g === IDENTITY ? t('config.tab_identity') : groupLabel(g)}
                {g !== IDENTITY && (
                  <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${needle && hits ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{needle ? hits || 0 : n}</span>
                )}
                {changedByGroup[g] ? <span className="h-2 w-2 rounded-full bg-amber-500" title={t('config.tab_unsaved', { n: changedByGroup[g] })} /> : null}
              </button>
            );
          })}
        </div>
      </div>

      {!needle && activeTab === IDENTITY && <BrandingForm />}
      {needle && shown.length === 0 && <p className="py-10 text-center text-sm text-gray-500">{t('config.search_empty', { q: q.trim() })}</p>}
      <div className="space-y-4">
        {shown.map((g) => {
          const rows = items.filter((i) => i.group === g && matches(i));
          // kelompok campuran (mis. Umum: app / map / sld / unit) dipecah per awalan kunci
          const prefixes = Array.from(new Set(rows.map((r) => r.key.split('.')[0])));
          const split = prefixes.length > 1;
          return (
            <div key={g} className="card overflow-hidden">
              {(needle || split) && (
                <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800">
                  {needle ? (
                    <button className="hover:underline" onClick={() => setTab(g)}>
                      {groupLabel(g)}
                    </button>
                  ) : (
                    groupLabel(g)
                  )}
                </div>
              )}
              <table className="w-full">
                {prefixes.map((p) => (
                  <tbody key={p} className="divide-y divide-gray-100">
                    {split && (
                      <tr className="bg-gray-50">
                        <td colSpan={4} className="px-4 pb-1 pt-3 font-mono text-[11px] font-semibold text-gray-500">
                          {p}.*
                        </td>
                      </tr>
                    )}
                    {rows
                      .filter((r) => r.key.split('.')[0] === p)
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
                ))}
              </table>
            </div>
          );
        })}
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
