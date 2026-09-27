'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const QUERY = '(max-width: 767px)';

/** true di layar ponsel (lebar ≤ 767 px). Tablet & desktop memakai tata letak desktop. */
export function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** Status koneksi perangkat. */
export function useOnline(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const f = () => setOn(navigator.onLine);
    f();
    window.addEventListener('online', f);
    window.addEventListener('offline', f);
    return () => {
      window.removeEventListener('online', f);
      window.removeEventListener('offline', f);
    };
  }, []);
  return on;
}

export interface GeoFix {
  lng: number;
  lat: number;
  accuracy: number;
  heading: number | null;
  at: number;
}

/** Posisi GPS (watchPosition) yang aktif selama `active` bernilai true. */
export function useGeolocation(active: boolean) {
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [error, setError] = useState('');
  const watch = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    if (!('geolocation' in navigator)) {
      setError('unsupported');
      return;
    }
    setError('');
    watch.current = navigator.geolocation.watchPosition(
      (p) => setFix({ lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, heading: p.coords.heading, at: p.timestamp }),
      (e) => setError(e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => {
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
    };
  }, [active]);
  const once = useCallback(
    () =>
      new Promise<GeoFix>((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('unsupported'));
        navigator.geolocation.getCurrentPosition(
          (p) => {
            const f = { lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, heading: p.coords.heading, at: p.timestamp };
            setFix(f);
            resolve(f);
          },
          (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable')),
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
        );
      }),
    [],
  );
  return { fix, error, once };
}

/** Jarak dua titik (meter). */
export function distanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function fmtMeters(m: number): string {
  return m >= 1000 ? `${(m / 1000).toLocaleString('id-ID', { maximumFractionDigits: 2 })} km` : `${Math.round(m)} m`;
}

/** Tautan navigasi ke titik (Google Maps; di iOS dibuka Apple Maps bila tersedia). */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}
