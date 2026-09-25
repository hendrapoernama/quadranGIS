'use client';

import { FormEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, setToken } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button, PrefsBar, Spinner } from '@/components/ui';
import { Icon } from '@/components/Icon';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const { t, locale } = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);

  const loadCaptcha = useCallback(async () => {
    setLoadingCaptcha(true);
    setAnswer('');
    try {
      const c = await api<{ captcha_id: string; question: string }>('/api/auth/captcha');
      setCaptchaId(c.captcha_id);
      setQuestion(c.question);
    } catch (e: any) {
      setError(t('login.captcha_failed', { msg: e?.message || '-' }));
    } finally {
      setLoadingCaptcha(false);
    }
  }, [t]);

  useEffect(() => {
    loadCaptcha();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: { username, password, captcha_id: captchaId, captcha_answer: answer },
      });
      setToken(res.token);
      const next = params.get('next') || '/map';
      window.location.href = next.startsWith('/') ? next : '/map';
    } catch (e: any) {
      setError(e?.message || t('login.failed'));
      await loadCaptcha();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 via-brand-950 to-gray-900 p-4" key={locale}>
      <div className="absolute right-4 top-4">
        <PrefsBar light />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3 text-white">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-yellow-300 shadow-lg">
            <Icon name="bolt" size={26} />
          </div>
          <div>
            <div className="text-2xl font-bold">QuadranGIS</div>
            <div className="text-sm text-gray-300">{t('login.subtitle')}</div>
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <h1 className="text-lg font-semibold text-gray-900">{t('login.title')}</h1>
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
          <div>
            <label className="label" htmlFor="username">
              {t('login.username')}
            </label>
            <input id="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="password">
              {t('login.password')}
            </label>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="captcha">
              {t('login.captcha_label')}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex h-9 min-w-[7rem] select-none items-center justify-center rounded-md border border-dashed border-gray-400 bg-gray-50 px-3 font-mono text-base font-semibold tracking-wider text-gray-800">
                {loadingCaptcha ? <Spinner size={16} /> : question || '...'}
              </div>
              <input id="captcha" className="input flex-1" inputMode="numeric" placeholder={t('login.captcha_placeholder')} value={answer} onChange={(e) => setAnswer(e.target.value)} required />
              <button type="button" className="rounded-md border border-gray-300 p-2 text-gray-600 hover:bg-gray-50" onClick={loadCaptcha} title={t('login.captcha_new')} aria-label={t('login.captcha_new')}>
                <Icon name="refresh" size={16} />
              </button>
            </div>
          </div>
          <Button type="submit" className="w-full" loading={loading}>
            {t('login.submit')}
          </Button>
          <p className="text-center text-xs text-gray-500">{t('login.footer')}</p>
        </form>
      </div>
    </div>
  );
}
