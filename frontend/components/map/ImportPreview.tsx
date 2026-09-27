'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { bboxOf } from '@/lib/geo';
import type { ComponentType, FeatureCollection } from '@/lib/types';
import { Badge, Button, Modal } from '@/components/ui';
import { csvRow, downloadText } from '@/components/exec/common';
import type { MapHandle } from './types';

export interface ImportItem {
  index: number;
  action: 'update' | 'create' | 'unchanged' | 'error';
  kind: string;
  id?: number;
  type_code?: string;
  code?: string;
  changes?: string;
  error?: string;
}

export interface ImportReport {
  applied: boolean;
  features: number;
  updates: number;
  creates: number;
  unchanged: number;
  errors: number;
  proposed?: number;
  changeset_id?: number;
  by_type: Record<string, Record<string, number>>;
  items: ImportItem[];
}

const COLOR: Record<string, string> = { create: '#16a34a', update: '#2563eb', error: '#dc2626' };

/** Pratinjau & rekap impor GeoJSON: ringkasan, rekap per layer, daftar berhasil / gagal, tampilan di peta. */
export function ImportPreview({
  open,
  onClose,
  report,
  fileName,
  geojson,
  types,
  mapRef,
  approval,
  applying,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  report: ImportReport;
  fileName: string;
  geojson: FeatureCollection | null;
  types: ComponentType[];
  mapRef: React.RefObject<MapHandle>;
  approval: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  const { t, pick } = useT();
  const [filter, setFilter] = useState<'' | 'create' | 'update' | 'error'>('');
  const [q, setQ] = useState('');
  const [onMap, setOnMap] = useState(false);
  const typeName = (code?: string) => {
    if (!code || code === '-') return '-';
    const x = types.find((y) => y.code === code);
    return x ? pick(x.name, x.name_en) : code;
  };
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...report.items].sort((a, b) => a.index - b.index).filter(
      (it) =>
        (!filter || it.action === filter) &&
        (!s || (it.code || '').toLowerCase().includes(s) || (it.error || '').toLowerCase().includes(s) || typeName(it.type_code).toLowerCase().includes(s)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, filter, q]);
  const valid = report.creates + report.updates;
  const done = report.applied;

  const toggleMap = () => {
    if (onMap || !geojson) {
      mapRef.current?.setOverlay(null);
      setOnMap(false);
      return;
    }
    const byIndex = new Map(report.items.map((it) => [it.index, it]));
    const feats = geojson.features
      .map((f, i) => {
        const it = byIndex.get(i + 1);
        if (!it || !COLOR[it.action] || !f.geometry) return null;
        return { ...f, id: i + 1, properties: { color: COLOR[it.action], big: true, label: it.code || '' } };
      })
      .filter(Boolean) as any[];
    const fc = { type: 'FeatureCollection', features: feats } as FeatureCollection;
    mapRef.current?.setOverlay(fc);
    const b = bboxOf(fc);
    if (b) mapRef.current?.fitBBox(b);
    setOnMap(true);
    onClose();
  };

  const downloadErrors = () => {
    const rows = [csvRow(['no_fitur', 'jenis', 'layer', 'kode', 'id', 'aksi', 'galat'])];
    for (const it of report.items.filter((x) => x.action === 'error')) rows.push(csvRow([it.index, it.kind, it.type_code, it.code, it.id ?? '', it.action, it.error]));
    downloadText(`galat-impor-${fileName.replace(/[^\w.-]+/g, '_')}.csv`, rows.join('\r\n'));
  };

  const cards: [string, number, string][] = [
    [t('xchg.features'), report.features, 'text-gray-900'],
    [t('xchg.act_create'), report.creates, 'text-emerald-700'],
    [t('xchg.act_update'), report.updates, 'text-brand-700'],
    [t('xchg.act_same'), report.unchanged, 'text-gray-600'],
    [t('xchg.act_error'), report.errors, report.errors ? 'text-red-700' : 'text-gray-600'],
  ];
  const typesRows = Object.entries(report.by_type || {}).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0));

  return (
    <Modal open={open} onClose={onClose} title={`${done ? t('xchg.result_title') : t('xchg.preview_title')} · ${fileName}`} width="max-w-4xl">
      <div className="max-h-[calc(90vh-4rem)] space-y-3 overflow-y-auto p-4 text-sm text-gray-800">
        {approval && !done && <div className="rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-800">{t('xchg.approval_import')}</div>}
        {done && report.changeset_id ? (
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {t('cs.imported', { id: report.changeset_id })} —{' '}
            <Link className="font-semibold underline" href={`/changes?id=${report.changeset_id}`}>
              {t('cs.open_page')}
            </Link>
          </div>
        ) : done ? (
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{t('xchg.applied_note')}</div>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {cards.map(([k, v, cls]) => (
            <div key={k} className="rounded-md border border-gray-200 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">{k}</div>
              <div className={`text-xl font-semibold tabular-nums ${cls}`}>{fmtNum(v)}</div>
            </div>
          ))}
        </div>
        {report.features > 0 && (
          <div className="h-2 w-full overflow-hidden rounded bg-gray-200" aria-hidden>
            <div className="flex h-full">
              <div className="bg-emerald-500" style={{ width: `${(report.creates / report.features) * 100}%` }} />
              <div className="bg-brand-600" style={{ width: `${(report.updates / report.features) * 100}%` }} />
              <div className="bg-gray-400" style={{ width: `${(report.unchanged / report.features) * 100}%` }} />
              <div className="bg-red-500" style={{ width: `${(report.errors / report.features) * 100}%` }} />
            </div>
          </div>
        )}
        <div className="text-xs text-gray-600">
          <b className="text-emerald-700">{fmtNum(valid + report.unchanged)}</b> {t('xchg.ok_rows')} · <b className={report.errors ? 'text-red-700' : ''}>{fmtNum(report.errors)}</b> {t('xchg.fail_rows')}
          {done && report.proposed ? ` · ${fmtNum(report.proposed)} ${t('xchg.proposed')} #${report.changeset_id}` : ''}
        </div>

        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-gray-500">{t('xchg.recap_by_type')}</h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1">Layer</th>
                  <th className="py-1 text-right">{t('xchg.act_create')}</th>
                  <th className="py-1 text-right">{t('xchg.act_update')}</th>
                  <th className="py-1 text-right">{t('xchg.act_same')}</th>
                  <th className="py-1 text-right">{t('xchg.act_error')}</th>
                </tr>
              </thead>
              <tbody>
                {typesRows.map(([tc, m]) => (
                  <tr key={tc} className="border-b border-gray-100">
                    <td className="py-1">{typeName(tc)}</td>
                    <td className="py-1 text-right tabular-nums text-emerald-700">{fmtNum(m.create || 0)}</td>
                    <td className="py-1 text-right tabular-nums text-brand-700">{fmtNum(m.update || 0)}</td>
                    <td className="py-1 text-right tabular-nums text-gray-500">{fmtNum(m.unchanged || 0)}</td>
                    <td className={`py-1 text-right tabular-nums ${m.error ? 'font-semibold text-red-700' : 'text-gray-500'}`}>{fmtNum(m.error || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
            {(['', 'create', 'update', 'error'] as const).map((k) => (
              <button key={k || 'all'} className={`rounded-full border px-2.5 py-0.5 ${filter === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700'}`} onClick={() => setFilter(k)}>
                {k === '' ? t('xchg.filter_all') : k === 'create' ? t('xchg.act_create') : k === 'update' ? t('xchg.act_update') : t('xchg.act_error')}
              </button>
            ))}
            <input className="input ml-auto !w-44 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} />
          </div>
          <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
            <table className="w-full text-xs">
              <tbody>
                {list.slice(0, 1000).map((it) => (
                  <tr key={it.index} className="border-b border-gray-100 align-top">
                    <td className="w-12 px-2 py-1 text-right font-mono text-[11px] text-gray-500">#{it.index}</td>
                    <td className="w-20 py-1">
                      <Badge tone={it.action === 'update' ? 'blue' : it.action === 'create' ? 'green' : it.action === 'error' ? 'red' : 'gray'}>
                        {it.action === 'update' ? t('xchg.act_update') : it.action === 'create' ? t('xchg.act_create') : it.action === 'error' ? t('xchg.act_error') : t('xchg.act_same')}
                      </Badge>
                    </td>
                    <td className="py-1">
                      <span className="font-mono text-[11px] text-gray-900">{it.code || (it.id ? `#${it.id}` : '-')}</span> <span className="text-gray-500">{typeName(it.type_code) !== '-' ? typeName(it.type_code) : it.kind}</span>
                      {it.changes && <span className="text-gray-600"> · {it.changes}</span>}
                      {it.error && <div className="text-red-700">{it.error}</div>}
                    </td>
                  </tr>
                ))}
                {list.length === 0 && (
                  <tr>
                    <td className="p-3 text-center text-gray-500">-</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3">
          {geojson && (
            <Button size="sm" variant="secondary" icon="map" onClick={toggleMap}>
              {onMap ? t('xchg.hide_on_map') : t('xchg.show_on_map')}
            </Button>
          )}
          {report.errors > 0 && (
            <Button size="sm" variant="secondary" icon="download" onClick={downloadErrors}>
              {t('xchg.download_errors')}
            </Button>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          {!done && (
            <Button size="sm" icon="check" loading={applying} disabled={valid === 0} onClick={onApply}>
              {t('xchg.apply', { n: valid })}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
