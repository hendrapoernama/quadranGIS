'use client';

import { useMemo, useState } from 'react';
import { useTheme } from '@/lib/theme';
import { downloadArea, fmtBytes, requestPersist, tilesFor } from '@/lib/offlineArea';
import type { MapHandle } from '@/components/map/types';
import { Button, Modal, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useFieldT } from './i18n';

/** Tombol peta "Simpan area offline": unduh tile jaringan untuk tampilan peta saat ini. */
export function OfflineAreaButton({ mapRef, configs, className = '' }: { mapRef: React.RefObject<MapHandle | null>; configs: Record<string, string>; className?: string }) {
  const f = useFieldT();
  const toast = useToast();
  const { resolved } = useTheme();
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState(2);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [ctrl, setCtrl] = useState<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<{ bbox: [number, number, number, number]; z: number } | null>(null);

  const basemapUrl = (configs['mobile.offline_basemap'] || 'false') === 'true'
    ? (resolved === 'dark' ? configs['app.basemap_dark_url'] : '') || configs['app.basemap_light_url'] || configs['app.basemap_url'] || ''
    : '';
  const maxTiles = Number(configs['mobile.offline_max_tiles'] || 1500);
  const count = useMemo(() => {
    if (!snapshot) return 0;
    const zmin = Math.max(10, snapshot.z);
    return tilesFor(snapshot.bbox, zmin, Math.min(18, zmin + extra)).length * (basemapUrl ? 2 : 1);
  }, [snapshot, extra, basemapUrl]);

  const start = async () => {
    if (!snapshot) return;
    const ac = new AbortController();
    setCtrl(ac);
    const zmin = Math.max(10, snapshot.z);
    try {
      await requestPersist().catch(() => false);
      const a = await downloadArea({
        name: `${new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })} · z${zmin}–${Math.min(18, zmin + extra)}`,
        bbox: snapshot.bbox,
        zmin,
        zmax: Math.min(18, zmin + extra),
        basemapUrl: basemapUrl || undefined,
        maxTiles,
        signal: ac.signal,
        onProgress: (d, t) => setProgress([d, t]),
      });
      toast.push(f('area_done', { n: a.tiles, size: fmtBytes(a.bytes) }), 'success');
      setOpen(false);
    } catch (e: any) {
      if (String(e?.message || '').startsWith('too_many')) toast.push(f('area_too_many', { n: e.message.split(':')[1] }), 'warning');
      else if (e?.name !== 'AbortError') toast.push(e.message || String(e), 'error');
    } finally {
      setProgress(null);
      setCtrl(null);
    }
  };

  return (
    <>
      <button
        className={`flex h-7 w-7 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 ${className}`}
        title={f('save_area')}
        aria-label={f('save_area')}
        onClick={() => {
          const b = mapRef.current?.getBounds();
          if (!b) return;
          setSnapshot({ bbox: b, z: Math.floor(mapRef.current?.getZoom() || 14) });
          setOpen(true);
        }}
      >
        <Icon name="download" size={16} />
      </button>
      <Modal open={open} title={f('save_area')} onClose={() => (ctrl?.abort(), setOpen(false))}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">{f('area_hint')}</p>
          {snapshot && (
            <>
              <label className="flex items-center gap-2">
                <span className="text-gray-700">{f('area_zoom', { a: Math.max(10, snapshot.z), b: Math.min(18, Math.max(10, snapshot.z) + extra) })}</span>
                <input type="range" min={0} max={4} value={extra} onChange={(e) => setExtra(Number(e.target.value))} className="flex-1" />
              </label>
              <div className={count > maxTiles ? 'font-semibold text-red-600' : 'text-gray-700'}>
                {f('area_tiles', { n: count })} {count > maxTiles && `· ${f('area_too_many', { n: count })}`}
              </div>
            </>
          )}
          <p className="text-[11px] text-gray-500">{basemapUrl ? f('area_basemap_on') : f('area_basemap_off')}</p>
          {progress && (
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-brand-600" style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
              </div>
              <div className="mt-1 text-xs text-gray-600">{f('area_progress', { done: progress[0], total: progress[1] })}</div>
            </div>
          )}
          <Button icon="download" loading={!!progress} disabled={!snapshot || count > maxTiles || count === 0} onClick={start}>
            {f('save_area')}
          </Button>
        </div>
      </Modal>
    </>
  );
}
