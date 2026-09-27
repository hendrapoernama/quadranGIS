'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, api, getToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useExecT } from '@/components/exec/i18n';

export type AiOpsTask = 'outage' | 'plan' | 'shift' | 'report' | 'insights';

export interface AiOpsParams {
  outage_id?: number;
  plan_id?: number;
  report_id?: number;
  hours?: number;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  meta?: string;
}

/** Markdown ringan: judul (#), poin (- / 1.), **tebal**, `kode`. */
export function RichText({ text }: { text: string }) {
  const inline = (s: string, key: number) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
        <strong key={`${key}-${j}`} className="font-semibold text-gray-900">
          {p.slice(2, -2)}
        </strong>
      ) : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
        <code key={`${key}-${j}`} className="rounded bg-gray-100 px-1 font-mono text-[0.85em]">
          {p.slice(1, -1)}
        </code>
      ) : (
        <React.Fragment key={`${key}-${j}`}>{p}</React.Fragment>
      ),
    );
  const lines = text.split('\n');
  return (
    <div className="space-y-1 text-[13px] leading-relaxed text-gray-800">
      {lines.map((ln, i) => {
        const t = ln.trimEnd();
        if (!t.trim()) return <div key={i} className="h-1" />;
        const hm = /^(#{1,4})\s+(.*)$/.exec(t);
        if (hm) return <div key={i} className="pt-1 text-sm font-semibold text-gray-900">{inline(hm[2].replace(/\*\*/g, ''), i)}</div>;
        const bm = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(t);
        if (bm) {
          const indent = Math.min(3, Math.floor(bm[1].length / 2));
          const num = /\d/.test(bm[2]);
          return (
            <div key={i} className="flex gap-1.5" style={{ paddingLeft: indent * 14 }}>
              <span className={`shrink-0 ${num ? 'tabular-nums text-gray-600' : 'text-gray-500'}`}>{num ? bm[2] : '•'}</span>
              <span>{inline(bm[3], i)}</span>
            </div>
          );
        }
        return <p key={i}>{inline(t, i)}</p>;
      })}
    </div>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  model: string;
  configured: boolean;
}

let providersCache: Promise<{ items: ProviderInfo[]; default: string }> | null = null;

interface Props {
  task: AiOpsTask;
  params?: AiOpsParams;
  /** mulai otomatis saat komponen tampil */
  autoStart?: boolean;
  /** tombol tambahan untuk jawaban AI pertama (mis. simpan sebagai ringkasan laporan) */
  onUse?: (text: string) => void;
  useLabel?: string;
  compact?: boolean;
}

/**
 * Panel analisis AI operasi: konteks disusun server (/api/ai/ops) dari data aplikasi, jawaban
 * dialirkan (SSE), lalu pengguna dapat bertanya lanjutan.
 */
export function AiOpsPanel({ task, params = {}, autoStart = false, onUse, useLabel, compact = false }: Props) {
  const e = useExecT();
  const { locale } = useT();
  const { has } = useAuth();
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [prov, setProv] = useState<ProviderInfo | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const allowed = has('ai.use');

  useEffect(() => {
    if (!allowed) return;
    if (!providersCache) providersCache = api<{ items: ProviderInfo[]; default: string }>('/api/ai/providers');
    providersCache
      .then((r) => setProv(r.items.find((p) => p.id === r.default) || r.items.find((p) => p.configured) || null))
      .catch(() => {
        providersCache = null;
        setProv(null);
      });
  }, [allowed]);

  const run = useCallback(
    async (history: Turn[]) => {
      if (!prov?.configured) return;
      setBusy(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const base = history.filter((t) => !t.error);
      setTurns([...history, { role: 'assistant', content: '' }]);
      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((ts) => {
          const c = ts.slice();
          c[c.length - 1] = fn(c[c.length - 1]);
          return c;
        });
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/ai/ops`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lang': locale, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          credentials: 'include',
          body: JSON.stringify({ task, ...params, provider: prov.id, messages: base.map(({ role, content }) => ({ role, content })) }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          let msg = res.statusText;
          try {
            msg = (await res.json()).error || msg;
          } catch {
            /* bukan JSON */
          }
          throw new Error(msg);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('\n');
            if (!data) continue;
            let ev: any;
            try {
              ev = JSON.parse(data);
            } catch {
              continue;
            }
            if (ev.delta) patch((t) => ({ ...t, content: t.content + ev.delta }));
            else if (ev.error) patch((t) => ({ ...t, content: (t.content ? t.content + '\n\n' : '') + ev.error, error: true }));
            else if (ev.done) {
              const u = ev.usage || {};
              const meta = [prov.name, u.output_tokens ? `${u.input_tokens}→${u.output_tokens} token` : '', `${(ev.duration_ms / 1000).toFixed(1)} s`].filter(Boolean).join(' · ');
              patch((t) => ({ ...t, meta }));
            }
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') patch((t) => ({ ...t, meta: e('ai_stopped') }));
        else patch((t) => ({ ...t, content: err.message || String(err), error: true }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [prov, task, params, locale, e],
  );

  // mulai otomatis sekali per target
  const key = `${task}:${JSON.stringify(params)}`;
  const started = useRef<string>('');
  useEffect(() => {
    if (autoStart && prov?.configured && started.current !== key) {
      started.current = key;
      run([]);
    }
  }, [autoStart, prov, key, run]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length]);

  if (!allowed) return <div className="rounded-md bg-gray-50 p-2 text-xs text-gray-600">{e('ai_no_perm')}</div>;
  if (prov === undefined)
    return (
      <div className="py-2 text-center">
        <Spinner size={16} />
      </div>
    );
  if (!prov?.configured)
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
        <Icon name="alert" size={14} />
        <span>{e('ai_not_configured')}</span>
      </div>
    );

  const first = turns.find((t) => t.role === 'assistant' && !t.error && t.content);
  const copy = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      toast.push(e('ai_copied'), 'success');
    } catch {
      /* clipboard tidak tersedia */
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <Button size="sm" variant="secondary" icon="stop" onClick={() => abortRef.current?.abort()}>
            {e('ai_stop')}
          </Button>
        ) : (
          <Button size="sm" icon="sparkles" onClick={() => run([])}>
            {turns.length ? e('ai_rerun') : e('ai_run')}
          </Button>
        )}
        {first && !busy && onUse && (
          <Button size="sm" variant="secondary" icon="check" onClick={() => onUse(first.content)}>
            {useLabel || e('rep_use_ai')}
          </Button>
        )}
        <span className="ml-auto text-[11px] text-gray-500">
          {prov.name} · {prov.model}
        </span>
      </div>
      {turns.length > 0 && (
        <div className={`space-y-2 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 ${compact ? 'max-h-[420px]' : 'max-h-[60vh]'}`}>
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="ml-8 rounded-md bg-brand-50 px-2 py-1 text-xs text-gray-800">
                {t.content}
              </div>
            ) : (
              <div key={i} className={`rounded-md px-1 ${t.error ? 'text-red-700' : ''}`}>
                {t.content ? t.error ? <p className="text-xs">{t.content}</p> : <RichText text={t.content} /> : <Spinner size={14} />}
                {(t.meta || (t.content && !busy)) && (
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
                    {t.meta && <span>{t.meta}</span>}
                    {t.content && !t.error && (
                      <button className="ml-auto flex items-center gap-1 hover:text-gray-800" onClick={() => copy(t.content)}>
                        <Icon name="link" size={11} />
                        {e('ai_copy')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      )}
      {turns.length > 0 && !busy && (
        <form
          className="flex gap-1"
          onSubmit={(ev) => {
            ev.preventDefault();
            const q = input.trim();
            if (!q) return;
            setInput('');
            run([...turns.filter((t) => !t.error), { role: 'user', content: q }]);
          }}
        >
          <input className="input flex-1 text-xs" value={input} onChange={(ev) => setInput(ev.target.value)} placeholder={e('ai_follow')} />
          <Button size="sm" variant="secondary" icon="send" type="submit">
            {e('ai_send')}
          </Button>
        </form>
      )}
      <p className="text-[10px] text-gray-500">{e('ai_disclaimer')}</p>
    </div>
  );
}
