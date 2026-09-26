'use client';

import React from 'react';

/**
 * Diagram dokumentasi. Warna diambil dari token CSS (.docs-diagram) yang punya nilai
 * terang & gelap sendiri, sehingga diagram tetap terbaca pada kedua tema dan saat dicetak.
 */
export const DIAGRAM_CSS = `
.docs-diagram {
  --d-bg: #ffffff; --d-panel: #f8fafc; --d-border: #d7dce3; --d-text: #111827; --d-muted: #5b6472;
  --d-line: #8a94a6;
  --d-client: #2a78d6; --d-client-bg: #e9f1fc;
  --d-edge: #7c5cd6;   --d-edge-bg: #f0ebfb;
  --d-app: #0f9f8f;    --d-app-bg: #e6f6f3;
  --d-data: #c9800f;   --d-data-bg: #fdf3e2;
  --d-ext: #d6508a;    --d-ext-bg: #fbeaf1;
}
.dark .docs-diagram {
  --d-bg: #111827; --d-panel: #1a2230; --d-border: #334155; --d-text: #f3f4f6; --d-muted: #a3acb9;
  --d-line: #6b7688;
  --d-client: #5b9cf0; --d-client-bg: #16263d;
  --d-edge: #a48cf0;   --d-edge-bg: #241d3d;
  --d-app: #2cc4b0;    --d-app-bg: #102a28;
  --d-data: #e6a23c;   --d-data-bg: #2e2412;
  --d-ext: #ef7fac;    --d-ext-bg: #331b27;
}
@media print {
  .docs-diagram { --d-bg:#fff; --d-panel:#f8fafc; --d-border:#d7dce3; --d-text:#111827; --d-muted:#5b6472; --d-line:#8a94a6;
    --d-client:#2a78d6; --d-client-bg:#e9f1fc; --d-edge:#7c5cd6; --d-edge-bg:#f0ebfb; --d-app:#0f9f8f; --d-app-bg:#e6f6f3;
    --d-data:#c9800f; --d-data-bg:#fdf3e2; --d-ext:#d6508a; --d-ext-bg:#fbeaf1; }
}
.docs-diagram text { font-family: Inter, 'Segoe UI', Arial, sans-serif; }
`;

type Tone = 'client' | 'edge' | 'app' | 'data' | 'ext';

function Box({ x, y, w, h, tone, title, lines = [], icon }: { x: number; y: number; w: number; h: number; tone: Tone; title: string; lines?: string[]; icon?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={`var(--d-${tone}-bg)`} stroke={`var(--d-${tone})`} strokeWidth={1.6} />
      <rect x={x} y={y} width={5} height={h} rx={2} fill={`var(--d-${tone})`} />
      <text x={x + 16} y={y + 24} fontSize={14} fontWeight={700} fill="var(--d-text)">
        {icon ? `${icon}  ` : ''}
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={i} x={x + 16} y={y + 44 + i * 17} fontSize={11.5} fill="var(--d-muted)">
          {l}
        </text>
      ))}
    </g>
  );
}

function Arrow({ d, label, lx, ly, dashed = false, anchor = 'middle' }: { d: string; label?: string; lx?: number; ly?: number; dashed?: boolean; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <g>
      <path d={d} fill="none" stroke="var(--d-line)" strokeWidth={1.8} strokeDasharray={dashed ? '5 4' : undefined} markerEnd="url(#docs-arrow)" />
      {label && (
        <text x={lx} y={ly} fontSize={10.5} fill="var(--d-muted)" textAnchor={anchor}>
          {label}
        </text>
      )}
    </g>
  );
}

