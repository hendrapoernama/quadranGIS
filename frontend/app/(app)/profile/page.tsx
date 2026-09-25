'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { Button, PageHeader, useToast } from '@/components/ui';
import { fmtDate } from '@/lib/format';

export default function ProfilePage() {
  const { user, permissions } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast.push(t('profile.mismatch'), 'error');
      return;
    }
    setLoading(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { old_password: oldPassword, new_password: newPassword } });
      toast.push(t('profile.changed'), 'success');
      setOld('');
      setNew('');
      setConfirm('');
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">{t('profile.account')}</h2>
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-gray-500">{t('login.username')}</dt>
            <dd className="col-span-2 font-medium">{user?.username}</dd>
            <dt className="text-gray-500">{t('common.name')}</dt>
            <dd className="col-span-2">{user?.full_name || '-'}</dd>
            <dt className="text-gray-500">{t('profile.email')}</dt>
            <dd className="col-span-2">{user?.email || '-'}</dd>
            <dt className="text-gray-500">{t('profile.role')}</dt>
            <dd className="col-span-2">{user?.role_name || '-'}</dd>
            <dt className="text-gray-500">{t('profile.last_login')}</dt>
            <dd className="col-span-2">{fmtDate(user?.last_login_at)}</dd>
          </dl>
          <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-gray-500">{t('profile.permissions')}</h3>
          <div className="flex flex-wrap gap-1">
            {permissions.map((p) => (
              <span key={p} className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700">
                {p}
              </span>
            ))}
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-gray-900">{t('profile.change_password')}</h2>
          <div>
            <label className="label">{t('profile.old_password')}</label>
            <input className="input" type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} required />
          </div>
          <div>
            <label className="label">{t('profile.new_password')}</label>
            <input className="input" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} required minLength={8} />
          </div>
          <div>
            <label className="label">{t('profile.confirm_password')}</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
          </div>
          <Button type="submit" loading={loading}>
            {t('common.save')}
          </Button>
        </form>
      </div>
    </div>
  );
}
