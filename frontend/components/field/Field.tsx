'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { ComponentType } from '@/lib/types';
import { directionsUrl, fmtMeters, isIOS, isStandalone, useGeolocation } from '@/lib/mobile';
import { compressPhoto, uid } from '@/lib/photo';
import { outboxAdd, outboxList, outboxRemove, onOutboxChange, uploadPhoto, type OutboxItem } from '@/lib/outbox';
import { bboxAround, deleteArea, downloadArea, fmtBytes, listAreas, requestPersist, storageInfo, tilesFor, type OfflineArea } from '@/lib/offlineArea';
import { Badge, Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useOpsT } from '@/components/ops/i18n';
import { usePwa } from '@/components/pwa/PwaProvider';
import { AssetPhotos, photoUrl, type PhotoMeta } from './AssetPhotos';
import { useFieldT } from './i18n';

interface NearbyItem {
  kind: 'node';
  id: number;
  code: string;
  name: string;
  type_code: string;
  energized: boolean;
  status: string;
  lng: number;
  lat: number;
  distance_m: number;
  photos: number;
}

const TYPE_GROUPS: Record<string, string[]> = {
  gd: ['gd', 'gh', 'trafo_distribusi', 'rak_tr', 'gi', 'trafo_gi'],
  switch: ['recloser', 'lbs_2way', 'lbs_3way', 'kubikel_20kv', 'switch_jurusan_tr'],
  pole: ['tiang_tm', 'tiang_tr'],
  customer: ['pelanggan_tr', 'pelanggan_tm', 'pelanggan_tt'],
};
const CATEGORIES = ['PADAM', 'PADAM_SEBAGIAN', 'TEGANGAN', 'KABEL_PUTUS', 'TIANG', 'BAHAYA', 'LAINNYA'];

