'use client';

import React from 'react';
import { ArchitectureDiagram, Flow, RealtimeDiagram } from './diagrams';

// =====================================================================
// Isi dokumentasi QuadranGIS (Bahasa Indonesia).
// Struktur: bagian → subbagian; subbagian panduan punya tangkapan layar.
// =====================================================================

export interface GuideItem {
  id: string;
  title: string;
  img?: string; // nama berkas di /guide
  intro: React.ReactNode;
  steps?: React.ReactNode[];
  tips?: React.ReactNode[];
  perm?: string;
}

export interface DocSection {
  id: string;
  title: string;
  icon: string;
  body?: React.ReactNode;
  guide?: { group: string; items: GuideItem[] }[];
}

const K = ({ children }: { children: React.ReactNode }) => <kbd className="rounded border border-gray-300 bg-gray-100 px-1 font-mono text-[11px] text-gray-800">{children}</kbd>;
const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[12px] text-gray-800">{children}</code>;
const B = ({ children }: { children: React.ReactNode }) => <b className="font-semibold text-gray-900">{children}</b>;

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 text-gray-700">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return <pre className="my-3 overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-[12.5px] leading-relaxed text-gray-100">{children}</pre>;
}

function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warn'; title: string; children: React.ReactNode }) {
  const cls = tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-brand-200 bg-brand-50 text-brand-900';
  return (
    <div className={`my-3 rounded-lg border px-3 py-2 text-sm ${cls}`}>
      <div className="font-semibold">{title}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function FeatureCard({ icon, title, items }: { icon: string; title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <span className="text-lg" aria-hidden>
          {icon}
        </span>
        {title}
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-gray-700">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="my-2 text-[14px] leading-relaxed text-gray-700">{children}</p>;
const H3 = ({ children, id }: { children: React.ReactNode; id?: string }) => (
  <h3 id={id} className="mb-1 mt-6 scroll-mt-20 text-base font-semibold text-gray-900">
    {children}
  </h3>
);

// ---------------------------------------------------------------- 1. overview
const overview = (
  <>
    <P>
      <B>QuadranGIS</B> adalah aplikasi Sistem Informasi Geografis (GIS) jaringan distribusi listrik berbasis web. Satu aplikasi dipakai untuk membangun
      dan memelihara data aset jaringan (dari gardu induk sampai pelanggan), memantau kondisi nyala/padam secara realtime, mengoperasikan jaringan
      (buka/tutup, energize/deenergize) dengan hak akses per peran, menghitung indeks keandalan, menganalisis aliran daya, dan menyusun Single Line
      Diagram otomatis dari data GIS.
    </P>
    <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[
        ['2,7 juta+', 'objek jaringan dalam graf memori, tetap responsif'],
        ['< 50 ms', 'perhitungan padam/nyala setelah manuver (inkremental)'],
        ['Realtime', 'perubahan tersebar ke semua pengguna lewat WebSocket'],
        ['1 sumber data', 'peta, monitoring, SLD & aliran daya selalu sinkron'],
      ].map(([v, l]) => (
        <div key={v} className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-2xl font-semibold text-gray-900">{v}</div>
          <div className="mt-1 text-xs text-gray-600">{l}</div>
        </div>
      ))}
    </div>
    <H3>Tujuan</H3>
    <ul className="my-2 list-disc space-y-1 pl-5 text-[14px] text-gray-700">
      <li>Menyediakan data jaringan yang lengkap, terhubung secara topologi, dan dapat dipercaya (single source of truth / SSOT).</li>
      <li>Mempercepat penanganan gangguan: lokasi padam, pelanggan terdampak, dan jalur pemulihan terlihat seketika.</li>
      <li>Mengukur kinerja keandalan (SAIDI, SAIFI, ENS) langsung dari kejadian operasi, bukan rekap manual.</li>
      <li>Mendukung perencanaan: aliran daya, pembebanan penghantar & trafo, dan diagram satu garis siap cetak.</li>
    </ul>
    <H3>Pengguna</H3>
    <Table
      head={['Peran', 'Kebutuhan utama', 'Menu yang dipakai']}
      rows={[
        ['Admin sistem', 'Pengguna, peran & izin, menu, konfigurasi, pemantauan server', 'Administrasi'],
        ['Editor GIS', 'Menggambar & memelihara aset, atribut SSOT, impor/ekspor QGIS', 'Editor Peta Jaringan'],
        ['Operator / Dispatcher', 'Monitoring realtime, manuver TM & TR, penanganan gangguan', 'Monitoring Kelistrikan, SLD'],
        ['Operator TR (ULP)', 'Operasi jaringan tegangan rendah saja', 'Monitoring Kelistrikan, SLD'],
        ['Perencana / Viewer', 'Analisis aliran daya, keandalan, trace, laporan', 'Aliran Daya, SLD, AI Assistant'],
      ]}
    />
  </>
);

// ---------------------------------------------------------------- 2. fitur
const features = (
  <div className="my-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
    <FeatureCard icon="🗺️" title="Editor Peta Jaringan" items={['Gambar titik, garis & bangunan (GI, GH, GD) dengan snapping', 'Topologi otomatis: sambung, pisah garis, junction', 'Atribut SSOT per tipe komponen', 'Edit vertex, pindah, gambar ulang, riwayat perubahan', 'Simbol standar kelistrikan IEC 60617']} />
    <FeatureCard icon="🔎" title="Topologi & Trace" items={['Graf jaringan di memori, jutaan node', 'Downtrace, uptrace, terhubung', 'Berhenti pada tipe tertentu, ringkasan per tipe', 'Validasi topologi (objek terisolasi, ujung bebas)']} />
    <FeatureCard icon="⚡" title="Monitoring Kelistrikan" items={['Rekap GI, trafo GI, penyulang, zona, gardu, pelanggan, beban', 'Peta nyala/padam realtime + filter', 'Tab GI, penyulang, gardu distribusi, pelanggan', 'Pencarian objek, ukur panjang & luas']} />
    <FeatureCard icon="🔌" title="Operasi Jaringan" items={['Buka/tutup switch TM & TR (termasuk per arah LBS 3 way)', 'Energize/deenergize gardu, trafo, saluran, pelanggan', 'Kategori: GANGGUAN, PEMELIHARAAN, MLS, MANUVER, BENCANA ALAM', 'Izin per peran & domain tegangan (TM/TR)']} />
    <FeatureCard icon="📊" title="Keandalan & Kejadian" items={['SAIDI, SAIFI, ENS (kWh & Rupiah) per periode', 'Kejadian padam per level: GI … pelanggan', 'Tarif, faktor beban & cos φ dapat diatur', 'Momentary vs sustained']} />
    <FeatureCard icon="🧾" title="SOE Realtime" items={['Sequence of Events presisi milidetik', 'Keparahan: normal, peringatan, serius, kritis', 'Jeda/lanjut, filter, alarm suara, ekspor CSV', 'Sinkron ulang otomatis bila koneksi putus']} />
    <FeatureCard icon="📐" title="Single Line Diagram" items={['Otomatis dari GIS: penyulang, GI, gardu, objek, area', '4 tingkat detail, penyederhanaan & lipatan baris', 'Manuver langsung dari diagram, status realtime', 'Overlay aliran daya, ekspor SVG/PNG/PDF']} />
    <FeatureCard icon="🔋" title="Aliran Daya" items={['Backward/forward sweep per penyulang', 'Tegangan (pu), arus, pembebanan penghantar & trafo, susut', 'Skenario faktor beban, cos φ, tegangan kirim', 'Peringkat penyulang kritis']} />
    <FeatureCard icon="🔁" title="Pertukaran Data" items={['Ekspor/impor GeoJSON untuk diedit di QGIS', 'Pratinjau perubahan sebelum diterapkan', 'Ekspor File Geodatabase (GDB) per area', 'Batas 10 MB, cek duplikasi & topologi']} />
    <FeatureCard icon="🧭" title="Overlay Wilayah" items={['Batas UP3 & ULP dari shapefile', 'Pewarnaan peta 5 warna, label wilayah', 'Transparansi dapat diatur per pengguna']} />
    <FeatureCard icon="✨" title="AI Assistant" items={['Claude, ChatGPT, Kimi, OpenRouter', 'Menjawab dari data jaringan terkini (tool calling)', 'Kunci API tersimpan aman di Konfigurasi']} />
    <FeatureCard icon="🛡️" title="Administrasi & Keamanan" items={['Pengguna, peran & izin granular, menu dinamis', 'Login dengan captcha, JWT HttpOnly, HTTPS', 'Audit log, monitoring sistem (CPU, memori, DB)', 'Tema terang/gelap, Bahasa Indonesia/Inggris']} />
  </div>
);

// ---------------------------------------------------------------- 3. arsitektur
const architecture = (
  <>
    <P>
      QuadranGIS berjalan sebagai sekumpulan container Docker. Pengguna hanya berinteraksi dengan <B>nginx</B> melalui HTTPS; nginx meneruskan halaman ke
      frontend Next.js dan panggilan <C>/api</C> serta WebSocket ke backend Go. Backend menyimpan data di PostgreSQL (PostGIS untuk geometri, TimescaleDB
      untuk metrik & event), memakai Redis untuk cache dan siaran realtime, serta Kafka untuk aliran event ke sistem lain.
    </P>
    <ArchitectureDiagram />
    <H3>Graf topologi di memori</H3>
    <P>
      Inti kecepatan aplikasi adalah graf jaringan yang dimuat di memori backend saat start (±20–35 detik untuk 2,7 juta node). Graf menyimpan
      konektivitas, posisi switch (saat ini & normal), jarak dari sumber, serta pengelompokan penyulang, zona, gardu, dan jurusan. Saat terjadi manuver,
      hanya wilayah terdampak yang dihitung ulang (inkremental), sehingga status nyala/padam diperbarui dalam milidetik. Trace, rekap monitoring, SLD,
      dan aliran daya membaca graf yang sama.
    </P>
    <RealtimeDiagram />
    <H3>Teknologi</H3>
    <Table
      head={['Lapisan', 'Teknologi', 'Peran']}
      rows={[
        ['Frontend', 'Next.js 14, React, TypeScript, Tailwind, MapLibre GL', 'Antarmuka, peta vector tile, SLD SVG, tema & bahasa'],
        ['Backend', 'Go 1.24, Gin, pgx, gorilla/websocket, kafka-go', 'API, graf topologi, energisasi, keandalan, SLD, aliran daya'],
        ['Database', 'PostgreSQL 16 + PostGIS + TimescaleDB', 'Aset jaringan, geometri, kejadian, SOE, metrik, audit'],
        ['Cache & realtime', 'Redis 7', 'Cache tile, pub/sub WebSocket, captcha, rate limit'],
        ['Stream', 'Apache Kafka 3.8 (KRaft)', 'Event GIS untuk integrasi & arsip'],
        ['Edge', 'nginx', 'TLS 1.2/1.3, HSTS, gzip, reverse proxy'],
        ['Konversi data', 'GDAL / ogr2ogr', 'Ekspor File Geodatabase'],
      ]}
    />
    <H3>Keamanan</H3>
    <ul className="my-2 list-disc space-y-1 pl-5 text-[14px] text-gray-700">
      <li>HTTPS wajib (HSTS); token sesi JWT dalam cookie HttpOnly; kata sandi bcrypt; captcha & pembatasan percobaan login.</li>
      <li>Izin dibaca dari peran di database pada setiap permintaan (di-cache 30 detik), sehingga perubahan peran langsung berlaku.</li>
      <li>Operasi jaringan dicek di server menurut izin dan domain tegangan (TM/TR); setiap aksi tercatat di audit log dan SOE.</li>
      <li>Kunci API penyedia AI disimpan sebagai konfigurasi rahasia dan tidak pernah dikirim ulang ke browser.</li>
    </ul>
  </>
);

// ---------------------------------------------------------------- 4. proses bisnis
const business = (
  <>
    <P>Berikut proses bisnis utama yang didukung QuadranGIS, lengkap dengan pelaku dan fitur yang dipakai pada tiap langkah.</P>
    <H3 id="bp-data">4.1 Pembangunan & pemeliharaan data jaringan</H3>
    <Flow
      steps={[
        { title: 'Survei / data lapangan', who: 'Editor GIS', desc: 'Data aset baru atau perubahan dari lapangan, gambar kerja, atau QGIS.', tone: 'client' },
        { title: 'Digitasi / impor', who: 'Editor GIS', desc: 'Gambar di Editor Peta, atau impor GeoJSON hasil edit QGIS dengan pratinjau perubahan.', tone: 'client' },
        { title: 'Topologi otomatis', who: 'Sistem', desc: 'Ujung garis tersambung, garis dipisah, junction dibuat; graf diperbarui.', tone: 'app' },
        { title: 'Atribut SSOT', who: 'Editor GIS', desc: 'Kode SSOT, kapasitas trafo, daya pelanggan, penghantar, posisi normal switch.', tone: 'client' },
        { title: 'Validasi', who: 'Editor GIS', desc: 'Periksa topologi: objek terisolasi, ujung bebas; trace untuk memastikan alur sumber → pelanggan.', tone: 'app' },
        { title: 'Energisasi & grup', who: 'Sistem', desc: 'Status nyala/padam, penyulang, zona, gardu & jurusan dihitung ulang otomatis.', tone: 'app' },
        { title: 'Siap dipakai', who: 'Semua', desc: 'Data tampil di Monitoring, SLD, Aliran Daya, dan dapat diekspor ke GDB.', tone: 'data' },
      ]}
      caption="Gambar 3. Alur pemeliharaan data aset jaringan."
    />
    <H3 id="bp-ops">4.2 Operasi jaringan & penanganan gangguan</H3>
    <Flow
      steps={[
        { title: 'Kejadian / rencana', who: 'Dispatcher', desc: 'Laporan gangguan, jadwal pemeliharaan, atau perintah MLS/manuver.', tone: 'client' },
        { title: 'Temukan objek', who: 'Dispatcher', desc: 'Cari di peta Monitoring, SLD, atau tab GI/penyulang/gardu/pelanggan.', tone: 'client' },
        { title: 'Buka / deenergize', who: 'Operator (sesuai izin)', desc: 'Pilih kategori pemadaman, isi catatan, konfirmasi. Izin TM/TR dicek server.', tone: 'app' },
        { title: 'Dampak dihitung', who: 'Sistem', desc: 'Wilayah padam dihitung inkremental; rekap pelanggan & beban padam.', tone: 'app' },
        { title: 'Kejadian & SOE', who: 'Sistem', desc: 'Kejadian padam per level, SOE bertingkat keparahan, notifikasi ke semua pengguna.', tone: 'data' },
        { title: 'Perbaikan', who: 'Tim lapangan', desc: 'Lokasi dan area terdampak terlihat di peta / SLD; trace membantu isolasi.', tone: 'client' },
        { title: 'Tutup / energize', who: 'Operator', desc: 'Pemulihan; kategori mengikuti kejadian; durasi tercatat otomatis.', tone: 'app' },
        { title: 'Keandalan', who: 'Manajemen', desc: 'SAIDI, SAIFI, ENS kWh & Rupiah terbarui per periode dan per level.', tone: 'data' },
      ]}
      caption="Gambar 4. Alur operasi jaringan dari kejadian sampai pelaporan keandalan."
    />
    <H3 id="bp-plan">4.3 Perencanaan & analisis</H3>
    <Flow
      steps={[
        { title: 'Pilih penyulang', who: 'Perencana', desc: 'Dari Aliran Daya atau SLD; atur skenario faktor beban, cos φ, tegangan kirim.', tone: 'client' },
        { title: 'Hitung aliran daya', who: 'Sistem', desc: 'Tegangan tiap node, arus & pembebanan penghantar dan trafo, susut daya.', tone: 'app' },
        { title: 'Identifikasi masalah', who: 'Perencana', desc: 'Tegangan jatuh, penghantar/trafo beban lebih; overlay warna di peta & SLD.', tone: 'app' },
        { title: 'Susun rencana', who: 'Perencana', desc: 'Manuver/rekonfigurasi lewat tie normally-open, uprating, gardu sisip.', tone: 'client' },
        { title: 'Dokumentasi', who: 'Perencana', desc: 'Ekspor SLD (PDF/SVG), data GDB, dan hasil untuk rapat/laporan.', tone: 'data' },
      ]}
      caption="Gambar 5. Alur perencanaan jaringan berbasis aliran daya dan SLD."
    />
    <H3 id="bp-admin">4.4 Tata kelola akses</H3>
    <Flow
      steps={[
        { title: 'Buat pengguna', who: 'Admin', desc: 'Akun, email, status aktif.', tone: 'client' },
        { title: 'Tetapkan peran', who: 'Admin', desc: 'Admin, editor, operator, operator_tr, viewer, atau peran baru.', tone: 'client' },
        { title: 'Atur izin & menu', who: 'Admin', desc: 'Izin granular (mis. power.switch_tm) dan menu yang tampil per peran.', tone: 'app' },
        { title: 'Pantau & audit', who: 'Admin', desc: 'Audit log aksi, monitoring sistem, konfigurasi aplikasi.', tone: 'data' },
      ]}
      caption="Gambar 6. Tata kelola pengguna dan hak akses."
    />
    <H3>Matriks peran & izin operasi</H3>
    <Table
      head={['Izin', 'Admin', 'Editor', 'Operator', 'Operator TR', 'Viewer']}
      rows={[
        ['Lihat peta & monitoring (gis.view)', '✓', '✓', '✓', '✓', '✓'],
        ['Edit data GIS (gis.edit)', '✓', '✓', '–', '–', '–'],
        ['Buka/tutup switch TM (power.switch_tm)', '✓', '✓', '✓', '–', '–'],
        ['Buka/tutup switch jurusan TR (power.switch_tr)', '✓', '✓', '✓', '✓', '–'],
        ['Energize/deenergize TM (power.energize_tm)', '✓', '✓', '✓', '–', '–'],
        ['Energize/deenergize TR (power.energize_tr)', '✓', '✓', '✓', '✓', '–'],
        ['Administrasi (admin.*)', '✓', '–', '–', '–', '–'],
      ]}
    />
  </>
);

// ---------------------------------------------------------------- 5. instalasi & konfigurasi
const install = (
  <>
    <H3>Kebutuhan</H3>
    <Table
      head={['Komponen', 'Minimal', 'Disarankan (jutaan objek)']}
      rows={[
        ['CPU', '4 vCPU', '8 vCPU'],
        ['Memori', '8 GB', '16 GB+ (graf memori ±2–3 GB untuk 2,7 juta node)'],
        ['Disk', '20 GB SSD', '100 GB SSD'],
        ['Perangkat lunak', 'Docker 24+ & Docker Compose v2', 'Linux server / Windows dengan Docker Desktop'],
        ['Browser', 'Chrome / Edge / Firefox terbaru (WebGL aktif)', ''],
      ]}
    />
    <H3>Instalasi dengan Docker</H3>
    <Pre>{`git clone https://github.com/hendrapoernama/quadranGIS.git
cd quadranGIS
cp .env.example .env          # ubah JWT_SECRET, ADMIN_PASSWORD, port bila perlu
bash scripts/gen-cert.sh      # Windows: powershell scripts/gen-cert.ps1
docker compose up -d --build`}</Pre>
    <P>
      Buka <C>https://localhost</C> (atau <C>https://localhost:&lt;HTTPS_PORT&gt;</C>). Sertifikat bawaan self-signed; ganti dengan sertifikat resmi di
      <C>nginx/certs</C> untuk produksi. Login awal: <C>admin</C> / nilai <C>ADMIN_PASSWORD</C>. Migrasi database berjalan otomatis setiap backend start.
    </P>
    <Callout tone="warn" title="Server dengan memori terbatas">
      Build image satu per satu (<C>docker compose build backend</C>, lalu <C>frontend</C>) agar build Next.js tidak kehabisan memori.
    </Callout>
    <H3>Variabel lingkungan penting (.env)</H3>
    <Table
      head={['Variabel', 'Keterangan']}
      rows={[
        [<C key="a">HTTPS_PORT / HTTP_PORT / BACKEND_PORT</C>, 'Port host nginx dan API langsung; ubah bila bentrok dengan layanan lain'],
        [<C key="b">DATABASE_URL</C>, 'Koneksi PostgreSQL (di Docker: postgres:5432)'],
        [<C key="c">REDIS_ADDR, KAFKA_BROKERS, KAFKA_ENABLED</C>, 'Redis dan Kafka; Kafka dapat dimatikan'],
        [<C key="d">JWT_SECRET, JWT_TTL_HOURS</C>, 'Kunci penandatangan sesi (wajib diganti) dan umur sesi'],
        [<C key="e">COOKIE_SECURE</C>, 'true bila diakses lewat HTTPS'],
        [<C key="f">ADMIN_USERNAME, ADMIN_PASSWORD</C>, 'Akun admin awal (dibuat bila belum ada pengguna)'],
        [<C key="g">CORS_ORIGINS</C>, 'Origin yang diizinkan memanggil API'],
      ]}
    />
    <H3>Konfigurasi aplikasi (menu Administrasi › Konfigurasi)</H3>
    <Table
      head={['Grup', 'Contoh kunci', 'Fungsi']}
      rows={[
        ['Umum', <C key="1">app.name, app.map_center, map.boundary_opacity</C>, 'Nama aplikasi, pusat peta, basemap, overlay UP3'],
        ['Loading', <C key="2">loading.max_features_per_tile, loading.density_max_zoom</C>, 'Kinerja tile & kepadatan titik'],
        ['Topologi', <C key="3">topology.snap_tolerance_m, topology.auto_split_edges</C>, 'Toleransi snapping, pemisahan garis, junction otomatis'],
        ['Monitoring', <C key="4">monitoring.default_daya_va, monitoring.soe_retention_days</C>, 'Daya bawaan pelanggan, interval refresh, retensi SOE'],
        ['Keandalan', <C key="5">reliability.tariff_rp_per_kwh, reliability.load_factor</C>, 'Tarif ENS Rupiah, faktor beban, cos φ, batas momentary'],
        ['Aliran daya', <C key="6">powerflow.source_pu, powerflow.default_trafo_kva</C>, 'Parameter perhitungan & batas tegangan'],
        ['SLD', <C key="7">sld.max_elements, sld.default_level</C>, 'Batas elemen & tingkat detail bawaan diagram'],
        ['AI', <C key="8">ai.default_provider, ai.anthropic_api_key</C>, 'Penyedia & kunci API AI (rahasia)'],
      ]}
    />
    <H3>Pengaturan layer (menu Administrasi › Pengaturan Layer)</H3>
    <P>
      Setiap tipe komponen (GI, trafo, recloser, SKTM, pelanggan, ...) dapat diatur nama, warna, simbol standar, zoom minimum tampil, zoom label,
      ukuran, tegangan, keikutsertaan topologi, jumlah arah switch, dan skema atribut SSOT.
    </P>
    <H3>Pemeliharaan</H3>
    <ul className="my-2 list-disc space-y-1 pl-5 text-[14px] text-gray-700">
      <li>
        Cadangan database: <C>docker compose exec postgres pg_dump -U quadran -Fc quadrangis &gt; backup.dump</C>
      </li>
      <li>
        Pembaruan: <C>git pull</C> lalu <C>docker compose build backend && docker compose up -d backend</C>, kemudian frontend.
      </li>
      <li>Setelah backend dimulai ulang, graf dimuat ±20–35 detik; selama itu SLD & rekap menampilkan pesan "graf sedang dimuat" dan mencoba ulang otomatis.</li>
      <li>
        Data simulasi massal (uji beban): <C>scripts/seed_bulk.sql</C>, hapus dengan <C>scripts/remove_bulk.sql</C>.
      </li>
    </ul>
    <H3>Pemecahan masalah</H3>
    <Table
      head={['Gejala', 'Penyebab & solusi']}
      rows={[
        ['Port sudah dipakai saat start', 'Ubah HTTPS_PORT / HTTP_PORT / BACKEND_PORT di .env'],
        ['Peringatan sertifikat di browser', 'Sertifikat self-signed; pasang sertifikat resmi di nginx/certs'],
        ['Peta kosong / tile tidak muncul', 'Periksa WebGL browser; tekan "Muat ulang tile" di tab Layer'],
        ['Pesan "graf sedang dimuat"', 'Normal setelah restart backend; tunggu ±30 detik'],
        ['AI tidak menjawab', 'Isi kunci API penyedia di halaman AI › Pengaturan (izin admin.config)'],
        ['Tombol operasi tidak tampil', 'Peran belum punya izin power.switch_* / power.energize_* yang sesuai'],
      ]}
    />
  </>
);

// ---------------------------------------------------------------- 6. panduan
const guide: { group: string; items: GuideItem[] }[] = [
  {
    group: 'Memulai',
    items: [
      {
        id: 'g-login',
        title: 'Masuk ke aplikasi',
        img: 'login',
        intro: 'Buka alamat aplikasi di browser, lalu masuk dengan akun yang diberikan admin.',
        steps: ['Isi nama pengguna dan kata sandi.', 'Jawab captcha penjumlahan/perkalian sederhana.', <>Tekan <B>Masuk</B>. Setelah beberapa kali gagal, login dikunci sementara.</>],
        tips: ['Tema (terang/gelap/ikuti sistem) dan bahasa (ID/EN) dapat diubah di bawah menu samping.', 'Keluar lewat tombol Keluar di pojok kiri bawah.'],
      },
    ],
  },
  {
    group: 'Editor Peta Jaringan',
    items: [
      {
        id: 'g-map',
        title: 'Tampilan editor peta',
        img: 'map-overview',
        intro: 'Halaman kerja utama untuk melihat dan menyunting jaringan. Kiri: toolbar gambar; atas: pencarian; kanan: panel Layer, Fitur, Trace, Data.',
        steps: ['Geser & zoom peta dengan mouse; objek kecil (pelanggan, SR) muncul pada zoom tinggi.', 'Cari objek berdasarkan kode, nama, id, atau kode SSOT di kotak pencarian.', 'Klik objek untuk membuka panel Fitur.'],
        perm: 'gis.view (menyunting: gis.edit)',
      },
      {
        id: 'g-layers',
        title: 'Layer, peta dasar & overlay UP3',
        img: 'map-layers',
        intro: 'Tab Layer mengatur tampilan: tipe yang tampil, peta dasar, label, pewarnaan (per tipe atau nyala/padam), dan overlay batas wilayah UP3/ULP.',
        steps: ['Centang/kosongkan tipe komponen; "Semua"/"Kosongkan" untuk sekaligus.', 'Pilih peta dasar: ikuti tema, OSM terang, OSM gelap, atau tanpa peta dasar.', 'Pada "Batas wilayah UP3": tampilkan batas, garis ULP, label, dan geser slider transparansi.'],
        tips: ['Legenda memakai simbol standar yang sama dengan peta.', 'Pilihan overlay tersimpan di browser masing-masing pengguna.'],
      },
      {
        id: 'g-feature',
        title: 'Informasi & atribut objek',
        img: 'map-feature',
        intro: 'Panel Fitur menampilkan tipe, kode, status, penyulang/zona/gardu/jurusan, rekap pelanggan hilir, atribut SSOT, konektivitas, dan riwayat.',
        steps: ['Ubah kode, nama, atau atribut SSOT lalu tekan Simpan.', 'Gunakan Pindahkan / Gambar ulang / Edit vertex untuk mengubah geometri.', 'Kotak operasi (buka/tutup, energize/deenergize) tampil sesuai izin peran.', 'Tombol Buka SLD membuka diagram satu garis objek tersebut.'],
        perm: 'gis.edit untuk menyimpan perubahan',
      },
      {
        id: 'g-draw',
        title: 'Menggambar komponen',
        img: 'map-draw',
        intro: 'Toolbar kiri menyediakan alat pilih, gambar titik, gambar garis, pindah, dan ukur. Topologi dibentuk otomatis saat menyimpan.',
        steps: [
          'Pilih ikon titik atau garis, lalu pilih tipe komponen (mis. SKTM, SKUTR, SR).',
          <>Klik di peta untuk setiap vertex; <K>Enter</K>/dobel-klik selesai, <K>Backspace</K> hapus vertex terakhir, <K>Esc</K> batal.</>,
          'Ujung garis menempel ke node terdekat; ujung di tengah garis lain memisah garis itu dan membuat junction.',
          'Gardu (GI/GH/GD) dapat digambar sebagai titik atau poligon bangunan.',
        ],
        perm: 'gis.edit',
      },
      {
        id: 'g-trace',
        title: 'Trace hilir, hulu & terhubung',
        img: 'map-trace',
        intro: 'Menelusuri jaringan dari sebuah titik: hilir (ke pelanggan), hulu (ke sumber), atau seluruh bagian yang terhubung.',
        steps: ['Pilih titik (mis. kubikel penyulang), tekan Trace hilir / Trace hulu / Terhubung.', 'Atur kedalaman dan tipe pemberhentian di tab Trace bila perlu.', 'Hasil disorot oranye; ringkasan per tipe, panjang, dan pelanggan tampil di panel; unduh GeoJSON.'],
        perm: 'gis.trace',
      },
      {
        id: 'g-data',
        title: 'Ekspor & impor GeoJSON (QGIS)',
        img: 'map-data',
        intro: 'Tab Data untuk bertukar data dengan QGIS: ekspor area tampilan/poligon ke GeoJSON, edit di QGIS, lalu impor kembali.',
        steps: ['Pilih cakupan (tampilan peta atau poligon) dan tipe, tekan Periksa ukuran (maks. 10 MB).', 'Unduh .geojson, sunting di QGIS (atribut & geometri).', 'Impor berkas: sistem menampilkan pratinjau jumlah dibuat/diubah/dilewati sebelum diterapkan.'],
        tips: ['Objek yang sama tidak diduplikasi; penghapusan tidak diterapkan dari impor.'],
        perm: 'ekspor: gis.view · impor: gis.edit',
      },
    ],
  },
  {
    group: 'Monitoring Kelistrikan',
    items: [
      {
        id: 'g-mon',
        title: 'Tampilan monitoring',
        img: 'monitoring-overview',
        intro: 'Pita atas merangkum GI, trafo GI, penyulang, zona, gardu distribusi, trafo, pelanggan, beban, kejadian aktif, dan switch terbuka. Baris kedua menampilkan indeks keandalan.',
        steps: ['Klik widget (GI, penyulang, gardu, pelanggan) untuk langsung membuka daftar terkait di panel kanan.', 'Filter peta: Semua / Nyala / Padam; alat ukur panjang & luas; tombol UP3 untuk overlay wilayah.', 'Warna peta: hijau nyala, merah padam, lingkaran merah = switch terbuka.'],
      },
      {
        id: 'g-outages',
        title: 'Keandalan & kejadian padam',
        img: 'monitoring-outages',
        intro: 'SAIDI, SAIFI, ENS (kWh) dan ENS (Rupiah) dihitung dari kejadian padam pada periode terpilih (hari ini, bulan ini, tahun ini).',
        steps: ['Pilih periode di kotak Keandalan.', 'Tab Kejadian padam: centang Riwayat periode untuk melihat semua kejadian; filter per level (GI … pelanggan).', 'Tiap kejadian menampilkan penyebab, durasi, pelanggan·menit, ENS, dan rekap per group; Tampilkan di peta menyorot area terdampak.'],
        tips: ['Padam lebih singkat dari batas momentary (bawaan 5 menit) tidak masuk SAIDI/SAIFI.'],
      },
      {
        id: 'g-soe',
        title: 'SOE (Sequence of Events)',
        img: 'monitoring-soe',
        intro: 'Log kronologis realtime dengan cap waktu milidetik: switch buka/tutup, pemutusan, padam mulai/selesai, perubahan energisasi.',
        steps: ['Filter kategori, keparahan, jenis, atau cari kode/penyulang/pengguna.', 'Jeda untuk menahan event baru; Lanjut untuk menampilkannya.', 'Aktifkan lonceng untuk alarm suara event serius & kritis; unduh CSV.'],
      },
      {
        id: 'g-gi',
        title: 'Daftar GI, penyulang & gardu',
        img: 'monitoring-gi',
        intro: 'Tab GI, Penyulang, dan Gardu menampilkan status nyala/sebagian/padam beserta rekap trafo, penyulang, gardu, pelanggan, dan beban.',
        steps: ['Cari dan filter status.', 'Klik kode untuk menuju objek di peta.', 'Pada GI: "Lihat n penyulang" membuka tab Penyulang yang tersaring ke GI tersebut.'],
      },
      {
        id: 'g-feeders',
        title: 'Daftar penyulang',
        img: 'monitoring-feeders',
        intro: 'Status setiap penyulang (kubikel outgoing) beserta GI asal, gardu, pelanggan, dan beban nyala/total.',
        steps: ['Filter padam / sebagian / nyala; penyulang bermasalah tampil di atas.', 'Klik kode penyulang untuk memilih kubikelnya di peta.'],
      },
      {
        id: 'g-customers',
        title: 'Daftar pelanggan',
        img: 'monitoring-customers',
        intro: 'Daftar pelanggan nyala/padam (paging di server untuk jutaan pelanggan) dengan daya, penyulang, gardu, jurusan, dan informasi kejadian padam.',
        steps: ['Klik widget Pelanggan di pita atas atau buka tab Pelanggan.', 'Cari kode, nama, atau kode SSOT; filter padam/nyala.', '"Muat berikutnya" untuk halaman selanjutnya.'],
      },
      {
        id: 'g-operate',
        title: 'Operasi buka/tutup & energize/deenergize',
        img: 'monitoring-operate',
        intro: 'Klik objek di peta; popup menampilkan rekap hilir dan kotak operasi sesuai jenis objek dan izin peran.',
        steps: [
          'Alat switching: Buka (open) / Tutup (close); LBS 3 way dapat per arah.',
          'Objek lain dan saluran: Deenergize (padamkan) / Energize (nyalakan).',
          'Saat membuka/deenergize wajib memilih kategori GANGGUAN, PEMELIHARAAN, MLS, MANUVER, atau BENCANA ALAM, lalu konfirmasi.',
          'Saat menutup, kategori otomatis mengikuti kejadian padam yang dipulihkan.',
        ],
        perm: 'power.switch_tm / power.switch_tr / power.energize_tm / power.energize_tr',
        tips: ['Setiap operasi tercatat di kejadian padam, SOE, riwayat manuver, dan audit.'],
      },
      {
        id: 'g-mon-trace',
        title: 'Downtrace & uptrace dari monitoring',
        img: 'monitoring-trace',
        intro: 'Tombol Downtrace (hilir) dan Uptrace (hulu) pada popup objek, dengan tab Trace untuk pengaturan lanjutan.',
        steps: ['Pilih objek, tekan Downtrace atau Uptrace.', 'Ringkasan node, garis, panjang, pelanggan & rekap per tipe tampil di tab Trace.'],
        perm: 'gis.trace',
      },
      {
        id: 'g-up3',
        title: 'Overlay batas UP3',
        img: 'monitoring-up3',
        intro: 'Batas wilayah UP3 (dan garis ULP) ditampilkan di bawah jaringan dengan warna berbeda untuk wilayah bersebelahan.',
        steps: ['Tekan tombol UP3 di toolbar peta.', 'Atur tampil/sembunyi, garis ULP, label, dan transparansi isi.'],
      },
      {
        id: 'g-export',
        title: 'Ekspor data ke File Geodatabase (GDB)',
        img: 'monitoring-export',
        intro: 'Tab Export menyimpan data jaringan area tertentu sebagai File Geodatabase untuk ArcGIS/QGIS.',
        steps: ['Pilih cakupan: tampilan peta atau gambar poligon.', 'Pilih tipe dan filter status (semua/nyala/padam), periksa ukuran (maks. 10 MB).', 'Unduh berkas .gdb.zip.'],
      },
    ],
  },
  {
    group: 'Single Line Diagram',
    items: [
      {
        id: 'g-sld',
        title: 'Menyusun SLD otomatis',
        img: 'sld',
        intro: 'SLD disusun langsung dari data GIS (topologi normal) dan diperbarui realtime. Sumber di kiri, saluran utama lurus, cabang tegak lurus.',
        steps: [
          'Pilih cakupan: Penyulang, Gardu induk, Gardu distribusi, Objek, atau Area GIS (gambar poligon).',
          'Pilih tingkat detail: hanya TM, sampai trafo gardu, sampai jurusan TR, atau sampai pelanggan.',
          'Atur orientasi, warna (nyala/padam atau per tipe), label, tie/loop, dan lipat baris panjang (penanda K1, K2, ...).',
          'Ekspor SVG, PNG, atau PDF (A3 dengan kop) melalui dialog cetak.',
        ],
        tips: ['Garis putus-putus "NO → ..." adalah tie normally-open ke penyulang lain.', 'Label seksi menunjukkan panjang, penghantar, dan jumlah objek yang dilipat (+n).'],
      },
      {
        id: 'g-sld-op',
        title: 'Operasi dari SLD',
        img: 'sld-operate',
        intro: 'Klik simbol di diagram untuk membuka panel objek dengan kotak operasi yang sama seperti di peta.',
        steps: ['Pilih kategori, lalu Buka/Deenergize dan konfirmasi; diagram berubah warna dalam hitungan detik.', 'Lihat di peta / Monitoring untuk menyorot objek yang sama di peta.', 'Overlay aliran daya mewarnai seksi menurut pembebanan dan menampilkan tegangan pu.'],
        perm: 'sama dengan operasi di Monitoring',
      },
      {
        id: 'g-sld-gd',
        title: 'SLD gardu distribusi sampai pelanggan',
        img: 'sld-gd',
        intro: 'Cakupan gardu distribusi menggambar jalur hulu ringkas, trafo, rak TR, switch jurusan, jurusan, dan pelanggan.',
        steps: ['Pilih Gardu distribusi lalu cari kode gardu.', 'Atur posisi manual (izin gis.edit): seret elemen, simpan; tetap berlaku saat diagram disusun ulang.'],
      },
    ],
  },
  {
    group: 'Analisis & AI',
    items: [
      {
        id: 'g-pf',
        title: 'Aliran daya (power flow)',
        img: 'powerflow',
        intro: 'Menghitung tegangan, arus, pembebanan penghantar & trafo, dan susut per penyulang dengan metode backward/forward sweep.',
        steps: ['Atur skenario: faktor beban, cos φ, dan tegangan kirim (pu).', 'Hitung semua penyulang atau cari satu kubikel penyulang.', 'Tab Detail menampilkan node tegangan terendah & saluran pembebanan tertinggi; peta diwarnai hasilnya.'],
      },
      {
        id: 'g-ai',
        title: 'AI Assistant',
        img: 'ai',
        intro: 'Asisten percakapan yang dapat membaca kondisi jaringan terkini (rekap, kejadian padam, penyulang) untuk menjawab pertanyaan.',
        steps: ['Pilih penyedia (Claude, ChatGPT, Kimi, OpenRouter) dan model.', 'Centang "Sertakan data jaringan" agar AI memakai data aktual.', 'Admin mengisi kunci API lewat tombol Pengaturan.'],
        tips: ['Jawaban AI dapat keliru; verifikasi sebelum mengambil keputusan operasional.'],
        perm: 'ai.use (pengaturan: admin.config)',
      },
    ],
  },
  {
    group: 'Administrasi',
    items: [
      { id: 'g-users', title: 'Pengguna', img: 'admin-users', intro: 'Menambah, mengubah, menonaktifkan pengguna, dan menetapkan peran.', steps: ['Tambah pengguna: nama, email, kata sandi (sesuai kebijakan), peran.', 'Nonaktifkan akun alih-alih menghapus untuk menjaga jejak audit.'], perm: 'admin.users' },
      { id: 'g-roles', title: 'Peran & izin', img: 'admin-roles', intro: 'Peran mengelompokkan izin granular: lihat, edit, trace, operasi TM/TR, AI, administrasi.', steps: ['Buat atau ubah peran, centang izin yang diperlukan.', 'Perubahan izin berlaku paling lambat 30 detik tanpa perlu login ulang.'], perm: 'admin.roles' },
      { id: 'g-menus', title: 'Menu', img: 'admin-menus', intro: 'Mengatur menu samping: judul (ID/EN), ikon, urutan, induk, dan peran yang dapat melihat.', perm: 'admin.menus' },
      { id: 'g-config', title: 'Konfigurasi', img: 'admin-config', intro: 'Parameter aplikasi per grup: umum, loading, topologi, monitoring, keandalan, aliran daya, SLD, AI. Nilai rahasia disamarkan.', steps: ['Ubah nilai lalu simpan; sebagian parameter berlaku seketika.', 'Untuk nilai rahasia, biarkan kosong agar nilai lama tetap dipakai.'], perm: 'admin.config' },
      { id: 'g-layerset', title: 'Pengaturan layer', img: 'admin-layers', intro: 'Mengatur tipe komponen: nama, warna, simbol standar (dengan varian terbuka), zoom, ukuran, tegangan, topologi, arah switch, dan atribut SSOT.', perm: 'gis.settings' },
      { id: 'g-sysmon', title: 'Monitoring sistem', img: 'admin-monitoring', intro: 'Pemantauan server: CPU, memori, database, Redis, Kafka, WebSocket, dan kinerja API.', perm: 'admin.monitoring' },
    ],
  },
];

export const SECTIONS: DocSection[] = [
  { id: 'overview', title: 'Overview aplikasi', icon: 'info', body: overview },
  { id: 'features', title: 'Fitur aplikasi', icon: 'layers', body: features },
  { id: 'architecture', title: 'Arsitektur aplikasi', icon: 'database', body: architecture },
  { id: 'business', title: 'Proses bisnis', icon: 'activity', body: business },
  { id: 'install', title: 'Instalasi & konfigurasi', icon: 'settings', body: install },
  { id: 'guide', title: 'Buku panduan penggunaan', icon: 'book', guide },
];
