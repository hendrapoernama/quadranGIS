'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';

/** URL lama /operations: fitur operasi kini ada di menu Pusat Operasi (/monitoring, grup tab Operasi). */
export default function OperationsRedirect() {
  const router = useRouter();
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab') || 'flisr';
    router.replace(`/monitoring?tab=${encodeURIComponent(tab)}`);
  }, [router]);
  return (
    <div className="flex h-full items-center justify-center text-gray-500">
      <Spinner size={28} />
    </div>
  );
}
