'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtNum, fmtVA } from '@/lib/format';
import type { ComponentType, SearchHit } from '@/lib/types';
import { Badge, Button, PageHeader, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { SearchBox } from '@/components/map/SearchBox';
import { loadUnits, type OrgUnit } from '@/components/units/useUnits';
import { useAssetT } from './i18n';

type Kind = 'gi' | 'trafo_gi' | 'feeder' | 'gd' | 'trafo' | 'route' | 'pelanggan' | 'none';
const LEVELS: Kind[] = ['gi', 'trafo_gi', 'feeder', 'gd', 'trafo', 'route', 'pelanggan'];
const TONE: Record<Kind, 'purple' | 'blue' | 'green' | 'amber' | 'gray' | 'red'> = {
  gi: 'purple',
  trafo_gi: 'purple',
  feeder: 'blue',
  gd: 'green',
  trafo: 'green',
  route: 'amber',
  pelanggan: 'gray',
  none: 'red',
};
const DOT: Record<string, string> = { on: 'bg-emerald-500', partial: 'bg-amber-400', off: 'bg-red-500' };
const PAGE = 200;

interface Row {
  kind: Kind;
  id: number;
  type_code: string;
  code: string;
  name: string;
  state: 'on' | 'partial' | 'off';
  energized: boolean;
  children: number;
  pelanggan: number;
  pelanggan_off: number;
  beban_va: number;
  beban_off_va: number;
  gi_id?: number;
  trafo_gi_id?: number;
  feeder_id?: number;
  gd_id?: number;
  trafo_id?: number;
  route_id?: number;
  gi_code?: string;
  trafo_gi_code?: string;
  feeder_code?: string;
  gd_code?: string;
  trafo_code?: string;
  route_code?: string;
  unit?: string;
}

interface Kids {
  items: Row[];
  total: number;
  offset: number; // offset item pertama yang dimuat
  loading?: boolean;
}

const keyOf = (k: string, id: number) => `${k}:${id}`;
const featOf = (r: Row) => (r.kind === 'route' ? `edge:${r.id}` : `node:${r.id}`);
const childLevel = (k: Kind): Kind | null => {
  if (k === 'none') return null;
  const i = LEVELS.indexOf(k);
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1] : null;
};

