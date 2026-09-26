'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { Icon } from '@/components/Icon';
import { SECTIONS, type GuideItem } from './content';
import { DIAGRAM_CSS } from './diagrams';

/** Menu Dokumentasi: daftar isi di kiri, isi di kanan, scrollspy, perbesar gambar, cetak. */
export default function Docs() {
  const { locale } = useT();
  const [active, setActive] = useState('overview');
  const [zoom, setZoom] = useState<GuideItem | null>(null);
  const [q, setQ] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  // daftar isi: bagian + subbagian panduan
  const toc = useMemo(
    () =>
      SECTIONS.map((s) => ({
        id: s.id,
        title: s.title,
        icon: s.icon,
        children: s.guide ? s.guide.flatMap((g) => [{ id: `grp-${slug(g.group)}`, title: g.group, group: true }, ...g.items.map((i) => ({ id: i.id, title: i.title, group: false }))]) : [],
      })),
    [],
  );
  const flatIds = useMemo(() => toc.flatMap((s) => [s.id, ...s.children.map((c) => c.id)]), [toc]);

  // scrollspy
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    flatIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [flatIds]);

  // tautan langsung #bagian
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (h) setTimeout(() => document.getElementById(h)?.scrollIntoView(), 200);
  }, []);

  const go = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
  };

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // cetak: muat semua gambar (lazy) lebih dulu agar ikut tercetak
  const [preparing, setPreparing] = useState(false);
  const printDocs = async () => {
    setPreparing(true);
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.docs-body img'));
    imgs.forEach((im) => (im.loading = 'eager'));
    await Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((r) => ((im.onload = r), (im.onerror = r))))));
    setPreparing(false);
    setTimeout(() => window.print(), 100);
  };
  useEffect(() => {
    // Ctrl+P: minta browser memuat gambar yang belum tampil
    const before = () => document.querySelectorAll<HTMLImageElement>('.docs-body img').forEach((im) => (im.loading = 'eager'));
    window.addEventListener('beforeprint', before);
    return () => window.removeEventListener('beforeprint', before);
  }, []);

  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  let figNo = 6; // gambar 1–6 ada di bagian arsitektur & proses bisnis

  return (
    <div className="docs-page flex h-full w-full">
      <style>{DIAGRAM_CSS + PRINT_CSS}</style>
      {/* daftar isi */}
      <nav className="docs-toc flex w-72 shrink-0 flex-col border-r border-gray-200 bg-white" aria-label="Daftar isi">
        <div className="border-b border-gray-200 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Icon name="book" size={16} /> Dokumentasi QuadranGIS
          </div>
          <input className="input mt-2 text-xs" placeholder="Cari topik..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari topik" />
        </div>
        <ol className="flex-1 overflow-y-auto p-2 text-sm">
          {toc.map((s, i) => (
            <li key={s.id} className="mb-1">
              {match(s.title) || s.children.some((c) => match(c.title)) ? (
                <>
                  <button
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium ${active === s.id ? 'bg-brand-600 text-white' : 'text-gray-800 hover:bg-gray-100'}`}
                    onClick={() => go(s.id)}
                  >
                    <Icon name={s.icon} size={15} />
                    <span className="flex-1">
                      {i + 1}. {s.title}
                    </span>
                  </button>
                  {s.children.length > 0 && (
                    <ol className="ml-4 mt-0.5 border-l border-gray-200 pl-2">
                      {s.children
                        .filter((c) => c.group || match(c.title))
                        .map((c) =>
                          c.group ? (
                            <li key={c.id} className="mt-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                              {c.title}
                            </li>
                          ) : (
                            <li key={c.id}>
                              <button
                                className={`w-full rounded px-2 py-1 text-left text-[13px] ${active === c.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`}
                                onClick={() => go(c.id)}
                              >
                                {c.title}
                              </button>
                            </li>
                          ),
                        )}
                    </ol>
                  )}
                </>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="border-t border-gray-200 p-3">
          <button className="flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100" onClick={printDocs} disabled={preparing}>
            <Icon name="download" size={14} /> {preparing ? 'Menyiapkan gambar...' : 'Cetak / simpan PDF'}
          </button>
        </div>
      </nav>

      {/* isi */}
      <div ref={scroller} className="docs-body min-w-0 flex-1 overflow-y-auto bg-gray-50">
        <article className="mx-auto max-w-5xl px-6 py-6">
          {locale === 'en' && (
            <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">This documentation is written in Indonesian.</div>
          )}
          <header className="docs-cover mb-8 rounded-2xl border border-gray-200 bg-white p-6">
            <div className="text-xs font-semibold uppercase tracking-widest text-brand-600">Dokumentasi</div>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">QuadranGIS · GIS Jaringan Distribusi Listrik</h1>
            <p className="mt-2 max-w-3xl text-sm text-gray-600">
              Overview, fitur, arsitektur, proses bisnis, instalasi & konfigurasi, serta buku panduan penggunaan dengan tangkapan layar setiap fitur.
            </p>
          </header>

          {SECTIONS.map((s, i) => (
            <section key={s.id} id={s.id} className="docs-section mb-10 scroll-mt-4">
              <h2 className="mb-3 flex items-center gap-2 border-b border-gray-200 pb-2 text-xl font-bold text-gray-900">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-sm text-white">{i + 1}</span>
                {s.title}
              </h2>
              {s.body}
              {s.guide?.map((g) => (
                <div key={g.group} id={`grp-${slug(g.group)}`} className="scroll-mt-4">
                  <h3 className="mb-3 mt-8 text-lg font-semibold text-gray-900">{g.group}</h3>
                  <div className="space-y-6">
                    {g.items.map((it) => {
                      if (it.img) figNo++;
                      const no = figNo;
                      return (
                        <div key={it.id} id={it.id} className="docs-guide-item scroll-mt-4 rounded-2xl border border-gray-200 bg-white p-4">
                          <h4 className="text-base font-semibold text-gray-900">{it.title}</h4>
                          <p className="mt-1 text-[14px] leading-relaxed text-gray-700">{it.intro}</p>
                          {it.img && (
                            <figure className="mt-3">
                              <button className="block w-full overflow-hidden rounded-lg border border-gray-200" onClick={() => setZoom(it)} aria-label={`Perbesar: ${it.title}`}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={`/guide/${it.img}.jpg`} alt={`Tangkapan layar: ${it.title}`} loading="lazy" className="w-full" />
                              </button>
                              <figcaption className="mt-1 text-center text-xs text-gray-500">
                                Gambar {no}. {it.title}
                              </figcaption>
                            </figure>
                          )}
                          <div className="mt-3 grid gap-4 md:grid-cols-[1fr_16rem]">
                            {it.steps && (
                              <div>
                                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Langkah</div>
                                <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13.5px] text-gray-700">
                                  {it.steps.map((st, k) => (
                                    <li key={k}>{st}</li>
                                  ))}
                                </ol>
                              </div>
                            )}
                            <div className="space-y-2">
                              {it.perm && (
                                <div className="rounded-lg bg-gray-50 p-2 text-xs text-gray-700">
                                  <div className="font-semibold text-gray-800">Hak akses</div>
                                  <code className="font-mono text-[11.5px]">{it.perm}</code>
                                </div>
                              )}
                              {it.tips && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                                  <div className="font-semibold">Tips</div>
                                  <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                                    {it.tips.map((tp, k) => (
                                      <li key={k}>{tp}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          ))}
          <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-500">QuadranGIS · dokumentasi dibuat dari aplikasi versi terpasang</footer>
        </article>
      </div>

      {/* perbesar gambar */}
      {zoom && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/85 p-4" role="dialog" aria-modal="true" aria-label={zoom.title} onClick={() => setZoom(null)}>
          <div className="mb-2 flex items-center justify-between text-sm text-white">
            <span className="font-medium">{zoom.title}</span>
            <button className="rounded p-1 hover:bg-white/10" onClick={() => setZoom(null)} aria-label="Tutup">
              <Icon name="x" size={18} />
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/guide/${zoom.img}.jpg`} alt={zoom.title} className="m-auto max-h-full max-w-full rounded object-contain" />
        </div>
      )}
    </div>
  );
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  aside, nav, nav.docs-toc, button[class*="fixed"] { display: none !important; }
  /* layout aplikasi (h-screen, overflow-hidden) tidak boleh memotong isi saat dicetak */
  html, body, body > div, body > div > div, main, .docs-page, .docs-body {
    height: auto !important; min-height: 0 !important; overflow: visible !important; position: static !important; display: block !important; background: #fff !important;
  }
  .docs-page { display: block !important; }
  .docs-body article { max-width: none !important; padding: 0 !important; }
  .docs-section { break-before: page; }
  .docs-section:first-of-type { break-before: auto; }
  .docs-guide-item, figure, table { break-inside: avoid; }
  .docs-page * { color-adjust: exact; -webkit-print-color-adjust: exact; }
}
`;