function Card({ title, icon, children, right }: { title: string; icon: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="card p-3">
      <div className="mb-2 flex items-center gap-2">
        <Icon name={icon} size={16} className="text-brand-700" />
        <h2 className="flex-1 text-sm font-semibold text-gray-900">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Menu Lapangan (dioptimalkan untuk ponsel): GPS, aset terdekat, foto, laporan cepat, antrean & area offline, notifikasi. */
export default function Field() {
  const f = useFieldT();
  const o = useOpsT();
  const { locale, pick } = useT();
  const { user, has } = useAuth();
  const toast = useToast();
  const pwa = usePwa();
  const [gpsOn, setGpsOn] = useState(true);
  const geo = useGeolocation(gpsOn);
  const [types, setTypes] = useState<ComponentType[]>([]);
  const [configs, setConfigs] = useState<Record<string, string>>({});

  useEffect(() => {
    api<{ configs: Record<string, string>; types: ComponentType[] }>('/api/config/public')
      .then((r) => {
        setTypes(r.types);
        setConfigs(r.configs);
      })
      .catch(() => {});
  }, []);
  const typeName = useCallback((c: string) => {
    const x = types.find((y) => y.code === c);
    return x ? pick(x.name, x.name_en) : c;
  }, [types, pick]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-3 p-3 pb-8">
        <div className="hidden md:block">
          <h1 className="text-xl font-semibold text-gray-900">{f('title')}</h1>
          <p className="text-sm text-gray-500">{f('subtitle')}</p>
        </div>

        {/* GPS */}
        <Card
          title={f('gps')}
          icon="target"
          right={
            <Button size="sm" variant={gpsOn ? 'secondary' : 'primary'} onClick={() => setGpsOn((v) => !v)}>
              {gpsOn ? 'GPS ✓' : f('gps_start')}
            </Button>
          }
        >
          {geo.error ? (
            <p className="text-xs text-red-700">{f(geo.error === 'denied' ? 'gps_denied' : geo.error === 'unsupported' ? 'gps_unsupported' : 'gps_unavailable')}</p>
          ) : geo.fix ? (
            <div className="flex flex-wrap items-center gap-x-3 text-sm">
              <span className="font-mono tabular-nums text-gray-900">
                {geo.fix.lat.toFixed(6)}, {geo.fix.lng.toFixed(6)}
              </span>
              <span className={`text-xs ${geo.fix.accuracy > 50 ? 'text-amber-700' : 'text-gray-500'}`}>{f('accuracy', { m: fmtMeters(geo.fix.accuracy) })}</span>
            </div>
          ) : gpsOn ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Spinner size={12} /> …
            </div>
          ) : (
            <p className="text-xs text-gray-500">{f('gps_off')}</p>
          )}
        </Card>

        <Nearby fix={geo.fix} typeName={typeName} online={pwa.online} configs={configs} />
        {has('report.manage') && <QuickReport fix={geo.fix} categoryLabel={(c) => o(`cat_${c}`)} />}
        <Outbox />
        <Areas fix={geo.fix} configs={configs} />
        <Notifications />
        <Install />
        {user && <RecentPhotos />}
      </div>
    </div>
  );
}

function Nearby({ fix, typeName, online, configs }: { fix: ReturnType<typeof useGeolocation>['fix']; typeName: (c: string) => string; online: boolean; configs: Record<string, string> }) {
  const f = useFieldT();
  const toast = useToast();
  const [radius, setRadius] = useState(Number(configs['mobile.nearby_radius_m'] || 500) || 500);
  const [group, setGroup] = useState<string>('');
  const [items, setItems] = useState<NearbyItem[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const last = useRef<string>('');
  const load = useCallback(async () => {
    if (!fix || !online) return;
    setBusy(true);
    try {
      const t = group ? `&types=${TYPE_GROUPS[group].join(',')}` : '';
      const r = await api<{ items: NearbyItem[] }>(`/api/field/nearby?lng=${fix.lng}&lat=${fix.lat}&radius=${radius}&limit=40${t}`);
      setItems(r.items);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix, online, radius, group]);
  // muat ulang bila posisi berpindah > 25 m, radius, atau filter berubah
  useEffect(() => {
    if (!fix) return;
    const key = `${radius}|${group}|${(fix.lat * 4000).toFixed(0)}|${(fix.lng * 4000).toFixed(0)}`;
    if (key === last.current) return;
    last.current = key;
    load();
  }, [fix, radius, group, load]);

  return (
    <Card
      title={f('nearby')}
      icon="point"
      right={
        <Button size="sm" variant="ghost" icon="refresh" loading={busy} onClick={load} disabled={!fix || !online}>
          {''}
        </Button>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        <select className="input !w-auto text-xs" value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label={f('radius')}>
          {[100, 250, 500, 1000, 2000].map((r) => (
            <option key={r} value={r}>
              {fmtMeters(r)}
            </option>
          ))}
        </select>
        {(['', 'gd', 'switch', 'pole', 'customer'] as const).map((g) => (
          <button key={g || 'all'} className={`rounded-full border px-2.5 py-1 ${group === g ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700'}`} onClick={() => setGroup(g)}>
            {g === '' ? f('all_types') : f(`t_${g}` as any)}
          </button>
        ))}
      </div>
      {!online ? (
        <p className="text-xs text-gray-500">{f('nearby_offline')}</p>
      ) : !fix ? (
        <p className="text-xs text-gray-500">{f('nearby_need_gps')}</p>
      ) : items === null ? (
        <Spinner size={16} />
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-500">{f('nearby_none')}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((n) => (
            <li key={n.id} className="py-1.5">
              <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === n.id ? null : n.id)}>
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${n.energized ? 'bg-emerald-500' : 'bg-red-500'}`} title={n.energized ? f('on') : f('off')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900">{n.code || `#${n.id}`}</span>
                  <span className="block truncate text-[11px] text-gray-500">
                    {typeName(n.type_code)}
                    {n.name ? ` · ${n.name}` : ''}
                    {n.status === 'open' ? ' · OPEN' : ''}
                  </span>
                </span>
                {n.photos > 0 && <Badge tone="blue">📷 {n.photos}</Badge>}
                <span className="shrink-0 text-xs tabular-nums text-gray-600">{fmtMeters(n.distance_m)}</span>
              </button>
              {open === n.id && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-4">
                  <Link href={`/monitoring?select=node:${n.id}`} className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-800">
                    <Icon name="map" size={14} /> {f('open_map')}
                  </Link>
                  <a href={directionsUrl(n.lat, n.lng)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-800">
                    <Icon name="send" size={14} /> {f('navigate')}
                  </a>
                  <AssetPhotos kind="node" id={n.id} pos={fix} />
                  <Link href={`/sld?focus=node:${n.id}`} className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-800">
                    <Icon name="diagram" size={14} /> {f('sld')}
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function QuickReport({ fix, categoryLabel }: { fix: ReturnType<typeof useGeolocation>['fix']; categoryLabel: (c: string) => string }) {
  const f = useFieldT();
  const toast = useToast();
  const { user, has } = useAuth();
  const { locale } = useT();
  const [form, setForm] = useState({ category: 'PADAM', customer_code: '', address: '', description: '' });
  const [useLoc, setUseLoc] = useState(true);
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    const loc = useLoc && fix ? { lng: fix.lng, lat: fix.lat } : {};
    if (!form.customer_code.trim() && !form.address.trim() && !('lng' in loc)) {
      toast.push(f('need_location'), 'warning');
      return;
    }
    setBusy(true);
    const clientId = uid();
    const body = { channel: 'LAPANGAN', reporter_name: user?.full_name || user?.username || '', ...form, ...loc };
    const created = new Date().toISOString();
    const compressed = await Promise.all(photos.map((p) => compressPhoto(p, 1600, 1400).catch(() => null)));
    const photoPayload = (i: number) => ({
      kind: 'report' as const,
      note: form.description.slice(0, 200),
      lng: fix?.lng,
      lat: fix?.lat,
      accuracy: fix?.accuracy,
      taken_at: created,
      image: compressed[i]!.image,
      thumb: compressed[i]!.thumb,
    });
    const queueAll = async (reportId?: number) => {
      if (!reportId) await outboxAdd({ id: clientId, kind: 'report', user: user?.username || '', label: `${categoryLabel(form.category)} ${form.customer_code || form.address}`.trim(), created, tries: 0, report: body });
      for (let i = 0; i < compressed.length; i++) {
        if (!compressed[i]) continue;
        await outboxAdd({ id: uid(), kind: 'photo', user: user?.username || '', label: `${f('outbox_report')} ${f('photo')} ${i + 1}`, created, tries: 0, photo: { ...photoPayload(i), id: reportId, reportClientId: reportId ? undefined : clientId } });
      }
    };
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      const r = await api<{ id: number; ticket: string }>('/api/ops/reports', { method: 'POST', body: { ...body, client_id: clientId } });
      let pending = false;
      for (let i = 0; i < compressed.length; i++) {
        if (!compressed[i]) continue;
        try {
          await uploadPhoto({ ...photoPayload(i), id: r.id }, uid(), locale);
        } catch {
          pending = true;
        }
      }
      if (pending) await queueAll(r.id);
      toast.push(f('sent', { ticket: r.ticket }), 'success');
      setForm({ category: 'PADAM', customer_code: '', address: '', description: '' });
      setPhotos([]);
    } catch (e: any) {
      if (e?.status && e.status < 500) toast.push(e.message, 'error');
      else {
        await queueAll();
        toast.push(f('queued'), 'warning');
        setForm({ category: 'PADAM', customer_code: '', address: '', description: '' });
        setPhotos([]);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={f('quick_report')} icon="alert">
      <p className="mb-2 text-[11px] text-gray-500">{f('quick_hint')}</p>
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-1">
          {CATEGORIES.map((c) => (
            <button key={c} className={`rounded-full border px-2.5 py-1 text-xs ${form.category === c ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700'}`} onClick={() => setForm({ ...form, category: c })}>
              {categoryLabel(c)}
            </button>
          ))}
        </div>
        <input className="input w-full" value={form.customer_code} onChange={(e) => setForm({ ...form, customer_code: e.target.value })} placeholder={f('customer_code')} inputMode="text" />
        <input className="input w-full" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={f('address')} />
        <textarea className="input min-h-[70px] w-full" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={f('description')} />
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input type="checkbox" checked={useLoc} onChange={(e) => setUseLoc(e.target.checked)} />
          {f('use_location')} {fix ? `(${f('accuracy', { m: fmtMeters(fix.accuracy) })})` : '—'}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {photos.map((p, i) => (
            <span key={i} className="relative h-14 w-14 overflow-hidden rounded-md bg-gray-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={URL.createObjectURL(p)} alt="" className="h-full w-full object-cover" />
              <button className="absolute right-0 top-0 rounded-bl bg-black/60 px-1 text-[10px] text-white" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          ))}
          {photos.length < 3 && has('field.photo') && (
            <>
              <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (e.target.files?.[0] && setPhotos([...photos, e.target.files[0]]), (e.target.value = ''))} />
              <Button size="sm" variant="secondary" icon="plus" onClick={() => input.current?.click()}>
                {f('add_photo')}
              </Button>
            </>
          )}
        </div>
        <Button icon="send" loading={busy} onClick={submit} className="w-full">
          {f('send')}
        </Button>
      </div>
    </Card>
  );
}

function Outbox() {
  const f = useFieldT();
  const { user } = useAuth();
  const pwa = usePwa();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setItems((await outboxList()).filter((i) => i.user === (user?.username || ''))), [user]);
  useEffect(() => {
    load();
    return onOutboxChange(load);
  }, [load]);
  return (
    <Card
      title={f('outbox')}
      icon="clock"
      right={
        items.length > 0 && (
          <Button size="sm" icon="send" loading={busy} disabled={!pwa.online} onClick={async () => (setBusy(true), await pwa.flush(), setBusy(false))}>
            {f('outbox_send')}
          </Button>
        )
      }
    >
      {items.length === 0 ? (
        <p className="flex items-center gap-1 text-xs text-emerald-700">
          <Icon name="check" size={13} /> {f('outbox_empty')}
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5 text-xs">
              <Badge tone={it.kind === 'report' ? 'purple' : 'blue'}>{it.kind === 'report' ? f('outbox_report') : f('outbox_photo')}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-gray-900">{it.label || it.id}</span>
                <span className="block text-[10px] text-gray-500">
                  {new Date(it.created).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}
                  {it.error && <span className="text-red-700"> · {f('outbox_error')}: {it.error}</span>}
                </span>
              </span>
              <button className="rounded p-1 text-gray-500 hover:bg-gray-100" onClick={() => outboxRemove(it.id)} title={f('outbox_remove')} aria-label={f('outbox_remove')}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Areas({ fix, configs }: { fix: ReturnType<typeof useGeolocation>['fix']; configs: Record<string, string> }) {
  const f = useFieldT();
  const toast = useToast();
  const pwa = usePwa();
  const [areas, setAreas] = useState<OfflineArea[]>([]);
  const [radius, setRadius] = useState(1000);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [info, setInfo] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  const refresh = useCallback(() => {
    setAreas(listAreas());
    storageInfo().then(setInfo).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  const maxTiles = Number(configs['mobile.offline_max_tiles'] || 1500);
  const basemapUrl = (configs['mobile.offline_basemap'] || 'false') === 'true' ? configs['app.basemap_light_url'] || configs['app.basemap_url'] || '' : '';
  const est = useMemo(() => (fix ? tilesFor(bboxAround(fix.lng, fix.lat, radius), 13, 17).length * (basemapUrl ? 2 : 1) : 0), [fix, radius, basemapUrl]);
  const save = async () => {
    if (!fix) return;
    try {
      await requestPersist().catch(() => false);
      const a = await downloadArea({
        name: `${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)} · ${fmtMeters(radius)}`,
        bbox: bboxAround(fix.lng, fix.lat, radius),
        zmin: 13,
        zmax: 17,
        basemapUrl: basemapUrl || undefined,
        maxTiles,
        onProgress: (d, t) => setProgress([d, t]),
      });
      toast.push(f('area_done', { n: a.tiles, size: fmtBytes(a.bytes) }), 'success');
    } catch (e: any) {
      if (String(e?.message || '').startsWith('too_many')) toast.push(f('area_too_many', { n: e.message.split(':')[1] }), 'warning');
      else toast.push(e.message || String(e), 'error');
    } finally {
      setProgress(null);
      refresh();
    }
  };
  return (
    <Card title={f('area')} icon="download">
      <p className="mb-2 text-[11px] text-gray-500">{f('area_hint')}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="input !w-auto text-xs" value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label={f('area_radius')}>
          {[500, 1000, 2000, 3000].map((r) => (
            <option key={r} value={r}>
              {fmtMeters(r)}
            </option>
          ))}
        </select>
        <span className={est > maxTiles ? 'text-red-600' : 'text-gray-600'}>
          {f('area_zoom', { a: 13, b: 17 })} · {f('area_tiles', { n: est })}
        </span>
        <Button size="sm" icon="download" loading={!!progress} disabled={!fix || !pwa.online || est > maxTiles} onClick={save}>
          {f('area_here')}
        </Button>
      </div>
      {progress && (
        <div className="mt-2">
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-brand-600" style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-gray-600">{f('area_progress', { done: progress[0], total: progress[1] })}</div>
        </div>
      )}
      <p className="mt-1 text-[10px] text-gray-500">{basemapUrl ? f('area_basemap_on') : f('area_basemap_off')}</p>
      {areas.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500">{f('area_none')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {areas.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-gray-900">{a.name}</span>
                <span className="block text-[10px] text-gray-500">
                  {f('area_tiles', { n: a.tiles })} · {fmtBytes(a.bytes)} · {new Date(a.created).toLocaleDateString('id-ID')}
                  {a.basemap ? ` · ${f('area_basemap_on')}` : ''}
                </span>
              </span>
              <button className="rounded p-1 text-gray-500 hover:bg-gray-100" onClick={async () => (await deleteArea(a.id), refresh())} title={f('area_delete')} aria-label={f('area_delete')}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {info && info.quota > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
          {f('storage', { used: fmtBytes(info.usage), quota: fmtBytes(info.quota) })}
          {info.persisted ? (
            <span className="text-emerald-700">✓ {f('persisted')}</span>
          ) : (
            <button className="text-brand-700 underline" onClick={async () => (await requestPersist(), refresh())}>
              {f('persist')}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function Notifications() {
  const f = useFieldT();
  const toast = useToast();
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [perm, setPerm] = useState<NotificationPermission>(supported ? Notification.permission : 'denied');
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [topics, setTopics] = useState<string[]>(['outage', 'report', 'plan']);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => {});
    api<{ subscriptions: { endpoint: string; topics: string[] }[] }>('/api/push/key')
      .then((r) => {
        navigator.serviceWorker.ready
          .then((reg) => reg.pushManager.getSubscription())
          .then((s) => {
            const mine = s && r.subscriptions.find((x) => x.endpoint === s.endpoint);
            if (mine) setTopics(mine.topics);
          });
      })
      .catch(() => {});
  }, [supported]);
  const enable = async (ts = topics) => {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const { public_key } = await api<{ public_key: string }>('/api/push/key');
      let s = await reg.pushManager.getSubscription();
      if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(public_key) as unknown as BufferSource });
      await api('/api/push/subscribe', { method: 'POST', body: { ...s.toJSON(), topics: ts } });
      setSub(s);
    } catch (e: any) {
      toast.push(e.message || String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe();
      }
      setSub(null);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const r = await api<{ sent: number }>('/api/push/test', { method: 'POST' });
      toast.push(f('notif_test_sent', { n: r.sent }), r.sent > 0 ? 'success' : 'warning');
    } catch (e: any) {
      toast.push(e.message, 'error');
    }
  };
  const iosNeedsInstall = isIOS() && !isStandalone();
  return (
    <Card title={f('notif')} icon="bell">
      <p className="mb-2 text-[11px] text-gray-500">{f('notif_hint')}</p>
      {!supported ? (
        <p className="text-xs text-amber-700">{iosNeedsInstall ? f('notif_ios') : f('notif_unsupported')}</p>
      ) : perm === 'denied' ? (
        <p className="text-xs text-red-700">{f('notif_denied')}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 text-xs text-gray-800">
            {(['outage', 'report', 'plan'] as const).map((tp) => (
              <label key={tp} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={topics.includes(tp)}
                  onChange={(e) => {
                    const ts = e.target.checked ? [...topics, tp] : topics.filter((x) => x !== tp);
                    setTopics(ts);
                    if (sub) enable(ts);
                  }}
                />
                {f(`topic_${tp}` as any)}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sub ? (
              <>
                <span className="flex items-center gap-1 text-xs text-emerald-700">
                  <Icon name="check" size={13} /> {f('notif_on')}
                </span>
                <Button size="sm" variant="secondary" icon="bell" onClick={test}>
                  {f('notif_test')}
                </Button>
                <Button size="sm" variant="ghost" loading={busy} onClick={disable}>
                  {f('notif_disable')}
                </Button>
              </>
            ) : (
              <Button size="sm" icon="bell" loading={busy} onClick={() => enable()}>
                {f('notif_enable')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Install() {
  const f = useFieldT();
  const pwa = usePwa();
  if (pwa.installed) return null;
  if (pwa.canInstall)
    return (
      <Card title={f('install')} icon="download">
        <Button icon="download" onClick={pwa.install}>
          {f('install')}
        </Button>
      </Card>
    );
  if (isIOS())
    return (
      <Card title={f('install')} icon="download">
        <p className="text-xs text-gray-600">{f('install_ios')}</p>
      </Card>
    );
  return null;
}

function RecentPhotos() {
  const f = useFieldT();
  const [items, setItems] = useState<PhotoMeta[] | null>(null);
  useEffect(() => {
    api<{ items: PhotoMeta[] }>('/api/field/photos?mine=1&limit=12')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  if (!items || items.length === 0) return null;
  return (
    <Card title={f('recent_photos')} icon="eye">
      <div className="grid grid-cols-4 gap-1.5">
        {items.map((p) => (
          <Link key={p.id} href={p.target_kind === 'report' ? '/monitoring?tab=reports' : `/monitoring?select=${p.target_kind}:${p.target_id}`} className="aspect-square overflow-hidden rounded-md bg-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl(p.id, true)} alt={p.note || ''} loading="lazy" className="h-full w-full object-cover" />
          </Link>
        ))}
      </div>
    </Card>
  );
}
