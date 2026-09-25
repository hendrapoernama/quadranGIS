'use client';

import dynamic from 'next/dynamic';
import { Spinner } from '@/components/ui';

const PowerMonitor = dynamic(() => import('@/components/power/PowerMonitor'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-gray-500">
      <Spinner size={28} />
    </div>
  ),
});

export default function MonitoringPage() {
  return <PowerMonitor />;
}
