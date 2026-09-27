'use client';

import { Icon } from './Icon';
import { logoUrl } from '@/lib/auth';

/** Logo aplikasi: logo unggahan (Identitas Aplikasi) atau ikon bawaan. */
export function AppLogo({ hasLogo, version, size = 36, className = '' }: { hasLogo: boolean; version: number; size?: number; className?: string }) {
  const url = logoUrl(hasLogo, version);
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" width={size} height={size} className={`shrink-0 rounded-lg object-contain ${className}`} style={{ width: size, height: size }} />
    );
  return (
    <div className={`flex shrink-0 items-center justify-center rounded-lg bg-brand-600 text-yellow-300 ${className}`} style={{ width: size, height: size }}>
      <Icon name="bolt" size={Math.round(size * 0.56)} />
    </div>
  );
}
