'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { Menu } from '@/lib/types';
import { Icon } from '@/components/Icon';
import { Sidebar } from '@/components/Sidebar';
import { AppLogo } from '@/components/AppLogo';
import { useFieldT } from '@/components/field/i18n';
import { usePwa } from './PwaProvider';

function flatten(ms: Menu[]): Menu[] {
  return ms.flatMap((m) => [m, ...flatten(m.children || [])]);
}

// urutan tombol navigasi bawah (hanya yang diizinkan untuk peran pengguna)
const BOTTOM = ['/executive', '/monitoring', '/field', '/sld'];

/** Cangkang ponsel: bar atas (☰, judul, status), laci menu, navigasi bawah. */
export function MobileShell({ children }: { children: React.ReactNode }) {
  const { menus, appName, hasLogo, logoVersion } = useAuth();
  const { pick } = useT();
  const f = useFieldT();
  const pathname = usePathname();
  const pwa = usePwa();
  const [drawer, setDrawer] = useState(false);
  const flat = useMemo(() => flatten(menus), [menus]);
  const current = flat.filter((m) => m.path && pathname.startsWith(m.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const bottom = BOTTOM.map((p) => flat.find((m) => m.path === p)).filter(Boolean) as Menu[];

  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gray-100 dark:bg-gray-950">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-gray-900 px-2 pt-[env(safe-area-inset-top)] text-gray-100" style={{ boxSizing: 'content-box' }}>
        <button className="rounded-md p-2 hover:bg-white/10" onClick={() => setDrawer(true)} aria-label={f('menu')}>
          <Icon name="menu" size={20} />
        </button>
        <AppLogo hasLogo={hasLogo} version={logoVersion} size={28} />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{current ? pick(current.title, current.title_en) : appName}</h1>
        {!pwa.online && (
          <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
            <Icon name="wifi" size={12} /> {f('offline')}
          </span>
        )}
        {pwa.outbox > 0 && (
          <Link href="/field" className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white" title={f('outbox_pending', { n: pwa.outbox })}>
            ↑{pwa.outbox}
          </Link>
        )}
        {pwa.updateReady && (
          <button className="rounded bg-emerald-600 px-1.5 py-0.5 text-[11px] font-semibold text-white" onClick={pwa.applyUpdate}>
            {f('update_apply')}
          </button>
        )}
        {pwa.canInstall && (
          <button className="rounded-md p-1.5 text-gray-300 hover:bg-white/10" onClick={pwa.install} title={f('install')} aria-label={f('install')}>
            <Icon name="download" size={18} />
          </button>
        )}
      </header>

      {!pwa.online && <div className="shrink-0 bg-amber-100 px-3 py-1 text-[11px] text-amber-900">{f('offline_banner')}</div>}

      <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>

      {bottom.length > 0 && (
        <nav className="flex shrink-0 border-t border-gray-800 bg-gray-900 pb-[env(safe-area-inset-bottom)] text-gray-400">
          {bottom.map((m) => {
            const active = pathname.startsWith(m.path);
            return (
              <Link key={m.id} href={m.path} className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${active ? 'text-white' : 'hover:text-gray-200'}`}>
                <span className={`rounded-full px-3 py-0.5 ${active ? 'bg-brand-600' : ''}`}>
                  <Icon name={m.icon || 'chevron-right'} size={20} />
                </span>
                <span className="max-w-full truncate px-1">{pick(m.title, m.title_en)}</span>
              </Link>
            );
          })}
          <button className="flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] hover:text-gray-200" onClick={() => setDrawer(true)}>
            <span className="rounded-full px-3 py-0.5">
              <Icon name="menu" size={20} />
            </span>
            {f('menu')}
          </button>
        </nav>
      )}

      {drawer && (
        <div className="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true">
          <div className="h-full pt-[env(safe-area-inset-top)] shadow-2xl [&>aside]:!w-72">
            <Sidebar onHide={() => setDrawer(false)} />
          </div>
          <button className="flex-1 bg-black/50" onClick={() => setDrawer(false)} aria-label={f('close')} />
        </div>
      )}
    </div>
  );
}
