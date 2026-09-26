'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { realtime } from '@/lib/ws';
import { fmtDuration, fmtNum, fmtVA } from '@/lib/format';
import type { RealtimeEvent, SOEEvent } from '@/lib/types';
import { Button, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';

/** Warna status (baik / peringatan / serius / kritis); info memakai abu netral. */
export const SEVERITY_COLOR: Record<string, string> = {
  good: '#0ca30c',
  info: '#8a94a6',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};
const SEV_ICON: Record<string, string> = { good: 'check', info: 'info', warning: 'alert', serious: 'alert', critical: 'alert' };
const MAX_ROWS = 2000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Cap waktu SOE: tanggal + jam:menit:detik.milidetik (waktu lokal). */
function fmtTs(s: string) {
  const d = new Date(s);
  return {
    date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
  };
}

interface Props {
  active: boolean; // tab SOE sedang terlihat
  onUnread: (n: number) => void;
  onSelect: (kind: 'node' | 'edge', id: number) => void;
  typeName: (code: string) => string;
  levelLabel: (lv: string) => string;
}

export function SOEPanel({ active, onUnread, onSelect, typeName, levelLabel }: Props) {
  const { t } = useT();
  const toast = useToast();
  const [items, setItems] = useState<SOEEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [buffer, setBuffer] = useState<SOEEvent[]>([]);
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(true);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [sound, setSound] = useState(false);
  const unread = useRef(0);
  const lastId = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const activeRef = useRef(active);
  activeRef.current = active;
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    const tm = setTimeout(() => setQd(q.trim()), 300);
    return () => clearTimeout(tm);
  }, [q]);

  const query = useCallback(
    (extra: Record<string, string | number>) => {
      const p = new URLSearchParams();
      if (category) p.set('category', category);
      if (severity) p.set('severity', severity);
      if (kind) p.set('kind', kind);
      if (qd) p.set('q', qd);
      for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
      return `/api/power/soe?${p.toString()}`;
    },
    [category, severity, kind, qd],
  );

  const matches = useCallback(
    (e: SOEEvent) => {
      const rank: Record<string, number> = { good: 0, info: 1, warning: 2, serious: 3, critical: 4 };
      if (category && e.category !== category) return false;
      if (severity && (rank[e.severity] ?? 0) < (rank[severity] ?? 0)) return false;
      if (kind && e.kind !== kind) return false;
      if (qd) {
        const s = qd.toLowerCase();
        if (![e.target_code, e.feeder_code, e.username, e.note].some((x) => (x || '').toLowerCase().includes(s))) return false;
      }
      return true;
    },
    [category, severity, kind, qd],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: SOEEvent[] }>(query({ limit: 300 }));
      setItems(r.items);
      setBuffer([]);
      setMore(r.items.length >= 300);
      lastId.current = Math.max(lastId.current, r.items[0]?.id || 0);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [query, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    const oldest = items[items.length - 1];
    if (!oldest) return;
    setLoading(true);
    try {
      const r = await api<{ items: SOEEvent[] }>(query({ limit: 300, before_id: oldest.id }));
      setItems((cur) => [...cur, ...r.items]);
      setMore(r.items.length >= 300);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const beep = (sev: string) => {
    if (!soundRef.current || (sev !== 'critical' && sev !== 'serious')) return;
    try {
      const ctx = audio.current || (audio.current = new AudioContext());
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = sev === 'critical' ? 880 : 660;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.35);
    } catch {
      /* audio tidak tersedia */
    }
  };

  const ingest = useCallback(
    (list: SOEEvent[]) => {
      const fresh = list.filter((e) => e.id > 0 && matches(e));
      for (const e of list) lastId.current = Math.max(lastId.current, e.id);
      if (fresh.length === 0) return;
      fresh.forEach((e) => beep(e.severity));
      if (!activeRef.current) {
        unread.current += fresh.length;
        onUnread(unread.current);
      }
      const sorted = [...fresh].sort((a, b) => b.id - a.id);
      if (pausedRef.current) {
        setBuffer((b) => [...sorted, ...b]);
        return;
      }
      setItems((cur) => {
        const seen = new Set(cur.map((x) => x.id));
        return [...sorted.filter((x) => !seen.has(x.id)), ...cur].slice(0, MAX_ROWS);
      });
      const ids = sorted.map((x) => x.id);
      setFresh((f) => new Set([...Array.from(f), ...ids]));
      setTimeout(() => setFresh((f) => new Set(Array.from(f).filter((x) => !ids.includes(x)))), 4000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matches, onUnread],
  );

  // realtime + sinkron ulang (after_id) saat koneksi pulih
  useEffect(() => {
    const off = realtime.subscribe((ev: RealtimeEvent) => {
      if (ev.type === 'soe' && ev.data) ingest([ev.data as SOEEvent]);
    });
    let wasOk = true;
    const offStatus = realtime.onStatus((ok) => {
      if (ok && !wasOk && lastId.current > 0) {
        api<{ items: SOEEvent[] }>(`/api/power/soe?after_id=${lastId.current}&limit=500`)
          .then((r) => ingest(r.items))
          .catch(() => {});
      }
      wasOk = ok;
    });
    return () => {
      off();
      offStatus();
    };
  }, [ingest]);

  useEffect(() => {
    if (active) {
      unread.current = 0;
      onUnread(0);
    }
  }, [active, onUnread]);

  const resume = () => {
    setItems((cur) => {
      const seen = new Set(cur.map((x) => x.id));
      return [...buffer.filter((x) => !seen.has(x.id)), ...cur].slice(0, MAX_ROWS);
    });
    setBuffer([]);
    setPaused(false);
  };

  const eventLabel = (e: SOEEvent) => {
    switch (e.event) {
      case 'OPEN':
        return e.category === 'switch' ? (e.way_edge_id ? t('soe.ev_open_way') : t('soe.ev_open')) : t('soe.ev_cut');
      case 'CLOSE':
        return e.category === 'switch' ? (e.way_edge_id ? t('soe.ev_close_way') : t('soe.ev_close')) : t('soe.ev_restore');
      case 'OUTAGE_START':
        return t('soe.ev_outage_start');
      case 'OUTAGE_END':
        return t('soe.ev_outage_end');
      case 'DEENERGIZED':
        return t('soe.ev_deenergized');
      case 'ENERGIZED':
        return t('soe.ev_energized');
    }
    return e.event;
  };
  const sevLabel = (s: string) => t(`soe.sev_${s}` as any);

  const exportCsv = () => {
    const head = ['id', 'waktu', 'kategori', 'event', 'keparahan', 'objek', 'tipe', 'id_objek', 'jenis', 'level', 'penyulang', 'pelanggan', 'beban_va', 'node', 'durasi_detik', 'pengguna', 'catatan'];
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = items.map((e) => {
      const ts = fmtTs(e.ts);
      return [e.id, `${ts.date} ${ts.time}`, e.category, e.event, e.severity, e.target_code, e.target_type, e.target_id ?? '', e.kind, e.level, e.feeder_code, e.customers, Math.round(e.load_va), e.nodes, e.duration_sec ?? '', e.username, e.note]
        .map(esc)
        .join(',');
    });
    const blob = new Blob(['﻿' + [head.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const now = fmtTs(new Date().toISOString());
    a.download = `soe_${now.date.split('/').reverse().join('')}_${now.time.slice(0, 8).replace(/:/g, '')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const counts = useMemo(() => {
    const c = { critical: 0, serious: 0, warning: 0 };
    for (const e of items) if (e.severity in c) c[e.severity as keyof typeof c]++;
    return c;
  }, [items]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className={`flex items-center gap-1 text-xs font-medium ${paused ? 'text-amber-700' : 'text-emerald-700'}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${paused ? 'bg-amber-500' : 'animate-pulse bg-emerald-500'}`} />
          {paused ? t('soe.paused') : t('soe.live')}
        </span>
        <span className="ml-auto" />
        <button
          className={`rounded p-1 hover:bg-gray-100 ${sound ? 'text-brand-700' : 'text-gray-400'}`}
          onClick={() => setSound(!sound)}
          title={sound ? t('soe.sound_on') : t('soe.sound_off')}
          aria-label={t('soe.sound_toggle')}
          aria-pressed={sound}
        >
          <Icon name="bell" size={15} />
        </button>
        <Button size="sm" variant="secondary" icon={paused ? 'play' : 'pause'} onClick={() => (paused ? resume() : setPaused(true))}>
          {paused ? t('soe.resume') : t('soe.pause')}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={exportCsv} disabled={items.length === 0}>
          CSV
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <select className="input text-xs" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('soe.category')}>
          <option value="">{t('soe.cat_all')}</option>
          <option value="switch">{t('soe.cat_switch')}</option>
          <option value="cut">{t('soe.cat_cut')}</option>
          <option value="outage">{t('soe.cat_outage')}</option>
          <option value="topology">{t('soe.cat_topology')}</option>
        </select>
        <select className="input text-xs" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label={t('soe.severity')}>
          <option value="">{t('soe.sev_all')}</option>
          <option value="warning">≥ {t('soe.sev_warning')}</option>
          <option value="serious">≥ {t('soe.sev_serious')}</option>
          <option value="critical">{t('soe.sev_critical')}</option>
        </select>
        <select className="input text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('feature.maneuver_kind')}>
          <option value="">{t('soe.kind_all')}</option>
          <option value="GANGGUAN">GANGGUAN</option>
          <option value="PEMELIHARAAN">PEMELIHARAAN</option>
          <option value="MLS">MLS</option>
          <option value="MANUVER">MANUVER</option>
          <option value="BENCANA ALAM">BENCANA ALAM</option>
        </select>
      </div>
      <input className="input text-xs" placeholder={t('soe.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-gray-600">
        <span>{t('soe.shown', { n: fmtNum(items.length) })}</span>
        {(['critical', 'serious', 'warning'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEVERITY_COLOR[s] }} />
            {sevLabel(s)} {counts[s]}
          </span>
        ))}
      </div>
      {paused && buffer.length > 0 && (
        <button className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100" onClick={resume}>
          {t('soe.buffered', { n: buffer.length })}
        </button>
      )}

      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto font-[inherit]" aria-live={paused ? 'off' : 'polite'}>
        {items.length === 0 && !loading && <li className="py-4 text-center text-xs text-gray-500">{t('soe.empty')}</li>}
        {items.map((e) => {
          const ts = fmtTs(e.ts);
          const color = SEVERITY_COLOR[e.severity] || SEVERITY_COLOR.info;
          return (
            <li
              key={e.id}
              className={`rounded border border-gray-200 bg-white px-2 py-1 text-xs transition-colors ${fresh.has(e.id) ? 'soe-fresh' : ''}`}
              style={{ borderLeft: `3px solid ${color}` }}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] tabular-nums text-gray-900" title={ts.date}>
                  {ts.time}
                </span>
                <span className="font-mono text-[10px] text-gray-400">{ts.date}</span>
                <span className="ml-auto flex items-center gap-0.5 text-[10px] font-semibold uppercase" style={{ color }}>
                  <Icon name={SEV_ICON[e.severity] || 'info'} size={11} />
                  <span className="text-gray-700">{sevLabel(e.severity)}</span>
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5">
                <span className="font-semibold text-gray-900">{eventLabel(e)}</span>
                {e.target_id ? (
                  <button className="font-medium text-brand-700 hover:underline" onClick={() => onSelect(e.target_kind === 'edge' ? 'edge' : 'node', e.target_id!)}>
                    {e.target_code || `#${e.target_id}`}
                  </button>
                ) : (
                  <span className="text-gray-600">{t('soe.network')}</span>
                )}
                {e.target_type && <span className="text-gray-500">{typeName(e.target_type)}</span>}
                {e.kind && <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-700">{e.kind}</span>}
                {e.level && <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-700">{levelLabel(e.level)}</span>}
              </div>
              <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-600">
                {e.feeder_code && <span>{t('power.feeders')} {e.feeder_code}</span>}
                {(e.customers > 0 || e.nodes > 0) && (
                  <span>
                    {fmtNum(e.customers)} {t('soe.cust')} · {fmtVA(e.load_va)}
                  </span>
                )}
                {e.duration_sec != null && (
                  <span>
                    {t('power.duration')} {fmtDuration(Math.round(e.duration_sec))}
                  </span>
                )}
                {e.outage_id && <span>{t('soe.outage_no', { id: e.outage_id })}</span>}
                {e.username && <span>· {e.username}</span>}
              </div>
              {e.note && <div className="truncate text-[11px] italic text-gray-500" title={e.note}>“{e.note}”</div>}
            </li>
          );
        })}
        {more && items.length > 0 && (
          <li className="py-1 text-center">
            <Button size="sm" variant="secondary" loading={loading} onClick={loadMore}>
              {t('soe.load_more')}
            </Button>
          </li>
        )}
      </ol>
    </div>
  );
}
