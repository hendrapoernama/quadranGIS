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
      <B>QuadranGIS</B> adalah aplikasi Sistem Informasi Geografis (GIS) jaringan distribusi listrik berbasis web. Satu aplikasi dipakai untuk membangun dan memelihara data aset jaringan (dari gardu
      induk sampai pelanggan) dengan alur persetujuan berjenjang, memantau kondisi nyala/padam secara realtime, mengoperasikan jaringan (buka/tutup, energize/deenergize) dengan hak akses per peran,
      menangani gangguan (FLISR, rencana manuver, laporan pelanggan), menghitung indeks keandalan per wilayah, menganalisis beban, energi & susut dari SCADA/AMR, menganalisis aliran daya, dan menyusun
      Single Line Diagram otomatis dari data GIS. Tersedia juga versi ponsel (PWA) untuk petugas lapangan.
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
        ['Admin sistem', 'Pengguna, peran & izin, menu, konfigurasi & identitas aplikasi, pemantauan server', 'Administrasi, Master Data'],
        ['Editor GIS', 'Menyusun perubahan aset (draf), atribut SSOT & unit pemilik, impor/ekspor QGIS', 'Map Editor › Editor Peta Jaringan'],
        ['Supervisor', 'Memeriksa & menyetujui / menolak paket perubahan jaringan', 'Map Editor › Persetujuan Perubahan'],
        ['Manajer', 'Menyetujui dan merilis paket perubahan ke jaringan aktif, laporan', 'Persetujuan Perubahan, Dashboard › Keandalan & Operasi'],
        ['Operator / Dispatcher', 'Monitoring realtime, manuver TM & TR, FLISR, rencana manuver, laporan gangguan', 'Pusat Operasi, SLD'],
        ['Operator TR (ULP)', 'Operasi jaringan tegangan rendah saja, laporan & foto lapangan', 'Pusat Operasi, Lapangan (ponsel)'],
        ['Manajemen', 'Kinerja keandalan, beban & energi, susut, laporan berkala', 'Dashboard › Keandalan & Operasi, Keandalan Wilayah, Analisa Beban & Energi'],
        ['Perencana / Viewer', 'Aliran daya, pembebanan, prakiraan, N-1, trace', 'Aliran Daya, Analisa Beban & Energi, SLD, AI'],
      ]}
    />
  </>
);

// ---------------------------------------------------------------- 2. fitur
const features = (
  <div className="my-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
    <FeatureCard
      icon="🗺️"
      title="Map Editor"
      items={[
        'Gambar titik, garis & bangunan (GI, GH, GD) dengan snapping',
        'Topologi otomatis: sambung, pisah garis, junction',
        'Atribut SSOT & unit pemilik per aset',
        'Edit vertex, pindah, gambar ulang, riwayat perubahan',
        'Simbol standar kelistrikan IEC 60617',
      ]}
    />
    <FeatureCard
      icon="✅"
      title="Persetujuan Perubahan"
      items={[
        'Setiap tambah/ubah/hapus menjadi paket perubahan',
        'Draf → diajukan → disetujui (supervisor) → dirilis (manajer)',
        'Pratinjau usulan di peta, perbandingan sebelum → sesudah',
        'Kunci objek, deteksi konflik, jejak audit lengkap',
      ]}
    />
    <FeatureCard
      icon="🔎"
      title="Topologi & Trace"
      items={['Graf jaringan di memori, jutaan node', 'Downtrace, uptrace, terhubung', 'Berhenti pada tipe tertentu, ringkasan per tipe', 'Validasi topologi (objek terisolasi, ujung bebas)']}
    />
    <FeatureCard
      icon="⚡"
      title="Pusat Operasi"
      items={[
        'Rekap GI, trafo GI, penyulang, zona, gardu, pelanggan, beban',
        'Peta nyala/padam realtime + filter',
        'Buka/tutup & energize/deenergize (hanya dari sini & SLD)',
        'Grup Operasi: FLISR, rencana manuver & simulasi, laporan gangguan, AI operasi',
      ]}
    />
    <FeatureCard
      icon="🧾"
      title="SOE Realtime"
      items={[
        'Sequence of Events presisi milidetik',
        'Identitas operator: nama, role, kanal (web/ponsel/SLD), IP',
        'Jeda/lanjut, filter, alarm suara, ekspor CSV',
        'Sinkron ulang otomatis bila koneksi putus',
      ]}
    />
    <FeatureCard
      icon="📊"
      title="Dashboard Keandalan & Operasi"
      items={[
        'KPI kondisi & kinerja periode vs target SAIDI/SAIFI',
        'Laporan berkala harian–tahunan, ringkasan AI, cetak PDF',
        'Keandalan per UP3/ULP di peta wilayah',
        'Wawasan otomatis & AI operasi',
      ]}
    />
    <FeatureCard
      icon="📈"
      title="Analisa Beban & Energi"
      items={[
        'Load profile trafo GI, penyulang & gardu (SCADA/AMR 30 menit)',
        'Besaran lengkap: arus & tegangan per fasa, P/Q/S, pf, frekuensi, kWh/kvarh',
        'Pembebanan MW, energi harian/bulanan/tahunan, anomali data',
        'Susut GI→penyulang→gardu→pelanggan (impor kWh tagihan bulanan)',
        'Prakiraan, N-1, laporan',
      ]}
    />
    <FeatureCard
      icon="📱"
      title="Lapangan (PWA)"
      items={['Dipasang di ponsel seperti aplikasi', 'Aset terdekat dengan GPS, foto aset', 'Laporan gangguan cepat, tetap tersimpan saat offline', 'Notifikasi push & peta area offline']}
    />
    <FeatureCard
      icon="📐"
      title="Single Line Diagram"
      items={[
        'Otomatis dari GIS: penyulang, GI, gardu, objek, area',
        '4 tingkat detail, penyederhanaan & lipatan baris',
        'Manuver langsung dari diagram, status realtime',
        'Overlay aliran daya, ekspor SVG/PNG/PDF',
      ]}
    />
    <FeatureCard
      icon="🔋"
      title="Aliran Daya"
      items={['Backward/forward sweep per penyulang', 'Tegangan (pu), arus, pembebanan penghantar & trafo, susut', 'Skenario faktor beban, cos φ, tegangan kirim', 'Kalibrasi beban dari data SCADA']}
    />
    <FeatureCard
      icon="🔁"
      title="Pertukaran Data"
      items={[
        'Ekspor/impor GeoJSON untuk diedit di QGIS',
        'Pratinjau & rekap impor: baru/ubah/sama/galat per layer',
        'Impor masuk paket perubahan (perlu persetujuan)',
        'Ekspor File Geodatabase (GDB) per area',
      ]}
    />
    <FeatureCard
      icon="🏘️"
      title="Pelanggan Kolektif (bulk)"
      items={[
        'Satu objek mewakili sekelompok pelanggan (perumahan, rusun, kawasan)',
        'Atribut jumlah pelanggan & total daya tersambung',
        'Dihitung sesuai jumlahnya di rekap, kejadian padam, SAIDI/SAIFI/ENS, FLISR, SLD, Data Aset, susut',
      ]}
    />
    <FeatureCard
      icon="🏢"
      title="Master Data Unit"
      items={[
        'PUSAT → REGION → UID/UP2B → UP3/UP2D → ULP',
        'Alamat, koordinat, kontak, wilayah kerja',
        'Kepemilikan aset (manual / otomatis dari lokasi)',
        'Dipakai analisa pembebanan & susut per wilayah',
      ]}
    />
    <FeatureCard
      icon="🌳"
      title="Master Data Aset"
      items={[
        'Hirarki GI → trafo GI → penyulang → gardu → trafo → jurusan → pelanggan',
        'Tampilan pohon (tree) & tabel data dengan jumlah pelanggan, beban, status',
        'Cari objek lalu tampilkan posisinya di pohon',
        'Filter tingkat, cakupan, status, unit pemilik; ekspor CSV',
      ]}
    />
    <FeatureCard
      icon="✨"
      title="AI Assistant"
      items={['Claude, ChatGPT, Kimi, OpenRouter', 'Menjawab dari data jaringan terkini (tool calling)', 'AI operasi: ringkasan gangguan, shift, laporan, beban']}
    />
    <FeatureCard
      icon="🛡️"
      title="Administrasi & Keamanan"
      items={[
        'Pengguna, peran & izin granular, menu dinamis bertingkat',
        'Identitas aplikasi: nama, deskripsi, logo',
        'Login captcha, JWT HttpOnly, HTTPS, audit log',
        'Tema terang/gelap (termasuk menu samping), Bahasa ID/EN',
      ]}
    />
  </div>
);

