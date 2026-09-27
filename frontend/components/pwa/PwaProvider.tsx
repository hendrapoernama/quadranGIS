'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { flushOutbox, onOutboxChange, outboxList } from '@/lib/outbox';
import { isStandalone } from '@/lib/mobile';
import { useToast } from '@/components/ui';
import { useFieldT } from '@/components/field/i18n';

interface PwaState {
  online: boolean;
  canInstall: boolean;
  installed: boolean;
  install: () => Promise<void>;
  updateReady: boolean;
  applyUpdate: () => void;
  outbox: number;
  flush: () => Promise<void>;
  swReady: boolean;
}

const Ctx = createContext<PwaState>({
  online: true,
  canInstall: false,
  installed: false,
  install: async () => {},
  updateReady: false,
  applyUpdate: () => {},
  outbox: 0,
  flush: async () => {},
  swReady: false,
});

export function usePwa() {
  return useContext(Ctx);
}

/** Service worker, pemasangan PWA, status online, dan pengiriman antrean offline. */
export function PwaProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { locale } = useT();
  const f = useFieldT();
  const toast = useToast();
  const [online, setOnline] = useState(true);
  const [prompt, setPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [outbox, setOutbox] = useState(0);
  const [swReady, setSwReady] = useState(false);
  const username = user?.username || '';
  const fRef = useRef(f);
  fRef.current = f;

  // service worker
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    let reg: ServiceWorkerRegistration | null = null;
    const watch = (r: ServiceWorkerRegistration) => {
      if (r.waiting && navigator.serviceWorker.controller) setWaiting(r.waiting);
      r.addEventListener('updatefound', () => {
        const nw = r.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) setWaiting(nw);
        });
      });
    };
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((r) => {
        reg = r;
        watch(r);
        setSwReady(true);
      })
      .catch(() => {});
    let reloading = false;
    const onCtrl = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onCtrl);
    const iv = setInterval(() => reg?.update().catch(() => {}), 30 * 60 * 1000);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onCtrl);
      clearInterval(iv);
    };
  }, []);

  // pemasangan
  useEffect(() => {
    setInstalled(isStandalone());
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) return;
    prompt.prompt();
    const r = await prompt.userChoice.catch(() => null);
    if (r?.outcome === 'accepted') setPrompt(null);
  }, [prompt]);

  const applyUpdate = useCallback(() => {
    waiting?.postMessage({ type: 'SKIP_WAITING' });
  }, [waiting]);

  // antrean offline
  const refreshCount = useCallback(async () => {
    const all = await outboxList();
    setOutbox(all.filter((i) => i.user === username).length);
  }, [username]);
  const flush = useCallback(async () => {
    if (!username) return;
    const r = await flushOutbox(username, locale);
    if (r.sent) toast.push(fRef.current('synced', { n: r.sent }), 'success');
    if (r.failed) toast.push(fRef.current('sync_failed', { n: r.failed }), 'warning');
    refreshCount();
  }, [username, locale, toast, refreshCount]);

  useEffect(() => {
    const up = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) flush();
    };
    setOnline(navigator.onLine);
    window.addEventListener('online', up);
    window.addEventListener('offline', up);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', up);
    };
  }, [flush]);

  useEffect(() => {
    if (!username) return;
    refreshCount();
    const off = onOutboxChange(refreshCount);
    flush();
    const iv = setInterval(() => {
      if (navigator.onLine) flush();
    }, 60000);
    return () => {
      off();
      clearInterval(iv);
    };
  }, [username, refreshCount, flush]);

  // tampilkan pemberitahuan versi baru sekali
  const shown = useRef(false);
  useEffect(() => {
    if (waiting && !shown.current) {
      shown.current = true;
      toast.push(fRef.current('update_ready'), 'info');
    }
  }, [waiting, toast]);

  return (
    <Ctx.Provider value={{ online, canInstall: !!prompt && !installed, installed, install, updateReady: !!waiting, applyUpdate, outbox, flush, swReady }}>
      {children}
    </Ctx.Provider>
  );
}
