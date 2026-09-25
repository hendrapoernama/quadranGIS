'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, api, getToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { AppConfig } from '@/lib/types';
import { Button, Spinner, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';

interface ProviderInfo {
  id: string;
  name: string;
  model: string;
  default_model: string;
  configured: boolean;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  meta?: string;
}

const HISTORY_KEY = 'qgis_ai_history';
const PREF_KEY = 'qgis_ai_pref';

function load<T>(key: string, def: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}
function save(key: string, v: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* penyimpanan browser tidak tersedia */
  }
}

/** Render ringan: blok kode ``` dan teks biasa (baris dipertahankan, **tebal** & `kode`). */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf('\n');
          const code = nl >= 0 ? part.slice(nl + 1) : part;
          return (
            <pre key={i} className="my-2 overflow-x-auto rounded-md bg-gray-100 p-2 font-mono text-xs text-gray-800">
              {code.replace(/\n$/, '')}
            </pre>
          );
        }
        const inline = part.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        return (
          <span key={i} className="whitespace-pre-wrap">
            {inline.map((s, j) =>
              s.startsWith('**') && s.endsWith('**') ? (
                <strong key={j}>{s.slice(2, -2)}</strong>
              ) : s.startsWith('`') && s.endsWith('`') ? (
                <code key={j} className="rounded bg-gray-100 px-1 font-mono text-[0.85em]">
                  {s.slice(1, -1)}
                </code>
              ) : (
                <React.Fragment key={j}>{s}</React.Fragment>
              ),
            )}
          </span>
        );
      })}
    </>
  );
}

