'use client';

import React, { useRef, useState } from 'react';

export type Snap = 'peek' | 'half' | 'full';
const HEIGHT: Record<Snap, string> = { peek: '9.5rem', half: '52%', full: '92%' };
const ORDER: Snap[] = ['peek', 'half', 'full'];

/**
 * Lembar bawah (ponsel) di atas peta: tiga posisi (intip / setengah / penuh), ditarik lewat
 * pegangan atau diketuk untuk berganti posisi. Isi di bawah header dapat digulir.
 */
export function BottomSheet({
  snap,
  onSnap,
  header,
  children,
}: {
  snap: Snap;
  onSnap: (s: Snap) => void;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);

  const parentH = () => ref.current?.parentElement?.clientHeight || window.innerHeight;
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, h: ref.current?.clientHeight || 0, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setDragH(Math.max(80, Math.min(parentH() * 0.95, d.h + dy)));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // ketuk: naik satu tingkat, dari penuh kembali ke intip
      onSnap(ORDER[(ORDER.indexOf(snap) + 1) % ORDER.length]);
      setDragH(null);
      return;
    }
    const h = dragH ?? d.h;
    const ph = parentH();
    const r = h / ph;
    onSnap(r > 0.72 ? 'full' : r > 0.3 ? 'half' : 'peek');
    setDragH(null);
  };

  return (
    <div
      ref={ref}
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl border-t border-gray-200 bg-white shadow-[0_-8px_24px_rgba(0,0,0,0.18)] ${dragH === null ? 'transition-[height] duration-200' : ''}`}
      style={{ height: dragH !== null ? `${dragH}px` : HEIGHT[snap] }}
    >
      <div className="shrink-0 cursor-grab touch-none select-none pb-1 pt-2" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="button" aria-label="sheet">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-gray-300" />
      </div>
      {header && <div className="shrink-0">{header}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}
