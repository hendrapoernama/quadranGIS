'use client';

import { createContext, useContext, useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { Menu } from '@/lib/types';
import { OrgBanner } from '@/components/exec/OrgBanner';

/** Isi khusus header dari halaman (judul / subjudul pengganti nama menu; print = ikut tercetak). */
export interface BannerOpts {
  title?: string;
  subtitle?: string;
  /** header ikut dicetak (mis. Infografis), juga saat header disembunyikan di layar */
  print?: boolean;
}

const BannerCtx = createContext<(o: BannerOpts | null) => void>(() => {});
export const PageBannerProvider = BannerCtx.Provider;

/** Halaman mengganti judul / subjudul header selama terpasang. */
export function usePageBanner({ title, subtitle, print }: BannerOpts) {
  const set = useContext(BannerCtx);
  useEffect(() => {
    set({ title, subtitle, print });
  }, [set, title, subtitle, print]);
  useEffect(() => () => set(null), [set]);
}

/** Halaman di luar daftar menu: kunci judul (i18n) menurut path. */
const NON_MENU: Record<string, string> = { '/profile': 'nav.profile' };

/** Jejak menu (induk → menu aktif) untuk path halaman; menu dengan path terpanjang yang cocok. */
function menuTrail(menus: Menu[], pathname: string): Menu[] {
  let best: Menu[] = [];
  let bestLen = 0;
  const walk = (items: Menu[], trail: Menu[]) => {
    for (const m of items) {
      const t = [...trail, m];
      const p = (m.path || '').replace(/\/$/, '');
      if (p && (pathname === p || pathname.startsWith(p + '/')) && p.length > bestLen) {
        best = t;
        bestLen = p.length;
      }
      if (m.children?.length) walk(m.children, t);
    }
  };
  walk(menus, []);
  return best;
}

/**
 * Header bergaya infografis di atas semua menu (Administrasi › Konfigurasi › Identitas Aplikasi): judul = nama menu
 * aktif, subjudul = menu induknya; halaman dapat menggantinya lewat usePageBanner.
 */
export function PageBanner({ opts }: { opts: BannerOpts | null }) {
  const { pageBanner, menus, appName } = useAuth();
  const pathname = usePathname() || '';
  const { pick, t } = useT();
  const trail = useMemo(() => menuTrail(menus, pathname), [menus, pathname]);
  if (!pageBanner && !opts?.print) return null;
  const last = trail[trail.length - 1];
  const extra = Object.keys(NON_MENU).find((p) => pathname === p || pathname.startsWith(p + '/'));
  const title = opts?.title ?? (last ? pick(last.title, last.title_en) : extra ? t(NON_MENU[extra] as any) : appName);
  const subtitle =
    opts?.subtitle ??
    trail
      .slice(0, -1)
      .map((m) => pick(m.title, m.title_en))
      .join(' › ');
  // disembunyikan di layar tetapi diminta tercetak → hanya muncul saat cetak
  const vis = pageBanner ? (opts?.print ? '' : 'no-print') : 'hidden print:block';
  return (
    <div className={`page-banner shrink-0 px-3 pt-3 md:px-4 ${vis}`} data-testid="page-banner">
      <OrgBanner title={title} subtitle={subtitle || undefined} />
    </div>
  );
}