// ---------------------------------------------------------------- 3. arsitektur
const architecture = (
  <>
    <P>
      QuadranGIS berjalan sebagai sekumpulan container Docker. Pengguna hanya berinteraksi dengan <B>nginx</B> melalui HTTPS; nginx meneruskan halaman ke frontend Next.js dan panggilan <C>/api</C>{' '}
      serta WebSocket ke backend Go. Backend menyimpan data di PostgreSQL (PostGIS untuk geometri, TimescaleDB untuk metrik & event), memakai Redis untuk cache dan siaran realtime, serta Kafka untuk
      aliran event ke sistem lain.
    </P>
    <ArchitectureDiagram />
    <H3>Graf topologi di memori</H3>
    <P>
      Inti kecepatan aplikasi adalah graf jaringan yang dimuat di memori backend saat start (±20–35 detik untuk 2,7 juta node). Graf menyimpan konektivitas, posisi switch (saat ini & normal), jarak
      dari sumber, serta pengelompokan penyulang, zona, gardu, dan jurusan. Saat terjadi manuver, hanya wilayah terdampak yang dihitung ulang (inkremental), sehingga status nyala/padam diperbarui
      dalam milidetik. Trace, rekap monitoring, SLD, dan aliran daya membaca graf yang sama.
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
        { title: 'Draf perubahan', who: 'Editor GIS', desc: 'Gambar / ubah / hapus di Map Editor, atau impor GeoJSON (pratinjau & rekap). Semua masuk paket perubahan draf.', tone: 'client' },
        { title: 'Atribut & unit', who: 'Editor GIS', desc: 'Kode SSOT, kapasitas, daya, penghantar, dan unit pemilik aset.', tone: 'client' },
        { title: 'Ajukan', who: 'Editor GIS', desc: 'Paket diajukan dengan catatan; jaringan aktif belum berubah.', tone: 'client' },
        { title: 'Periksa & setujui', who: 'Supervisor', desc: 'Pratinjau di peta, sebelum → sesudah; setujui, atau tolak dengan alasan (kembali ke editor).', tone: 'app' },
        { title: 'Rilis', who: 'Manajer', desc: 'Operasi diputar ulang lewat editor bertopologi; konflik dicek lebih dulu.', tone: 'app' },
        { title: 'Topologi & energisasi', who: 'Sistem', desc: 'Sambungan, junction, status nyala/padam, penyulang, zona, gardu dihitung ulang.', tone: 'app' },
        { title: 'Siap dipakai', who: 'Semua', desc: 'Data tampil di Pusat Operasi, SLD, Aliran Daya, Analisa Beban, dan dapat diekspor.', tone: 'data' },
      ]}
      caption="Gambar 3. Alur pemeliharaan data aset jaringan dengan persetujuan berjenjang."
    />
    <H3 id="bp-ops">4.2 Operasi jaringan & penanganan gangguan</H3>
    <Flow
      steps={[
        { title: 'Kejadian / rencana', who: 'Dispatcher', desc: 'Laporan gangguan, jadwal pemeliharaan, atau perintah MLS/manuver.', tone: 'client' },
        { title: 'Temukan objek', who: 'Dispatcher', desc: 'Cari di peta Monitoring, SLD, atau tab GI/penyulang/gardu/pelanggan.', tone: 'client' },
        { title: 'Buka / deenergize', who: 'Operator (sesuai izin)', desc: 'Pilih kategori pemadaman, isi catatan, konfirmasi. Izin TM/TR dicek server.', tone: 'app' },
        { title: 'Dampak dihitung', who: 'Sistem', desc: 'Wilayah padam dihitung inkremental; rekap pelanggan & beban padam.', tone: 'app' },
        { title: 'Kejadian & SOE', who: 'Sistem', desc: 'Kejadian padam per level, SOE bertingkat keparahan beserta identitas operator, notifikasi push.', tone: 'data' },
        {
          title: 'FLISR / rencana',
          who: 'Dispatcher',
          desc: 'Lokasi gangguan dari arus relai, isolasi seksi gangguan & pemulihan lewat tie (cek kapasitas), atau rencana manuver bersimulasi.',
          tone: 'app',
        },
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
    <H3 id="bp-load">4.4 Analisa beban, energi & susut</H3>
    <Flow
      steps={[
        { title: 'Data SCADA / AMR', who: 'Sistem', desc: 'Pesan 30 menit trafo GI, penyulang, gardu lewat Kafka: arus & tegangan per fasa, P/Q/S, pf, frekuensi, kWh/kvarh.', tone: 'data' },
        { title: 'Rekap & anomali', who: 'Sistem', desc: 'Rekap harian MW & energi, profil dasar, deteksi data hilang/macet/lonjakan, beban lebih, frekuensi.', tone: 'app' },
        { title: 'Neraca energi', who: 'Sistem', desc: 'Trafo GI → Σ penyulang → Σ gardu per hari; susut distribusi & GI, cakupan meter.', tone: 'app' },
        { title: 'kWh pelanggan', who: 'Analis susut', desc: 'Impor kWh tagihan bulanan (CSV/XLSX per IDPEL); susut gardu → pelanggan per bulan, pelanggan 0 kWh / jam nyala rendah.', tone: 'client' },
        { title: 'Analisa', who: 'Perencana', desc: 'Per UID/UP3/GI/trafo/penyulang/gardu: harian, bulanan, tahunan, prakiraan, N-1.', tone: 'client' },
        { title: 'Laporan', who: 'Manajemen', desc: 'Laporan beban & susut otomatis (harian/bulanan/tahunan) + ringkasan AI.', tone: 'data' },
      ]}
      caption="Gambar 6. Alur analisa beban, energi, dan susut."
    />
    <H3 id="bp-admin">4.5 Tata kelola akses</H3>
    <Flow
      steps={[
        { title: 'Buat pengguna', who: 'Admin', desc: 'Akun, email, status aktif.', tone: 'client' },
        { title: 'Tetapkan peran', who: 'Admin', desc: 'Admin, editor, supervisor, manajer, operator, operator_tr, viewer, atau peran baru.', tone: 'client' },
        { title: 'Atur izin & menu', who: 'Admin', desc: 'Izin granular (mis. power.switch_tm) dan menu yang tampil per peran.', tone: 'app' },
        { title: 'Pantau & audit', who: 'Admin', desc: 'Audit log aksi, monitoring sistem, konfigurasi aplikasi.', tone: 'data' },
      ]}
      caption="Gambar 7. Tata kelola pengguna dan hak akses."
    />
    <H3>Matriks peran & izin</H3>
    <Table
      head={['Izin', 'Admin', 'Manajer', 'Supervisor', 'Editor', 'Operator', 'Operator TR', 'Viewer']}
      rows={[
        ['Lihat peta & monitoring (gis.view)', '✓', '✓', '✓', '✓', '✓', '✓', '✓'],
        ['Susun perubahan data GIS (gis.edit)', '✓', '–', '–', '✓', '–', '–', '–'],
        ['Setujui / tolak paket perubahan (gis.approve)', '✓', '✓', '✓', '–', '–', '–', '–'],
        ['Rilis paket ke jaringan aktif (gis.release)', '✓', '✓', '–', '–', '–', '–', '–'],
        ['Buka/tutup switch TM (power.switch_tm)', '✓', '–', '–', '✓', '✓', '–', '–'],
        ['Buka/tutup switch jurusan TR (power.switch_tr)', '✓', '–', '–', '✓', '✓', '✓', '–'],
        ['Energize/deenergize TM / TR (power.energize_*)', '✓', '–', '–', '✓', '✓', 'TR', '–'],
        ['Setujui rencana manuver (power.plan_approve)', '✓', '–', '–', '–', '✓', '–', '–'],
        ['Analisa beban (load.view) / kelola (load.manage)', '✓ / ✓', '✓ / –', '✓ / –', '✓ / –', '✓ / ✓', '–', '✓ / –'],
        ['Master data unit (master.view / master.manage)', '✓ / ✓', '✓ / ✓', '✓ / –', '✓ / –', '✓ / –', '✓ / –', '✓ / –'],
        ['Administrasi (admin.*)', '✓', '–', '–', '–', '–', '–', '–'],
      ]}
    />
    <P>Izin dapat diubah per peran di menu Administrasi › Roles; tabel di atas adalah pengaturan bawaan.</P>
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
        ['Identitas aplikasi', <C key="0">app.name, app.description, app.logo</C>, 'Nama, deskripsi & logo — diubah lewat bagian Identitas aplikasi'],
        ['Umum', <C key="1">app.map_center, map.boundary_opacity, unit.default_code</C>, 'Pusat peta, basemap, overlay UP3, unit bawaan kepemilikan aset'],
        ['Loading', <C key="2">loading.max_features_per_tile, loading.density_max_zoom</C>, 'Kinerja tile & kepadatan titik'],
        ['Topologi', <C key="3">topology.snap_tolerance_m, gis.approval_enabled, gis.approval_allow_self</C>, 'Toleransi snapping, pemisahan garis, alur persetujuan editing'],
        ['Monitoring', <C key="4">monitoring.default_daya_va, monitoring.soe_retention_days</C>, 'Daya bawaan pelanggan, interval refresh, retensi SOE'],
        ['Keandalan', <C key="5">reliability.tariff_rp_per_kwh, reliability.load_factor</C>, 'Tarif ENS Rupiah, faktor beban, cos φ, batas momentary'],
        ['Aliran daya', <C key="6">powerflow.source_pu, powerflow.default_trafo_kva</C>, 'Parameter perhitungan & batas tegangan'],
        ['SLD', <C key="7">sld.max_elements, sld.default_level</C>, 'Batas elemen & tingkat detail bawaan diagram'],
        ['Beban & energi', <C key="9">load.kafka_topic, load.simulator, load.cap_pf, load.energy_mode, load.losses_high_pct</C>, 'Topik SCADA, simulator, daya mampu MW, mode energi, batas susut'],
        ['Mobile', <C key="10">mobile.*, push.*</C>, 'PWA lapangan & notifikasi push'],
        ['AI', <C key="8">ai.default_provider, ai.anthropic_api_key</C>, 'Penyedia & kunci API AI (rahasia)'],
      ]}
    />
    <H3>Pengaturan layer (menu Administrasi › Pengaturan Layer)</H3>
    <P>
      Setiap tipe komponen (GI, trafo, recloser, SKTM, pelanggan, ...) dapat diatur nama, warna, simbol standar, zoom minimum tampil, zoom label, ukuran, tegangan, keikutsertaan topologi, jumlah arah
      switch, dan skema atribut SSOT.
    </P>
    <H3>Status operasi objek (rencana / non aktif / tidak operasi / bongkar)</H3>
    <P>
      Atribut <C>status_operasi</C> pada objek titik bertopologi (gardu, trafo, alat switching, pelanggan, ...): Operasi / Rencana / Non aktif / Tidak operasi / Bongkar, diubah di editor. Objek selain{' '}
      <strong>Operasi</strong> tidak dihitung di rekap nyala / padam (gardu, trafo, pelanggan, beban, SAIDI / SAIFI / ENS, pelanggan per wilayah, dampak kejadian, daftar pelanggan), tampil abu-abu di
      peta, dan berlabel sesuai statusnya (bukan PADAM) di panel fitur. Otomatis saat impor GDB: status GDB <C>INACTIVE</C> → Non aktif, <C>DECOMMISSIONED</C> → Bongkar (gardu, trafo, PHB-TR,
      pelanggan), pelanggan tanpa SR → Tidak operasi, gardu berkode / bernomor mengandung kata <C>REN</C> / <C>RENCANA</C> → Rencana.
    </P>
    <H3>Integrasi Kafka: energize / de-energize dari sistem eksternal (menu Administrasi › Integrasi Kafka)</H3>
    <P>
      Sistem eksternal (SCADA, DMS, AMI, ...) membuka / menutup objek jaringan dengan mengirim pesan JSON ke topik Kafka <C>scada.switch.events</C>
      (konfigurasi <C>scada.switch_topic</C>). Pesan diproses lewat jalur yang sama dengan operator: kejadian padam, SAIDI / SAIFI / ENS, SOE (kanal Kafka), notifikasi, dan audit; pelaku dicatat
      sebagai <C>scada</C> + nama sistem pengirim.
    </P>
    <Table
      head={['Kolom', 'Nama lain', 'Keterangan']}
      rows={[
        ['code', 'kode, name, nama', 'Kode / nama objek (juga kode SSOT atau IDPEL). Alternatif: id (id objek QuadranGIS).'],
        ['type', 'jenis, type_code', 'Jenis objek: kode tipe (recloser, gd, pelanggan_tr, ...) atau nama tipe — untuk kode yang dipakai beberapa objek.'],
        ['status', 'action, aksi', 'open = buka / de-energize, close = tutup / energize (juga buka/tutup, off/on, trip, deenergize/energize).'],
        ['outage_category', 'kategori, category', 'GANGGUAN / PEMELIHARAAN / MLS / MANUVER / BENCANA ALAM — wajib untuk open.'],
        ['timestamp', 'tanggal, date, waktu', 'Waktu kejadian: ISO 8601, "YYYY-MM-DD HH:MM:SS" (WIB), atau epoch; dipakai sebagai waktu mulai / selesai padam.'],
        ['event_id', 'message_id', 'Id unik pesan: pesan dengan id sama tidak diproses dua kali.'],
        ['note, source', 'catatan, sumber', 'Catatan (SOE & riwayat manuver) dan nama sistem pengirim.'],
      ]}
    />
    <ul className="my-2 list-disc space-y-1 pl-5 text-[14px] text-gray-700">
      <li>
        Contoh: <C>{'{"event_id":"SCADA-000123","code":"REC-GMB-02-05","type":"recloser","status":"open","outage_category":"GANGGUAN","timestamp":"2026-09-29T10:15:00+07:00"}'}</C>
      </li>
      <li>Gunakan kode objek sebagai kunci (key) pesan Kafka agar urutan perintah satu objek terjaga.</li>
      <li>
        Hasil setiap pesan dicatat (tabel <C>switch_events</C>): Diterapkan, Dilewati (status objek sudah sama), Duplikat (event_id sudah diproses), atau Galat (objek tidak ditemukan / ambigu, format
        salah). Halaman admin menampilkan log, format pesan, dan pengiriman uji (lewat Kafka atau proses langsung).
      </li>
      <li>
        Konfigurasi: <C>scada.switch_enabled</C>, <C>scada.switch_topic</C> & <C>scada.switch_group</C> (ubah = mulai ulang backend), <C>scada.switch_username</C>,<C>scada.switch_max_future_sec</C>.
      </li>
    </ul>
    <H3>Impor GDB (menu Administrasi › Impor GDB)</H3>
    <P>
      Mengimpor jaringan dari Esri File Geodatabase PLN (geometric network ESRI) — kompres folder <C>*.gdb</C> menjadi ZIP (maks. 1 GB), isi tag batch, lalu
      <strong> Mulai impor</strong>. Proses berjalan di latar belakang: ekstrak & periksa 18 layer wajib, muat ke skema staging (ogr2ogr), petakan tipe & potong garis di simpul, tetapkan unit pemilik
      dari lokasi (opsional), hapus staging, bangun ulang topologi. Contoh data ULP Kramat Jati (±450 rb fitur, 85 MB ZIP) selesai ±5,5 menit.
    </P>
    <ul className="my-2 list-disc space-y-1 pl-5 text-[14px] text-gray-700">
      <li>
        Pemetaan: JTM → SUTM/SKTM, JTR → SKUTR, LVCABLE → SKTR, SR → SR, BUSBAR_LINE → rel GI / rel gardu, MVCELL → FCO / PMT / LBS, SWITCH → switch jurusan TR (sisi TR) / PMS, GD → gardu (BLOKGARDU =
        denah), TRAFO → trafo distribusi, PHBTR → rak TR, PELANGGAN → pelanggan TR, TIANG → tiang TM/TR (objek pendukung, tidak tersambung). Status INACTIVE → terbuka.
      </li>
      <li>
        Semua objek hasil impor bertanda <C>properties.import = tag</C> (objek sintesis — kepala penyulang di GI bila ada celah data — juga
        <C>sintesis: true</C>). Tag yang sama menggantikan batch sebelumnya; <strong>Hapus batch</strong> menampilkan jumlah objek & saluran manual yang ikut terhapus sebelum dijalankan.
      </li>
      <li>
        Impor ditulis langsung, tidak melalui alur persetujuan editing. Izin: <C>admin.config</C>.
      </li>
      <li>
        Denah gardu di GDB sering berupa miniatur skematik (mis. 0,5 m dengan komponen berjarak 3–5 cm) sehingga simbol menumpuk bahkan di zoom maksimum. Saat impor, denah gardu kecil diperbesar
        hingga ±10 m (dibatasi 90% jarak ke gardu terdekat, skala maks. 25×) mengelilingi titik pusatnya — komponen, ujung & vertex saluran di dalam denah ikut bergeser, sambungan topologi tetap.
        Posisi asli disimpan di tabel <C>gis_layout_backup</C>; skala per gardu di atribut <C>denah_skala</C>.
      </li>
      <li>
        Batas data sumber yang perlu diperiksa setelah impor: titik buka normal (normally-open) tidak tersedia di GDB, dan GI tanpa kubikel / trafo GI di wilayah data tidak memiliki penyulang.
        Pelanggan tanpa SR otomatis diberi <C>status_operasi = Tidak operasi</C>.
      </li>
    </ul>
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
        ['Tombol operasi tidak tampil', 'Operasi buka/tutup hanya di Pusat Operasi & SLD; peran perlu izin power.switch_* / power.energize_*'],
        ['Perubahan di editor tidak muncul di Pusat Operasi', 'Perubahan masih usulan (paket draf); ajukan, setujui, lalu rilis di Persetujuan Perubahan'],
        ['Tidak bisa menyetujui paket', 'Penyusun tidak boleh menyetujui paketnya sendiri; perlu izin gis.approve (rilis: gis.release)'],
        ['Data beban sintetis', 'Simulator SCADA aktif (load.simulator); matikan saat SCADA/AMR asli tersambung'],
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
        steps: [
          'Isi nama pengguna dan kata sandi.',
          'Jawab captcha penjumlahan/perkalian sederhana.',
          <>
            Tekan <B>Masuk</B>. Setelah beberapa kali gagal, login dikunci sementara.
          </>,
        ],
        tips: ['Nama, deskripsi, dan logo pada halaman masuk mengikuti Identitas aplikasi.', 'Keluar lewat tombol Keluar di pojok kiri bawah.'],
      },
      {
        id: 'g-theme',
        title: 'Menu samping, tema & bahasa',
        img: 'theme-light',
        intro: 'Menu samping menampilkan menu sesuai peran, dengan submenu bertingkat (mis. Map Editor › Editor Peta Jaringan & Persetujuan Perubahan). Warna menu mengikuti tema terang atau gelap.',
        steps: ['Tekan tombol tema di bawah menu: Terang → Gelap → Ikuti sistem.', 'Pilih bahasa ID / EN.', 'Ciutkan menu dengan tombol panah, atau sembunyikan seluruhnya dengan tombol panel.'],
        tips: ['Pilihan tema & bahasa tersimpan di browser masing-masing pengguna.'],
      },
    ],
  },
  {
    group: 'Map Editor',
    items: [
      {
        id: 'g-map',
        title: 'Tampilan editor peta',
        img: 'map-overview',
        intro:
          'Menu Map Editor › Editor Peta Jaringan: halaman kerja untuk melihat dan menyunting jaringan. Kiri: toolbar gambar; atas: pencarian; kanan: panel Layer, Fitur, Trace, Data, dan Perubahan.',
        steps: [
          'Geser & zoom peta dengan mouse; objek kecil (pelanggan, SR) muncul pada zoom tinggi.',
          'Cari objek berdasarkan kode, nama, id, atau kode SSOT di kotak pencarian.',
          'Klik objek untuk membuka panel Fitur.',
        ],
        perm: 'gis.view (menyunting: gis.edit)',
      },
      {
        id: 'g-layers',
        title: 'Layer, peta dasar & overlay UP3',
        img: 'map-layers',
        intro: 'Tab Layer mengatur tampilan: tipe yang tampil, peta dasar, label, pewarnaan (per tipe atau nyala/padam), dan overlay batas wilayah UP3/ULP.',
        steps: [
          'Centang/kosongkan tipe komponen; "Semua"/"Kosongkan" untuk sekaligus.',
          'Pilih peta dasar: ikuti tema, OSM terang, OSM gelap, atau tanpa peta dasar.',
          'Pada "Batas wilayah UP3": tampilkan batas, garis ULP, label, dan geser slider transparansi.',
        ],
        tips: ['Legenda memakai simbol standar yang sama dengan peta.', 'Pilihan overlay tersimpan di browser masing-masing pengguna.'],
      },
      {
        id: 'g-feature',
        title: 'Informasi & atribut objek',
        img: 'map-feature',
        intro: 'Panel Fitur menampilkan tipe, kode, status, penyulang/zona/gardu/jurusan, rekap pelanggan hilir, unit pemilik, atribut SSOT, konektivitas, dan riwayat.',
        steps: [
          'Ubah kode, nama, unit pemilik, atau atribut SSOT lalu tekan Simpan usulan.',
          'Unit pemilik kosong berarti ditetapkan otomatis dari lokasi (ULP/UP3 terdekat).',
          'Gunakan Pindahkan / Gambar ulang / Edit vertex untuk mengubah geometri.',
          'Tombol Buka SLD membuka diagram satu garis objek tersebut.',
        ],
        tips: ['Buka/tutup switch dan energize/deenergize tidak ada di editor — lakukan di Pusat Operasi atau SLD.'],
        perm: 'gis.edit untuk menyusun perubahan',
      },
      {
        id: 'g-draw',
        title: 'Menggambar komponen',
        img: 'map-draw',
        intro: 'Toolbar kiri menyediakan alat pilih, gambar titik, gambar garis, pindah, dan ukur. Topologi dibentuk otomatis saat menyimpan.',
        steps: [
          'Pilih ikon titik atau garis, lalu pilih tipe komponen (mis. SKTM, SKUTR, SR).',
          <>
            Klik di peta untuk setiap vertex; <K>Enter</K>/dobel-klik selesai, <K>Backspace</K> hapus vertex terakhir, <K>Esc</K> batal.
          </>,
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
        steps: [
          'Pilih titik (mis. kubikel penyulang), tekan Trace hilir / Trace hulu / Terhubung.',
          'Atur kedalaman dan tipe pemberhentian di tab Trace bila perlu.',
          'Hasil disorot oranye; ringkasan per tipe, panjang, dan pelanggan tampil di panel; unduh GeoJSON.',
        ],
        perm: 'gis.trace',
      },
      {
        id: 'g-data',
        title: 'Ekspor & impor GeoJSON (QGIS)',
        img: 'map-data',
        intro: 'Tab Data untuk bertukar data dengan QGIS: ekspor area tampilan/poligon ke GeoJSON, edit di QGIS, lalu impor kembali.',
        steps: [
          'Pilih cakupan (tampilan peta atau poligon) dan tipe, tekan Periksa ukuran (maks. 10 MB).',
          'Unduh .geojson, sunting di QGIS (atribut & geometri).',
          'Impor berkas: pratinjau lengkap tampil sebelum diterapkan (lihat panduan berikut).',
        ],
        tips: ['Objek yang sama tidak diduplikasi; penghapusan tidak diterapkan dari impor.'],
        perm: 'ekspor: gis.view · impor: gis.edit',
      },
      {
        id: 'g-import',
        title: 'Pratinjau & rekap impor GeoJSON',
        img: 'map-import',
        intro: 'Setelah berkas dipilih, sistem memvalidasi setiap fitur tanpa mengubah data, lalu menampilkan ringkasan dan daftar berhasil / gagal.',
        steps: [
          'Baca kartu ringkasan: jumlah fitur, baru, ubah, sama, dan galat.',
          'Periksa Rekap per layer, lalu saring daftar (baru / ubah / galat) dan baca alasan galat per fitur.',
          'Tampilkan di peta untuk melihat lokasi fitur (hijau baru, biru ubah, merah galat); unduh CSV daftar galat untuk diperbaiki di QGIS.',
          'Tekan Terapkan: dalam mode persetujuan, perubahan masuk paket perubahan baru untuk diajukan.',
        ],
        tips: ['Galat yang diperiksa: geometri & jenis, type_code wajib, kode ganda di berkas, atribut SSOT bentrok, titik menumpuk objek lain.'],
        perm: 'gis.edit',
      },
      {
        id: 'g-approval-edit',
        title: 'Menyusun perubahan (paket draf)',
        img: 'map-approval',
        intro: 'Setiap tambah, ubah, hapus, pisah, atau gabung di editor disimpan sebagai usulan pada paket perubahan. Jaringan aktif baru berubah setelah paket disetujui dan dirilis.',
        steps: [
          'Mulai menyunting seperti biasa; paket draf dibuat otomatis pada perubahan pertama (atau tekan + di tab Perubahan).',
          'Usulan tampil di peta: oranye = baru, biru = diubah, merah = dihapus, ungu = pisah/gabung. Klik untuk mengubah atau membatalkannya.',
          'Di tab Perubahan: isi judul & alasan, periksa daftar, batalkan item yang tidak perlu (×).',
          'Tekan Ajukan untuk disetujui.',
        ],
        tips: ['Satu objek aktif hanya boleh diusulkan di satu paket terbuka.', 'Paket yang ditolak kembali berstatus dapat diubah; perbaiki lalu ajukan ulang.'],
        perm: 'gis.edit',
      },
      {
        id: 'g-approval',
        title: 'Persetujuan Perubahan',
        img: 'changes',
        intro: 'Menu Map Editor › Persetujuan Perubahan: daftar paket per status dengan tahapan, perbandingan sebelum → sesudah, konflik, dan jejak audit.',
        steps: [
          'Pilih filter Perlu tindakan (sesuai izin), Diajukan, Disetujui, Dirilis, Ditolak, Draf, atau Semua.',
          'Buka paket: periksa daftar perubahan dan Lihat di peta.',
          'Supervisor: Setujui, atau Tolak dengan alasan wajib.',
          'Manajer: Rilis ke jaringan aktif; hasil diterapkan/gagal per item tercatat.',
        ],
        tips: ['Penyusun tidak dapat menyetujui paketnya sendiri.', 'Bila objek berubah setelah diusulkan, rilis ditolak; tolak paket agar penyusun menyinkronkan item tersebut.'],
        perm: 'gis.approve (setujui/tolak) · gis.release (rilis)',
      },
    ],
  },
  {
    group: 'Pusat Operasi',
    items: [
      {
        id: 'g-mon',
        title: 'Tampilan monitoring',
        img: 'monitoring-overview',
        intro: 'Pita atas merangkum GI, trafo GI, penyulang, zona, gardu distribusi, trafo, pelanggan, beban, kejadian aktif, dan switch terbuka. Baris kedua menampilkan indeks keandalan.',
        steps: [
          'Klik widget (GI, penyulang, gardu, pelanggan) untuk langsung membuka daftar terkait di panel kanan.',
          'Filter peta: Semua / Nyala / Padam; alat ukur panjang & luas; tombol UP3 untuk overlay wilayah.',
          'Warna peta: hijau nyala, merah padam, lingkaran merah = switch terbuka.',
        ],
      },
      {
        id: 'g-outages',
        title: 'Keandalan & kejadian padam',
        img: 'monitoring-outages',
        intro: 'SAIDI, SAIFI, ENS (kWh) dan ENS (Rupiah) dihitung dari kejadian padam pada periode terpilih (hari ini, bulan ini, tahun ini).',
        steps: [
          'Pilih periode di kotak Keandalan.',
          'Tab Kejadian padam: centang Riwayat periode untuk melihat semua kejadian; filter per level (GI … pelanggan).',
          'Tiap kejadian menampilkan penyebab, durasi, pelanggan·menit, ENS, dan rekap per group; Tampilkan di peta menyorot area terdampak.',
        ],
        tips: ['Padam lebih singkat dari batas momentary (bawaan 5 menit) tidak masuk SAIDI/SAIFI.'],
      },
      {
        id: 'g-soe',
        title: 'SOE (Sequence of Events)',
        img: 'monitoring-soe',
        intro:
          'Log kronologis realtime dengan cap waktu milidetik: switch buka/tutup, pemutusan, padam mulai/selesai, perubahan energisasi — lengkap dengan identitas operator (nama, username, role, kanal web/ponsel/SLD, alamat IP).',
        steps: [
          'Filter kategori, keparahan, jenis, atau cari kode/penyulang/pengguna.',
          'Klik nama operator untuk menampilkan semua event oleh operator tersebut.',
          'Jeda untuk menahan event baru; Lanjut untuk menampilkannya.',
          'Aktifkan lonceng untuk alarm suara event serius & kritis; unduh CSV (termasuk kolom operator).',
        ],
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
        intro: 'Buka/tutup dan energize/deenergize hanya dilakukan di Pusat Operasi (dan SLD). Klik objek di peta; popup menampilkan rekap hilir dan kotak operasi sesuai jenis objek dan izin peran.',
        steps: [
          'Alat switching (kubikel, recloser, LBS, FCO, PMT, PMS, switch jurusan): Buka (open) / Tutup (close); LBS 3 way dapat per arah. FCO putus dicatat sebagai Buka dengan kategori GANGGUAN.',
          'PMT / PMS gardu beton & gardu hubung dapat berfungsi sebagai pembatas zona atau hanya pemutus (atribut Pembatas zona; bawaan PMT = Ya, PMS = Tidak).',
          'Objek lain dan saluran: Deenergize (padamkan) / Energize (nyalakan).',
          'Saat membuka/deenergize wajib memilih kategori GANGGUAN, PEMELIHARAAN, MLS, MANUVER, atau BENCANA ALAM, lalu konfirmasi.',
          'Saat menutup, kategori otomatis mengikuti kejadian padam yang dipulihkan.',
        ],
        perm: 'power.switch_tm / power.switch_tr / power.energize_tm / power.energize_tr',
        tips: ['Setiap operasi tercatat di kejadian padam, SOE, riwayat manuver, dan audit — beserta identitas operator (nama, role, kanal web/ponsel/SLD, alamat IP).'],
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
        id: 'g-flisr',
        title: 'FLISR (isolasi gangguan & pemulihan)',
        img: 'ops-flisr',
        intro: 'Grup Operasi › FLISR: dari kejadian padam aktif, sistem menyusun langkah isolasi seksi gangguan, pemulihan hulu, dan pemulihan hilir lewat tie dengan cek kapasitas penyulang.',
        steps: [
          'Pilih kejadian padam aktif, atau pilih objek di peta sebagai lokasi gangguan untuk analisis proaktif.',
          'Tentukan seksi gangguan; tinjau langkah dan beban yang dipulihkan.',
          'Jalankan langkah (sesuai izin) atau simpan sebagai rencana manuver.',
        ],
        perm: 'power.plan',
      },
      {
        id: 'g-faultloc',
        title: 'Lokasi gangguan dari arus relai',
        img: 'ops-flisr',
        intro: 'Di tab FLISR, panel Lokasi gangguan dari arus relai memperkirakan titik gangguan TM dari arus gangguan yang terbaca relai pada alat yang trip (PMT, recloser, kubikel).',
        steps: [
          'Pilih kejadian padam (alat penyebab otomatis menjadi alat trip) atau pilih alat di peta lalu Pakai objek terpilih.',
          'Pilih jenis gangguan (3 fasa, fasa-fasa, fasa-tanah) dan isi arus gangguan; atau isi arus per fasa Ia/Ib/Ic/In agar jenis gangguan dideteksi otomatis.',
          'Bila perlu, ubah parameter sumber & saluran: daya hubung singkat busbar, X/R, NGR, tahanan gangguan, Z0/Z1, toleransi.',
          'Tekan Hitung lokasi: kandidat tampil urut jarak dari alat, di peta merah (kandidat) dan oranye (saluran dalam toleransi).',
          'Tekan Analisa FLISR pada kandidat untuk menyusun isolasi dan pemulihan dari lokasi itu.',
        ],
        tips: [
          'Daya hubung singkat & NGR diambil dari atribut trafo GI / GI (daya_hs_mva, ngr_ohm) bila diisi, selain itu dari konfigurasi fault.*.',
          'Jaringan bercabang bisa menghasilkan beberapa kandidat dengan jarak sama; padukan dengan laporan pelanggan atau hasil patroli.',
          'Perhitungan tanpa arus beban dan memakai impedansi penghantar per tipe (dapat ditimpa per saluran r_ohm_km / x_ohm_km).',
        ],
        perm: 'gis.view',
      },
      {
        id: 'g-plans',
        title: 'Rencana manuver & simulasi what-if',
        img: 'ops-plans',
        intro: 'Menyusun urutan buka/tutup, menyimulasikan dampaknya (pelanggan & beban padam, pembebanan penyulang) sebelum dijalankan, lalu disetujui dan dieksekusi.',
        steps: ['Tekan Rencana baru, tambah langkah dari objek di peta.', 'Simulasikan; periksa dampak & peringatan kapasitas.', 'Ajukan persetujuan, lalu jalankan langkah satu per satu.'],
        perm: 'power.plan · persetujuan: power.plan_approve',
      },
      {
        id: 'g-reports',
        title: 'Laporan gangguan pelanggan',
        img: 'ops-reports',
        intro: 'Laporan dari pelanggan, petugas lapangan (PWA), atau operator; dikaitkan otomatis dengan kejadian padam dan dipantau terhadap SLA.',
        steps: ['Buat / terima laporan, lihat lokasinya di peta.', 'Tindak lanjuti: tugaskan, ubah status, tutup.'],
        perm: 'report.manage',
      },
      {
        id: 'g-aiops',
        title: 'AI operasi',
        img: 'ops-ai',
        intro: 'Ringkasan dan saran berbasis AI dari data operasi terkini: analisis gangguan, rencana manuver, laporan shift, ringkasan laporan, wawasan, dan pembebanan.',
        steps: ['Pilih jenis tugas AI, tekan jalankan; jawaban tampil bertahap.', 'Gunakan hasilnya sebagai narasi laporan (dapat disunting).'],
        tips: ['Jawaban AI dapat keliru; verifikasi sebelum mengambil keputusan operasional.'],
        perm: 'ai.use',
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
    group: 'Dashboard & Keandalan Wilayah',
    items: [
      {
        id: 'g-exec',
        title: 'Keandalan & Operasi',
        img: 'executive',
        intro:
          'Menu Dashboard › Keandalan & Operasi (sebelumnya Dasbor Eksekutif). Ringkasan kondisi saat ini dan kinerja periode (hari ini, bulan ini, 30 hari, tahun ini): SAIDI, SAIFI, ENS, kejadian padam, laporan & SLA, tahun berjalan vs target.',
        steps: ['Pilih periode; bandingkan dengan periode sebelumnya.', 'Lihat tren SAIDI 12 bulan, kejadian per hari, kategori, penyulang terdampak, dan wilayah dengan SAIDI tertinggi.'],
        perm: 'exec.view',
      },
      {
        id: 'g-exec-reports',
        title: 'Laporan berkala',
        img: 'executive-reports',
        intro: 'Laporan keandalan harian, mingguan, bulanan, dan tahunan dibuat otomatis setiap periode selesai atau manual.',
        steps: ['Buka tab Laporan Berkala, pilih laporan.', 'Susun ringkasan dengan AI, cetak / simpan PDF, atau unduh CSV.'],
        perm: 'exec.view · membuat/menghapus: exec.report',
      },
      {
        id: 'g-reliability',
        title: 'Keandalan wilayah UP3 / ULP',
        img: 'reliability',
        intro: 'SAIDI, SAIFI, ENS, dan kejadian per UP3 dan ULP ditampilkan di peta wilayah dan tabel peringkat.',
        steps: ['Pilih periode dan tingkat wilayah (UP3 / ULP).', 'Klik wilayah untuk rinciannya; urutkan tabel menurut indikator.'],
        perm: 'exec.view',
      },
    ],
  },
  {
    group: 'Analisa Beban & Energi',
    items: [
      {
        id: 'g-load',
        title: 'Ringkasan beban & energi',
        img: 'load-overview',
        intro:
          'Menu Analisa Beban & Energi: load profile trafo GI, penyulang, dan gardu distribusi dari SCADA/AMR per 30 menit. Beban dalam MW; pembebanan % = MW ÷ daya mampu (rating MVA × faktor daya kapasitas).',
        steps: [
          'Baca kartu: titik ukur, kelengkapan data, puncak hari ini & kemarin, energi, susut kemarin, beban lebih, anomali.',
          'Klik titik pada daftar pembebanan tertinggi (penyulang/trafo & gardu) untuk membuka analisanya.',
        ],
        perm: 'load.view',
      },
      {
        id: 'g-load-analysis',
        title: 'Analisa harian, bulanan, tahunan',
        img: 'load-analysis',
        intro: 'Pilih objek (Sistem, UID, UP3, GI, Trafo GI, Penyulang, Gardu) dan periode.',
        steps: [
          'Harian: kurva MW vs minggu lalu & prakiraan; untuk satu titik tersedia panel Besaran SCADA (arus & tegangan per fasa, P/Q/S, pf & frekuensi, energi kWh/kvarh, tabel data + CSV).',
          'Bulanan: puncak & energi harian, peta panas hari × jam.',
          'Tahunan: puncak bulanan vs tahun lalu, kurva lama beban, tabel bulanan.',
        ],
        perm: 'load.view',
      },
      {
        id: 'g-losses',
        title: 'Susut energi (losses)',
        img: 'load-losses',
        intro: 'Neraca energi harian antar-tingkat meter: trafo GI → Σ penyulang (selisih GI) dan penyulang → Σ gardu (susut distribusi JTM + trafo gardu).',
        steps: [
          'Pilih cakupan (sistem, UID, UP3, GI, trafo GI, penyulang) dan periode (harian, 30 hari, bulanan, tahunan).',
          'Baca susut distribusi, selisih GI, susut gabungan, cakupan meter, dan rantai energi.',
          'Klik penyulang pada tabel untuk profil 30 menit dan dekomposisi susut (tetap, sebanding beban, kuadrat beban) serta energi tiap gardu.',
        ],
        tips: [
          'Bila tidak semua gardu bermeter, energi gardu diperkirakan dari cakupan kapasitas; hari dengan cakupan rendah tidak dihitung.',
          'Susut negatif menandakan kesalahan meter atau gardu tercatat di penyulang lain.',
        ],
        perm: 'load.view',
      },
      {
        id: 'g-losses-customers',
        title: 'Susut gardu → pelanggan (kWh tagihan bulanan)',
        img: 'load-billing',
        intro:
          'Tab Susut › Gardu → pelanggan (bulanan): susut tiap gardu distribusi = energi keluar gardu dari meter AMR sebulan − Σ kWh pelanggan di bawahnya dari data tagihan. Mencakup susut JTR, SR, dan non-teknis. Data kWh pelanggan tidak berasal dari SCADA, tetapi diimpor per bulan.',
        steps: [
          'Tekan Impor kWh pelanggan, pilih berkas CSV atau XLSX (kolom wajib IDPEL dan kWh; opsional BLTH, nama, tarif, daya). Unduh template bila perlu.',
          'Bila berkas tidak memiliki kolom BLTH, pilih periodenya. Tekan Pratinjau: periksa baris sah, galat, baris ganda (dijumlahkan), IDPEL yang cocok / tidak ditemukan, dan data lama pada periode itu.',
          'Tekan Simpan. Centang Ganti seluruh data periode bila berkas adalah data lengkap pengganti.',
          'Pilih periode tagihan, bulan energi gardu (sama dengan BLTH atau 1–2 bulan sebelumnya), UP3/ULP, dan filter status; urutkan tabel menurut susut %. Rekap per penyulang tampil di sampingnya.',
          'Klik gardu untuk tren 12 bulan (energi gardu vs kWh terjual) dan daftar pelanggan dengan jam nyala; pelanggan bertanda tampil paling atas.',
        ],
        tips: [
          'IDPEL dicocokkan ke atribut idpel pelanggan GIS, lalu kode SSOT, lalu kode objek. Unduh daftar IDPEL tak ditemukan untuk melengkapi data GIS.',
          'Gardu dihitung bila data AMR mencakup ≥ 80% hari dan pelanggan bertagihan ≥ 90% pelanggan GIS (konfigurasi load.lv_*). Gardu tanpa meter AMR hanya menampilkan kWh terjual.',
          'Tanda pelanggan: 0 kWh, jam nyala < 40 jam (indikasi P2TL), tanpa tagihan, atau melebihi daya (data daya / kWh keliru).',
          'BLTH umumnya memuat pemakaian bulan sebelumnya; atur bawaan pergeseran di konfigurasi load.lv_billing_lag_months.',
        ],
        perm: 'load.view · impor / hapus: load.manage',
      },
      {
        id: 'g-load-anomalies',
        title: 'Anomali data & beban',
        img: 'load-anomalies',
        intro:
          'Anomali kualitas data (hilang, macet, di luar batas, beban nol, lonjakan, energi ≠ daya, incoming ≠ Σ penyulang) dan kondisi jaringan (beban lebih, tidak seimbang, pf rendah, tegangan, frekuensi, susut, pergeseran level).',
        steps: ['Saring jenis, tingkat, status, dan rentang hari.', 'Buka anomali untuk melihat data di sekitarnya; tandai ditangani atau selesaikan dengan catatan.'],
        perm: 'load.view · tindak lanjut: load.manage',
      },
      {
        id: 'g-load-reports',
        title: 'Laporan beban',
        img: 'load-reports',
        intro: 'Laporan beban harian, bulanan, tahunan otomatis: beban sistem (MW) vs periode sebelumnya & tahun lalu, energi, beban per UID/UP3/GI, titik & gardu terberat, susut, dan anomali.',
        steps: ['Pilih laporan atau buat laporan baru.', 'Cetak / PDF, CSV, atau susun ringkasan AI.'],
        perm: 'load.view · membuat: load.manage',
      },
      {
        id: 'g-load-adv',
        title: 'Analisa lanjutan',
        img: 'load-advanced',
        intro: 'Prakiraan beban & proyeksi puncak 12 bulan, kontingensi N-1, beban gardu (terukur / alokasi), karakter beban, kesehatan aset, kalibrasi simulasi, dan AI pembebanan.',
        steps: ['Pilih subtab analisa, lalu objeknya.'],
        perm: 'load.view',
      },
    ],
  },
  {
    group: 'Lapangan (ponsel / PWA)',
    items: [
      {
        id: 'g-field',
        title: 'Aplikasi lapangan',
        img: 'field',
        intro: 'Versi ponsel yang dapat dipasang seperti aplikasi (Tambahkan ke layar utama). Menu bawah berisi Keandalan & Operasi, Pusat Operasi, Lapangan, SLD, dan Menu.',
        steps: [
          'Aktifkan GPS untuk melihat aset terdekat (gardu, proteksi/switch, tiang, pelanggan).',
          'Laporan gangguan cepat: pilih jenis, isi keterangan, tambah foto, kirim. Tanpa sinyal, laporan disimpan lalu dikirim otomatis.',
          'Unggah foto aset dari popup objek; simpan area peta untuk dipakai offline.',
          'Aktifkan notifikasi push sesuai topik (gangguan, laporan, beban).',
        ],
        perm: 'gis.view · foto: field.photo · laporan: report.manage',
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
        steps: [
          'Pilih kategori, lalu Buka/Deenergize dan konfirmasi; diagram berubah warna dalam hitungan detik.',
          'Lihat di peta / Monitoring untuk menyorot objek yang sama di peta.',
          'Overlay aliran daya mewarnai seksi menurut pembebanan dan menampilkan tegangan pu.',
        ],
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
        steps: [
          'Atur skenario: faktor beban, cos φ, dan tegangan kirim (pu).',
          'Hitung semua penyulang atau cari satu kubikel penyulang.',
          'Tab Detail menampilkan node tegangan terendah & saluran pembebanan tertinggi; peta diwarnai hasilnya.',
        ],
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
    group: 'Master Data',
    items: [
      {
        id: 'g-assets',
        title: 'Data aset (hirarki GI → pelanggan)',
        img: 'master-assets',
        intro:
          'Master Data › Data Aset: seluruh aset jaringan dalam hirarki GI → trafo GI → penyulang → gardu distribusi → trafo distribusi → jurusan TR → pelanggan. Hirarki dihitung otomatis dari topologi (posisi normal switch), jadi selalu sesuai dengan data peta.',
        steps: [
          'Baris atas menampilkan jumlah aset per tingkat; klik salah satu untuk membuka tabelnya.',
          'Tab Hirarki (tree): buka tingkat dengan panah; tiap baris memuat status, isi (jumlah anak), pelanggan (padam), beban tersambung, dan unit pemilik. Daftar panjang dimuat bertahap (Muat berikutnya).',
          'Ketik kode / nama di kotak cari lalu pilih hasilnya: pohon dibuka sampai objek tersebut dan barisnya disorot. Objek pendukung (tiang, switch, saluran) diarahkan ke kelompok yang memuatnya.',
          'Klik baris untuk melihat Rincian aset: rantai hulu, Lihat di peta Pusat Operasi, Buka SLD, dan tabel aset di bawahnya.',
          'Tab Tabel data: pilih tingkat, cakupan, pencarian, status, dan unit pemilik (termasuk unit bawahannya); urutkan dengan klik judul kolom; Unduh CSV (maks. 100.000 baris).',
        ],
        tips: [
          'Hirarki gardu: gardu → trafo distribusi → jurusan bila trafo ada di data; gardu tanpa trafo distribusi menampilkan jurusan langsung di bawah gardu (diberi keterangan di panel rincian); pelanggan TM tanpa jurusan tampil langsung di bawah gardu / penyulang.',
          'Aset yang tidak tersambung ke GI dikelompokkan di “Tidak tersambung ke sumber” — periksa topologinya di Map Editor.',
        ],
        perm: 'master.view atau gis.view',
      },
      {
        id: 'g-load-points',
        title: 'Titik SCADA & kontrak pesan',
        img: 'load-points',
        intro:
          'Menu Master Data › Titik SCADA (sebelumnya tab di Analisa Beban & Energi): daftar titik ukur (trafo GI, penyulang, gardu) beserta pemetaan ke objek GIS, rating, dan data terakhir; kontrak pesan Kafka dan kirim data uji.',
        steps: ['Tambah / ubah titik, atau Petakan otomatis dari GIS (termasuk gardu).', 'Kode baru dari SCADA/AMR yang cocok dengan kode GIS didaftarkan otomatis.'],
        tips: ['Matikan simulator (load.simulator) saat SCADA/AMR asli sudah tersambung.'],
        perm: 'load.manage',
      },
      {
        id: 'g-units',
        title: 'Unit & kepemilikan aset',
        img: 'master-units',
        intro: 'Master Data › Unit: unit organisasi berjenjang PUSAT → REGION → UID / UP2B → UP3 / UP2D → ULP (UP2B setara UID, UP2D setara UP3) sebagai pemilik & pengelola aset.',
        steps: [
          'Tambah unit: jenis, induk (divalidasi sesuai jenjang), kode, nama, alamat, koordinat, kontak, dan wilayah kerja (poligon batas).',
          'Klik unit untuk melihat aset yang dimilikinya.',
          'Tetapkan kepemilikan otomatis: pratinjau lalu terapkan — GI, trafo GI, penyulang → UP3; gardu, trafo distribusi, LBS, tiang → ULP terdekat.',
          'Kepemilikan per aset juga dapat diubah di panel Fitur editor (lewat persetujuan).',
        ],
        tips: ['Unit pemilik dipakai analisa beban & susut per UID / UP3 / ULP.', 'Unit yang masih memiliki unit bawahan atau aset tidak dapat dihapus.'],
        perm: 'master.view · mengelola: master.manage',
      },
    ],
  },
  {
    group: 'Administrasi',
    items: [
      {
        id: 'g-users',
        title: 'Pengguna',
        img: 'admin-users',
        intro: 'Menambah, mengubah, menonaktifkan pengguna, dan menetapkan peran.',
        steps: ['Tambah pengguna: nama, email, kata sandi (sesuai kebijakan), peran.', 'Nonaktifkan akun alih-alih menghapus untuk menjaga jejak audit.'],
        perm: 'admin.users',
      },
      {
        id: 'g-roles',
        title: 'Peran & izin',
        img: 'admin-roles',
        intro:
          'Peran mengelompokkan izin granular: lihat, susun/setujui/rilis perubahan, trace, operasi TM/TR, beban, master data, AI, administrasi. Tersedia peran bawaan supervisor & manajer untuk alur persetujuan.',
        steps: ['Buat atau ubah peran, centang izin yang diperlukan.', 'Perubahan izin berlaku paling lambat 30 detik tanpa perlu login ulang.'],
        perm: 'admin.roles',
      },
      {
        id: 'g-menus',
        title: 'Menu',
        img: 'admin-menus',
        intro: 'Mengatur menu samping: judul (ID/EN), ikon, urutan, induk (submenu, mis. Map Editor), dan peran yang dapat melihat.',
        perm: 'admin.menus',
      },
      {
        id: 'g-config',
        title: 'Konfigurasi & identitas aplikasi',
        img: 'admin-config',
        intro:
          'Bagian Identitas aplikasi mengatur nama, deskripsi, dan logo (PNG/JPEG/SVG/WebP maks. 512 KB) yang tampil di menu samping, halaman masuk, judul tab, favicon, dan kepala laporan. Di bawahnya, parameter aplikasi per grup.',
        steps: [
          'Isi nama & deskripsi, unggah logo, periksa pratinjau, lalu Simpan.',
          'Ubah parameter lain lalu simpan; sebagian berlaku seketika.',
          'Untuk nilai rahasia, biarkan kosong agar nilai lama tetap dipakai.',
        ],
        perm: 'admin.config',
      },
      {
        id: 'g-layerset',
        title: 'Pengaturan layer',
        img: 'admin-layers',
        intro:
          'Mengatur tipe komponen: nama, warna, simbol standar (dengan varian terbuka), zoom, ukuran, tegangan, topologi (objek pendukung seperti tiang wajib tanpa topologi dan tidak pernah terhubung ke jaringan), arah switch, dan atribut SSOT.',
        perm: 'gis.settings',
      },
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
