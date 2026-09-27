'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader, Spinner, useToast } from '@/components/ui';
import { useLoadT } from './i18n';
import { Points } from './Points';

/** Menu Master Data › Titik SCADA: titik ukur trafo GI, penyulang & gardu serta kontrak pesan SCADA/AMR. */
export default function PointsPage() {
  const L = useLoadT();
  const { has } = useAuth();
  const toast = useToast();
  const [ov, setOv] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      setOv(await api('/api/load/overview'));
    } catch (e: any) {
      toast.push(e.message, 'error');
      setOv({});
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto p-3 md:p-6">
      <PageHeader title={L('points_title')} subtitle={L('points_subtitle')} />
      {ov === null ? <Spinner size={20} /> : <Points canManage={has('load.manage')} overview={ov} onChanged={load} />}
    </div>
  );
}
