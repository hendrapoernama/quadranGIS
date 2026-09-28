'use client';

import { useT } from '@/lib/i18n';
import { Badge } from '@/components/ui';

/** Status operasi non-aktif (atribut status_operasi): rencana / non aktif / tidak operasi / bongkar, selain itu null. */
export function nonOperating(attrs: Record<string, any> | null | undefined): 'rencana' | 'non_aktif' | 'tidak_operasi' | 'bongkar' | null {
  const v = String(attrs?.status_operasi ?? '')
    .trim()
    .toLowerCase();
  if (v === 'rencana') return 'rencana';
  if (v === 'non aktif' || v === 'nonaktif') return 'non_aktif';
  if (v === 'tidak operasi') return 'tidak_operasi';
  if (v === 'bongkar') return 'bongkar';
  return null;
}

/** Lencana kondisi kelistrikan: NYALA / PADAM, atau RENCANA / NON AKTIF / TIDAK OPERASI / BONGKAR (tidak dihitung di rekap). */
export function PowerStateBadge({ energized, attrs }: { energized: boolean; attrs?: Record<string, any> | null }) {
  const { t } = useT();
  const op = nonOperating(attrs);
  if (op)
    return (
      <span title={t('feature.op_hint')}>
        <Badge tone="gray">{t(`feature.op_${op}` as any)}</Badge>
      </span>
    );
  return energized ? <Badge tone="green">{t('feature.on')}</Badge> : <Badge tone="red">{t('feature.off')}</Badge>;
}
