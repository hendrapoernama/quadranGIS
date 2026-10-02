'use client';

import { useAuth } from '@/lib/auth';

/** Nama unit induk (org_units) untuk kepala halaman. */
export interface OrgNames {
  uid: string;
  up2d: string;
}

/** Nama UID & UP2D dari profil login (GET /api/auth/me), tersedia bagi semua pengguna. */
export function useOrgNames(): OrgNames {
  return useAuth().org;
}

/**
 * Kepala halaman bergaya infografis: logo PLN + "PT. PLN (Persero) <UID>" / UP2D di kiri, judul di tengah (tanpa nama
 * UID, sudah tertulis di kiri), logo Danantara Indonesia di kanan. Dipakai header semua menu (PageBanner).
 */
export function OrgBanner({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) {
  const org = useOrgNames();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-gradient-to-r from-teal-700 via-cyan-600 to-teal-600 px-4 py-3 text-white shadow">
      <div className="order-1 flex min-w-0 flex-1 items-center gap-2 md:min-w-[12rem] md:flex-none">
        {/* logo PLN (aset statis public/brand/pln-logo.png) */}
        <img src="/brand/pln-logo.png" alt="PLN" width={44} height={44} className="h-11 w-11 shrink-0 rounded-sm shadow ring-1 ring-white/50" />
        <div className="min-w-0 leading-tight">
          <div className="text-sm font-bold">{['PT. PLN (Persero)', org.uid].filter(Boolean).join(' ')}</div>
          <div className="text-[11px] opacity-90">{org.up2d || ''}</div>
        </div>
      </div>
      <div className="order-3 w-full text-center md:order-2 md:w-auto md:flex-1">
        <h1 className="text-base font-bold uppercase tracking-wide md:text-xl">{title}</h1>
        {subtitle && <div className="text-xs opacity-90">{subtitle}</div>}
      </div>
      {/* logo Danantara Indonesia (aset statis public/brand/danantara-logo.png); di ponsel sebaris dengan logo PLN */}
      <div className="order-2 ml-auto flex shrink-0 justify-end md:order-3 md:ml-0 md:min-w-[12rem]">
        <img src="/brand/danantara-logo.png" alt="Danantara Indonesia" width={116} height={32} className="h-7 w-auto md:h-8" />
      </div>
    </div>
  );
}