function Band({ x, w, label, tone }: { x: number; w: number; label: string; tone: Tone }) {
  return (
    <g>
      <rect x={x} y={34} width={w} height={606} rx={14} fill="var(--d-panel)" stroke="var(--d-border)" strokeDasharray="4 4" />
      <text x={x + w / 2} y={56} fontSize={11} fontWeight={700} letterSpacing={1.4} fill={`var(--d-${tone})`} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** Arsitektur sistem: lapisan pengguna → edge → aplikasi → data & layanan. */
export function ArchitectureDiagram() {
  return (
    <figure className="docs-diagram my-4 overflow-x-auto rounded-xl border border-gray-200 p-3" style={{ background: 'var(--d-bg)' }}>
      <svg viewBox="0 0 1180 660" className="h-auto w-full min-w-[760px]" role="img" aria-labelledby="arch-title arch-desc">
        <title id="arch-title">Arsitektur QuadranGIS</title>
        <desc id="arch-desc">Browser terhubung lewat HTTPS ke nginx, yang meneruskan ke frontend Next.js dan backend Go; backend memakai PostgreSQL/PostGIS/TimescaleDB, Redis, Kafka, dan penyedia AI.</desc>
        <defs>
          <marker id="docs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--d-line)" />
          </marker>
        </defs>
        <Band x={10} w={200} label="PENGGUNA" tone="client" />
        <Band x={236} w={176} label="EDGE" tone="edge" />
        <Band x={438} w={400} label="APLIKASI" tone="app" />
        <Band x={864} w={306} label="DATA & LAYANAN" tone="data" />

        <Box x={24} y={74} w={172} h={170} tone="client" title="Browser" lines={['Editor Peta Jaringan', 'Monitoring Kelistrikan', 'Single Line Diagram', 'Aliran Daya · AI', 'Dokumentasi']} />
        <Box x={24} y={268} w={172} h={104} tone="client" title="QGIS / ArcGIS" lines={['GeoJSON (edit & impor)', 'File GDB (ekspor)']} />
        <Box x={24} y={396} w={172} h={120} tone="client" title="Peran pengguna" lines={['Admin · Editor GIS', 'Operator / Dispatcher', 'Operator TR (ULP)', 'Viewer']} />

        <Box x={250} y={150} w={148} h={214} tone="edge" title="nginx" lines={['HTTPS TLS 1.2/1.3', 'HSTS · gzip', 'reverse proxy', 'WebSocket upgrade', 'DNS Docker dinamis', '(tanpa 502 saat', ' container dibuat ulang)']} />

        <Box x={452} y={74} w={372} h={134} tone="app" title="Frontend · Next.js 14 (TypeScript)" lines={['MapLibre GL (vector tile, simbol IEC SDF)', 'Panel monitoring, SOE, keandalan, SLD SVG', 'Tema terang/gelap · Bahasa ID/EN', 'Realtime lewat WebSocket']} />
        <Box x={452} y={228} w={372} h={396} tone="app" title="Backend · Go 1.24 (Gin, pgx)" lines={[]} />
        {/* modul backend */}
        {[
          ['REST API & auth (JWT, RBAC per izin)', 282],
          ['Vector tile MVT (PostGIS ST_AsMVT) + cache', 315],
          ['Graf topologi di memori (2,7 jt node)', 348],
          ['Energisasi inkremental · manuver · kejadian', 381],
          ['Keandalan SAIDI/SAIFI/ENS · SOE', 414],
          ['Aliran daya (backward/forward sweep)', 447],
          ['Single Line Diagram otomatis', 480],
          ['Ekspor/impor GeoJSON & GDB (GDAL)', 513],
          ['Hub WebSocket · produser Kafka', 546],
          ['AI Assistant (tool-calling ke data GIS)', 579],
        ].map(([label, y]) => (
          <g key={label as string}>
            <rect x={470} y={(y as number) - 16} width={336} height={26} rx={6} fill="var(--d-bg)" stroke="var(--d-border)" />
            <circle cx={484} cy={(y as number) - 3} r={4} fill="var(--d-app)" />
            <text x={496} y={(y as number) + 1} fontSize={11.5} fill="var(--d-text)">
              {label as string}
            </text>
          </g>
        ))}

        <Box x={878} y={74} w={278} h={150} tone="data" title="PostgreSQL 16" lines={['PostGIS: node, saluran, bangunan,', '  batas wilayah UP3/ULP', 'TimescaleDB: metrik & stream event', 'Manuver, kejadian padam, SOE, audit', 'Migrasi SQL otomatis saat start']} />
        <Box x={878} y={244} w={278} h={112} tone="data" title="Redis 7" lines={['Cache tile & versi tile', 'Pub/sub → WebSocket semua klien', 'Captcha & rate limit']} />
        <Box x={878} y={376} w={278} h={112} tone="data" title="Apache Kafka 3.8 (KRaft)" lines={['Topik quadran.gis.events', 'Integrasi sistem lain (SCADA,', '  pelaporan) · arsip event']} />
        <Box x={878} y={508} w={278} h={116} tone="ext" title="Penyedia AI (opsional)" lines={['Claude (Anthropic) · ChatGPT', 'Kimi · OpenRouter', 'Kunci API disimpan terenkripsi', '  di Konfigurasi']} />

        {/* panah */}
        <Arrow d="M196 160 L250 200" label="HTTPS" lx={222} ly={170} />
        <Arrow d="M196 320 L250 300" label="HTTPS" lx={222} ly={300} />
        <Arrow d="M398 200 L452 150" label="halaman" lx={425} ly={165} />
        <Arrow d="M398 300 L452 330" label="/api · /ws" lx={425} ly={300} />
        <Arrow d="M638 208 L638 228" />
        <Arrow d="M824 300 L878 170" label="SQL" lx={852} ly={225} />
        <Arrow d="M824 360 L878 300" label="cache · pub/sub" lx={853} ly={316} />
        <Arrow d="M824 540 L878 432" label="event" lx={855} ly={478} />
        <Arrow d="M824 575 L878 566" label="HTTPS" lx={851} ly={562} dashed />
      </svg>
      <figcaption className="mt-2 text-center text-xs text-gray-500">
        Gambar 1. Arsitektur QuadranGIS: seluruh layanan berjalan sebagai container Docker; pengguna hanya mengakses nginx (HTTPS).
      </figcaption>
    </figure>
  );
}

/** Aliran perubahan realtime: dari aksi pengguna sampai semua klien diperbarui. */
export function RealtimeDiagram() {
  const steps: [string, string, Tone][] = [
    ['Aksi pengguna', 'edit GIS / manuver / impor', 'client'],
    ['Backend', 'validasi, izin role, topologi', 'app'],
    ['Graf memori', 'energisasi inkremental (ms)', 'app'],
    ['PostgreSQL', 'simpan status, kejadian, SOE', 'data'],
    ['Redis pub/sub', 'siarkan event', 'data'],
    ['WebSocket', 'semua browser: peta, SLD, SOE', 'client'],
  ];
  return (
    <figure className="docs-diagram my-4 overflow-x-auto rounded-xl border border-gray-200 p-3" style={{ background: 'var(--d-bg)' }}>
      <svg viewBox="0 0 1180 190" className="h-auto w-full min-w-[760px]" role="img" aria-label="Aliran perubahan realtime">
        <defs>
          <marker id="docs-arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--d-line)" />
          </marker>
        </defs>
        {steps.map(([t, s, tone], i) => {
          const x = 14 + i * 196;
          return (
            <g key={t}>
              <rect x={x} y={28} width={170} height={78} rx={10} fill={`var(--d-${tone}-bg)`} stroke={`var(--d-${tone})`} strokeWidth={1.6} />
              <circle cx={x + 20} cy={48} r={11} fill={`var(--d-${tone})`} />
              <text x={x + 20} y={52} fontSize={11} fontWeight={700} fill="var(--d-bg)" textAnchor="middle">
                {i + 1}
              </text>
              <text x={x + 38} y={52} fontSize={13} fontWeight={700} fill="var(--d-text)">
                {t}
              </text>
              <text x={x + 14} y={82} fontSize={11} fill="var(--d-muted)">
                {s}
              </text>
              {i < steps.length - 1 && <path d={`M${x + 172} 67 L${x + 194} 67`} stroke="var(--d-line)" strokeWidth={1.8} markerEnd="url(#docs-arrow2)" />}
            </g>
          );
        })}
        <path d="M896 106 C 896 150, 860 160, 820 160" fill="none" stroke="var(--d-line)" strokeWidth={1.6} strokeDasharray="5 4" markerEnd="url(#docs-arrow2)" />
        <text x={640} y={164} fontSize={11} fill="var(--d-muted)">
          Kafka: salinan event untuk sistem lain & arsip (stream_events)
        </text>
      </svg>
      <figcaption className="mt-2 text-center text-xs text-gray-500">Gambar 2. Setiap perubahan tersebar ke semua pengguna dalam hitungan detik tanpa memuat ulang halaman.</figcaption>
    </figure>
  );
}

export interface FlowStep {
  title: string;
  who?: string;
  desc: string;
  tone?: Tone;
}

/** Alur proses bisnis: langkah bernomor dengan pelaku, membungkus ke baris berikutnya. */
export function Flow({ steps, caption }: { steps: FlowStep[]; caption?: string }) {
  return (
    <figure className="docs-diagram my-4">
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {steps.map((s, i) => {
          const tone = s.tone || 'app';
          return (
            <li key={i} className="relative rounded-xl p-3" style={{ background: `var(--d-${tone}-bg)`, border: `1.5px solid var(--d-${tone})` }}>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold" style={{ background: `var(--d-${tone})`, color: 'var(--d-bg)' }}>
                  {i + 1}
                </span>
                <span className="text-sm font-semibold" style={{ color: 'var(--d-text)' }}>
                  {s.title}
                </span>
              </div>
              {s.who && (
                <div className="mt-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: `var(--d-${tone})` }}>
                  {s.who}
                </div>
              )}
              <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--d-muted)' }}>
                {s.desc}
              </p>
              {i < steps.length - 1 && (
                <span className="absolute -right-2.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[11px] sm:flex" style={{ background: 'var(--d-bg)', color: 'var(--d-line)', border: '1px solid var(--d-border)' }} aria-hidden>
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {caption && <figcaption className="mt-2 text-center text-xs text-gray-500">{caption}</figcaption>}
    </figure>
  );
}
