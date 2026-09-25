'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { SearchHit } from '@/lib/types';
import { Icon } from '@/components/Icon';

export function SearchBox({ onPick, typeName }: { onPick: (hit: SearchHit) => void; typeName: (code: string) => string }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setItems([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await api<{ items: SearchHit[] }>(`/api/gis/search?q=${encodeURIComponent(q.trim())}&limit=15`);
        setItems(r.items);
        setOpen(true);
      } catch {
        setItems([]);
      }
    }, 250);
  }, [q]);

  return (
    <div className="relative w-80">
      <div className="flex items-center rounded-lg border border-gray-200 bg-white shadow-lg">
        <span className="pl-2 text-gray-400">
          <Icon name="search" size={16} />
        </span>
        <input
          className="w-full bg-transparent px-2 py-2 text-sm text-gray-900 focus:outline-none"
          placeholder={t('map.search_placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => items.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {q && (
          <button className="pr-2 text-gray-400 hover:text-gray-600" onClick={() => setQ('')} aria-label={t('common.clear')}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {open && items.length > 0 && (
        <div className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {items.map((h) => (
            <button
              key={`${h.kind}-${h.id}`}
              className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-gray-100"
              onMouseDown={() => {
                onPick(h);
                setOpen(false);
              }}
            >
              <span className="text-sm font-medium text-gray-900">
                {h.code || `#${h.id}`} <span className="font-normal text-gray-500">{h.name}</span>
              </span>
              <span className="text-[11px] text-gray-500">
                {typeName(h.type_code)} · {h.kind === 'node' ? t('map.node').toLowerCase() : t('map.edge').toLowerCase()} #{h.id}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
