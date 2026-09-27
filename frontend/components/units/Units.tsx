'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { fmtDate, fmtNum } from '@/lib/format';
import type { ComponentType } from '@/lib/types';
import { Badge, Button, Confirm, Field, Modal, PageHeader, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { UNIT_KINDS, UNIT_PARENT, invalidateUnits, loadUnits, type OrgUnit } from './useUnits';
import { useUnitT } from './i18n';

const KIND_TONE: Record<string, 'purple' | 'blue' | 'green' | 'amber' | 'gray'> = { PUSAT: 'purple', REGION: 'purple', UID: 'blue', UP2B: 'blue', UP3: 'green', UP2D: 'green', ULP: 'amber' };

type Form = Omit<OrgUnit, 'level' | 'children' | 'updated_at' | 'updated_by' | 'lng' | 'lat'> & { lng: string; lat: string };

const emptyForm = (): Form => ({ id: 0, code: '', name: '', kind: 'ULP', parent_id: null, address: '', lng: '', lat: '', phone: '', email: '', boundary_name: '', active: true });

interface AutoResult {
  applied: boolean;
  total: number;
  by_unit: Record<string, Record<string, number>>;
  default: number;
  unmatched: number;
}

export default function Units() {
  const U = useUnitT();
  const { pick } = useT();
  const { has } = useAuth();
  const toast = useToast();
  const canManage = has('master.manage');
  const [items, setItems] = useState<OrgUnit[] | null>(null);
  const [types, setTypes] = useState<ComponentType[]>([]);
  const [boundaries, setBoundaries] = useState<{ level: string; name: string }[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<OrgUnit | null>(null);
  const [sel, setSel] = useState<OrgUnit | null>(null);
  const [assets, setAssets] = useState<{ id: number; type_code: string; code: string; name: string }[] | null>(null);
  const [auto, setAuto] = useState<{ open: boolean; overwrite: boolean; res: AutoResult | null; busy: string }>({ open: false, overwrite: false, res: null, busy: '' });
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      invalidateUnits();
      setItems(await loadUnits(true));
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);
  useEffect(() => {
    load();
    api<{ types: ComponentType[] }>('/api/config/public')
      .then((r) => setTypes(r.types))
      .catch(() => {});
    api<{ features: { properties: { level: string; name: string } }[] }>('/api/gis/boundaries')
      .then((r) => setBoundaries(r.features.map((f) => ({ level: f.properties.level, name: f.properties.name }))))
      .catch(() => {});
  }, [load]);

  const typeName = (c: string) => {
    const x = types.find((y) => y.code === c);
    return x ? pick(x.name, x.name_en) : c;
  };
  const byId = useMemo(() => new Map((items || []).map((u) => [u.id, u])), [items]);
  const hiddenByCollapse = (u: OrgUnit) => {
    let cur = u.parent_id ? byId.get(u.parent_id) : undefined;
    while (cur) {
      if (collapsed.has(cur.id)) return true;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return false;
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items || []).filter(
      (u) =>
        (!kind || u.kind === kind) &&
        (!s || u.name.toLowerCase().includes(s) || u.code.toLowerCase().includes(s) || u.address.toLowerCase().includes(s)) &&
        (s || kind || !hiddenByCollapse(u)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, kind, collapsed]);
  const totals = useMemo(() => {
    const m: Record<string, number> = {};
    for (const u of items || []) m[u.kind] = (m[u.kind] || 0) + 1;
    return m;
  }, [items]);
  const assetTotal = (u: OrgUnit) => Object.values(u.assets || {}).reduce((a, b) => a + b, 0);

  const openForm = (u?: OrgUnit) => {
    if (!u) return setForm(emptyForm());
    setForm({ ...u, lng: u.lng?.toString() ?? '', lat: u.lat?.toString() ?? '' });
  };
  const save = async () => {
    if (!form) return;
    const lng = form.lng.trim() === '' ? null : Number(form.lng.replace(',', '.'));
    const lat = form.lat.trim() === '' ? null : Number(form.lat.replace(',', '.'));
    if ((lng === null) !== (lat === null) || (lng !== null && (Number.isNaN(lng) || Number.isNaN(lat!) || Math.abs(lng) > 180 || Math.abs(lat!) > 90))) {
      toast.push(U('bad_coord'), 'warning');
      return;
    }
    setSaving(true);
    try {
      const body = { ...form, lng, lat, parent_id: form.parent_id || null };
      await api(form.id ? `/api/units/${form.id}` : '/api/units', { method: form.id ? 'PUT' : 'POST', body });
      toast.push(U('saved'), 'success');
      setForm(null);
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const openAssets = async (u: OrgUnit) => {
    setSel(u);
    setAssets(null);
    try {
      setAssets((await api<{ items: any[] }>(`/api/units/${u.id}/assets?limit=500`)).items);
    } catch {
      setAssets([]);
    }
  };
  const runAuto = async (apply: boolean) => {
    setAuto((a) => ({ ...a, busy: apply ? 'apply' : 'preview' }));
    try {
      const res = await api<AutoResult>('/api/units/auto-assign', { method: 'POST', body: { apply, overwrite: auto.overwrite } });
      setAuto((a) => ({ ...a, res, busy: '' }));
      if (apply) {
        toast.push(U('auto_done', { n: fmtNum(res.total - res.unmatched) }), 'success');
        load();
      }
    } catch (e: any) {
      toast.push(e.message, 'error');
      setAuto((a) => ({ ...a, busy: '' }));
    }
  };

  const parentOptions = (form ? (items || []).filter((u) => UNIT_PARENT[form.kind]?.includes(u.kind) && u.id !== form.id) : []) as OrgUnit[];
  const boundaryLevel = form?.kind === 'ULP' ? 'ulp' : form?.kind === 'UP3' ? 'up3' : '';

  return (
    <div className="h-full overflow-y-auto p-3 md:p-6">
      <PageHeader
        title={U('title')}
        subtitle={U('subtitle')}
        actions={
          canManage ? (
            <>
              <Button variant="secondary" icon="refresh" onClick={() => setAuto({ open: true, overwrite: false, res: null, busy: '' })}>
                {U('auto')}
              </Button>
              <Button icon="plus" onClick={() => openForm()}>
                {U('add')}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="card mb-3 flex flex-wrap items-center gap-2 p-3 text-xs">
        <span className="font-semibold text-gray-700">{U('hierarchy')}</span>
        {[['PUSAT'], ['REGION'], ['UID', 'UP2B'], ['UP3', 'UP2D'], ['ULP']].map((grp, i) => (
          <span key={grp.join()} className="flex items-center gap-1">
            {grp.map((k) => (
              <Badge key={k} tone={KIND_TONE[k]}>
                {k} {totals[k] ? `· ${totals[k]}` : ''}
              </Badge>
            ))}
            {i < 4 && <span className="text-gray-400">→</span>}
          </span>
        ))}
        <span className="text-[11px] text-gray-500">{U('hierarchy_note')}</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr,360px]">
        <div className="card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <input className="input !w-56 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={U('search')} aria-label={U('search')} />
            <select className="input !w-auto text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={U('kind')}>
              <option value="">{U('all_kinds')}</option>
              {UNIT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            {!items && <Spinner size={14} />}
            <span className="ml-auto text-gray-500">{fmtNum(shown.length)}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1">{U('name')}</th>
                  <th className="py-1">{U('code')}</th>
                  <th className="py-1">{U('address')}</th>
                  <th className="py-1">{U('coord')}</th>
                  <th className="py-1">{U('boundary')}</th>
                  <th className="py-1 text-right">{U('assets')}</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id} className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${sel?.id === u.id ? 'bg-brand-50' : ''} ${u.active ? '' : 'opacity-60'}`} onClick={() => openAssets(u)}>
                    <td className="py-1.5">
                      <div className="flex items-center gap-1" style={{ paddingLeft: q || kind ? 0 : u.level * 16 }}>
                        {u.children > 0 && !q && !kind ? (
                          <button
                            className="text-gray-400 hover:text-gray-800"
                            onClick={(e) => {
                              e.stopPropagation();
                              const s = new Set(collapsed);
                              if (s.has(u.id)) s.delete(u.id);
                              else s.add(u.id);
                              setCollapsed(s);
                            }}
                            aria-label={collapsed.has(u.id) ? U('expand') : U('collapse')}
                          >
                            <Icon name={collapsed.has(u.id) ? 'chevron-right' : 'chevron-down'} size={12} />
                          </button>
                        ) : (
                          <span className="inline-block w-3" />
                        )}
                        <Badge tone={KIND_TONE[u.kind]}>{u.kind}</Badge>
                        <span className="font-medium text-gray-900">{u.name}</span>
                        {!u.active && <span className="text-[10px] text-gray-500">({U('inactive')})</span>}
                      </div>
                      {(q || kind) && u.path && u.path.length > 0 && <div className="pl-4 text-[10px] text-gray-500">{u.path.join(' › ')}</div>}
                    </td>
                    <td className="py-1.5 font-mono text-[11px] text-gray-700">{u.code}</td>
                    <td className="max-w-[16rem] truncate py-1.5 text-gray-700" title={u.address}>
                      {u.address || '-'}
                    </td>
                    <td className="py-1.5 font-mono text-[11px] text-gray-600">{u.lng != null ? `${u.lat!.toFixed(5)}, ${u.lng.toFixed(5)}` : '-'}</td>
                    <td className="py-1.5 text-gray-700">{u.boundary_name || '-'}</td>
                    <td className="py-1.5 text-right tabular-nums" title={Object.entries(u.assets || {}).map(([k, v]) => `${typeName(k)}: ${v}`).join('\n')}>
                      {fmtNum(assetTotal(u))}
                    </td>
                    <td className="py-1.5 text-right">
                      {canManage && (
                        <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" icon="edit" onClick={() => openForm(u)} title={U('edit')} />
                          <Button size="sm" variant="ghost" icon="trash" onClick={() => setDel(u)} title={U('delete')} />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card h-fit p-3 text-xs xl:sticky xl:top-0">
          {!sel ? (
            <p className="text-gray-500">{U('pick')}</p>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Badge tone={KIND_TONE[sel.kind]}>{sel.kind}</Badge>
                <b className="text-sm text-gray-900">{sel.name}</b>
              </div>
              <dl className="mb-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
                <dt className="text-gray-500">{U('parent')}</dt>
                <dd>{sel.path && sel.path.length ? sel.path.join(' › ') : '-'}</dd>
                <dt className="text-gray-500">{U('address')}</dt>
                <dd>{sel.address || '-'}</dd>
                <dt className="text-gray-500">{U('contact')}</dt>
                <dd>{[sel.phone, sel.email].filter(Boolean).join(' · ') || '-'}</dd>
                <dt className="text-gray-500">{U('updated')}</dt>
                <dd>
                  {fmtDate(sel.updated_at)} {sel.updated_by ? `· ${sel.updated_by}` : ''}
                </dd>
              </dl>
              <h4 className="mb-1 font-semibold text-gray-900">{U('owned_assets')}</h4>
              <div className="mb-2 flex flex-wrap gap-1">
                {Object.entries(sel.assets || {}).length === 0 ? (
                  <span className="text-gray-500">{U('no_assets')}</span>
                ) : (
                  Object.entries(sel.assets || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <span key={k} className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">
                        {typeName(k)} <b>{fmtNum(v)}</b>
                      </span>
                    ))
                )}
              </div>
              {assets === null ? (
                <Spinner size={14} />
              ) : (
                assets.length > 0 && (
                  <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto">
                    {assets.map((a) => (
                      <li key={a.id} className="flex items-center gap-1">
                        <a className="font-mono text-[11px] text-brand-700 hover:underline" href={`/map?select=node:${a.id}`}>
                          {a.code || `#${a.id}`}
                        </a>
                        <span className="truncate text-gray-500">{typeName(a.type_code)}</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </>
          )}
        </div>
      </div>

      <Modal open={!!form} title={form?.id ? U('edit') : U('add')} onClose={() => setForm(null)} width="max-w-2xl">
        {form && (
          <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={U('kind')}>
                <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as any, parent_id: null })}>
                  {UNIT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k} — {U(`kind_${k}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={U('parent')}>
                <select className="input" value={form.parent_id ?? ''} disabled={UNIT_PARENT[form.kind].length === 0} onChange={(e) => setForm({ ...form, parent_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{UNIT_PARENT[form.kind].length === 0 ? U('no_parent') : `— ${UNIT_PARENT[form.kind].join(' / ')} —`}</option>
                  {parentOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.kind})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={U('code')}>
                <input className="input font-mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="ULP-MENTENG" />
              </Field>
              <Field label={U('name')}>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ULP MENTENG" />
              </Field>
              <div className="sm:col-span-2">
                <Field label={U('address')}>
                  <textarea className="input min-h-[56px]" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </Field>
              </div>
              <Field label={U('lat')}>
                <input className="input font-mono" inputMode="decimal" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="-6.1760" />
              </Field>
              <Field label={U('lng')}>
                <input className="input font-mono" inputMode="decimal" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="106.8330" />
              </Field>
              <Field label={U('phone')}>
                <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label={U('email')}>
                <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <Field label={U('boundary')}>
                  <select className="input" value={form.boundary_name} onChange={(e) => setForm({ ...form, boundary_name: e.target.value })}>
                    <option value="">—</option>
                    {boundaries
                      .filter((b) => !boundaryLevel || b.level === boundaryLevel)
                      .map((b) => (
                        <option key={`${b.level}:${b.name}`} value={b.name}>
                          {b.name} ({b.level.toUpperCase()})
                        </option>
                      ))}
                    {form.boundary_name && !boundaries.some((b) => b.name === form.boundary_name) && <option value={form.boundary_name}>{form.boundary_name}</option>}
                  </select>
                </Field>
                <p className="mt-1 text-[11px] text-gray-500">{U('boundary_hint')}</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> {U('active')}
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 pt-3">
              <Button variant="secondary" onClick={() => setForm(null)}>
                {U('cancel')}
              </Button>
              <Button icon="check" loading={saving} onClick={save} disabled={!form.code.trim() || !form.name.trim()}>
                {U('save')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={auto.open} title={U('auto_title')} onClose={() => setAuto({ ...auto, open: false })} width="max-w-2xl">
        <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4 text-sm">
          <p className="text-xs text-gray-600">{U('auto_hint')}</p>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={auto.overwrite} onChange={(e) => setAuto({ ...auto, overwrite: e.target.checked, res: null })} /> {U('auto_overwrite')}
          </label>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" icon="search" loading={auto.busy === 'preview'} onClick={() => runAuto(false)}>
              {U('preview')}
            </Button>
            <Button size="sm" icon="check" loading={auto.busy === 'apply'} disabled={!auto.res || auto.res.applied || auto.res.total === 0} onClick={() => runAuto(true)}>
              {U('apply')}
            </Button>
          </div>
          {auto.res && (
            <div className="space-y-2 text-xs">
              <div>
                {U('auto_summary', { n: fmtNum(auto.res.total), d: fmtNum(auto.res.default), u: fmtNum(auto.res.unmatched) })}
                {auto.res.applied && <b className="ml-1 text-emerald-700">✓ {U('applied')}</b>}
              </div>
              <table className="w-full">
                <tbody>
                  {Object.entries(auto.res.by_unit)
                    .sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))
                    .map(([name, m]) => (
                      <tr key={name} className="border-b border-gray-100 align-top">
                        <td className="py-1 pr-2 font-medium text-gray-900">{name}</td>
                        <td className="py-1 text-gray-600">
                          {Object.entries(m)
                            .map(([k, v]) => `${typeName(k)} ${fmtNum(v)}`)
                            .join(' · ')}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>

      <Confirm
        open={!!del}
        title={U('delete')}
        message={del ? U('delete_msg', { name: del.name }) : ''}
        danger
        onCancel={() => setDel(null)}
        onConfirm={async () => {
          if (!del) return;
          try {
            await api(`/api/units/${del.id}`, { method: 'DELETE' });
            toast.push(U('deleted'), 'success');
            setDel(null);
            if (sel?.id === del.id) setSel(null);
            load();
          } catch (e: any) {
            toast.push(e.message, 'error');
          }
        }}
      />
    </div>
  );
}
