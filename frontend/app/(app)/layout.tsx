'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Icon } from '@/components/Icon';
import { Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';

const HIDDEN_KEY = 'qgis_sidebar_hidden';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useT();
  const router = useRouter();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDDEN_KEY) === '1');
    } catch {
      /* abaikan */
    }
  }, []);

  const toggle = useCallback(() => {
    setHidden((h) => {
      try {
        window.localStorage.setItem(HIDDEN_KEY, h ? '0' : '1');
      } catch {
        /* abaikan */
      }
      return !h;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500">
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {!hidden && <Sidebar onHide={toggle} />}
      {hidden && (
        <button
          className="fixed left-0 top-1/2 z-40 flex h-16 w-5 -translate-y-1/2 items-center justify-center rounded-r-md bg-gray-900/90 text-gray-200 shadow-lg hover:bg-brand-600 hover:text-white"
          onClick={toggle}
          title={t('nav.show_sidebar')}
          aria-label={t('nav.show_sidebar')}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      )}
      <main className="relative flex-1 overflow-hidden bg-gray-100 dark:bg-gray-950">{children}</main>
    </div>
  );
}