async function downloadBlob(path: string, name: string) {
  const buf = await api<ArrayBuffer>(path, { raw: true });
  const url = URL.createObjectURL(new Blob([buf], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function Assets() {
  const A = useAssetT();
  const { pick } = useT();
  const toast = useToast();
  const [tab, setTab] = useState<'tree' | 'table'>('tree');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [types, setTypes] = useState<ComponentType[]>([]);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [notReady, setNotReady] = useState(false);

  // --- pohon
  const [kids, setKids] = useState<Record<string, Kids>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Row | null>(null);
  const [flash, setFlash] = useState('');

  // --- tabel
  const [level, setLevel] = useState<Kind>('feeder');
  const [scope, setScope] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [state, setState] = useState('');
  const [unit, setUnit] = useState(0);
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'code', desc: false });
  const [offset, setOffset] = useState(0);
  const [table, setTable] = useState<{ items: Row[]; total: number; sorted: string; search_capped: boolean } | null>(null);
  const [tLoading, setTLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const tableLimit = 100;

  const typeName = useCallback(
    (c: string) => {
      const x = types.find((y) => y.code === c);
      return x ? pick(x.name, x.name_en) : c;
    },
    [types, pick],
  );

  const fetchKids = useCallback(async (kind: string, id: number, off = 0, around = 0) => {
    const qs = new URLSearchParams({ kind, id: String(id), offset: String(off), limit: String(PAGE) });
    if (around) qs.set('around', String(around));
    return api<{ items: Row[]; total: number; offset: number; counts?: Record<string, number> }>(`/api/assets/tree?${qs}`);
  }, []);

  const loadRoot = useCallback(async () => {
    try {
      const r = await fetchKids('root', 0);
      setNotReady(false);
      setCounts(r.counts || null);
      setKids((m) => ({ ...m, root: { items: r.items, total: r.total, offset: 0 } }));
    } catch (e: any) {
      if (e.status === 503) {
        setNotReady(true);
        setTimeout(loadRoot, 5000);
      } else toast.push(e.message, 'error');
    }
  }, [fetchKids, toast]);

  useEffect(() => {
    loadRoot();
    api<{ types: ComponentType[] }>('/api/config/public')
      .then((r) => setTypes(r.types))
      .catch(() => {});
    loadUnits()
      .then(setUnits)
      .catch(() => {});
  }, [loadRoot]);

  const toggle = async (r: Row) => {
    const k = keyOf(r.kind, r.id);
    const s = new Set(open);
    if (s.has(k)) {
      s.delete(k);
      setOpen(s);
      return;
    }
    s.add(k);
    setOpen(s);
    if (kids[k]) return;
    setKids((m) => ({ ...m, [k]: { items: [], total: r.children, offset: 0, loading: true } }));
    try {
      const res = await fetchKids(r.kind, r.id);
      setKids((m) => ({ ...m, [k]: { items: res.items, total: res.total, offset: res.offset } }));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setKids((m) => {
        const n = { ...m };
        delete n[k];
        return n;
      });
    }
  };

  const loadMore = async (parentKey: string, kind: string, id: number, prev = false) => {
    const cur = kids[parentKey];
    if (!cur) return;
    const off = prev ? Math.max(0, cur.offset - PAGE) : cur.offset + cur.items.length;
    setKids((m) => ({ ...m, [parentKey]: { ...cur, loading: true } }));
    try {
      const res = await fetchKids(kind, id, off);
      setKids((m) => {
        const c = m[parentKey] || cur;
        const items = prev ? [...res.items.slice(0, c.offset - off), ...c.items] : [...c.items, ...res.items];
        return { ...m, [parentKey]: { items, total: res.total, offset: prev ? off : c.offset } };
      });
    } catch (e: any) {
      toast.push(e.message, 'error');
      setKids((m) => ({ ...m, [parentKey]: { ...cur, loading: false } }));
    }
  };

  // cari objek → buka jalur hirarkinya dan sorot
  const locate = async (kind: 'node' | 'edge', id: number) => {
    try {
      const { path } = await api<{ path: { kind: Kind; id: number }[] }>(`/api/assets/locate?kind=${kind}&id=${id}`);
      setTab('tree');
      const s = new Set(open);
      const add: Record<string, Kids> = {};
      let parent = { kind: 'root', id: 0 };
      let found: Row | null = null;
      for (const step of path) {
        const pk = parent.kind === 'root' ? 'root' : keyOf(parent.kind, parent.id);
        const have = kids[pk];
        if (!have || !have.items.some((x) => x.kind === step.kind && x.id === step.id)) {
          const res = await fetchKids(parent.kind, parent.id, 0, step.id);
          add[pk] = { items: res.items, total: res.total, offset: res.offset };
        }
        found = (add[pk] || have)!.items.find((x) => x.kind === step.kind && x.id === step.id) || null;
        if (pk !== 'root') s.add(pk);
        parent = step;
      }
      setKids((m) => ({ ...m, ...add }));
      setOpen(s);
      if (found) {
        const fk = keyOf(found.kind, found.id);
        setSel(found);
        setFlash(fk);
        setTimeout(() => document.getElementById(`asset-${fk}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
        setTimeout(() => setFlash(''), 2500);
      }
    } catch (e: any) {
      toast.push(e.status === 404 ? A('not_found') : e.message, 'error');
    }
  };

  // --- tabel
  const loadTable = useCallback(async () => {
    setTLoading(true);
    const qs = new URLSearchParams({ level, offset: String(offset), limit: String(tableLimit), sort: sort.key, dir: sort.desc ? 'desc' : 'asc' });
    if (scope) {
      qs.set('scope_kind', scope.kind);
      qs.set('scope_id', String(scope.id));
    }
    if (qApplied) qs.set('q', qApplied);
    if (state) qs.set('state', state);
    if (unit) qs.set('unit', String(unit));
    try {
      setTable(await api(`/api/assets/table?${qs}`));
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setTLoading(false);
    }
  }, [level, offset, sort, scope, qApplied, state, unit, toast]);

  useEffect(() => {
    if (tab === 'table') loadTable();
  }, [tab, loadTable]);

  // filter berubah → kembali ke halaman pertama
  const firstPage = useRef(false);
  useEffect(() => {
    if (!firstPage.current) {
      firstPage.current = true;
      return;
    }
    setOffset(0);
  }, [level, scope, qApplied, state, unit, sort]);

  const exportCsv = async () => {
    setExporting(true);
    const qs = new URLSearchParams({ level, format: 'csv', sort: sort.key, dir: sort.desc ? 'desc' : 'asc' });
    if (scope) {
      qs.set('scope_kind', scope.kind);
      qs.set('scope_id', String(scope.id));
    }
    if (qApplied) qs.set('q', qApplied);
    if (state) qs.set('state', state);
    if (unit) qs.set('unit', String(unit));
    try {
      await downloadBlob(`/api/assets/table?${qs}`, `aset-${level}${scope ? `-${scope.code || scope.id}` : ''}.csv`);
      const total = table?.total || 0;
      if (total > 100000) toast.push(A('export_capped', { total: fmtNum(total) }), 'warning');
      else toast.push(A('exported', { n: fmtNum(total) }), 'success');
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const openTable = (r: Row, lv?: Kind) => {
    const target = lv || childLevel(r.kind) || r.kind;
    setScope(r.kind === 'none' ? null : r);
    setLevel(target);
    setTab('table');
  };

  const unitOptions = useMemo(() => units.filter((u) => u.active), [units]);

  // --- tampilan
  const levelBadge = (k: Kind) => <Badge tone={TONE[k]}>{A(`sh_${k}`)}</Badge>;
  const stateDot = (s: string) => <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[s] || 'bg-gray-400'}`} title={A(`st_${s}`)} />;

  const renderRows = (parentKey: string, parent: { kind: string; id: number }, depth: number): React.ReactNode => {
    const c = kids[parentKey];
    if (!c) return null;
    const out: React.ReactNode[] = [];
    if (c.offset > 0)
      out.push(
        <button key={`${parentKey}-prev`} className="block py-1 text-xs text-brand-700 hover:underline" style={{ paddingLeft: depth * 18 + 22 }} onClick={() => loadMore(parentKey, parent.kind, parent.id, true)}>
          ↑ {A('load_prev', { n: Math.min(PAGE, c.offset) })}
        </button>,
      );
    for (const r of c.items) {
      const k = keyOf(r.kind, r.id);
      const isOpen = open.has(k);
      out.push(
        <div key={k}>
          <div
            id={`asset-${k}`}
            className={`group flex cursor-pointer items-center gap-1.5 rounded border-b border-gray-100 py-1 pr-2 text-xs hover:bg-gray-50 ${sel && keyOf(sel.kind, sel.id) === k ? 'bg-brand-50' : ''} ${flash === k ? 'ring-2 ring-brand-500' : ''}`}
            style={{ paddingLeft: depth * 18 + 4 }}
            onClick={() => setSel(r)}
          >
            {r.children > 0 ? (
              <button
                className="text-gray-400 hover:text-gray-800"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r);
                }}
                aria-label={r.code || r.name}
                aria-expanded={isOpen}
              >
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
              </button>
            ) : (
              <span className="inline-block w-3.5" />
            )}
            {stateDot(r.state)}
            {levelBadge(r.kind)}
            <span className="font-mono text-[11px] font-medium text-gray-900">{r.kind === 'none' ? A('lv_none') : r.code || `#${r.id}`}</span>
            <span className="min-w-0 truncate text-gray-600">{r.name}</span>
            <span className="ml-auto flex shrink-0 items-center gap-3 tabular-nums text-gray-600">
              {r.children > 0 && r.kind !== 'route' && (
                <span className="hidden text-[11px] text-gray-500 md:inline">
                  {fmtNum(r.children)} {A(`ch_${r.kind}`)}
                </span>
              )}
              <span className="w-24 text-right" title={A('customers_total')}>
                {r.kind === 'pelanggan' ? '' : fmtNum(r.pelanggan)}
                {r.pelanggan_off > 0 && r.kind !== 'pelanggan' && <span className="text-red-600"> ({fmtNum(r.pelanggan_off)})</span>}
              </span>
              <span className="w-20 text-right" title={A('load')}>
                {fmtVA(r.beban_va)}
              </span>
              <span className="hidden w-36 truncate text-right text-[11px] text-gray-500 lg:inline" title={r.unit}>
                {r.unit || '-'}
              </span>
            </span>
          </div>
          {isOpen && (kids[k]?.loading && !kids[k]?.items.length ? <div className="py-1 text-xs text-gray-500" style={{ paddingLeft: depth * 18 + 26 }}>{A('loading')}</div> : renderRows(k, r, depth + 1))}
        </div>,
      );
    }
    const shown = c.offset + c.items.length;
    if (shown < c.total)
      out.push(
        <button key={`${parentKey}-more`} className="block py-1 text-xs text-brand-700 hover:underline disabled:opacity-50" style={{ paddingLeft: depth * 18 + 22 }} disabled={c.loading} onClick={() => loadMore(parentKey, parent.kind, parent.id)}>
          ↓ {A('load_more', { n: Math.min(PAGE, c.total - shown), shown: fmtNum(shown), total: fmtNum(c.total) })}
        </button>,
      );
    return out;
  };

  const chain = (r: Row) =>
    (
      [
        ['gi', r.gi_id, r.gi_code],
        ['trafo_gi', r.trafo_gi_id, r.trafo_gi_code],
        ['feeder', r.feeder_id, r.feeder_code],
        ['gd', r.gd_id, r.gd_code],
        ['trafo', r.trafo_id, r.trafo_code],
        ['route', r.route_id, r.route_code],
      ] as [Kind, number | undefined, string | undefined][]
    ).filter(([k, id]) => id && LEVELS.indexOf(k) < LEVELS.indexOf(r.kind));

  const parentCols = LEVELS.slice(0, LEVELS.indexOf(level));
  const codeOf = (r: Row, k: Kind) => (r as any)[`${k}_code`] as string | undefined;
  const sortHead = (key: string, label: string, right = true) => (
    <th className={`cursor-pointer select-none py-1.5 ${right ? 'text-right' : ''}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'code' }))}>
      {label} {sort.key === key ? (sort.desc ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div className="h-full overflow-y-auto p-3 md:p-6">
      <PageHeader title={A('title')} subtitle={A('subtitle')} />

      {/* jumlah aset per tingkat */}
      <div className="card mb-3 flex flex-wrap items-center gap-2 p-3 text-xs">
        {LEVELS.map((k, i) => (
          <span key={k} className="flex items-center gap-1.5">
            <button className="flex items-center gap-1.5 rounded-md border border-gray-200 px-2 py-1 hover:bg-gray-50" onClick={() => { setScope(null); setLevel(k); setTab('table'); }} title={A('lv_' + k)}>
              {levelBadge(k)}
              <b className="tabular-nums text-gray-900">{counts ? fmtNum(counts[k]) : '…'}</b>
            </button>
            {i < LEVELS.length - 1 && <span className="text-gray-400">→</span>}
          </span>
        ))}
        {counts && counts.none > 0 && (
          <span className="ml-2 text-[11px] text-gray-500">
            {A('lv_none')}: <b className="text-red-600">{fmtNum(counts.none)}</b>
          </span>
        )}
      </div>

      <div className="mb-3 flex items-center gap-1 border-b border-gray-200">
        {(['tree', 'table'] as const).map((t) => (
          <button key={t} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-gray-600 hover:text-gray-900'}`} onClick={() => setTab(t)}>
            <Icon name={t === 'tree' ? 'diagram' : 'list'} size={14} className="mr-1 inline" /> {A(`tab_${t}`)}
          </button>
        ))}
      </div>

      {notReady && (
        <div className="card mb-3 flex items-center gap-2 p-3 text-sm text-gray-600">
          <Spinner size={14} /> {A('not_ready')}
        </div>
      )}

      {tab === 'tree' ? (
        <div className="grid gap-4 xl:grid-cols-[1fr,340px]">
          <div className="card p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="[&_input]:text-xs">
                <SearchBox typeName={typeName} onPick={(h: SearchHit) => locate(h.kind, h.id)} />
              </div>
              <Button size="sm" variant="secondary" onClick={() => setOpen(new Set())}>
                {A('collapse_all')}
              </Button>
              <span className="ml-auto hidden gap-3 text-[10px] uppercase tracking-wide text-gray-500 md:flex">
                <span className="w-24 text-right">{A('customers')}</span>
                <span className="w-20 text-right">{A('load')}</span>
                <span className="hidden w-36 text-right lg:inline">{A('unit')}</span>
              </span>
            </div>
            <div className="min-h-[200px]">{kids.root ? renderRows('root', { kind: 'root', id: 0 }, 0) : !notReady && <Spinner size={18} />}</div>
            <p className="mt-2 text-[11px] text-gray-500">{A('legend')} {A('note_none')}</p>
          </div>

          <div className="card h-fit p-3 text-xs xl:sticky xl:top-0">
            <div className="mb-2 text-sm font-semibold text-gray-900">{A('detail')}</div>
            {!sel ? (
              <p className="text-gray-500">{A('pick')}</p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {stateDot(sel.state)}
                  {levelBadge(sel.kind)}
                  <span className="font-mono font-semibold text-gray-900">{sel.kind === 'none' ? A('lv_none') : sel.code || `#${sel.id}`}</span>
                </div>
                {sel.name && <div className="text-gray-700">{sel.name}</div>}
                <table className="w-full">
                  <tbody className="[&_td]:py-0.5">
                    {sel.kind !== 'none' && (
                      <tr>
                        <td className="text-gray-500">{A('type')}</td>
                        <td className="text-right text-gray-900">{typeName(sel.type_code)}</td>
                      </tr>
                    )}
                    <tr>
                      <td className="text-gray-500">{A('state')}</td>
                      <td className="text-right text-gray-900">{A(`st_${sel.state}`)}</td>
                    </tr>
                    {sel.kind !== 'pelanggan' && sel.kind !== 'none' && (
                      <tr>
                        <td className="text-gray-500">{A('children')}</td>
                        <td className="text-right text-gray-900">
                          {fmtNum(sel.children)} {A(`ch_${sel.kind}`)}
                        </td>
                      </tr>
                    )}
                    {sel.kind !== 'pelanggan' && (
                      <tr>
                        <td className="text-gray-500">{A('customers_total')}</td>
                        <td className="text-right text-gray-900">
                          {fmtNum(sel.pelanggan)} <span className={sel.pelanggan_off ? 'text-red-600' : 'text-gray-500'}>({fmtNum(sel.pelanggan_off)})</span>
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td className="text-gray-500">{A('load_total')}</td>
                      <td className="text-right text-gray-900">
                        {fmtVA(sel.beban_va)} <span className={sel.beban_off_va ? 'text-red-600' : 'text-gray-500'}>({fmtVA(sel.beban_off_va)})</span>
                      </td>
                    </tr>
                    <tr>
                      <td className="text-gray-500">{A('unit')}</td>
                      <td className="text-right text-gray-900">{sel.unit || '-'}</td>
                    </tr>
                  </tbody>
                </table>
                {chain(sel).length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{A('chain')}</div>
                    <ol className="space-y-0.5">
                      {chain(sel).map(([k, , code], i) => (
                        <li key={k} className="flex items-center gap-1.5" style={{ paddingLeft: i * 10 }}>
                          {levelBadge(k)} <span className="font-mono text-gray-800">{code}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {sel.kind !== 'none' && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <a className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-gray-800 hover:bg-gray-50" href={`/monitoring?select=${featOf(sel)}`}>
                      <Icon name="map" size={12} /> {A('show_map')}
                    </a>
                    <a className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-gray-800 hover:bg-gray-50" href={`/sld?focus=${featOf(sel)}`}>
                      <Icon name="diagram" size={12} /> {A('show_sld')}
                    </a>
                  </div>
                )}
                {childLevel(sel.kind) && sel.children > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {LEVELS.slice(LEVELS.indexOf(sel.kind) + 1).map((lv) => (
                      <button key={lv} className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-gray-800 hover:bg-gray-50" onClick={() => openTable(sel, lv)}>
                        <Icon name="list" size={12} /> {A('show_table', { level: A(`lv_${lv}`).toLowerCase() })}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <select className="input !w-auto text-xs" value={level} onChange={(e) => setLevel(e.target.value as Kind)} aria-label={A('level')}>
              {LEVELS.filter((l) => !scope || LEVELS.indexOf(l) > LEVELS.indexOf(scope.kind)).map((l) => (
                <option key={l} value={l}>
                  {A(`lv_${l}`)}
                </option>
              ))}
            </select>
            <span className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1">
              <span className="text-gray-500">{A('scope')}:</span>
              {scope ? (
                <>
                  {levelBadge(scope.kind)} <span className="font-mono text-gray-900">{scope.code}</span>
                  <button className="text-gray-400 hover:text-red-600" onClick={() => setScope(null)} title={A('clear_scope')} aria-label={A('clear_scope')}>
                    <Icon name="x" size={12} />
                  </button>
                </>
              ) : (
                <span className="text-gray-900">{A('scope_all')}</span>
              )}
            </span>
            <form
              className="flex"
              onSubmit={(e) => {
                e.preventDefault();
                setQApplied(q.trim());
              }}
            >
              <input className="input !w-56 text-xs" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setQApplied(q.trim())} placeholder={A('search_table')} aria-label={A('search_table')} />
            </form>
            <select className="input !w-auto text-xs" value={state} onChange={(e) => setState(e.target.value)} aria-label={A('state')}>
              <option value="">{A('all_states')}</option>
              {['on', 'partial', 'off'].map((s) => (
                <option key={s} value={s}>
                  {A(`st_${s}`)}
                </option>
              ))}
            </select>
            <select className="input !w-auto max-w-[14rem] text-xs" value={unit} onChange={(e) => setUnit(Number(e.target.value))} aria-label={A('unit')}>
              <option value={0}>{A('all_units')}</option>
              {unitOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {' '.repeat(u.level * 2)}
                  {u.kind} · {u.name}
                </option>
              ))}
            </select>
            {tLoading && <Spinner size={14} />}
            <span className="ml-auto" />
            <Button size="sm" variant="secondary" icon="download" loading={exporting} onClick={exportCsv} disabled={!table || table.total === 0}>
              {A('export_csv')}
            </Button>
          </div>
          {table && (table.sorted === 'id' || table.search_capped) && (
            <p className="mb-2 text-[11px] text-amber-700">
              {table.sorted === 'id' && A('sorted_id')} {table.search_capped && A('search_capped')}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  {sortHead('code', A('code'), false)}
                  {parentCols.map((k) => (
                    <th key={k} className="py-1.5">
                      {A(`sh_${k}`)}
                    </th>
                  ))}
                  <th className="py-1.5">{A('state')}</th>
                  {level !== 'pelanggan' && sortHead('children', A('children'))}
                  {level !== 'pelanggan' && sortHead('pelanggan', A('customers'))}
                  {level !== 'pelanggan' && sortHead('off', A('customers_off'))}
                  {sortHead('beban', A('load'))}
                  <th className="py-1.5 pl-4">{A('unit')}</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {table?.items.map((r) => (
                  <tr key={keyOf(r.kind, r.id)} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-1.5">
                      <div className="font-mono text-[11px] font-medium text-gray-900">{r.code || `#${r.id}`}</div>
                      <div className="max-w-[16rem] truncate text-gray-500" title={r.name}>
                        {r.name}
                      </div>
                    </td>
                    {parentCols.map((k) => (
                      <td key={k} className="py-1.5 font-mono text-[11px] text-gray-700">
                        {codeOf(r, k) || '-'}
                      </td>
                    ))}
                    <td className="py-1.5">
                      <span className="flex items-center gap-1.5">
                        {stateDot(r.state)}
                        <span className="text-gray-700">{A(`st_${r.state}`)}</span>
                      </span>
                    </td>
                    {level !== 'pelanggan' && (
                      <td className="py-1.5 text-right tabular-nums text-gray-700" title={A(`ch_${r.kind}`)}>
                        {fmtNum(r.children)}
                      </td>
                    )}
                    {level !== 'pelanggan' && <td className="py-1.5 text-right tabular-nums text-gray-900">{fmtNum(r.pelanggan)}</td>}
                    {level !== 'pelanggan' && <td className={`py-1.5 text-right tabular-nums ${r.pelanggan_off ? 'text-red-600' : 'text-gray-500'}`}>{fmtNum(r.pelanggan_off)}</td>}
                    <td className="py-1.5 text-right tabular-nums text-gray-900">{fmtVA(r.beban_va)}</td>
                    <td className="max-w-[12rem] truncate py-1.5 pl-4 text-gray-700" title={r.unit}>
                      {r.unit || '-'}
                    </td>
                    <td className="py-1.5 text-right">
                      <span className="flex justify-end gap-0.5">
                        <button className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-brand-700" title={A('show_tree')} aria-label={A('show_tree')} onClick={() => locate(r.kind === 'route' ? 'edge' : 'node', r.id)}>
                          <Icon name="diagram" size={13} />
                        </button>
                        <a className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-brand-700" title={A('show_map')} aria-label={A('show_map')} href={`/monitoring?select=${featOf(r)}`}>
                          <Icon name="map" size={13} />
                        </a>
                        {childLevel(r.kind) && r.children > 0 && (
                          <button className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-brand-700" title={A('show_table', { level: A(`lv_${childLevel(r.kind)}`).toLowerCase() })} aria-label={A('show_table', { level: A(`lv_${childLevel(r.kind)}`).toLowerCase() })} onClick={() => openTable(r)}>
                            <Icon name="list" size={13} />
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {table && table.items.length === 0 && <p className="py-8 text-center text-sm text-gray-500">{A('empty')}</p>}
          </div>
          {table && table.total > 0 && (
            <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-600">
              <span>{A('rows', { from: fmtNum(offset + 1), to: fmtNum(Math.min(offset + tableLimit, table.total)), total: fmtNum(table.total) })}</span>
              <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - tableLimit))}>
                {A('prev')}
              </Button>
              <Button size="sm" variant="secondary" disabled={offset + tableLimit >= table.total} onClick={() => setOffset(offset + tableLimit)}>
                {A('next')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