export default function AiAssistant() {
  const { t, locale } = useT();
  const { has } = useAuth();
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [withContext, setWithContext] = useState(true);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const canConfig = has('admin.config');

  const loadProviders = useCallback(async () => {
    try {
      const r = await api<{ items: ProviderInfo[]; default: string }>('/api/ai/providers');
      setProviders(r.items);
      const pref = load<{ provider?: string; withContext?: boolean }>(PREF_KEY, {});
      const pick = r.items.find((p) => p.id === pref.provider && p.configured) || r.items.find((p) => p.id === r.default && p.configured) || r.items.find((p) => p.configured) || r.items[0];
      if (pick) {
        setProvider(pick.id);
        setModel(pick.model);
      }
      if (pref.withContext !== undefined) setWithContext(pref.withContext);
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    setMessages(load<ChatMsg[]>(HISTORY_KEY, []));
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (!busy) save(HISTORY_KEY, messages.slice(-60));
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const current = providers.find((p) => p.id === provider);

  function changeProvider(id: string) {
    setProvider(id);
    const p = providers.find((x) => x.id === id);
    if (p) setModel(p.model);
    save(PREF_KEY, { provider: id, withContext });
  }

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    if (!current?.configured) {
      toast.push(t('ai.not_configured', { name: current?.name || provider }), 'warning');
      return;
    }
    const history: ChatMsg[] = [...messages.filter((m) => !m.error), { role: 'user', content: q }];
    setMessages([...messages, { role: 'user', content: q }, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patchLast = (fn: (m: ChatMsg) => ChatMsg) =>
      setMessages((ms) => {
        const copy = ms.slice();
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lang': locale, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
        body: JSON.stringify({ provider, model, include_context: withContext, messages: history.map(({ role, content }) => ({ role, content })) }),
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
          if (ev.delta) patchLast((m) => ({ ...m, content: m.content + ev.delta }));
          else if (ev.error) patchLast((m) => ({ ...m, content: (m.content ? m.content + '\n\n' : '') + ev.error, error: true }));
          else if (ev.done) {
            const u = ev.usage || {};
            const meta = [current?.name, model, u.output_tokens ? `${u.input_tokens}→${u.output_tokens} token` : '', `${(ev.duration_ms / 1000).toFixed(1)} s`].filter(Boolean).join(' · ');
            patchLast((m) => ({ ...m, meta }));
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') patchLast((m) => ({ ...m, meta: t('ai.stopped') }));
      else patchLast((m) => ({ ...m, content: e.message || String(e), error: true }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const suggestions = [t('ai.suggest_summary'), t('ai.suggest_outages'), t('ai.suggest_feeders'), t('ai.suggest_explain')];

  if (!loaded)
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Spinner size={28} />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-2">
        <div className="mr-2 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Icon name="sparkles" size={18} /> {t('ai.title')}
        </div>
        <select className="input w-52" value={provider} onChange={(e) => changeProvider(e.target.value)} aria-label={t('ai.provider')}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.configured ? '' : ` (${t('ai.not_set')})`}
            </option>
          ))}
        </select>
        <input className="input w-56 font-mono text-xs" value={model} onChange={(e) => setModel(e.target.value)} placeholder={current?.default_model} aria-label={t('ai.model')} title={t('ai.model')} />
        <label className="flex items-center gap-1.5 text-xs text-gray-700" title={t('ai.context_hint')}>
          <input
            type="checkbox"
            checked={withContext}
            onChange={(e) => {
              setWithContext(e.target.checked);
              save(PREF_KEY, { provider, withContext: e.target.checked });
            }}
          />
          {t('ai.include_context')}
        </label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" icon="refresh" onClick={() => setMessages([])} disabled={busy || messages.length === 0}>
            {t('ai.new_chat')}
          </Button>
          {canConfig && (
            <Button size="sm" variant="secondary" icon="settings" onClick={() => setSettingsOpen(true)}>
              {t('ai.settings')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {!current?.configured && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {t('ai.not_configured', { name: current?.name || provider })}
              {canConfig ? ` ${t('ai.config_hint_admin')}` : ` ${t('ai.config_hint_user')}`}
            </div>
          )}
          {messages.length === 0 && (
            <div className="pt-8 text-center">
              <div className="mb-1 text-lg font-semibold text-gray-900">{t('ai.welcome')}</div>
              <div className="mb-4 text-sm text-gray-500">{t('ai.welcome_sub')}</div>
              <div className="mx-auto grid max-w-2xl gap-2 sm:grid-cols-2">
                {suggestions.map((s) => (
                  <button key={s} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50" onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  m.role === 'user' ? 'bg-brand-600 text-white' : m.error ? 'border border-red-200 bg-red-50 text-red-800' : 'border border-gray-200 bg-white text-gray-800'
                }`}
              >
                {m.role === 'assistant' && !m.content && busy && i === messages.length - 1 ? (
                  <span className="flex items-center gap-2 text-gray-500">
                    <Spinner size={14} /> {t('ai.thinking')}
                  </span>
                ) : m.role === 'user' ? (
                  <span className="whitespace-pre-wrap">{m.content}</span>
                ) : (
                  <RichText text={m.content} />
                )}
                {m.meta && <div className="mt-1 text-[10px] text-gray-400">{m.meta}</div>}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-gray-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            className="input min-h-[2.5rem] flex-1 resize-none"
            rows={Math.min(6, Math.max(1, input.split('\n').length))}
            placeholder={t('ai.placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          {busy ? (
            <Button variant="secondary" icon="stop" onClick={() => abortRef.current?.abort()}>
              {t('ai.stop')}
            </Button>
          ) : (
            <Button icon="send" onClick={() => send(input)} disabled={!input.trim()}>
              {t('ai.send')}
            </Button>
          )}
        </div>
        <div className="mx-auto mt-1 max-w-3xl text-[11px] text-gray-400">{t('ai.disclaimer')}</div>
      </div>

      {settingsOpen && <AiSettings providers={providers} onClose={() => setSettingsOpen(false)} onSaved={loadProviders} />}
    </div>
  );
}

/** Pengaturan penyedia (admin): API key, model, URL; kunci tidak pernah ditampilkan kembali. */
function AiSettings({ providers, onClose, onSaved }: { providers: ProviderInfo[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [cfg, setCfg] = useState<AppConfig[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ items: AppConfig[] }>('/api/admin/configs')
      .then((r) => setCfg(r.items.filter((c) => c.key.startsWith('ai.'))))
      .catch((e) => toast.push(e.message, 'error'));
  }, [toast]);

  const get = (k: string) => cfg.find((c) => c.key === k);
  const val = (k: string) => draft[k] ?? get(k)?.value ?? '';
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });

  async function saveAll() {
    const items = Object.entries(draft)
      .filter(([k, v]) => (get(k)?.value_type === 'secret' ? v !== '' : v !== (get(k)?.value ?? '')))
      .map(([key, value]) => ({ key, value, value_type: get(key)?.value_type || 'string', group: 'ai' }));
    if (items.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await api('/api/admin/configs', { method: 'PUT', body: { items } });
      toast.push(t('ai.settings_saved'), 'success');
      onSaved();
      onClose();
    } catch (e: any) {
      toast.push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-base font-semibold text-gray-900">{t('ai.settings_title')}</div>
          <button className="text-gray-500 hover:text-gray-800" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="label">{t('ai.default_provider')}</label>
            <select className="input" value={val('ai.default_provider')} onChange={(e) => set('ai.default_provider', e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t('ai.max_tokens')}</label>
            <input className="input" type="number" min={256} step={256} value={val('ai.max_tokens')} onChange={(e) => set('ai.max_tokens', e.target.value)} />
          </div>
        </div>
        <div className="space-y-3">
          {providers.map((p) => {
            const keyCfg = get(`ai.${p.id}.api_key`);
            return (
              <div key={p.id} className="rounded-md border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">{p.name}</span>
                  {keyCfg?.has_value ? <span className="text-xs text-emerald-700">{t('ai.key_set')}</span> : <span className="text-xs text-gray-500">{t('ai.not_set')}</span>}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="label">API key</label>
                    <div className="flex gap-1">
                      <input
                        className="input flex-1"
                        type="password"
                        autoComplete="new-password"
                        placeholder={keyCfg?.has_value ? t('config.secret_saved') : t('config.secret_empty')}
                        value={draft[`ai.${p.id}.api_key`] ?? ''}
                        onChange={(e) => set(`ai.${p.id}.api_key`, e.target.value)}
                      />
                      {keyCfg?.has_value && (
                        <Button size="sm" variant="secondary" onClick={() => set(`ai.${p.id}.api_key`, ' ')} title={t('ai.clear_key')}>
                          {t('ai.clear_key')}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="label">{t('ai.model')}</label>
                    <input className="input font-mono text-xs" value={val(`ai.${p.id}.model`)} placeholder={p.default_model} onChange={(e) => set(`ai.${p.id}.model`, e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Base URL</label>
                    <input className="input font-mono text-xs" value={val(`ai.${p.id}.base_url`)} onChange={(e) => set(`ai.${p.id}.base_url`, e.target.value)} />
                  </div>
                </div>
              </div>
            );
          })}
          <div>
            <label className="label">{t('ai.system_prompt')}</label>
            <textarea className="input h-20 w-full" value={val('ai.system_prompt')} onChange={(e) => set('ai.system_prompt', e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon="check" loading={saving} onClick={saveAll}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
