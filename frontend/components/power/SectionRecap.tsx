'use client';

import { useT } from '@/lib/i18n';
import { fmtNum, fmtVA } from '@/lib/format';
import { OFF_STATUS, ON_STATUS } from '@/components/map/mapStyle';

export interface SectionStat {
  kind: 'feeder' | 'zone' | 'gd' | 'rak' | 'route';
  customers: number;
  customers_off: number;
  load_va: number;
  load_off_va: number;
}

/** Rekap pelanggan & daya terpasang (nyala / padam) di hilir gardu, switch, atau kubikel outgoing. */
export function SectionRecap({ sec }: { sec?: SectionStat | null }) {
  const { t } = useT();
  if (!sec) return null;
  const title =
    sec.kind === 'feeder'
      ? t('sec.title_feeder')
      : sec.kind === 'zone'
        ? t('sec.title_zone')
        : sec.kind === 'rak'
          ? t('sec.title_rak')
          : sec.kind === 'route'
            ? t('sec.title_route')
            : t('sec.title_gd');
  const rows: { label: string; on: string; off: string; total: string; onRatio: number; offCount: number }[] = [
    {
      label: t('sec.customers'),
      on: fmtNum(sec.customers - sec.customers_off),
      off: fmtNum(sec.customers_off),
      total: fmtNum(sec.customers),
      onRatio: sec.customers > 0 ? (sec.customers - sec.customers_off) / sec.customers : 1,
      offCount: sec.customers_off,
    },
    {
      label: t('sec.installed'),
      on: fmtVA(sec.load_va - sec.load_off_va),
      off: fmtVA(sec.load_off_va),
      total: fmtVA(sec.load_va),
      onRatio: sec.load_va > 0 ? (sec.load_va - sec.load_off_va) / sec.load_va : 1,
      offCount: sec.load_off_va,
    },
  ];
  return (
    <div className="mt-2 rounded-md border border-gray-200 p-2 text-xs">
      <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{title}</div>
      <table className="w-full">
        <thead>
          <tr className="text-[10px] text-gray-500">
            <th className="text-left font-normal" />
            <th className="whitespace-nowrap text-right font-normal">
              <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: ON_STATUS }} />
              {t('power.on')}
            </th>
            <th className="whitespace-nowrap pl-2 text-right font-normal">
              <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: OFF_STATUS }} />
              {t('power.off')}
            </th>
            <th className="whitespace-nowrap pl-2 text-right font-normal">{t('sec.total')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="align-top">
              <td className="pr-2 text-gray-500">
                {r.label}
                <div className="mt-0.5 h-1 w-full min-w-[3rem] overflow-hidden rounded bg-gray-200" aria-hidden>
                  <div className="h-full" style={{ width: `${r.onRatio * 100}%`, background: ON_STATUS }} />
                </div>
              </td>
              <td className="whitespace-nowrap pl-1 text-right font-semibold tabular-nums text-emerald-700">{r.on}</td>
              <td className={`whitespace-nowrap pl-1 text-right font-semibold tabular-nums ${r.offCount > 0 ? 'text-red-700' : 'text-gray-500'}`}>{r.off}</td>
              <td className="whitespace-nowrap pl-1 text-right tabular-nums text-gray-700">{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
