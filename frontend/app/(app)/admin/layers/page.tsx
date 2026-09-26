'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { AppConfig, ComponentType } from '@/lib/types';
import { Badge, Button, PageHeader, useToast } from '@/components/ui';
import { SYMBOLS, SYMBOL_KEYS, SymbolSwatch, isSymbol } from '@/components/map/symbols';

const LOADING_KEYS = [
  'loading.tile_cache_ttl_seconds',
  'loading.max_features_per_tile',
  'loading.density_max_zoom',
  'loading.simplify_tolerance_px',
  'loading.density_refresh_seconds',
  'loading.max_bbox_features',
  'loading.realtime_debounce_ms',
  'topology.snap_tolerance_m',
  'topology.auto_split_edges',
  'topology.auto_junction',
  'trace.max_depth',
  'trace.max_result_features',
];

export default function LayersPage() {
  const { t, pick } = useT();
  const toast = useToast();
  const [types, setTypes] = useState<ComponentType[]>([]);
  const [edits, setEdits] = useState<Record<string, Partial<ComponentType>>>({});
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [cfgDraft, setCfgDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tt, c] = await Promise.all([api<{ items: ComponentType[] }>('/api/gis/types'), api<{ items: AppConfig[] }>('/api/admin/configs')]);
      setTypes(tt.items);
      setConfigs(c.items.filter((x) => LOADING_KEYS.includes(x.key)));
      setEdits({});
      setCfgDraft({});
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const val = <K extends keyof ComponentType>(x: ComponentType, k: K): ComponentType[K] => (edits[x.code]?.[k] as ComponentType[K]) ?? x[k];
  const set = (code: string, patch: Partial<ComponentType>) => setEdits({ ...edits, [code]: { ...edits[code], ...patch } });

  // editor skema atribut SSOT (JSON)
  const [attrsFor, setAttrsFor] = useState<ComponentType | null>(null);
  const [attrsText, setAttrsText] = useState('');
  const [attrsErr, setAttrsErr] = useState('');
  const openAttrs = (x: ComponentType) => {
    setAttrsFor(x);
    setAttrsText(JSON.stringify(val(x, 'attributes') || [], null, 2));
    setAttrsErr('');
  };
  const applyAttrs = () => {
    if (!attrsFor) return;
    try {
      const parsed = JSON.parse(attrsText);
      if (!Array.isArray(parsed)) throw new Error('array');
      set(attrsFor.code, { attributes: parsed });
      setAttrsFor(null);
    } catch {
      setAttrsErr(t('layerspage.attributes_invalid'));
    }
  };

  async function saveType(x: ComponentType) {
    setSaving(x.code);
    try {
      const body = { ...x, ...edits[x.code] };
      await api(`/api/admin/layers/${x.code}`, { method: 'PUT', body });
      toast.push(t('layerspage.saved', { name: pick(body.name, body.name_en) }), 'success');
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(null);
    }
  }

  async function saveConfigs() {
    const changed = Object.keys(cfgDraft).filter((k) => cfgDraft[k] !== configs.find((c) => c.key === k)?.value);
    if (!changed.length) return;
    setSaving('cfg');
    try {
      await api('/api/admin/configs', { method: 'PUT', body: { items: changed.map((k) => ({ key: k, value: cfgDraft[k] })) } });
      toast.push(t('layerspage.params_saved'), 'success');
      load();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t('layerspage.title')} subtitle={t('layerspage.subtitle')} />

      <div className="card mb-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2">
          <div className="text-sm font-semibold text-gray-800">{t('layerspage.params_title')}</div>
          <Button size="sm" onClick={saveConfigs} loading={saving === 'cfg'} icon="check">
            {t('common.save')}
          </Button>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {configs.map((c) => (
            <div key={c.key}>
              <label className="label font-mono">{c.key}</label>
              {c.value_type === 'bool' ? (
                <select className="input" value={cfgDraft[c.key] ?? c.value} onChange={(e) => setCfgDraft({ ...cfgDraft, [c.key]: e.target.value })}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input className="input" type="number" step="any" value={cfgDraft[c.key] ?? c.value} onChange={(e) => setCfgDraft({ ...cfgDraft, [c.key]: e.target.value })} />
              )}
              <p className="mt-0.5 text-xs text-gray-500">{c.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800">{t('layerspage.types_title')}</div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="th">{t('common.code')}</th>
                <th className="th">{t('layerspage.name_id')}</th>
                <th className="th">{t('layerspage.name_en')}</th>
                <th className="th">{t('layerspage.color')}</th>
                <th className="th">{t('layerspage.symbol')}</th>
                <th className="th">{t('layerspage.min_zoom')}</th>
                <th className="th">{t('layerspage.label_zoom')}</th>
                <th className="th">{t('layerspage.size')}</th>
                <th className="th">kV</th>
                <th className="th">{t('layerspage.order')}</th>
                <th className="th">{t('layerspage.topology')}</th>
                <th className="th">{t('layerspage.ways')}</th>
                <th className="th">{t('layerspage.attributes')}</th>
                <th className="th">{t('common.active')}</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {types.map((x) => (
                <tr key={x.code} className={edits[x.code] ? 'bg-amber-50' : ''}>
                  <td className="td">
                    <div className="font-mono text-xs">{x.code}</div>
                    <div className="mt-0.5 flex gap-1">
                      <Badge>{x.geom_kind}</Badge>
                      {x.is_source && <Badge tone="red">{t('layerspage.source')}</Badge>}
                      {x.is_switch && <Badge tone="purple">{t('layerspage.switch')}</Badge>}
                      {x.is_sink && <Badge tone="green">{t('layerspage.customer')}</Badge>}
                      {x.topology === false && <Badge tone="amber">{t('layerspage.support')}</Badge>}
                    </div>
                  </td>
                  <td className="td">
                    <input className="input min-w-[12rem]" value={val(x, 'name')} onChange={(e) => set(x.code, { name: e.target.value })} />
                  </td>
                  <td className="td">
                    <input className="input min-w-[12rem]" value={val(x, 'name_en') || ''} onChange={(e) => set(x.code, { name_en: e.target.value })} />
                  </td>
                  <td className="td">
                    <input type="color" className="h-8 w-12 cursor-pointer rounded border border-gray-300" value={val(x, 'color')} onChange={(e) => set(x.code, { color: e.target.value })} />
                  </td>
                  <td className="td">
                    {x.geom_kind === 'line' ? (
                      <span className="text-xs text-gray-400">-</span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {isSymbol(val(x, 'icon')) ? (
                          <>
                            <SymbolSwatch icon={val(x, 'icon')} color={val(x, 'color')} size={22} />
                            {SYMBOLS[val(x, 'icon')].switchable && <SymbolSwatch icon={val(x, 'icon')} color={val(x, 'color')} size={22} open title={t('layerspage.symbol_open')} />}
                          </>
                        ) : (
                          <span className="inline-block h-4 w-4 rounded-full" style={{ background: val(x, 'color') }} />
                        )}
                        <select className="input w-60 text-xs" value={isSymbol(val(x, 'icon')) ? val(x, 'icon') : 'circle'} onChange={(e) => set(x.code, { icon: e.target.value })}>
                          <option value="circle">{t('layerspage.symbol_circle')}</option>
                          {SYMBOL_KEYS.map((k) => (
                            <option key={k} value={k}>
                              {pick(SYMBOLS[k].label, SYMBOLS[k].labelEN)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </td>
                  <td className="td">
                    <input className="input w-16" type="number" min={0} max={22} value={val(x, 'min_zoom')} onChange={(e) => set(x.code, { min_zoom: Number(e.target.value) })} />
                  </td>
                  <td className="td">
                    <input className="input w-16" type="number" min={0} max={22} value={val(x, 'label_zoom')} onChange={(e) => set(x.code, { label_zoom: Number(e.target.value) })} />
                  </td>
                  <td className="td">
                    <input className="input w-16" type="number" step="0.5" min={0.5} value={val(x, 'size')} onChange={(e) => set(x.code, { size: Number(e.target.value) })} />
                  </td>
                  <td className="td">
                    <input className="input w-20" type="number" step="any" value={val(x, 'voltage_kv')} onChange={(e) => set(x.code, { voltage_kv: Number(e.target.value) })} />
                  </td>
                  <td className="td">
                    <input className="input w-16" type="number" value={val(x, 'sort_order')} onChange={(e) => set(x.code, { sort_order: Number(e.target.value) })} />
                  </td>
                  <td className="td">
                    <input type="checkbox" checked={val(x, 'topology') ?? true} disabled={x.geom_kind === 'line'} onChange={(e) => set(x.code, { topology: e.target.checked })} />
                  </td>
                  <td className="td">
                    <input className="input w-14" type="number" min={0} max={8} value={val(x, 'ways') ?? 0} disabled={!x.is_switch} onChange={(e) => set(x.code, { ways: Number(e.target.value) })} />
                  </td>
                  <td className="td">
                    <button className="text-xs text-brand-700 hover:underline" onClick={() => openAttrs(x)}>
                      {(val(x, 'attributes') || []).length} {t('layerspage.fields')}
                    </button>
                  </td>
                  <td className="td">
                    <input type="checkbox" checked={val(x, 'is_active')} onChange={(e) => set(x.code, { is_active: e.target.checked })} />
                  </td>
                  <td className="td text-right">
                    <Button size="sm" disabled={!edits[x.code]} loading={saving === x.code} onClick={() => saveType(x)}>
                      {t('common.save')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {attrsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setAttrsFor(null)}>
          <div className="card w-full max-w-2xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-sm font-semibold text-gray-900">{t('layerspage.attributes_title', { name: pick(attrsFor.name, attrsFor.name_en) })}</div>
            <p className="mb-2 text-xs text-gray-500">{t('layerspage.attributes_hint')}</p>
            <textarea className="input h-72 w-full font-mono text-xs" value={attrsText} onChange={(e) => setAttrsText(e.target.value)} spellCheck={false} />
            {attrsErr && <div className="mt-1 text-xs text-red-700">{attrsErr}</div>}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAttrsFor(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={applyAttrs} icon="check">
                {t('layerspage.apply')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
