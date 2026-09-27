'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { Button, useToast } from '@/components/ui';
import { AppLogo } from './AppLogo';

const MAX_BYTES = 512 * 1024;
const ACCEPT = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

/** Identitas aplikasi: nama, deskripsi, dan logo (disimpan di konfigurasi app.name / app.description / app.logo). */
export function BrandingForm() {
  const { t } = useT();
  const toast = useToast();
  const { appName, appDescription, hasLogo, logoVersion, refresh } = useAuth();
  const [name, setName] = useState(appName);
  const [desc, setDesc] = useState(appDescription);
  const [logo, setLogo] = useState<string>(''); // '' = tidak diubah, '-' = hapus, data URL = baru
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(appName);
    setDesc(appDescription);
  }, [appName, appDescription]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!ACCEPT.includes(f.type) || f.size > MAX_BYTES) {
      toast.push(t('brand.logo_hint'), 'warning');
      return;
    }
    const r = new FileReader();
    r.onload = () => setLogo(String(r.result || ''));
    r.readAsDataURL(f);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/admin/branding', { method: 'PUT', body: { name, description: desc, logo } });
      toast.push(t('brand.saved'), 'success');
      setLogo('');
      await refresh();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const changed = name !== appName || desc !== appDescription || logo !== '';
  const previewSrc = logo && logo !== '-' ? logo : null;

  return (
    <div className="card mb-4 overflow-hidden">
      <div className="border-b border-gray-200 bg-gray-50 px-4 py-2">
        <div className="text-sm font-semibold text-gray-800">{t('brand.title')}</div>
        <div className="text-xs text-gray-500">{t('brand.subtitle')}</div>
      </div>
      <div className="grid gap-4 p-4 md:grid-cols-[1fr,260px]">
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="brand-name">
              {t('brand.name')}
            </label>
            <input id="brand-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="brand-desc">
              {t('brand.description')}
            </label>
            <input id="brand-desc" className="input" maxLength={120} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div>
            <span className="label">{t('brand.logo')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept={ACCEPT.join(',')} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
              <Button size="sm" variant="secondary" icon="plus" onClick={() => fileRef.current?.click()}>
                {t('brand.upload')}
              </Button>
              {(hasLogo || previewSrc) && logo !== '-' && (
                <Button size="sm" variant="ghost" icon="trash" onClick={() => setLogo('-')}>
                  {t('brand.remove')}
                </Button>
              )}
              <span className="text-[11px] text-gray-500">{t('brand.logo_hint')}</span>
            </div>
          </div>
          <Button icon="check" loading={saving} disabled={!changed || !name.trim()} onClick={save}>
            {t('common.save')}
          </Button>
        </div>
        {/* pratinjau seperti di sidebar */}
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">{t('brand.preview')}</div>
          <div className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-3 text-gray-100">
            {previewSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" />
            ) : (
              <AppLogo hasLogo={hasLogo && logo !== '-'} version={logoVersion} size={36} />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{name || '-'}</div>
              <div className="truncate text-[11px] text-gray-400">{desc}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
