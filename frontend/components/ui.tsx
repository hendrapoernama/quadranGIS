'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useT, type Locale } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

// ------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  loading,
  icon,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50';
  const sizes = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm';
  const variants: Record<Variant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 focus:ring-brand-300',
    secondary: 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 focus:ring-gray-200',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-300',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300',
    ghost: 'text-gray-700 hover:bg-gray-100 focus:ring-gray-200',
  };
  return (
    <button className={`${base} ${sizes} ${variants[variant]} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="loading">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------------ Form
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'green' | 'red' | 'blue' | 'amber' | 'purple' }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-emerald-100 text-emerald-800',
    red: 'bg-red-100 text-red-800',
    blue: 'bg-blue-100 text-blue-800',
    amber: 'bg-amber-100 text-amber-800',
    purple: 'bg-purple-100 text-purple-800',
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

// ------------------------------------------------------------------ Modal
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const { t } = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div className={`card w-full ${width} max-h-[90vh] overflow-hidden`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button className="rounded p-1 text-gray-500 hover:bg-gray-100" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({
  open,
  title,
  message,
  onCancel,
  onConfirm,
  loading,
  danger = true,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  loading?: boolean;
  danger?: boolean;
}) {
  const { t } = useT();
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {t('common.yes_continue')}
          </Button>
        </>
      }
    >
      <div className="text-sm text-gray-700">{message}</div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Toast
interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error' | 'warning';
}

const ToastCtx = createContext<{ push: (message: string, tone?: Toast['tone']) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-4), { id, message, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), tone === 'error' ? 7000 : 4500);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  const tones = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg ${tones[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

// ------------------------------------------------------------------ Page helpers
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-gray-500">{text}</div>;
}

export function StatCard({ label, value, sub, tone = 'gray' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue' }) {
  const bar = { gray: 'bg-gray-300', green: 'bg-emerald-500', red: 'bg-red-500', amber: 'bg-amber-400', blue: 'bg-brand-500' }[tone];
  return (
    <div className="card flex items-stretch overflow-hidden">
      <div className={`w-1.5 ${bar}`} />
      <div className="px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
      </div>
    </div>
  );
}

/** Pemilih tema & bahasa yang dipakai di sidebar dan halaman login. */
export function PrefsBar({ compact = false, light = false }: { compact?: boolean; light?: boolean }) {
  const { locale, setLocale, t } = useT();
  return <ThemeLangControls compact={compact} light={light} locale={locale} setLocale={setLocale} t={t} />;
}

function ThemeLangControls({
  compact,
  light,
  locale,
  setLocale,
  t,
}: {
  compact: boolean;
  light: boolean;
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: any, p?: any) => string;
}) {
  const { theme, resolved, setTheme } = useTheme();
  const base = light ? 'text-gray-300 hover:bg-white/10 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900';
  const active = light ? 'bg-white/15 text-white' : 'bg-brand-600 text-white hover:bg-brand-700 hover:text-white';
  const cycle = () => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light');
  const themeIcon = theme === 'system' ? 'monitor' : resolved === 'dark' ? 'moon' : 'sun';
  const themeLabel = theme === 'system' ? t('nav.theme_system') : resolved === 'dark' ? t('nav.theme_dark') : t('nav.theme_light');
  return (
    <div className={`flex items-center gap-1 ${compact ? 'flex-col' : ''}`}>
      <button className={`flex h-8 items-center gap-1 rounded-md px-2 text-xs ${base}`} onClick={cycle} title={`${t('nav.theme')}: ${themeLabel}`} aria-label={t('nav.theme')}>
        <Icon name={themeIcon} size={16} />
        {!compact && <span>{themeLabel}</span>}
      </button>
      <div className={`flex overflow-hidden rounded-md ${light ? 'border border-white/20' : 'border border-gray-300'}`} role="group" aria-label={t('nav.language')}>
        {(['id', 'en'] as Locale[]).map((l) => (
          <button key={l} className={`px-2 py-1 text-xs font-semibold uppercase ${locale === l ? active : base}`} onClick={() => setLocale(l)} title={t('nav.language')}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
