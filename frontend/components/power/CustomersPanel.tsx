'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fmtDate, fmtNum, fmtVA } from '@/lib/format';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { OFF_STATUS, ON_STATUS } from '@/components/map/mapStyle';

interface CodeName {
  id: number;
  code: string;
  name: string;
}

export interface CustomerRow {
  id: number;
  code: string;
  name: string;
  type_code: string;
  energized: boolean;
  daya_va: number;
  kode_ssot: string;
  feeder: CodeName | null;
  gd: CodeName | null;
  route: CodeName | null;
  outage_id: number | null;
  outage_kind?: string;
  off_since: string | null;
}

export type CustomerState = 'all' | 'on' | 'off';
const PAGE = 100;

interface Props {
  active: boolean;
  state: CustomerState;
  onState: (s: CustomerState) => void;
  refreshKey: number; // naik saat ada manuver / perubahan energisasi
  onSelect: (kind: 'node' | 'edge', id: number) => void;
  typeName: (code: string) => string;
}

/** Daftar pelanggan nyala / padam (paging di server; 2 juta+ pelanggan). */
export function CustomersPanel({ active, state, onState, refreshKey, onSelect, typeName }: Props) {
  const { t } = useT();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [items, setItems] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [counts, setCounts] = useState<{ total: number; on: number; off: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tm = setTimeout(() => setQd(q.trim()), 350);
    return () => clearTimeout(tm);
  }, [q]);

  const fetchPage = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const r = await api<{ items: CustomerRow[]; total: number; total_capped: boolean; counts: { total: number; on: number; off: number } }>(
          `/api/power/customers?state=${state}&q=${encodeURIComponent(qd)}&limit=${PAGE}&offset=${offset}`,
        );
        setItems((cur) => (offset === 0 ? r.items : [...cur, ...r.items]));
        setTotal(r.total);
        setCapped(r.total_capped);
        setCounts(r.counts);
      } catch (e: any) {
        toast.push(e.message, 'error');
      } finally {
        setLoading(false);
      }
    },
    [state, qd, toast],
  );

  useEffect(() => {
    if (active) fetchPage(0);
  }, [active, fetchPage, refreshKey]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input className="input flex-1" placeholder={t('cust.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-28" value={state} onChange={(e) => onState(e.target.value as CustomerState)} aria-label={t('common.status')}>
          <option value="all">{t('power.filter_all')}</option>
          <option value="off">{t('power.off')}</option>
          <option value="on">{t('power.on')}</option>
        </select>
      </div>
      {counts && (
        <div className="flex flex-wrap gap-x-3 text-[11px] text-gray-600">
          <span>
            {t('power.customers')}: {fmtNum(counts.total)}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: ON_STATUS }} /> {t('power.on')} {fmtNum(counts.on)}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: OFF_STATUS }} /> {t('power.off')} {fmtNum(counts.off)}
          </span>
        </div>
      )}
      <div className="text-[11px] text-gray-500">{t('cust.shown', { n: fmtNum(items.length), total: `${fmtNum(total)}${capped ? '+' : ''}` })}</div>
      {items.length === 0 && !loading && <div className="py-4 text-center text-xs text-gray-500">{t('common.no_data')}</div>}
      <ul className="space-y-1">
        {items.map((c) => (
          <li key={c.id} className={`rounded border px-2 py-1 text-xs ${c.energized ? 'border-gray-200' : 'border-red-200 bg-red-50/50'}`}>
            <div className="flex items-center gap-2">
              <button className="truncate text-left font-medium text-brand-700 hover:underline" onClick={() => onSelect('node', c.id)}>
                {c.code || `#${c.id}`}
              </button>
              <span className="flex-1 truncate text-gray-500">{c.name}</span>
              {c.energized ? <Badge tone="green">{t('power.on')}</Badge> : <Badge tone="red">{t('power.off')}</Badge>}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-600">
              <span>{typeName(c.type_code)}</span>
              {c.daya_va > 0 && <span>{fmtVA(c.daya_va)}</span>}
              {c.feeder && (
                <span>
                  {t('power.feeders')} {c.feeder.code}
                </span>
              )}
              {c.gd && (
                <button className="text-brand-700 hover:underline" onClick={() => onSelect('node', c.gd!.id)}>
                  {c.gd.code}
                </button>
              )}
              {c.route && (
                <span>
                  {t('feature.route')} {c.route.code}
                </span>
              )}
              {c.kode_ssot && <span className="font-mono">{c.kode_ssot}</span>}
            </div>
            {!c.energized && (
              <div className="text-[11px] text-red-700">
                {c.off_since ? t('cust.off_since', { time: fmtDate(c.off_since), kind: c.outage_kind || '-', id: c.outage_id ?? '-' }) : t('cust.off_no_event')}
              </div>
            )}
          </li>
        ))}
      </ul>
      {loading && (
        <div className="flex justify-center py-2">
          <Spinner size={16} />
        </div>
      )}
      {!loading && items.length < total && (
        <div className="py-1 text-center">
          <Button size="sm" variant="secondary" onClick={() => fetchPage(items.length)}>
            {t('cust.load_more', { n: PAGE })}
          </Button>
        </div>
      )}
    </div>
  );
}
