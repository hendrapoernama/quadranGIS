'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { Menu } from '@/lib/types';
import { Icon } from './Icon';
import { PrefsBar } from './ui';

function MenuItem({ item, depth, collapsed }: { item: Menu; depth: number; collapsed: boolean }) {
  const pathname = usePathname();
  const { pick } = useT();
  const hasChildren = !!item.children?.length;
  const isActive = item.path && pathname.startsWith(item.path);
  const childActive = hasChildren && item.children!.some((c) => c.path && pathname.startsWith(c.path));
  const [open, setOpen] = useState(childActive || depth === 0);
  const title = pick(item.title, item.title_en);

  const cls = `flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
    isActive ? 'bg-brand-600 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'
  }`;

  if (hasChildren) {
    return (
      <div>
        <button className={cls} onClick={() => setOpen(!open)} title={title}>
          <Icon name={item.icon || 'menu'} size={18} />
          {!collapsed && <span className="flex-1 text-left">{title}</span>}
          {!collapsed && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />}
        </button>
        {open && (
          <div className={collapsed ? 'mt-1 space-y-1' : 'ml-4 mt-1 space-y-1 border-l border-white/10 pl-2'}>
            {item.children!.map((c) => (
              <MenuItem key={c.id} item={c} depth={depth + 1} collapsed={collapsed} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <Link href={item.path || '#'} className={cls} title={title}>
      <Icon name={item.icon || 'chevron-right'} size={18} />
      {!collapsed && <span>{title}</span>}
    </Link>
  );
}

export function Sidebar({ onHide }: { onHide: () => void }) {
  const { user, menus, appName, logout } = useAuth();
  const { t } = useT();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`flex h-full flex-col bg-gray-900 text-gray-100 transition-all ${collapsed ? 'w-16' : 'w-60'}`}>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-yellow-300">
          <Icon name="bolt" size={20} />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{appName}</div>
            <div className="truncate text-[11px] text-gray-400">{t('nav.app_subtitle')}</div>
          </div>
        )}
        <div className="ml-auto flex flex-col gap-0.5">
          <button className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white" onClick={() => setCollapsed(!collapsed)} title={collapsed ? t('nav.expand') : t('nav.collapse')} aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
          </button>
          <button className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white" onClick={onHide} title={t('nav.hide_sidebar')} aria-label={t('nav.hide_sidebar')}>
            <Icon name="panel-left" size={16} />
          </button>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {menus.map((m) => (
          <MenuItem key={m.id} item={m} depth={0} collapsed={collapsed} />
        ))}
        {menus.length === 0 && !collapsed && <div className="px-3 text-xs text-gray-500">{t('nav.no_menu')}</div>}
      </nav>
      <div className="border-t border-white/10 p-2">
        <div className={`mb-1 flex ${collapsed ? 'justify-center' : 'justify-start px-1'}`}>
          <PrefsBar compact={collapsed} light />
        </div>
        <Link href="/profile" className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-white/10" title={t('nav.profile')}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs font-semibold uppercase">
            {user?.username?.slice(0, 2) || '?'}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{user?.full_name || user?.username}</div>
              <div className="truncate text-[11px] text-gray-400">{user?.role_name || '-'}</div>
            </div>
          )}
        </Link>
        <button className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-gray-300 hover:bg-white/10 hover:text-white" onClick={logout} title={t('nav.logout')}>
          <Icon name="logout" size={18} />
          {!collapsed && <span>{t('nav.logout')}</span>}
        </button>
      </div>
    </aside>
  );
}
