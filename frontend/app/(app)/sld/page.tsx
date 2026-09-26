'use client';

import dynamic from 'next/dynamic';
import { Spinner } from '@/components/ui';

const SLD = dynamic(() => import('@/components/sld/SLD'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-gray-500">
      <Spinner size={28} />
    </div>
  ),
});

export default function SLDPage() {
  return <SLD />;
}
