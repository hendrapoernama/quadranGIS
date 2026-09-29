# QuadranGIS

Aplikasi GIS jaringan kelistrikan berbasis web: menggambar komponen jaringan
(GI, GH, gardu distribusi, trafo, busbar, kubikel, SKTM/SUTM/SKUTR/SKTR/SR,
pelanggan TT/TM/TR), pembentukan topologi otomatis saat editing, trace hulu/hilir,
serta administrasi aplikasi lengkap.

## Arsitektur

| Lapisan     | Teknologi                                                        |
|-------------|------------------------------------------------------------------|
| Backend     | Go 1.24 + Gin, pgx, gorilla/websocket, segmentio/kafka-go       |
| Frontend    | Next.js 14 (App Router, TypeScript, Tailwind), MapLibre GL JS    |
| Database    | PostgreSQL 16 + PostGIS + TimescaleDB (`timescale/timescaledb-ha`) |
| Stream      | Apache Kafka 3.8 (KRaft, tanpa ZooKeeper)                        |
| Realtime    | Redis 7 (cache tile, captcha, rate-limit, pub/sub → WebSocket)   |
| Keamanan    | HTTPS via nginx (TLS 1.2/1.3, HSTS), JWT HttpOnly cookie, bcrypt |

```
browser ──HTTPS──> nginx ──> frontend (Next.js :3000)
                        └──> backend  (Go :8080) ──> PostgreSQL/PostGIS/Timescale
                                              ├──> Redis (cache, pub/sub)
                                              └──> Kafka (event stream)
```

## Menjalankan (Docker, disarankan)

```bash
cp .env.example .env            # sesuaikan JWT_SECRET, ADMIN_PASSWORD, dll.
bash scripts/gen-cert.sh        # atau: powershell scripts/gen-cert.ps1
docker compose up -d --build
```

Buka **https://localhost** (sertifikat self-signed, terima peringatan browser).
Login awal: `admin` / nilai `ADMIN_PASSWORD` di `.env` (bawaan `Admin#12345`).
Login memerlukan jawaban captcha matematika.

Layanan (port host dapat diubah lewat `HTTPS_PORT`, `HTTP_PORT`, `BACKEND_PORT` di `.env`;
bila `HTTPS_PORT` bukan 443, buka langsung `https://localhost:<HTTPS_PORT>` karena
pengalihan dari port HTTP menuju port 443):

| Layanan   | Port host | Keterangan                              |
|-----------|-----------|-----------------------------------------|
| nginx     | 443, 80   | HTTPS; 80 dialihkan ke 443              |
| backend   | 8080      | API langsung (HTTP) untuk pengembangan  |
| postgres  | 5434      | user/pass `quadran`/`quadran` (5432 di jaringan Docker) |
| redis     | 6380      | (6379 di jaringan Docker)               |
| kafka     | 29093     | listener untuk host (9092 di jaringan Docker) |

## Pengembangan lokal (tanpa nginx)

```bash
docker compose up -d postgres redis kafka
# backend
cd backend && COOKIE_SECURE=false KAFKA_BROKERS=localhost:29093 REDIS_ADDR=localhost:6380 \
  DATABASE_URL="postgres://quadran:quadran@localhost:5434/quadrangis?sslmode=disable" \
  go run ./cmd/server
# frontend (rewrite /api -> http://localhost:8080)
cd frontend && npm install && BACKEND_INTERNAL_URL=http://localhost:8080 \
  NEXT_PUBLIC_WS_URL=ws://localhost:8080/api/ws npm run dev
```

Buka http://localhost:3000.

## Fitur

### Administrasi
- **Pengguna**: CRUD, role, aktif/nonaktif, reset kata sandi.
- **Roles**: izin granular (`gis.view`, `gis.edit`, `gis.trace`, `gis.maneuver`,
  `gis.settings`, `admin.*`). Role bawaan: `admin`, `editor`, `viewer`.
- **Menu**: struktur menu bertingkat, ikon, urutan, hak akses per role; sidebar
  dibangun dari data ini.
- **Konfigurasi aplikasi**: key/value bertipe, berlaku langsung (cache 30 dtk).
- **Pengaturan layer**: zoom minimum, warna, ukuran, label per tipe komponen,
  serta parameter loading/topologi/trace.
- **Monitoring sistem**: CPU, memori, heap, goroutine, pool DB, latensi Redis,
  status Kafka, klien WebSocket, permintaan/latensi HTTP (hypertable
  `system_metrics`), statistik DB, event stream Kafka, dan audit aktivitas.

### Login & keamanan
- Username + kata sandi (bcrypt) + **captcha matematika** (sekali pakai, TTL di Redis).
- Rate-limit percobaan gagal (Redis), JWT HS256 di cookie HttpOnly `SameSite=Lax`.
- HTTPS oleh nginx (atau langsung oleh backend bila `TLS_CERT`/`TLS_KEY` diisi),
  header keamanan (HSTS, nosniff, frame-options).

### Peta & editing
- **Vector tile** dihasilkan langsung oleh PostGIS (`ST_AsMVT`) dan di-cache di
  Redis + nginx. Satu tile berisi tiga source-layer: `nodes`, `edges`, `density`.
- **Loading ringan** untuk >10 juta titik:
  - tiap tipe punya `min_zoom` (pelanggan/SR baru tampil pada zoom tinggi),
  - di zoom rendah titik yang belum tampil diringkas sebagai **kepadatan**
    (materialized view, di-refresh berkala),
  - batas fitur per tile, simplifikasi garis di zoom rendah,
  - invalidasi cache hanya untuk tile yang terdampak bbox perubahan,
  - editing per fitur (tidak memuat ulang seluruh layer).
- **Menggambar** komponen titik & garis dengan snapping visual dan snapping
  server (`/api/gis/snap`).
- **Topologi otomatis** saat menyimpan:
  - ujung garis menempel ke node terdekat (toleransi `topology.snap_tolerance_m`),
  - ujung garis di tengah garis lain → garis lain **dipisah** dan junction dibuat,
  - titik diletakkan di atas garis → garis dipisah pada titik itu,
  - ujung bebas → **junction** otomatis,
  - memindahkan node ikut menggeser ujung garis terhubung,
  - menghapus garis membersihkan junction yatim; menghapus node menghapus garis terkait.
- **Realtime**: setiap perubahan disiarkan lewat Redis pub/sub → WebSocket ke
  semua klien; tile diperbarui otomatis. Event juga dipublikasikan ke Kafka
  (`quadran.gis.events`) dan dikonsumsi kembali ke hypertable `stream_events`.
- Buka / tutup switch dan energize / deenergize **tidak** dilakukan dari editor;
  operasi itu hanya ada di menu **Pusat Operasi** (dan SLD).

### Alur persetujuan editing (paket perubahan)

Migrasi `029_units_workflow_branding.sql`, konfigurasi `gis.approval_enabled` (bawaan `true`).

- Selama alur aktif, setiap tambah / ubah / hapus / pisah / gabung di editor dan setiap impor GeoJSON
  **tidak langsung mengubah jaringan aktif**. Perubahan disimpan sebagai operasi tertunda di
  **paket perubahan** (`gis_changesets`, `gis_change_items`).
- Alur & jenjang:
  1. **Draf** — disusun editor (`gis.edit`). Paket draf dibuat otomatis pada edit pertama, atau dibuat
     manual di tab **Perubahan** pada editor.
  2. **Diajukan** — penyusun mengajukan paket.
  3. **Disetujui** — supervisor (`gis.approve`) menyetujui, atau menolak dengan alasan wajib.
     Paket yang ditolak kembali ke penyusun untuk diperbaiki dan diajukan ulang. Penyusun tidak boleh
     menyetujui paketnya sendiri (`gis.approval_allow_self`).
  4. **Dirilis** — manajer (`gis.release`) merilis paket. Operasi diputar ulang berurutan lewat editor
     bertopologi yang sama (snap, sambung, pisah garis otomatis), lalu tile, graf, dan siaran realtime
     diperbarui.
- Role baru: **supervisor** (`gis.approve`) dan **manajer** (`gis.approve` + `gis.release`).
  Admin memiliki semuanya.
- Di editor:
  - objek usulan tampil sebagai lapisan pratinjau: oranye = baru, biru = diubah, merah = dihapus,
    ungu = pisah / gabung;
  - objek baru yang belum dirilis memakai id negatif, dan dapat dipilih, diubah, atau dibatalkan;
  - garis baru dapat di-snap ke titik usulan;
  - panel atribut menampilkan kondisi usulan beserta penandanya.
- **Kunci objek**: satu objek aktif hanya boleh memiliki usulan di satu paket terbuka.
- **Deteksi konflik**: bila objek berubah atau terhapus setelah diusulkan, rilis ditolak seluruhnya.
  Penyusun lalu menyinkronkan (*rebase*) atau membatalkan item tersebut.
- Menu induk **Map Editor** (migrasi `030_menu_map_editor.sql`) berisi submenu **Editor Peta
  Jaringan** (`/map`) dan **Persetujuan Perubahan** (`/changes`).
- Menu **Persetujuan Perubahan** (`/changes`) memuat:
  - daftar paket per status ("Perlu tindakan" sesuai izin);
  - tahapan beserta pelaku & waktunya;
  - tabel perubahan *sebelum → sesudah* (atribut, kode/nama, jenis, unit, geometri);
  - konflik, jejak audit (aksi, nama, role, catatan), dan tautan *Lihat di peta*.
- Setiap transisi dicatat di `gis_changeset_log` dan audit, serta disiarkan realtime (`changeset.*`).
- Mematikan `gis.approval_enabled` mengembalikan editing langsung seperti sebelumnya.

### Master data unit & kepemilikan aset

Menu **Master Data → Unit** (`/master/units`, izin `master.view` / `master.manage`).

- Jenjang: **PUSAT → REGION → UID / UP2B → UP3 / UP2D → ULP**. UP2B setara UID, dan UP2D setara UP3.
- Induk yang sah divalidasi server.
- Tiap unit menyimpan kode, nama, jenis, induk, alamat, koordinat, kontak, wilayah kerja (poligon batas
  wilayah), dan status aktif.
- Unit terisi awal dari batas wilayah yang ada (UID JAKARTA RAYA, UP3, ULP) ditambah contoh PUSAT,
  REGION, UP2B, dan UP2D. Semuanya dapat diubah.
- **Kepemilikan aset** tersimpan di `gis_nodes.unit_id` / `gis_edges.unit_id`, dan dapat ditetapkan per
  objek di panel atribut editor (lewat alur persetujuan).
- Bila kosong, pemilik diturunkan otomatis dari lokasi, yaitu ULP terdekat dalam `unit.auto_max_km`:
  - GI, trafo GI, kubikel / penyulang, dan recloser dikelola UP3;
  - gardu, trafo distribusi, LBS, switch TR, dan tiang dikelola ULP;
  - aset di luar semua wilayah memakai `unit.default_code`.
- *Tetapkan kepemilikan otomatis* menyimpan pemilik ke aset, dengan pratinjau lebih dulu.
- **Analisa beban & susut** memakai unit pemilik aset untuk UID / UP3 / ULP titik ukur
  (`scada_points.unit_id`), dengan cadangan poligon wilayah GI.

### Identitas aplikasi

**Administrasi → Konfigurasi → Identitas aplikasi**: nama (`app.name`), deskripsi (`app.description`),
dan logo.

- Logo berupa PNG / JPEG / SVG / WebP, maksimal 512 KB, disimpan sebagai data URL di `app.logo`.
- Identitas ini tampil di sidebar, halaman masuk, header mobile, judul tab & favicon, dan kepala laporan.
- API publik: `GET /api/branding` dan `GET /api/branding/logo`. SVG disajikan dengan CSP tanpa skrip.
- Ubah lewat `PUT /api/admin/branding` (izin `admin.config`).

### Trace kelistrikan
- Graf jaringan dimuat di memori (id, tipe, status, konektivitas). Jarak hop dari
  sumber (`power_grid`, `gi`) dihitung dengan BFS multi-sumber.
- **Downtrace** (hilir): menelusuri node yang jaraknya dari sumber bertambah.
- **Uptrace** (hulu): menuju sumber.
- **Connected**: seluruh bagian yang terhubung tanpa arah.
- Kubikel/switch berstatus `open` memutus penelusuran; bisa berhenti pada tipe
  tertentu (mis. berhenti di gardu distribusi).
- Hasil: daftar fitur, ringkasan per tipe, panjang per tipe, sumber, switch open,
  overlay di peta, unduh GeoJSON.

## Data simulasi Jakarta Pusat

Migrasi `003_i18n_basemap_sim.sql` mengisi jaringan simulasi (idempoten, hanya
bila `GI-GMB` belum ada): transmisi 150 kV → **GI Gambir** (2 trafo 60 MVA,
kubikel incoming, busbar 20 kV) → **5 penyulang** `GMB-01..05` ke arah
Kemayoran, Senen, Menteng, Tanah Abang, dan Petojo. Tiap penyulang memiliki
8 gardu distribusi (dua di antaranya diganti GH), trafo distribusi, 2 jurusan
TR (SKUTR/SKTR) dengan 4 tiang/junction, SR, ±16 pelanggan TR per gardu,
pelanggan TM, satu pelanggan TT, serta dua *tie switch* normally-open antar
penyulang. Total ±1.000 node dan ±1.000 garis (±70 km). Pusat peta awal berada
di GI Gambir.

## Tema, bahasa, dan tata letak

- **Tema** terang / gelap / ikuti sistem (tombol di sidebar dan halaman login,
  tersimpan di browser). Grafik monitoring dan kontrol peta ikut menyesuaikan.
- **Basemap** OpenStreetMap terang (tile.openstreetmap.org) atau gelap: tile OSM
  yang sama dibalik warnanya di klien (properti raster MapLibre: inversi +
  hue-rotate 180), sehingga tidak butuh API key. Bawaan mengikuti tema, dapat
  diubah di tab *Layer*. URL diatur lewat `app.basemap_light_url` /
  `app.basemap_dark_url`; bila memakai penyedia tile gelap asli, set
  `app.basemap_dark_invert=false`. Bila tile utama gagal berulang, peta otomatis
  beralih ke `app.basemap_fallback_url` (mirror tile.openstreetmap.de).
- **Bahasa** Indonesia / English untuk seluruh antarmuka; pesan dari backend
  (validasi, topologi, trace) mengikuti header `X-Lang`. Judul menu dan nama
  tipe komponen punya kolom `title_en` / `name_en` yang dapat diubah di admin.
- **Sidebar** dapat diciutkan (ikon saja) atau disembunyikan penuh (tombol
  panel atau **Ctrl+B**); tombol tipis di tepi kiri menampilkannya kembali.
- Warna latar dan teks sidebar **mengikuti tema** terang/gelap (variabel CSS `--sb-*`
  dan kelas `.sb*` di `globals.css`); item aktif tetap biru.

## Bangunan, editing lanjutan, dan alat ukur

- **Bangunan sebagai poligon**: GI, GH, dan gardu distribusi bertipe `polygon`.
  Denah disimpan di `gis_nodes.footprint`; titik node tetap menjadi titik sambung
  topologi (centroid denah). Digambar dengan mengklik sudut-sudut denah, atau
  satu klik + Enter memakai ukuran bawaan `footprint_size_m` per tipe. Ujung garis
  yang jatuh di dalam denah otomatis tersambung ke bangunan itu. Tile memuat
  source-layer `buildings` (fill + outline).
- **Edit vertex realtime** (panel Fitur → *Edit vertex*): seret vertex, seret titik
  tengah untuk menambah vertex, klik kanan untuk menghapus; disimpan saat dilepas
  dan ujung garis di-snap ulang oleh server. *Geser realtime* pada titik menyeret
  node dengan garis-garis terhubung yang ikut bergerak.
- **Pisah garis** (panel Fitur → *Pisah garis*): klik pada garis, garis dipecah
  menjadi dua objek dengan junction baru (`POST /api/gis/edges/{id}/split`).
  Kebalikannya, **Gabung garis** pada junction berderajat dua menyatukan kedua
  garis bertipe sama (`POST /api/gis/nodes/{id}/merge`).
- **Alat ukur** (ikon penggaris & area di toolbar): panjang geodesik per segmen
  dan total, serta luas (spherical) dan keliling; hasil tampil di peta dan panel.

## Objek pengaman, objek pendukung, atribut SSOT, manuver & monitoring kelistrikan

Migrasi `007_power_monitoring.sql` menambahkan:

- **Objek jaringan baru** (ikut topologi, alat switching): `recloser`, `lbs_2way`,
  `lbs_3way` (kategori *pengaman*). LBS 3 way dapat dibuka **per arah** (per garis
  yang menempel; disimpan di `gis_nodes.open_ways`), selain dibuka seluruhnya.
- **Objek pendukung** (bukan bagian topologi): `tiang_tm`, `tiang_tr`. Tipe dengan
  `component_types.topology=false` tidak dimuat ke graf, tidak menyambung garis,
  dan tidak memisah garis saat diletakkan di atasnya (boleh tepat di posisi
  junction/tiang sambungan).
- **Atribut SSOT** per tipe: skema `component_types.attributes`
  (`[{key,label,label_en,type:text|number|select|bool,unit,options}]`) yang
  dirender sebagai formulir baku di panel Fitur (nilai tersimpan di
  `properties`). Skema diubah di *Pengaturan Layer* (kolom *Atribut SSOT*).
  Atribut `daya_va` / `daya_kva` / `daya_mva` pelanggan dipakai untuk rekap beban
  (bawaan `monitoring.default_daya_va` bila kosong); atribut `normal` (`open`/
  `closed`) pada switch menentukan posisi normal untuk pengelompokan.
- **Group jaringan** dihitung otomatis di graf dari posisi normal switch:
  **penyulang** (JTM; kepala = kubikel outgoing yang menempel busbar; tahu GI dan
  trafo GI induknya), **zona** (wilayah di hilir tiap alat switching sampai alat
  berikutnya), dan **jurusan** (JTR; tiap saluran TR pertama yang keluar dari
  gardu/trafo distribusi). Panel Fitur menampilkan penyulang, GI, zona, jurusan
  setiap objek.
- **Manuver jaringan** (`POST /api/gis/maneuver`, izin `gis.maneuver`):
  `{node_id, action: open|close, kind: GANGGUAN|PEMELIHARAAN|MLS, note, way_edge_id?}`.
  Graf memperbarui energisasi secara inkremental: saat membuka, hanya wilayah yang
  jalur terpendeknya melewati alat itu yang dihitung ulang; saat menutup, jarak
  direlaksasi dari alat itu saja (diuji acak terhadap BFS penuh). Lalu backend
  menyimpan kolom `energized` node/edge yang berubah, mencatat `maneuvers`, dan
  membuka **kejadian padam** (`outages`) dengan level group dari tipe alat
  (GI, trafo GI, penyulang, zona, gardu distribusi) beserta rekap dampak:
  GI, trafo GI, penyulang, zona, gardu distribusi, trafo distribusi, pelanggan,
  beban (VA). Manuver *close* pada alat yang sama menutup kejadian dan mencatat
  pemulihan. Perubahan status via editing (mis. menghapus garis) juga
  disinkronkan ke kolom `energized` lewat hook graf.
- **Peta**: tile membawa properti `energized`; tab *Layer* punya mode pewarnaan
  *Per tipe* (objek padam abu dengan tepi merah) atau *Nyala / padam* (hijau /
  merah, garis padam putus-putus). Event realtime `maneuver` dan `energized`
  memperbarui tile semua klien.
- **Menu Pusat Operasi** (`/monitoring`): peta nyala/padam, rekap
  GI, trafo GI, penyulang (nyala / sebagian / padam), zona, gardu distribusi,
  trafo distribusi, pelanggan, beban; daftar kejadian padam aktif & riwayat dengan
  rekap per group dan tombol *Tampilkan di peta* (area terdampak); daftar
  penyulang dengan filter status. Diperbarui otomatis (`monitoring.power_refresh_seconds`)
  dan lewat WebSocket.
- **Penanda padam berkedip** (Pusat Operasi dan Editor Peta, `GET /api/power/off-markers`):
  - gardu distribusi dan trafo GI yang padam tampil dengan simbol merah berkedip dan gelombang merah;
  - bila banyak dan berdekatan, penanda dikelompokkan menjadi **cluster merah** berangka;
  - klik cluster untuk memperbesar peta; klik penanda untuk memilih objek; arahkan kursor untuk
    melihat kejadian padam aktifnya;
  - objek rencana / non aktif / bongkar tidak ditandai;
  - diperbarui lewat WebSocket setelah manuver / energize dan setiap `monitoring.power_refresh_seconds`;
  - tombol *Tanda padam* (Pusat Operasi) dan kotak centang di tab *Layer* (Editor Peta) menyembunyikannya
    (disimpan per browser);
  - animasi hanya berjalan selama ada penanda di area tampilan, dan dimatikan bila browser meminta
    gerak dikurangi (`prefers-reduced-motion`).

- **Pewarnaan per penyulang** (Pusat Operasi, tombol *Warna peta: Status | Penyulang*):
  - setiap penyulang diberi satu dari 12 warna; penyulang yang tersambung lewat tie point, keluar dari
    GI / trafo GI yang sama, atau berjalan berdekatan dibedakan warnanya, dan warna stabil antar-perhitungan
    (tabel `feeder_colors`, dihitung ulang setelah pengelompokan);
  - **Normal**: keanggotaan menurut posisi normal switch (kolom `feeder_id` di `gis_nodes` / `gis_edges`,
    ditulis backend setelah pengelompokan, hanya yang berubah);
  - **Aktual**: penyulang yang menyuplai saat ini. Seksi yang dilimpahkan lewat manuver (mis. tie ditutup lalu
    kubikel penyulang asal dibuka) ikut berganti warna; dihitung inkremental hanya pada wilayah terdampak manuver
    dan disimpan sebagai override kecil (`gis_node_feeder_live`, `gis_edge_feeder_live`);
  - objek padam abu-abu, objek bertegangan tanpa penyulang (GI, busbar, data belum tersambung) abu kebiruan;
  - legenda menampilkan penyulang di layar; klik untuk menyorot (yang lain diredupkan) dan memperbesar ke batas
    penyulang; kartu objek menampilkan *Disuplai saat ini* bila objek sedang dilimpahkan;
  - pengisian awal saat migrasi `047_feeder_coloring.sql` pertama kali berjalan menulis ±5,9 juta baris di
    latar belakang (±4,5 menit pada data simulasi massal);
  - tersedia juga di **Editor Peta** (tab *Layer* › Pewarnaan › *Penyulang*) dan **SLD** (Warna: *Penyulang
    (normal)* / *Penyulang (aktual)*; legenda diagram & cetak berisi penyulang yang tampil); di ponsel legenda
    berada di bawah kotak cari dan tertutup bawaan agar tidak tertutup panel bawah.
- **Penanda penyulang paralel** (`GET /api/power/parallel`, Pusat Operasi & Editor Peta):
  - dua penyulang paralel = ada saluran tertutup & bertegangan yang kedua ujungnya disuplai penyulang berbeda
    (titik temu suplai dalam satu loop); saluran yang menempel kepala penyulang (busbar antar-kubikel GI)
    tidak dihitung;
  - tie penyebab = switch / arah LBS normally-open yang kini tertutup di antara kedua penyulang; penanda kuning
    tua (cincin + label "Paralel A / B") di tie, atau di titik temu bila tie tidak dikenali;
  - spanduk "⚠ Paralel: A ⇄ B lewat …" di bawah toolbar (klik = menuju tie) dan toast saat paralel baru terjadi;
  - loop yang sudah ada pada posisi normal switch (mis. data impor tanpa tie bertanda normally-open) tidak
    ditandai; jumlahnya (`normal_loops`) tampil sebagai catatan data di legenda penyulang.

  Konfigurasi penanda padam:

  | Kunci | Bawaan | Fungsi |
  |---|---|---|
  | `monitoring.off_marker_types` | `gd,trafo_gi` | tipe objek yang ditandai (kode tipe, pisahkan koma) |
  | `monitoring.off_marker_cluster_radius` | `50` | radius pengelompokan dalam piksel; `0` = tanpa cluster |
  | `monitoring.off_marker_cluster_max_zoom` | `15` | di atas zoom ini setiap objek tampil sendiri |
- Data contoh pada simulasi Gambir: 2 recloser, 2 LBS 2 way, 1 LBS 3 way (arah
  ke-3 = tie normally-open ke penyulang GMB-05), tiang TM tiap ±45 m di SUTM,
  tiang TR di tiap tiang sambungan SKUTR.

### Pemutusan objek & indeks keandalan (SAIDI, SAIFI, ENS)

Migrasi `012_reliability.sql`:

- **Pemutusan objek non-switch dan saluran**: `POST /api/gis/maneuver` juga menerima
  `{edge_id, action, kind, note}` (memutus / menyambung saluran; status disimpan di
  `gis_edges.status`) dan `node_id` objek non-switch (gardu, trafo distribusi,
  pelanggan, dsb.: objek itu sendiri ikut padam). Panel Fitur menampilkan kotak
  *Pemutusan* (Putus / Normalkan) untuk objek tersebut. `maneuvers.target_kind` dan
  `outages.cause_kind` (`node`|`edge`) membedakan target.
- **Level kejadian padam** (8 level): GI, trafo GI, penyulang, zona, gardu
  distribusi, trafo gardu distribusi, jurusan TR, pelanggan. Ditentukan dari objek
  penyebab (mis. SUTM/SKTM/recloser/LBS → zona, SKUTR/SUTR → jurusan, SR/pelanggan →
  pelanggan) dan dinaikkan ke GI / trafo GI bila dampaknya mencakup GI / trafo GI.
- **Indeks keandalan** (`GET /api/power/reliability?period=today|month|year|30d`
  atau `from`/`to`), dihitung dari kejadian yang beririsan dengan periode (durasi
  dipotong ke periode; kejadian aktif dihitung sampai sekarang):
  - SAIDI = Σ(pelanggan padam × menit) ÷ jumlah pelanggan dilayani (menit/plg)
  - SAIFI = Σ pelanggan padam ÷ jumlah pelanggan dilayani (kali/plg)
  - ENS (kWh) = daya terpasang padam (kVA) × faktor beban × cos φ × jam
  - ENS (Rupiah) = ENS (kWh) × harga per kWh

  Padam lebih singkat dari `reliability.sustained_minutes` dihitung *momentary*:
  tidak masuk SAIDI/SAIFI, tetap masuk ENS. Parameter diatur di *Konfigurasi* grup
  *Keandalan*: `reliability.tariff_rp_per_kwh` (bawaan 1444,70),
  `reliability.load_factor` (0,6), `reliability.power_factor` (0,85),
  `reliability.sustained_minutes` (5). Hasil juga dipecah per level dan per jenis
  (GANGGUAN / PEMELIHARAAN / MLS).
- **Pusat Operasi**: baris *Keandalan* di bawah pita rekap (pilihan periode,
  SAIDI, SAIFI, ENS kWh, ENS Rupiah, jumlah kejadian, jumlah per level). Tab
  *Kejadian padam* dikelompokkan per level (subtotal SAIDI/SAIFI/ENS tiap level),
  punya filter level, dan tiap kejadian menampilkan pelanggan·menit, ENS kWh, dan
  ENS Rupiah. *Riwayat periode* menampilkan kejadian pada periode terpilih.

### Rak TR, switch jurusan TR, simbol standar & operasi per role

Migrasi `014_equipment_operate.sql`:

- **Peralatan baru**: `rak_tr` (Rak TR / PHB-TR, busbar TR di gardu) dan
  `switch_jurusan_tr` (NH fuse / NFB per jurusan, alat switching TR). Data contoh: tiap
  trafo distribusi mendapat rak TR (6 m dari trafo) dan satu switch jurusan per saluran
  TR keluar (trafo -[kabel]- rak -[kabel]- switch -[jurusan]).
  Pengelompokan: zona hanya dibentuk alat switching TM; tiap saluran keluar rak TR
  menjadi satu jurusan. Popup switch jurusan menampilkan rekap pelanggan jurusan itu,
  rak TR menampilkan rekap seluruh jurusannya. Level kejadian: rak TR → trafo gardu
  distribusi, switch jurusan → jurusan TR.
- **Objek pendukung wajib tidak terhubung** — migrasi `036_support_not_connected.sql`: tipe berkategori
  *pendukung* (tiang TM, tiang TR) wajib `topology = false` (constraint `component_types_support_no_topology`).
  Trigger basis data menolak saluran yang berujung di objek non-topologi dan menolak perubahan tipe objek yang
  masih tersambung menjadi tipe pendukung, sehingga berlaku untuk semua jalur (editor, impor, rilis paket,
  skrip). Editor dan Pengaturan Layer memberi pesan yang jelas; centang topologi tipe pendukung terkunci.
- **Lokasi gangguan dari arus relai** — migrasi `039_fault_location.sql`, `internal/gis/faultloc.go`,
  panel di Pusat Operasi › FLISR. Dari alat yang trip, arus hubung singkat dihitung menyusuri jaringan TM
  hilirnya (topologi normal, berhenti di tie normally-open dan sisi TR):
  - 3 fasa `I = Vf / |Z1s + Z1l + Rf|`, fasa-fasa `I = √3·Vf / |2(Z1s + Z1l) + Rf|`,
    fasa-tanah `I = 3·Vf / |2(Z1s + Z1l) + (Z0s + Z0l) + 3(R_NGR + Rf)|`;
  - Z1s dari daya hubung singkat busbar TM (atribut `daya_hs_mva` trafo GI / GI, atau `fault.source_mva`),
    Z1l dari parameter penghantar aliran daya (per tipe / per saluran), Z0l = `fault.z0_ratio` × Z1l;
  - jenis gangguan dapat dideteksi otomatis dari Ia/Ib/Ic/In; kandidat = titik tempat arus hitungan sama dengan
    arus terukur (bisa beberapa pada jaringan bercabang), dengan rentang toleransi `fault.tol_pct`;
  - `POST /api/ops/fault-locate` (hasil + GeoJSON overlay), `GET /api/ops/fault-locate/defaults?device_id=`.
- **Pelanggan kolektif (bulk customer)** — migrasi `038_pelanggan_kolektif.sql`: tipe `pelanggan_bulk`
  (kategori *pelanggan*, sink, simbol `sym_bulk`). Atribut `jumlah_pelanggan` (wajib) dan `daya_kva` (total daya
  tersambung), tarif dominan, IDPEL induk, kawasan, alamat. Graf menandai node kolektif dengan `flagBulk` dan
  menyimpan jumlahnya di peta kecil `Graph.bulkN` (tanpa menambah memori per node); `custLocked` memberi bobot
  pelanggan pada rekap Pusat Operasi, ringkasan kejadian padam (SAIDI / SAIFI / ENS), trace, FLISR, simulasi
  manuver, SLD, Data Aset, dan cakupan tagihan susut gardu → pelanggan. Beban memakai total daya. Data contoh:
  `PLG-KOL-GMB-01-1` (Rusun Kemayoran Blok A, 120 pelanggan, 250 kVA).
- **PMT, PMS & busbar gardu** — migrasi `037_pmt_pms_busbar_gardu.sql` untuk gardu beton / gardu hubung:
  - `pmt_20kv` (PMT / pemutus tenaga, simbol `sym_pmt`) dan `pms_20kv` (PMS / pemisah, simbol `sym_pms`):
    alat switching TM (izin `power.switch_tm`). Atribut **Pembatas zona** (Ya / Tidak) per objek: Ya = membentuk
    zona seperti recloser / LBS, Tidak = hanya pemutus (tidak membentuk zona). Bawaan bila kosong: PMT = Ya,
    PMS = Tidak (flag graf `flagNoZone`). PMT / PMS yang menempel ke gardu atau trafo dihitung milik gardu itu.
  - Level kejadian PMT / PMS menurut dampak: zona (ada gardu terdampak) → trafo gardu → pelanggan.
  - `busbar_gardu` (rel TM di dalam gardu, impedansi nol): **terpisah** dari `busbar` GI — tidak menandai kepala
    penyulang dan tidak memberi level kejadian trafo GI; saluran busbar gardu tidak melepas penanda gardu.
  - Pemodelan yang disarankan: titik gardu (GH / GD) bertindak sebagai busbar; PMT / PMS disisipkan pada kabel
    masuk / keluar dekat gardu. Busbar gardu dipakai bila rel di dalam gardu digambar rinci.
  - Data contoh: PMT (pembatas zona) pada kabel keluar GH-GMB-01, PMS (hanya pemutus) pada kabel keluar GH-GMB-03.
- **FCO (Fuse Cut Out)** — migrasi `035_fco.sql`: tipe `fco` (kategori *pengaman*, 20 kV, alat
  switching, simbol `sym_fco`: tabung fuse berengsel yang jatuh miring saat terbuka / putus). Atribut:
  fungsi (Trafo / Percabangan), jenis & rating fuse link, merek, posisi normal, tahun. Data contoh: satu
  FCO pada kabel gardu → trafo di setiap trafo distribusi (`FCO-<kode>`).
  - **FCO trafo** (bertetangga langsung dengan trafo distribusi) termasuk gardu: tidak membentuk zona dan
    tidak melepas penanda gardu, sehingga hirarki aset, SLD gardu, dan susut gardu tetap utuh. Level
    kejadian saat dibuka: trafo gardu distribusi.
  - **FCO percabangan** (di saluran cabang TM) membentuk zona seperti LBS; level kejadian: zona.
  - Operasi memakai izin `power.switch_tm`; fuse putus dicatat sebagai *Buka* dengan kategori GANGGUAN.
- **Simbol standar kelistrikan** (gaya diagram satu garis IEC 60617): sumber AC, gardu
  induk, gardu hubung, gardu distribusi, transformator (dua lingkaran), pemutus tenaga /
  kubikel, recloser, LBS 2/3 arah, FCO, switch jurusan (NH fuse), rak TR (busbar), tiang,
  dan pelanggan (rumah). Alat switching punya varian **terbuka** (kotak berongga / pisau
  miring). Simbol digambar sebagai ikon SDF sehingga tetap berwarna per tipe atau
  nyala/padam, dengan tepi merah bila padam / terbuka. Simbol per tipe dapat diganti di
  *Pengaturan Layer* (kolom *Simbol*, `component_types.icon`, mis. `sym_trafo`); legenda
  di tab *Layer* memakai simbol yang sama.
- **Operasi dari Pusat Operasi**: popup objek terpilih punya kotak *Buka / tutup*
  (alat switching, termasuk per arah LBS 3 way) atau *Energize / deenergize* (objek
  non-switch & saluran). Saat membuka / deenergize **kategori pemadaman wajib**:
  GANGGUAN, PEMELIHARAAN, MLS, MANUVER, atau BENCANA ALAM. Saat menutup / energize kategori boleh
  kosong (mengikuti kejadian padam yang ditutup). Kotak yang sama dipakai di panel Fitur
  Editor Peta. Status objek topologi tidak lagi diubah lewat formulir edit, hanya lewat
  operasi (tercatat sebagai manuver, kejadian padam, dan SOE).
- **Tab GI (gardu induk)** di Pusat Operasi (setelah tab *Trace*;
  `GET /api/power/gi?state=all|on|partial|off&q=`): tiap GI dengan status nyala /
  sebagian / padam (padam bila GI padam atau seluruh penyulangnya padam; sebagian bila ada
  penyulang padam/sebagian atau trafo GI padam), trafo GI, penyulang, gardu distribusi,
  pelanggan, dan beban (nyala/total). Filter status, pencarian, klik kode untuk menuju GI,
  dan *Lihat n penyulang* membuka tab *Penyulang* yang tersaring ke GI itu.
- **Tab Pelanggan** di Pusat Operasi (setelah tab *Gardu*;
  `GET /api/power/customers?state=all|on|off&q=&limit=&offset=`): daftar pelanggan nyala /
  padam dengan paging di server (100 per halaman, *Muat berikutnya*), padam ditampilkan
  lebih dulu. Tiap baris: tipe, daya, penyulang, gardu distribusi, jurusan, kode SSOT; untuk
  pelanggan padam: waktu mulai padam, kategori, dan nomor kejadian aktif. Pencarian kode /
  nama / kode SSOT. Klik widget rekap *Pelanggan* membuka tab ini (filter padam bila ada).
  Indeks `gis_nodes (energized, code, id)` (migrasi 017) menjaga paging tetap < 0,4 detik
  pada 2 juta pelanggan.
- **Downtrace / uptrace di Pusat Operasi** (izin `gis.trace`): tombol di popup
  objek terpilih dan tab *Trace* (hilir / hulu, kedalaman maks, berhenti pada tipe,
  unduh hasil). Hasil disorot di peta dan dirangkum: jumlah node / garis, panjang,
  pelanggan, sumber, switch terbuka, rekap per tipe; klik baris untuk memilih objek.
- **Hak akses per role** (menggantikan `gis.maneuver`):

  | Izin | Untuk |
  |---|---|
  | `power.switch_tm` | buka / tutup alat switching TM (kubikel, recloser, LBS, FCO, PMT, PMS) |
  | `power.switch_tr` | buka / tutup switch jurusan TR |
  | `power.energize_tm` | energize / deenergize objek & saluran TM (GI, GD, SUTM, SKTM, ...) |
  | `power.energize_tr` | energize / deenergize objek & saluran TR (trafo distribusi, rak TR, SKUTR, SR, pelanggan) |

  Domain TM/TR ditentukan dari tegangan tipe (objek tanpa tegangan, mis. junction:
  dari saluran yang menempel) dan diperiksa di backend. Role bawaan baru: `operator`
  (seluruh izin operasi) dan `operator_tr` (hanya TR). Role yang sebelumnya memiliki
  `gis.maneuver` mendapat keempat izin.

### Overlay batas wilayah UP3 / ULP

Migrasi `015_boundaries.sql` membuat tabel `gis_boundaries`. Shapefile `docs/bts_area`
(34 wilayah ULP, WGS84; UP3 Cikupa, Teluk Naga, Serpong, dan Cikokol dikeluarkan lewat migrasi 016, sehingga tersisa 27 ULP) dikonversi ke GeoJSON (`backend/internal/gis/seed/bts_area.geojson`,
disematkan di backend) dan dimuat otomatis saat tabel masih kosong. Batas **UP3** (16)
adalah gabungan (dissolve) poligon ULP per `nama_area`.

- `GET /api/gis/boundaries` (izin `gis.view`): poligon UP3 & ULP (disederhanakan ~5 m)
  dan titik label; di-cache di server, ETag + gzip (±120 KB).
- Warna isi memakai **pewarnaan peta 5 warna** (UP3 bersebelahan selalu berbeda); warna
  tidak mewakili nilai. Merah/hijau tidak dipakai agar tidak tertukar dengan status nyala/padam.
- Di **Editor Peta** (tab *Layer*) dan **Pusat Operasi** (tombol *UP3* di toolbar
  peta): tampilkan/sembunyikan batas UP3, garis batas ULP (putus-putus), label nama wilayah,
  dan slider **transparansi isi** (0–100%). Pilihan tiap pengguna diingat di browser;
  bawaan dari konfigurasi `map.boundary_visible` dan `map.boundary_opacity`.
- Overlay digambar paling bawah (di bawah jaringan). Label UP3 tampil sampai zoom 15,
  label ULP pada zoom 11–16.
- Mengganti data: kosongkan tabel (`TRUNCATE gis_boundaries`), ganti file seed, lalu
  build ulang & restart backend.

### SOE (Sequence of Events) realtime

Migrasi `013_soe.sql` menambah tabel `soe_events`: log kronologis kejadian jaringan
dengan cap waktu presisi milidetik (`clock_timestamp()`), diisi awal dari riwayat
manuver & kejadian padam yang sudah ada.

- **Event yang dicatat**: switch BUKA / TUTUP (termasuk per arah LBS 3 way),
  pemutusan / penormalan objek & saluran, PADAM mulai / selesai (level, pelanggan,
  beban, durasi), serta bagian jaringan padam / nyala akibat edit jaringan atau muat
  ulang graf (kategori *topologi*). Tiap event membawa objek, penyulang, jenis
  (GANGGUAN / PEMELIHARAAN / MLS), pengguna, dan catatan.
- **Identitas operator** (audit buka / tutup, migrasi `029`): tiap event & manuver menyimpan pengguna
  (username, nama lengkap, role), kanal (`web`, `mobile`, `sld` — header `X-Client-Channel`; event
  otomatis = `sistem`), dan alamat IP. Tab SOE menampilkan "Operator: nama (username · role) kanal".
  Klik nama operator untuk menyaring event berdasarkan operator tersebut; ekspor CSV memuat kolom
  operator.
- **Keparahan**: normal (pemulihan), peringatan, serius (manuver GANGGUAN; padam
  zona / gardu distribusi), kritis (padam GI / trafo GI / penyulang).
- **Realtime**: setiap event disiarkan lewat WebSocket (`type: "soe"`) dan Kafka.
  Klien yang tersambung ulang menyinkronkan event yang terlewat (`after_id`).
- **Tab SOE** di Pusat Operasi: daftar terbaru di atas dengan jam
  `hh:mm:ss.mmm`, sorot baris baru, *Jeda* / *Lanjut* (event baru ditahan selama
  dijeda), filter kategori / keparahan / jenis, pencarian, *Muat lebih lama*,
  unduh CSV, bunyi alarm opsional untuk event serius & kritis, badge jumlah event
  belum dibaca saat tab lain aktif; klik kode objek untuk memilih & terbang ke objek.
- **API**: `GET /api/power/soe?limit&before_id&after_id&category&severity&kind&q&from&to&target_kind&target_id&user`.
- **Retensi**: `monitoring.soe_retention_days` (bawaan 365 hari), dibersihkan tiap 6 jam.

## Export / import data GIS

- **Peta Jaringan → tab Data**: export **GeoJSON** dan import kembali hasil edit
  **QGIS**. **Pusat Operasi → tab Export**: export **Esri File
  Geodatabase** (`.gdb` dalam zip, satu feature class per tipe komponen, dibuat
  dengan GDAL `ogr2ogr` driver OpenFileGDB di container backend), dengan filter
  status nyala / padam.
- Data wajib dipilih dulu: **area** (tampilan peta saat ini atau poligon yang
  digambar) dan **layer**. *Periksa ukuran* menampilkan jumlah fitur & ukuran;
  export ditolak bila melebihi **10 MB**.
- GeoJSON (EPSG:4326) berisi kolom datar: `qgis_kind` (node/edge), `qgis_id`,
  `type_code`, `code`, `name`, `status`, atribut objek sebagai kolom sendiri, dan
  kolom informasi (`energized`, `from_node_id`, `to_node_id`, `length_m`). Gardu
  & GI diekspor sebagai poligon denah.
- **Import** (izin `gis.edit`, maks. 10 MB, 5.000 perubahan): fitur ber-`qgis_id`
  dibandingkan dengan data saat ini (toleransi presisi koordinat QGIS,
  Multi* satu bagian diterima) lalu diperbarui lewat editor bertopologi; fitur
  tanpa `qgis_id` (wajib `type_code`) dibuat baru, kecuali bertipe & berkode sama
  sudah ada di lokasi itu (import ulang aman). Ujung garis mengikuti sambungan
  di aplikasi: menggeser node di QGIS memindahkan node (garis ikut), mengubah
  vertex tengah membentuk ulang garis. Fitur yang dihapus di QGIS **tidak**
  dihapus.
- **Pratinjau & rekap sebelum impor**:
  - jumlah fitur, baru, ubah, sama, dan galat, disertai bilah proporsi;
  - rekap per layer;
  - daftar yang bisa difilter & dicari, berisi alasan galat per fitur;
  - *Tampilkan di peta* (hijau = baru, biru = ubah, merah = galat);
  - unduh CSV daftar galat;
  - hasil impor berupa rekap berhasil / gagal.
- Validasi pratinjau mencakup: geometri & jenis, `type_code` wajib, kode ganda di dalam berkas,
  atribut SSOT bentrok, dan titik bertopologi yang menumpuk objek lain.
- Dalam mode persetujuan, impor dimasukkan ke **paket perubahan baru** (sumber `import`) dan baru
  berlaku setelah disetujui & dirilis.
- API: `POST /api/exchange/export {format: geojson|gdb, dry, bbox|polygon, types, energized}`,
  `POST /api/exchange/import?apply=0|1` (badan GeoJSON).

## Energize / de-energize dari sistem eksternal lewat Kafka

- Sistem eksternal (SCADA, DMS, AMI, ...) mengirim JSON ke topik `scada.switch.events` (konfigurasi
  `scada.switch_topic`, consumer group `scada.switch_group`; ubah = mulai ulang backend). Kunci pesan
  sebaiknya kode objek agar urutan perintah satu objek terjaga.
- Kolom (nama fleksibel ID / EN, diurai `internal/switchcmd`): `code` / `kode` / `name` / `nama` (atau `id`),
  `type` / `jenis` (kode / nama tipe), `status` open | close (juga buka / tutup, off / on, trip,
  deenergize / energize), `outage_category` / `kategori` (wajib untuk open), `timestamp` / `tanggal`
  (ISO 8601, "YYYY-MM-DD HH:MM:SS" WIB, epoch), `event_id` (anti duplikat), `note`, `source`.
- Objek dicari dari kode / nama / kode SSOT / IDPEL (+ jenis); dijalankan lewat `execManeuver` — jalur
  yang sama dengan operator (kejadian padam, SAIDI / SAIFI, SOE kanal `kafka`, notifikasi, audit);
  tanggal dipakai sebagai waktu manuver / mulai / selesai padam / SOE. Status yang sudah sama diabaikan.
- Log di tabel `switch_events` (applied | skipped | duplicate | error); halaman **Administrasi → Integrasi
  Kafka**: status, format, uji kirim (Kafka / langsung), log. API: `GET /api/admin/switch-events`,
  `POST /api/admin/switch-events/test?mode=kafka|direct`.

## Impor Esri File Geodatabase PLN (GDB)

- **Administrasi → Impor GDB** (izin `admin.config`): unggah ZIP berisi folder `*.gdb`
  (maks. 1 GB) + tag batch. Job latar belakang: ekstrak → cek 18 layer wajib → `ogr2ogr`
  PGDump → `psql` ke skema `stg_<tag>` → `backend/internal/gdbimport/import_staging.sql`
  (satu transaksi) → unit pemilik dari lokasi (opsional) → hapus staging (opsional simpan)
  → muat ulang graf.
- Pemetaan tipe, pemotongan garis di simpul (grid 1 cm), tiang sebagai objek pendukung,
  dan kepala penyulang sintesis di GI dijelaskan di kepala skrip SQL.
- Objek bertanda `properties.import = <tag>`; tag sama = ganti batch. Riwayat di tabel
  `gdb_imports`; indeks parsial `gis_nodes_import_idx` / `gis_edges_import_idx`.
- Impor langsung, **tidak** melalui alur persetujuan.
- Denah gardu miniatur (skematik GDB, median ±1,6 m; komponen berjarak cm) diperbesar dengan
  `SELECT * FROM qgis_expand_gardu_layout('<tag>', 10, 25)` (migrasi 044; target 10 m dibatasi 90% jarak ke
  gardu terdekat, skala maks. 25×) agar simbol tidak menumpuk di zoom 24. Posisi asli node / saluran di
  `gis_layout_backup` (kind, id, geom, footprint, length_m, tag); gardu bertanda `properties.denah_skala`.
  Mengembalikan: `UPDATE gis_nodes n SET geom = b.geom, footprint = COALESCE(b.footprint, n.footprint),
  properties = n.properties - 'denah_skala' FROM gis_layout_backup b WHERE b.kind = 'node' AND b.id = n.id AND b.tag = '<tag>'`
  (dan serupa untuk `gis_edges` dengan `geom`, `length_m`), lalu naikkan versi tile.
- Status GDB `INACTIVE` → `status_operasi = "Non aktif"`, `DECOMMISSIONED` → `"Bongkar"` (gardu, trafo,
  PHB-TR, pelanggan; nilai asli di `gdb_status`); pelanggan tanpa SR → `"Tidak operasi"`; gardu berkode /
  bernomor mengandung kata `REN` / `RENCANA` → `"Rencana"`. Atribut `status_operasi` (Operasi / Rencana /
  Non aktif / Tidak operasi / Bongkar, semua objek titik bertopologi) mengecualikan objek dari rekap graf (dilewati di rekap nyala /
  padam & dampak kejadian; pelanggan bukan sink), rekap wilayah, dan daftar pelanggan; di tile peta
  properti `nonaktif` → abu-abu. Kondisi SQL bersama: `gis.SQLNonOperating`.
- API: `POST /api/admin/gdb-import?tag=&name=&assign_units=1&keep_staging=0` (badan ZIP),
  `GET /api/admin/gdb-import/status`, `GET /api/admin/gdb-import/batches`,
  `DELETE /api/admin/gdb-import/batches/:tag?apply=0|1`.
- `POST /api/units/auto-assign` menerima `import_tag` untuk membatasi penetapan unit ke satu batch.
- Manual (tanpa UI): muat layer ke skema staging lalu
  `psql -v src=stg_x -v tag=X -f backend/internal/gdbimport/import_staging.sql`.

## Single Line Diagram (SLD) otomatis

Menu **Single Line Diagram** (`/sld`, migrasi `018_sld.sql`) menurunkan diagram satu garis
langsung dari graf topologi GIS, sehingga selalu sinkron dengan peta, monitoring, trace, dan
aliran daya. Tidak ada gambar terpisah yang perlu dirawat.

**Cakupan** (panel kiri):

| Cakupan | Isi diagram |
|---|---|
| Penyulang | GI → trafo GI → kubikel incoming → busbar → kubikel outgoing → sampai ujung penyulang |
| Gardu induk | GI → trafo GI → busbar → seluruh penyulangnya |
| Gardu distribusi | jalur hulu (diringkas) → gardu → trafo → rak TR → switch jurusan → jurusan → pelanggan |
| Objek | jalur hulu objek sampai sumber + seluruh hilirnya (recloser, LBS, gardu, ...) |
| Area GIS | poligon di peta: objek dalam area digambar penuh, jalur hulu ke sumber diringkas, jaringan yang keluar area menjadi penghubung antar-halaman |

**Penyusunan** (`POST /api/sld/build {scope, id, level, polygon?}`):

- Pohon dibangun dari sumber memakai **topologi normal** (posisi normal switch), sehingga
  bentuk diagram tidak berubah karena manuver. Warna dan simbol mengikuti kondisi saat ini.
  Switch normally-open, arah LBS 3 way yang normal terbuka, dan sambungan ke penyulang lain
  digambar sebagai **tie** (garis putus-putus "NO → ...") dan loop sebagai sambungan berlabel.
- **Penyederhanaan**: junction dan tiang pass-through dilipat. Segmen berurutan digabung
  menjadi satu seksi berlabel panjang total, penghantar, dan jumlah objek yang dilipat (`+n`).
- **Tingkat detail**: hanya TM, sampai trafo gardu, sampai jurusan TR, atau sampai pelanggan.
  Pelanggan di bawah tingkat yang dipilih diagregasi per titik potong ("16 plg · 38,9 kVA").
- **Tata letak** ortogonal ala SLD PLN: sumber di kiri (atau di atas), cabang utama
  (pelanggan terbanyak) lurus, cabang lain tegak lurus. Saluran utama yang sangat panjang
  **dilipat** menjadi beberapa baris dengan penanda kelanjutan K1, K2, ....
- Batas `sld.max_elements` (bawaan 3000) dan tingkat detail bawaan `sld.default_level`.
  Hasil di-cache per versi graf. Jarak topologi normal disimpan di graf dan dihitung ulang
  hanya saat topologi diedit. Satu penyulang disusun dalam ±20–60 ms.

**Integrasi dengan GIS & operasi**:

- Status nyala/padam dan posisi switch diperbarui **realtime** (WebSocket `maneuver`,
  `energized`, `topology.rebuilt`); edit jaringan di GIS membuat diagram disusun ulang.
- Klik elemen atau seksi membuka panel objek. Dari sana tersedia kotak **operasi buka/tutup
  atau energize/deenergize**: endpoint, kategori pemadaman, konfirmasi, dan izin per role
  (`power.switch_*`, `power.energize_*`) sama dengan peta, dan tercatat sama di manuver,
  kejadian padam, SOE, dan indeks keandalan.
- **Sorot silang**: *Lihat di peta* / *Monitoring* membuka objek di peta. Tombol **Buka SLD**
  di panel Fitur Editor Peta dan popup Monitoring membuka SLD cakupan objek itu
  (`/sld?focus=node:ID`, cakupan dipilih otomatis lewat `GET /api/sld/resolve`).
- **Overlay aliran daya**: warna seksi menurut pembebanan (<60 / 60–80 / 80–100 / >100 %) dan
  tegangan pu di tiap elemen (dihitung lewat `/api/powerflow/feeder` untuk penyulang dalam
  diagram, maksimal 6).

**Ekspor & penyesuaian**:

- **SVG**, **PNG** (resolusi 2×), dan **PDF** lewat dialog cetak browser: halaman A3 lanskap
  dengan kop (aplikasi, judul diagram, penyulang, tingkat detail, tanggal cetak, pengguna)
  dan legenda.
- **Atur posisi manual** (izin `gis.edit`): seret elemen lalu simpan. Pergeseran disimpan per
  cakupan & per id objek (`sld_positions`, `PUT/DELETE /api/sld/positions`), tetap berlaku saat
  diagram disusun ulang; objek baru ditempatkan otomatis. *Kembalikan otomatis* menghapusnya.
- Topologi tetap diedit di GIS; SLD hanya untuk melihat & mengoperasikan.

## Dokumentasi (menu di aplikasi)

Menu **Dokumentasi** (`/docs`, migrasi `019_docs.sql`, untuk semua peran) berisi:
overview aplikasi, fitur, arsitektur (diagram lapisan & alur realtime), proses bisnis
(pemeliharaan data, operasi & gangguan, perencanaan, tata kelola akses, matriks izin),
instalasi & konfigurasi, dan buku panduan penggunaan dengan tangkapan layar tiap fitur.
Daftar isi dengan pencarian, perbesar gambar, dan tombol **Cetak / simpan PDF** (A4, tiap
bagian di halaman baru). Isi ada di `frontend/components/docs/content.tsx`; diagram di
`diagrams.tsx` mengikuti tema terang/gelap.

Tangkapan layar (`frontend/public/guide/*.jpg`) dapat diperbarui setelah UI berubah:

```bash
npm i -D playwright && npx playwright install chromium
node scripts/docs-screenshots.js frontend/public/guide   # lalu build ulang frontend
```

## Operasi jaringan: FLISR, rencana manuver & simulasi what-if, laporan gangguan

Fitur operasi ada di menu **Pusat Operasi** (`/monitoring`, sebelumnya *Peta Jaringan Listrik*, migrasi `021_operations.sql`
& `022_outage_continuation.sql`). Panel kanan punya dua grup tab: **Monitoring** (padam, SOE,
trace, GI, penyulang, gardu, pelanggan, ekspor) dan **Operasi** (FLISR, Rencana Manuver, Laporan
Gangguan, AI Operasi). Objek yang dipilih di peta dipakai kedua grup. Pita rekap juga
menampilkan rencana manuver aktif dan laporan terbuka. Menu operasi terpisah yang lama
dihapus (`024_merge_operations_menu.sql`); URL `/operations?tab=…` dialihkan ke
`/monitoring?tab=…`.

**Simulasi what-if** (`POST /api/ops/simulate`): urutan aksi buka/tutup disimulasikan tanpa
mengubah jaringan. Hanya wilayah terkait yang dihitung, yaitu penyulang target, penyulang
tetangga lewat tie (2 putaran), dan area sumber. Hasil per langkah: pelanggan padam
sekarang/setelah, pulih, padam baru, beban per penyulang
(`kapasitas = √3·kV·A`, konfigurasi `ops.feeder_capacity_a`, `ops.feeder_kv`,
`powerflow.load_factor`), dan peringatan paralel/beban lebih. Hasilnya tampil sebagai overlay
di peta (hijau pulih, merah padam baru, biru objek dimanuver).

**FLISR** (lokalisasi, isolasi & pemulihan; bersifat penasihat): pilih kejadian padam aktif.
Sistem menampilkan kandidat seksi gangguan yang dibatasi sakelar, lengkap dengan riwayat
gangguan 365 hari dan jumlah laporan pelanggan terbuka. Untuk seksi yang dipilih, sistem
menyusun:

- buka sakelar batas seksi (isolasi hulu & hilir),
- tutup alat yang trip (pemulihan hulu),
- tutup tie untuk tiap pulau hilir, memilih kandidat dengan persentase beban akhir terendah
  dan hanya jika ≤ 100%.

Semua langkah lalu disimulasikan. Tidak ada yang dijalankan otomatis: hasilnya disimpan sebagai
rencana manuver.

**Rencana manuver** (izin `power.plan`, persetujuan `power.plan_approve`): draft berisi langkah
BUKA/TUTUP yang bisa diurutkan dan disimulasikan, lalu disetujui dan dieksekusi langkah demi
langkah secara berurutan (atau dilewati). Eksekusi memakai jalur manuver yang sama dengan Power
Monitor, sehingga izin TM/TR, pencatatan padam, SOE, dan audit ikut berlaku.

**Padam lanjutan**: bila sebuah padam ditutup tetapi sebagian pelanggan masih padam (pemulihan
parsial), sistem membuka kejadian anak (`outages.parent_id`) per sakelar pengisolasi. Kejadian
anak menambah SAIDI/ENS tetapi tidak menambah SAIFI maupun jumlah kejadian.

**Laporan gangguan pelanggan** (izin `report.manage`):

- Nomor tiket berformat `LG-YYYYMMDD-NNNNN`.
- Kanal dan kategori laporan dicatat. Pelanggan dicari lewat kode/idpel/kode SSOT, atau
  pelanggan terdekat dalam 50 m dari titik lokasi.
- Prioritas otomatis: bahaya/kabel putus → darurat.
- Laporan otomatis ditautkan ke padam aktif dan otomatis selesai saat padam itu ditutup.
- SLA diatur lewat `ops.report_sla_minutes` (bawaan 120 menit); laporan yang melewatinya
  ditandai terlambat.
- **Dugaan lokasi gangguan**: laporan terbuka yang belum tertaut padam dikelompokkan, lalu
  dicari titik bersama terdekat pada topologi normal.

## Dasbor eksekutif, laporan berkala, keandalan wilayah & AI operasi

Migrasi `023_executive.sql` menambahkan menu **Dasbor Eksekutif** (`/executive`; sejak migrasi
`032_menu_dashboard_scada.sql` menjadi **Dashboard › Keandalan & Operasi** / *Reliability and Operations*) dan
**Keandalan Wilayah** (`/reliability`). Izinnya `exec.view` untuk melihat dan `exec.report`
untuk menyusun/menghapus laporan dan menulis ringkasan. Target keandalan diatur di konfigurasi
`reliability.target_saidi_year` (bawaan 120 menit/pelanggan) dan `reliability.target_saifi_year`
(bawaan 2 kali/pelanggan). Target periode dihitung pro-rata terhadap panjang periode.

**Dasbor eksekutif** (`GET /api/exec/dashboard?period=today|month|30d|year`) berisi:

- kondisi saat ini: pelanggan padam, padam aktif, laporan terbuka/melewati SLA, rencana aktif,
  penyulang dengan beban ≥ 80%;
- kinerja periode: SAIDI, SAIFI, ENS, jumlah kejadian, rata-rata lama padam, dan laporan yang
  selesai sesuai SLA, dibandingkan dengan periode sebelumnya dan target;
- realisasi tahun berjalan vs target beserta proyeksi akhir tahun;
- tren SAIDI 12 bulan dan kejadian per hari;
- rincian per kategori, penyulang terdampak terbesar, ULP dengan SAIDI tertinggi;
- temuan otomatis.

**Laporan berkala** (tab *Laporan Berkala*) berupa snapshot harian, mingguan (Senin–Minggu), dan
bulanan di tabel `periodic_reports`:

- Dibuat otomatis untuk periode lengkap terakhir (00:15 WIB, bila `report.auto_daily|weekly|monthly`
  aktif), atau manual lewat `POST /api/exec/reports`.
- Isinya: indikator vs periode sebelumnya & target, per kategori, per UP3/ULP, penyulang,
  kejadian terbesar, operasi & layanan pelanggan, serta rincian harian.
- Laporan bisa dicetak A4 (selalu bertema terang) dan diunduh sebagai CSV.
- Ringkasan eksekutif dapat ditulis manual atau disusun AI.

**Keandalan per wilayah UP3/ULP**:

- Setiap kejadian padam menyimpan jumlah pelanggan terdampak per ULP (`outages.regions`), dihitung
  dari titik pelanggan terdampak di dalam poligon ULP. Kejadian lama dihitung saat backend start.
- Pelanggan·menit dan ENS dibagi ke wilayah sebanding jumlah pelanggan. UP3 adalah gabungan
  ULP-nya.
- Pelanggan di luar poligon masuk kelompok **di luar batas wilayah**.
- Halaman menampilkan peta koroplet (SAIDI, SAIFI, ENS, kejadian, padam sekarang), tabel
  UP3 → ULP, dan rincian wilayah: kategori, penyulang, dan kejadian beserta porsi wilayahnya.
- Setelah batas wilayah diubah, hitung ulang lewat `POST /api/exec/regions/recompute`.

**AI untuk operasi.** Konteks disusun deterministik oleh backend dari data aplikasi; LLM hanya
menulis analisis. Kunci API dan penyedia sama dengan AI Assistant.

- **Temuan otomatis** (`GET /api/ops/insights`, tanpa LLM):
  - padam aktif lebih dari 2 jam;
  - penyulang dengan gangguan ≥ 3 kali dalam 30 hari;
  - alat yang trip berulang;
  - padam sesaat berulang;
  - proyeksi SAIDI melebihi target;
  - ULP di atas target pro-rata;
  - beban penyulang tinggi;
  - laporan melewati SLA;
  - kumpulan laporan tanpa kejadian padam tercatat;
  - rencana yang tertunda.
- **Tab AI Operasi** di grup Operasi menu Pusat Operasi (`POST /api/ai/ops`, izin `ai.use`):
  - *analisis kejadian padam*: dampak, dugaan seksi, usulan FLISR tersimulasi, risiko K3, dan
    draf pesan pelanggan;
  - *review rencana manuver*: berdasarkan hasil simulasi;
  - *laporan serah terima shift*;
  - *temuan & rekomendasi*.

  Tugas yang sama dapat dibuka dari tombol *Analisis AI kejadian* (FLISR) dan *Review AI*
  (rencana). Jawaban dialirkan, dapat ditanya lanjut, dan dicatat di audit (`ai.ops`).
- **Ringkasan eksekutif AI** untuk laporan berkala (`task: report`) dan analisis temuan di dasbor.

## Versi mobile (PWA) & fitur lapangan

QuadranGIS dapat dipasang di ponsel sebagai **Progressive Web App** (`public/manifest.webmanifest`,
`public/sw.js`, migrasi `026_field_mobile.sql`). Di Android/Chrome, gunakan tombol *Pasang aplikasi*
(bar atas atau menu Lapangan). Di iPhone/iPad, pilih Bagikan → *Tambahkan ke Layar Utama*.

**Tampilan ponsel** (lebar ≤ 767 px):

- Sidebar diganti bar atas (☰ laci menu, status offline, jumlah antrean) dan navigasi bawah:
  Dasbor, Pusat Operasi, Lapangan, SLD, Menu.
- **Pusat Operasi**: panel kanan menjadi *bottom sheet* (intip / setengah / penuh, bisa ditarik).
  Objek yang dipilih tampil di dalam sheet, termasuk buka/tutup, trace, dan foto.
  Tombol GPS menampilkan posisi dan akurasi di peta.
- **SLD**: cubit dua jari untuk zoom. Panel cakupan menjadi laci; objek terpilih menjadi lembar bawah.
- Dasbor Eksekutif, Laporan Berkala, dan Keandalan Wilayah menyesuaikan layar kecil.
- **Editor Peta**: panel tertutup bawaan dan alat gambar disembunyikan. Pengeditan lengkap
  tetap di desktop/tablet.

**Menu Lapangan** (`/field`):

- GPS dan **aset terdekat** (`GET /api/field/nearby`, pencarian KNN GiST, filter gardu /
  proteksi / tiang / pelanggan). Tiap aset punya tombol lihat di peta, navigasi (Google Maps),
  foto, dan SLD.
- **Foto aset** (`POST /api/field/photos`, izin `field.photo`): dikompres di ponsel (≤ 1600 px,
  ≤ `mobile.photo_max_kb`) beserta thumbnail, lalu disimpan di tabel `asset_photos` dengan
  koordinat. Galeri foto juga tersedia di kartu objek Pusat Operasi.
- **Laporan gangguan cepat** (kanal `LAPANGAN`) dengan lokasi GPS dan sampai 3 foto.
- **Antrean offline**: laporan dan foto yang dibuat tanpa sinyal disimpan di IndexedDB, lalu
  dikirim otomatis saat online, laporan lebih dulu, baru fotonya.
  - Pengiriman idempoten lewat `client_id`, sehingga kiriman ulang tidak membuat data ganda.
  - Waktu laporan memakai waktu saat dibuat di ponsel.
  - Antrean hanya dikirim oleh pengguna yang membuatnya.
- **Area kerja offline**: tile jaringan di sekitar lokasi (atau tampilan peta, lewat tombol unduh
  di toolbar Pusat Operasi) disimpan di Cache Storage.
  - Batas jumlah tile diatur `mobile.offline_max_tiles`.
  - Peta dasar hanya ikut diunduh bila `mobile.offline_basemap=true`. Aktifkan hanya bila server
    peta dasar mengizinkan unduhan massal; kebijakan tile OpenStreetMap melarangnya.
- **Notifikasi Web Push** (`/api/push/*`): VAPID + enkripsi aes128gcm (RFC 8291/8292) memakai
  pustaka standar Go (`internal/push`).
  - Kunci VAPID dibuat otomatis (`push.vapid_public`, `push.vapid_private` bertipe secret).
  - Topik: padam & pulih (urgensi tinggi untuk GANGGUAN/BENCANA ALAM), laporan pelanggan baru,
    dan rencana manuver disetujui.
  - Langganan yang kedaluwarsa (404/410) atau gagal 5 kali dihapus otomatis.

**Service worker (offline):**

- Halaman: network-first → cache → `/offline.html`.
- API GET: network-first → data terakhir (header `X-QGIS-Offline`).
- Tile jaringan: network-first → cache → area kerja.
- Aset `_next/static`: cache-first.
- Peta dasar: stale-while-revalidate (dibatasi).
- Tidak di-cache: login/captcha, AI, dan WebSocket.
- Saat logout, cache data per pengguna (API, halaman, foto) dihapus.

**Syarat produksi:**

- Service worker, GPS, kamera, dan push hanya berjalan di **HTTPS dengan sertifikat tepercaya**.
  Sertifikat self-signed pengembangan tidak diterima ponsel.
- Push di iOS butuh iOS 16.4+ dan aplikasi yang sudah dipasang ke Layar Utama.

## Master Data › Data Aset (hirarki GI → pelanggan)

Menu **Data Aset** (`/master/assets`, migrasi `031_menu_asset_data.sql`, izin `master.view` atau
`gis.view`) menampilkan seluruh aset dalam hirarki
**GI → trafo GI → penyulang → gardu distribusi → trafo distribusi → jurusan TR → pelanggan**.

- Hirarki diturunkan dari pengelompokan graf di memori (posisi normal switch) oleh
  `internal/gis/assets.go`, dan disimpan sebagai indeks yang dibangun ulang malas. Indeks dibangun ulang
  bila pengelompokan berubah; setelah manuver, paling cepat setiap 15 detik.
- Pola data tanpa trafo distribusi (gardu → saluran TR → pelanggan) didukung: jurusan tampil langsung di
  bawah gardu. Pelanggan tanpa jurusan tampil di bawah gardu / penyulang. Aset tanpa GI dikelompokkan di
  "Tidak tersambung ke sumber".
- **Tab Hirarki (tree)** dimuat bertahap (200 anak per permintaan). Isinya:
  - status, jumlah anak, pelanggan (padam), beban tersambung, dan unit pemilik per aset;
  - pencarian objek yang membuka jalur hirarki sampai objek tersebut;
  - panel rincian (rantai hulu, peta Pusat Operasi, SLD, tabel di bawahnya).
- **Tab Tabel data**:
  - pilihan tingkat, cakupan (simpul pohon), pencarian kode/nama/SSOT, status, dan unit pemilik
    (termasuk unit bawahannya, kepemilikan efektif);
  - pengurutan kolom (hasil ≤ 60.000 baris), paging, dan ekspor CSV (≤ 100.000 baris).

| Metode | Path | Keterangan |
|---|---|---|
| GET | `/api/assets/tree?kind=root\|gi\|trafo_gi\|feeder\|gd\|trafo\|route\|none&id=&offset=&limit=&around=` | anak langsung satu simpul hirarki (`counts` per tingkat pada root) |
| GET | `/api/assets/table?level=&scope_kind=&scope_id=&q=&state=&unit=&sort=&dir=&offset=&limit=&format=csv` | tabel aset per tingkat |
| GET | `/api/assets/locate?kind=node\|edge&id=` | jalur hirarki dari akar sampai objek |

## Analisa Beban & Energi (load profile) trafo GI, penyulang & gardu dari SCADA/AMR

Menu **Analisa Beban & Energi** (`/load`, sebelumnya "Pembebanan"; migrasi `027_load_profile.sql` dan `028_load_energy_losses.sql`,
izin `load.view` dan `load.manage`). Paket backend-nya `internal/load`.

**Alur data:**

- Konsumer Kafka membaca topik `load.kafka_topic` (bawaan `scada.load.30m`, group `load.kafka_group`),
  menampung pesan, lalu menyimpan per batch.
- Setiap batch diikuti rekap harian, deteksi anomali, dan siaran realtime `load.data` / `load.anomaly`.
- Data juga bisa dikirim lewat HTTP: `POST /api/load/ingest`.
- **Kontrak pesan** (satu objek atau array per pesan; `type` = `feeder` | `trafo_gi` | `gd`):

  ```json
  {"point":"KBK-GMB-02","type":"feeder","ts":"2026-09-27T10:30:00+07:00",
   "i_r":182,"i_s":175,"i_t":190,"v_r":20.3,"v_s":20.4,"v_t":20.2,
   "p_mw":6.1,"q_mvar":1.9,"s_mva":6.39,"pf":0.95,"f_hz":50.01,
   "kwh_imp":3050,"kwh_exp":0,"kvarh_imp":950,"kvarh_exp":0,"quality":"good"}
  ```

  - `ts` = awal periode 30 menit; tanpa zona waktu dianggap WIB.
  - `v_r/v_s/v_t` (kV) boleh antarfasa atau fasa-netral. Nilai < 75% tegangan nominal titik dianggap
    fasa-netral lalu dikali √3 untuk tegangan antarfasa `v_kv`.
  - Energi `kwh_*` / `kvarh_*` adalah energi selama periode (`load.energy_mode = interval`), atau
    register meter (`cumulative`, bisa juga per pesan lewat `"energy_mode"`). Pada mode kumulatif,
    energi periode = selisih register dengan slot 30 menit sebelumnya. Register yang turun (reset)
    atau slot bolong menghasilkan energi kosong. Register terakhir disimpan di `scada_registers`.
  - Besaran yang tidak dikirim diturunkan: S dari P/Q atau arus × tegangan, P dari S × `load.default_pf`,
    Q dari S dan P, dan pf dari P/S.
  - Kiriman ulang untuk titik & waktu yang sama menimpa data lama.

**Pembebanan berbasis MW:**

- Besaran beban utama di seluruh analisa, laporan, prakiraan, dan N-1 adalah daya aktif **P (MW)**.
- % pembebanan = |P| ÷ daya mampu. Daya mampu = rating MVA × `load.cap_pf` (bawaan 0,85).
  Untuk penyulang, rating MVA = √3 × kV × arus nominal kubikel; untuk gardu, rating = kVA trafo.
- Energi harian dihitung dari meter kWh. Bila meter kosong, dipakai integrasi MW × 0,5 jam, dan
  jumlah slot bermeter dicatat sebagai `metered_slots`.

**Pemetaan titik** (`scada_points`, menu **Master Data › Titik SCADA** `/master/scada-points`; tautan
lama `/load?tab=points` diarahkan ke sana):

- Kode titik = kode kubikel penyulang, kode trafo GI, atau kode gardu di GIS, dan bisa dipetakan otomatis.
- Kode baru dari SCADA/AMR yang cocok dengan objek GIS **didaftarkan otomatis** (`load.auto_register`).
  Kapasitas gardu diambil dari atribut `daya_kva` trafo distribusi di dalam gardu; bila kosong,
  dipakai `load.default_gd_kva`.
- Hierarki disinkronkan dari graf: gardu → penyulang pemasok (`feeder_id`) → trafo GI → GI → UP3/ULP
  (poligon wilayah) → UID (atribut `uid` pada UP3, bawaan `load.default_uid`).
- Kode dari SCADA yang belum dikenal dicatat di daftar *belum dipetakan*.

**Penyimpanan:**

- `load_30m` adalah hypertable TimescaleDB (chunk 7 hari, kompresi setelah 21 hari). Tabel ini
  menyimpan arus & tegangan per fasa, P/Q/S, pf, frekuensi, energi impor/ekspor, dan % pembebanan.
- `load_daily` berisi rekap harian WIB:
  - puncak MW & jamnya, puncak MVA, puncak WBP/LWBP, beban minimum dan rata-rata;
  - energi impor/ekspor (MWh), MVArh, dan faktor beban;
  - jam ≥ 80% / ≥ 100%, ketidakseimbangan, pf, tegangan, dan frekuensi.
- `load_baseline` berisi profil dasar MW (median & MAD per jenis hari × slot, 4 minggu), diperbarui
  tiap hari.
- Beban kelompok (GI, UP3, UID, sistem) = jumlah serentak per slot dari **titik dasar**: trafo GI
  yang terukur ditambah penyulang yang trafonya tidak terukur, supaya tidak terhitung dua kali.
  Gardu berada di hilir penyulang, jadi tidak ikut dijumlah.

**Analisa** (gardu, penyulang, trafo GI, GI, UP3, UID, sistem):

- **Harian:** kurva MW 48 slot vs minggu lalu vs prakiraan, dan karakter beban. Untuk satu titik ada
  panel **besaran SCADA**: arus per fasa, tegangan per fasa, P/Q/S, pf, frekuensi, energi
  kWh/kvarh impor-ekspor per 30 menit, serta tabel data 30 menit (unduh CSV). Gardu ditampilkan dalam kW / V.
- **Bulanan:** puncak harian, energi harian, dan peta panas hari × jam.
- **Tahunan:** puncak bulanan vs tahun lalu (pertumbuhan), kurva lama beban, dan tabel bulanan
  (energi, faktor beban, jam ≥ 80%, kelengkapan data).
- Ringkasan menampilkan:
  - puncak sistem hari ini & kemarin, dan energi hari ini & kemarin;
  - susut kemarin, kelengkapan data, dan beban lebih;
  - peringkat pembebanan penyulang/trafo dan gardu.

**Susut energi (losses)** — tab **Susut**, `GET /api/load/losses` dan `/api/load/losses/feeder`:

- **Neraca energi harian antar-tingkat meter:**
  - trafo GI → Σ penyulang (selisih GI: bus 20 kV, pemakaian sendiri, beda meter);
  - penyulang → Σ gardu (**susut distribusi**: JTM + trafo gardu sampai meter gardu).
- Energi harian dikoreksi untuk slot yang hilang, dan hanya hari dengan ≥ 40 slot yang dihitung.
- Bila tidak semua gardu penyulang bermeter, energi gardu diperkirakan dari **cakupan** kapasitas
  (kVA) gardu yang terukur. Hari dengan cakupan < `load.losses_min_coverage` (bawaan 90%) tidak
  dihitung, dan statusnya ditandai *lengkap / estimasi / cakupan kurang*.
- Hasil tersedia per penyulang, per trafo GI, dan agregat GI / UP3 / UID / sistem, untuk periode
  harian, 30 hari, bulanan, atau tahunan. Ada juga susut gabungan trafo GI → gardu dan tren susut harian.
- **Rincian penyulang:**
  - profil per 30 menit (beban penyulang vs Σ gardu vs susut);
  - susut harian, dan energi & pembebanan tiap gardu;
  - **dekomposisi** susut dengan regresi L = a + b·P + c·P² atas slot 30 hari: komponen tetap
    (rugi inti trafo), sebanding beban (indikasi non-teknis / meter), dan kuadrat beban (rugi teknis I²R).
- Anomali `losses` dicatat harian:
  - susut distribusi ≥ `load.losses_high_pct`;
  - susut negatif (indikasi kesalahan meter atau gardu tercatat di penyulang lain);
  - selisih trafo GI ≥ `load.losses_gi_pct`.

**Susut gardu → pelanggan (kWh tagihan bulanan)**

Mode **Gardu → pelanggan (bulanan)** pada tab **Susut** dibuat dengan migrasi `033_customer_kwh.sql`.
Data kWh pelanggan tidak berasal dari SCADA; datanya diimpor per bulan dari billing / AP2T.

- **Impor** CSV (pemisah `;` `,` tab `|`) atau XLSX (lembar pertama, tanpa pustaka tambahan):
  - kolom wajib `IDPEL` dan `kWh`; opsional `BLTH`/periode, nama, tarif, daya (judul kolom dikenali dari beberapa alias);
  - angka format Indonesia (`1.234,5`) maupun internasional; baris ganda (periode + IDPEL sama) dijumlahkan;
  - pratinjau dulu (`apply=0`), lalu simpan (`apply=1`); `replace=1` mengganti seluruh data periode;
  - maksimum 200 MB (nginx punya lokasi khusus untuk endpoint impor);
  - riwayat impor tersimpan dan dapat dihapus.
- **Pencocokan**: atribut `idpel` pelanggan GIS (indeks `gis_nodes_idpel_idx`), lalu `kode_ssot`, lalu kode objek.
  Gardu pelanggan ditentukan dari topologi (`Graph.SinkGroups`).
- **Susut gardu** = energi keluar gardu (AMR, Σ hari sah × hari sebulan ÷ hari sah) − Σ kWh pelanggan.
  Bulan energi gardu = BLTH − `load.lv_billing_lag_months` (migrasi `034_billing_lag.sql`, bawaan 0; bisa diganti
  per tampilan dengan `lag=0..3`), karena BLTH umumnya memuat pemakaian bulan sebelumnya.
  Status per gardu:
  - `ok` / `estimasi` — dihitung;
  - `tagihan_kurang` — pelanggan bertagihan < `load.lv_min_billed_pct`;
  - `energi_kurang` — hari data AMR < `load.lv_min_energy_days_pct`;
  - `tanpa_meter` — gardu tanpa meter AMR.
  Tanda hasil: `tinggi` (≥ `load.lv_losses_high_pct`) dan `negatif`.
- **Rincian gardu**: tren 12 bulan dan daftar pelanggan dengan jam nyala (kWh ÷ kVA kontrak). Tanda pelanggan:
  `nol`, `rendah` (< `load.lv_low_hours`), `tanpa_tagihan`, `melebihi_daya`.
- Data: tabel `customer_kwh` (PK periode + IDPEL, `node_id` NULL bila tidak ditemukan) dan `customer_kwh_imports`.

| Metode | Path | Keterangan |
|---|---|---|
| POST | `/api/load/customer-kwh/import?period=&apply=0\|1&replace=0\|1&name=` | pratinjau / simpan berkas (izin `load.manage`) |
| GET/DELETE | `/api/load/customer-kwh` · `/api/load/customer-kwh/imports/:id` | periode & riwayat impor / hapus impor |
| GET | `/api/load/customer-kwh/unmatched?period=&format=csv` · `/api/load/customer-kwh/template` | IDPEL tak ditemukan, template berkas |
| GET | `/api/load/losses/customers?period=&lag=&up3&ulp&feeder&q&status&sort&dir&offset&limit&format=csv` | susut per gardu + rekap penyulang |
| GET | `/api/load/losses/customers/gd?period=&gd=` | rincian gardu: pelanggan & tren 12 bulan |

**Anomali** (`load_anomalies`; slot berurutan digabung menjadi satu kejadian dengan status
terbuka → ditangani → selesai):

- **Kualitas data:**
  - data hilang (termasuk titik yang berhenti mengirim > 1 jam);
  - nilai macet;
  - di luar batas fisik (termasuk energi negatif / frekuensi mustahil);
  - beban nol tanpa kejadian padam (gardu dicocokkan dengan padam penyulangnya);
  - lonjakan / penurunan tajam (median & MAD profil dasar);
  - **energi meter ≠ integrasi daya** (> `load.energy_dev_pct`, minimal 2 jam);
  - incoming trafo GI ≠ Σ penyulang (> `load.mismatch_pct`).
- **Kondisi jaringan:**
  - beban tinggi / lebih (`load.warn_pct`, `load.over_pct`);
  - ketidakseimbangan fasa;
  - faktor daya rendah;
  - tegangan di luar batas;
  - **frekuensi di luar batas** (`load.f_nominal` ± `load.f_dev`);
  - **susut tinggi / negatif**;
  - pergeseran level harian dibanding hari sejenis, yang otomatis **dikaitkan dengan manuver /
    kejadian padam** pada penyulang itu.
- Anomali serius dikirim sebagai Web Push topik `load`. Data hilang pada gardu tidak dikirim sebagai
  notifikasi karena jumlah gardu sangat banyak.

**Laporan beban:**

- Laporan harian, bulanan, dan tahunan dibuat otomatis (≥ 00:40 WIB) atau manual. Laporan disimpan
  di `periodic_reports` dengan kategori `load`.
- Isi laporan:
  - beban sistem (MW) vs periode sebelumnya & tahun lalu, dan energi impor/ekspor;
  - beban per UID/UP3/GI;
  - trafo & penyulang dengan pembebanan tertinggi, titik yang pernah ≥ 80%, dan gardu ≥ 80%;
  - **susut energi**: neraca GI & distribusi, susut per UP3, dan penyulang dengan susut tertinggi;
  - ringkasan anomali dan kelengkapan data.
- Laporan bisa dicetak / PDF, diunduh CSV, dan diberi ringkasan AI.

**Analisa lanjutan:**

- **Prakiraan beban (MW):** hari sejenis berbobot × tren mingguan, pita 10–90%, uji mundur MAPE, dan
  proyeksi puncak bulanan 12 bulan beserta bulan saat daya mampu terlampaui.
- **Kontingensi N-1:** beban puncak penyulang (MW) dilimpahkan lewat tie ke tetangga, dengan beban
  tetangga pada saat yang sama. Hasilnya aman / parsial / tidak aman.
- **Beban gardu:**
  - gardu bermeter memakai beban puncak & energi terukurnya;
  - gardu tanpa meter mendapat alokasi beban puncak penyulang sebanding daya kontrak;
  - keduanya dibandingkan dengan daya mampu trafo gardu.
- **Karakter beban:** residensial / bisnis / industri / campuran, dari profil dasar (penyulang, trafo GI, gardu).
- **Indeks kesehatan aset** (trafo GI / penyulang / gardu): pembebanan 12 bulan, umur, dan anomali.
- **Kalibrasi simulasi & FLISR:** faktor = puncak MVA terukur 7 hari ÷ daya kontrak. Faktor ini dipakai
  simulasi what-if dan FLISR menggantikan faktor beban tetap, dan rating kubikel dipakai sebagai
  kapasitas (`load.calibrate_sim`).
- **AI pembebanan** (`POST /api/ai/ops` dengan `task: load`) mendapat konteks beban MW, gardu
  terberat, dan susut.

**Simulator SCADA/AMR** (`load.simulator`, aktif bawaan di pengembangan):

- Membangkitkan data sintetis realistis:
  - bentuk kurva per jenis beban, hari kerja/libur (`load.holidays`), musim, dan pertumbuhan 5%/tahun;
  - semua besaran pesan: tegangan per fasa, frekuensi sistem, dan energi kWh/kvarh.
- Neraca energinya konsisten:
  - trafo GI = Σ penyulang × (1 + susut GI 0,3–1,2%);
  - Σ gardu = penyulang − susut distribusi (tetap + non-teknis + I²R). Sebagian kecil penyulang
    sengaja diberi susut non-teknis tinggi.
- Menyisipkan anomali telemetri & meter agar deteksi teruji, dan mengirim data **live tiap 30 menit
  lewat Kafka**.
- Saat pertama start:
  - titik dipetakan otomatis;
  - gardu diberi meter, yaitu seluruh gardu penyulang nyata + `load.sim_gd_feeders` penyulang
    simulasi massal;
  - riwayat diisi: 400 hari untuk titik nyata, 35 hari untuk titik simulasi massal beserta gardunya.
- Pengisian ulang tersedia lewat `POST /api/load/simulator/backfill`.
- **Matikan `load.simulator` saat SCADA/AMR asli tersambung.**

## Aliran daya (power flow)

Menu **Aliran Daya** (`/powerflow`) menghitung aliran daya tiap penyulang dengan
metode *backward/forward sweep* (jaringan distribusi radial), dari kubikel
outgoing 20 kV sampai pelanggan TR, pada kondisi jaringan saat ini (switch
terbuka/tertutup ikut diperhitungkan).

- **Model**: satu fase ekuivalen seimbang, per-unit (Sbase 1 MVA). Saluran R+jX
  per km menurut tipe; trafo distribusi (impedansi `powerflow.trafo_z_pct`, X/R
  `powerflow.trafo_xr`) di titik peralihan TM ke TR, kapasitas dari atribut
  `daya_kva` trafo/gardu atau `powerflow.default_trafo_kva`. Beban daya konstan
  = daya kontrak pelanggan × faktor beban, cos φ tetap. Loop (mesh) diabaikan
  dan dilaporkan.
- **Parameter penghantar bawaan** (Ω/km, KHA): SKTM 0,125+j0,097 / 400 A,
  SUTM 0,2162+j0,3305 / 425 A, SKUTR 0,443+j0,1 / 196 A, SKTR 0,268+j0,08 /
  206 A, SR 3,08+j0,1 / 54 A. Ganti per tipe lewat `powerflow.line_params`
  (JSON) atau per saluran lewat atribut SSOT `r_ohm_km`, `x_ohm_km`, `kha_a`.
- **Hasil**: tegangan tiap node (pu, kV/V), arus & pembebanan saluran terhadap
  KHA, pembebanan trafo, susut (kW, %), daya kirim, pelanggaran batas tegangan
  (`powerflow.v_min_pu` / `v_max_pu`, bawaan 0,90–1,05 pu) dan beban lebih.
  Peta mewarnai saluran/trafo menurut pembebanan atau tegangan (Normal, Waspada,
  Berat, Kritis).
- **Skenario**: faktor beban, cos φ, dan tegangan kirim dapat diubah di halaman
  tanpa mengubah konfigurasi.
- **API**: `POST /api/powerflow/feeder {head_id,...}`,
  `POST /api/powerflow/run-all`, `GET /api/powerflow/results`,
  `GET /api/powerflow/params`.
- Terukur pada data massal: satu penyulang (2.701 node) ±0,1 detik; seluruh
  1.005 penyulang (2,7 juta node) 2–3 detik. Diverifikasi terhadap solusi
  analitik dua bus (`internal/gis/powerflow_test.go`).

## AI Assistant

Menu **AI Assistant** (`/ai`, izin `ai.use`) memakai LLM pilihan: Claude
(Anthropic), ChatGPT (OpenAI), Kimi (Moonshot AI), atau OpenRouter. Jawaban
dialirkan (streaming) lewat `POST /api/ai/chat` sebagai server-sent events.

- **Pengaturan**: admin (izin `admin.config`) menekan *Pengaturan* di halaman AI,
  atau mengubah kunci `ai.*` di Konfigurasi: API key, model, dan base URL per
  penyedia, penyedia bawaan, batas token, instruksi tambahan. Model bawaan:
  `claude-sonnet-5`, `gpt-5-mini`, `kimi-k2-0905-preview`, `openrouter/auto`;
  sesuaikan bila akun Anda memakai model lain.
- **API key** bertipe `secret`: tidak pernah dikirim ke browser, menyimpan nilai
  kosong tidak mengubahnya, tombol *Hapus key* mengosongkannya. Kunci disimpan
  apa adanya (tidak terenkripsi) di tabel `app_configs`.
- **Sertakan data jaringan**: backend menambahkan ringkasan nyala/padam,
  penyulang padam, dan kejadian padam aktif ke prompt sistem, sehingga AI
  menjawab berdasarkan kondisi terkini.
- Riwayat obrolan disimpan di browser pengguna; setiap permintaan dicatat di
  audit (`ai.chat`, tanpa isi percakapan).
- **Ruang lingkup** (`ai.scope_strict`, bawaan `true`; kotak centang di *Pengaturan* halaman AI):
  - asisten hanya menjawab topik QuadranGIS: data & kondisi jaringan, operasi dan analisis jaringan
    distribusi (keandalan, beban, susut, aliran daya, gangguan, K3/SOP), serta cara memakai aplikasi;
  - pertanyaan lain (pengetahuan umum, hiburan, kode yang tidak terkait, dan sejenisnya) ditolak
    dengan sopan, disertai contoh pertanyaan yang relevan;
  - permintaan untuk mengabaikan atau membocorkan instruksi juga ditolak;
  - aturan ini ditaruh paling akhir di prompt sistem obrolan dan AI Operasi, setelah
    `ai.system_prompt` dan data jaringan, sehingga instruksi tambahan tidak dapat melonggarkannya.

## Cara memakai peta

1. **Memilih fitur**: mode *Pilih* (ikon kursor), klik titik/garis → panel *Fitur*
   menampilkan atribut, konektivitas, garis terhubung, riwayat, dan tombol trace.
2. **Menggambar titik**: ikon titik → pilih tipe (GI, GH, GD, trafo, kubikel,
   pelanggan…) → klik di peta. Klik di atas garis akan memisah garis itu; klik
   di atas junction akan mengubah junction menjadi tipe yang dipilih.
3. **Menggambar garis**: ikon garis → pilih tipe (busbar, SKTM, SUTM, SKUTR,
   SKTR, SR) → klik untuk tiap vertex, **dobel-klik / Enter** selesai,
   **Backspace** hapus vertex terakhir, **Esc** batal. Ujung garis otomatis
   menempel ke node/garis terdekat atau dibuatkan junction.
4. **Memindahkan / menggambar ulang**: dari panel Fitur tekan *Pindahkan*
   (node) atau *Gambar ulang* (garis).
5. **Manuver switch**: pilih kubikel / recloser / LBS → kotak *Manuver jaringan*
   di panel Fitur: pilih jenis (GANGGUAN, PEMELIHARAAN, MLS), lalu *Buka* atau
   *Tutup* (LBS 3 way juga per arah). Objek hilir padam/nyala, trace mengikuti,
   dan kejadian tercatat di menu Pusat Operasi.
6. **Trace**: pilih node → *Trace hilir / hulu / terhubung*, atau buka tab
   *Trace* untuk mengatur kedalaman dan tipe pemberhentian. Hasil ditandai
   oranye di peta dan dapat diunduh sebagai GeoJSON.
7. **Layer**: tab *Layer* untuk menyembunyikan tipe, peta dasar, label, memuat
   ulang tile, memeriksa topologi, dan melihat status graf.

## API ringkas

| Metode | Path | Keterangan |
|--------|------|------------|
| GET  | `/api/auth/captcha` | soal captcha |
| POST | `/api/auth/login` | `{username,password,captcha_id,captcha_answer}` |
| GET  | `/api/auth/me` | profil, izin, menu |
| GET  | `/api/gis/tiles/{z}/{x}/{y}.pbf` | vector tile |
| GET  | `/api/gis/features/{kind}/{id}` | detail fitur (`node`/`edge`) |
| POST | `/api/gis/features` | buat fitur (topologi otomatis) |
| PUT  | `/api/gis/features/{kind}/{id}` | ubah atribut/geometri |
| DELETE | `/api/gis/features/{kind}/{id}` | hapus |
| GET  | `/api/gis/snap?lng&lat&radius_m` | kandidat snapping |
| GET  | `/api/gis/search?q` | cari kode/nama |
| POST | `/api/gis/trace` | `{node_id,direction:down|up|connected,max_depth,stop_types}` |
| GET  | `/api/gis/topology/status` / `validate` | status graf & pemeriksaan |
| POST | `/api/gis/topology/rebuild` | muat ulang graf |
| POST | `/api/gis/maneuver` | `{node_id\|edge_id,action:open|close,kind:GANGGUAN|PEMELIHARAAN|MLS|MANUVER|BENCANA ALAM (wajib saat open),note,way_edge_id?}`; izin `power.switch_*` / `power.energize_*` |
| GET  | `/api/power/summary` | rekap nyala/padam (GI, trafo GI, penyulang, zona, GD, pelanggan, beban) |
| GET  | `/api/power/off-markers` | objek padam bertanda peta (tipe `monitoring.off_marker_types`) beserta kejadian padam aktifnya |
| GET  | `/api/power/feeder-colors` | seluruh penyulang dengan indeks warna palet, GI, dan jumlah objek yang sedang dilimpahkan |
| GET  | `/api/power/feeders/{id}/extent?live=1` | batas area penyulang (untuk memperbesar peta ke penyulang) |
| GET  | `/api/power/parallel` | penyulang yang beroperasi paralel (tie penyebab, titik temu) + jumlah loop pada posisi normal |
| GET  | `/api/power/feeders?state&q` | daftar penyulang beserta status |
| GET  | `/api/power/gi?state&q` | daftar gardu induk beserta rekap penyulang |
| GET  | `/api/power/customers?state&q&limit&offset` | daftar pelanggan nyala / padam (paging) |
| GET  | `/api/power/outages?active=1\|period=` / `/{id}` | kejadian padam per level, dengan ENS per kejadian (+ GeoJSON area terdampak) |
| GET  | `/api/power/maneuvers?node_id` | riwayat manuver |
| GET  | `/api/power/soe?limit&before_id&after_id&category&severity&q` | SOE (Sequence of Events), terbaru dulu |
| POST | `/api/sld/build` | `{scope: feeder\|gi\|gd\|node\|area, id, level: tm\|gd\|jurusan\|pelanggan, polygon?}` → diagram satu garis |
| GET  | `/api/sld/resolve?kind&id` | cakupan SLD bawaan untuk sebuah objek |
| GET/PUT/DELETE | `/api/sld/positions?scope` | posisi manual elemen SLD (ubah: `gis.edit`) |
| POST | `/api/ops/simulate` | `{actions:[{target_kind,target_id,action,way_edge?}]}` → simulasi what-if + GeoJSON |
| GET  | `/api/ops/flisr/sections?outage_id` | kandidat seksi gangguan (riwayat, laporan) |
| POST | `/api/ops/flisr` | `{fault_kind, fault_id}` → isolasi & pemulihan usulan + simulasi |
| GET/POST/PUT/DELETE | `/api/ops/plans[/:id]` | rencana manuver (ubah: `power.plan`) |
| POST | `/api/ops/plans/:id/{simulate\|approve\|cancel\|reopen}` | simulasi / status rencana (setujui: `power.plan_approve`) |
| POST | `/api/ops/plans/:id/steps/:seq/{execute\|skip}` | eksekusi / lewati langkah berurutan |
| GET/POST/PUT | `/api/ops/reports[/:id]` | laporan gangguan pelanggan (ubah: `report.manage`) |
| GET  | `/api/ops/reports/suspects` | dugaan lokasi gangguan dari laporan terbuka |
| GET  | `/api/ops/insights` | temuan operasi otomatis (tanpa LLM) |
| GET  | `/api/exec/dashboard?period=` | dasbor eksekutif: KPI, tren 12 bulan, tahun berjalan vs target (`exec.view`) |
| GET  | `/api/exec/regions?period=` / `/{id}` | keandalan per UP3/ULP (id 0 = di luar batas wilayah) |
| POST | `/api/exec/regions/recompute` | hitung ulang wilayah kejadian padam (`exec.report`) |
| GET/POST/DELETE | `/api/exec/reports[/:id]` | laporan berkala `{kind: daily\|weekly\|monthly, date}` (ubah: `exec.report`) |
| PUT  | `/api/exec/reports/:id/narrative` | simpan ringkasan eksekutif |
| POST | `/api/ai/ops` | `{task: outage\|plan\|shift\|report\|insights, outage_id\|plan_id\|report_id\|hours, messages?}` → analisis AI (SSE) |
| GET  | `/api/load/overview` | ringkasan pembebanan: puncak sistem (MW), energi, susut kemarin, kelengkapan data, peringkat penyulang/trafo/gardu, anomali, status Kafka |
| GET  | `/api/load/entities?level=` / `/api/load/analysis?level&id&period=day\|month\|year&date` | objek analisa & analisa beban (level `system\|uid\|up3\|gi\|trafo_gi\|feeder\|gd\|point`) |
| GET  | `/api/load/ranking?period&date&kind` | peringkat pembebanan titik |
| GET/PUT | `/api/load/anomalies[/:id]` · `/api/load/anomalies/:id/series` | anomali beban & data di sekitarnya (ubah: `load.manage`) |
| GET/POST/DELETE | `/api/load/points[/:id]` · `POST /api/load/points/automap` | titik SCADA ↔ objek GIS |
| POST | `/api/load/ingest` | kirim pesan SCADA lewat HTTP (jalur sama dengan Kafka) |
| POST | `/api/load/simulator/backfill` · `/api/load/recompute` | isi riwayat simulasi · hitung ulang rekap/anomali |
| GET/POST/PUT/DELETE | `/api/load/reports[/:id][/narrative]` | laporan beban harian/bulanan/tahunan |
| GET  | `/api/load/forecast` · `/n1` · `/gd?point` · `/profiles` · `/health` · `/calibration` | analisa lanjutan |
| GET/POST/PUT | `/api/gis/changesets[/:id]` · `/:id/geojson` · `POST /:id/submit\|approve\|reject\|release\|cancel` · `DELETE /:id/items/:item` · `POST /:id/items/:item/rebase` | paket perubahan (alur persetujuan editing); editing memakai `?cs=` |
| GET/POST/PUT/DELETE | `/api/units[/:id]` · `GET /api/units/owner?kind&id` · `GET /api/units/:id/assets` · `POST /api/units/auto-assign` | master data unit & kepemilikan aset |
| GET/PUT | `/api/branding` · `/api/branding/logo` (publik) · `PUT /api/admin/branding` | identitas aplikasi |
| GET  | `/api/load/losses?level&id&period=day\|30d\|month\|year&date` · `/api/load/losses/feeder?point&date&days` | neraca energi & susut (GI, distribusi, gabungan) · rincian susut penyulang (profil, dekomposisi, gardu) |
| GET  | `/api/field/nearby?lng&lat&radius&types&limit` | aset terdekat dari posisi GPS (urut jarak) |
| GET/POST/DELETE | `/api/field/photos[/:id]` | foto aset (`kind=node\|edge\|report&id`); unggah multipart `image`, `thumb`, `client_id` (izin `field.photo`) |
| GET  | `/api/field/photos/:id/image?thumb=1` | isi foto / thumbnail (cache immutable) |
| GET  | `/api/push/key` | kunci publik VAPID + langganan milik pengguna |
| POST | `/api/push/subscribe` / `unsubscribe` / `test` | kelola langganan Web Push perangkat ini, kirim notifikasi uji |
| GET  | `/api/power/reliability?period=today\|month\|year` | SAIDI, SAIFI, ENS kWh & Rupiah (total, per level, per jenis) |
| GET  | `/api/ws` | WebSocket event realtime |
| *    | `/api/admin/...` | users, roles, menus, configs, layers, monitoring |

## Simulasi massal (uji beban)

```bash
make seed-bulk     # 5-15 menit; restart backend otomatis agar graf dimuat ulang
make remove-bulk   # hapus kembali seluruh data massal (properti "bulk": true)
```

[scripts/seed_bulk.sql](scripts/seed_bulk.sql) membangun jaringan bertopologi
lengkap di Jawa Barat–Jawa Tengah (grid 20×5 GI, jarak antar GI ±20 km):

| Komponen | Jumlah | Keterangan |
|---|---|---|
| Power grid 150 kV | 100 | satu per GI, 6 km dari GI |
| Gardu induk | 100 | denah 80 m, 2 trafo, busbar 20 kV |
| Trafo GI | 200 | 60 MVA |
| Kubikel PMT outgoing | 1.000 | = 1.000 penyulang, 10 per GI |
| Segmen SKTM | 200.000 | 4 segmen per bentang antar gardu |
| Gardu distribusi | 50.000 | 50 per penyulang, ±300 m, denah 8 m |
| Segmen JTR (SKUTR/SKTR) | 500.000 | 2 jurusan × 5 tiang per gardu |
| Tarikan SR | 1.000.000 | 2 per tiang; tiap tarikan melayani 2 pelanggan (SR + SR deret = 2.000.000 segmen) |
| Pelanggan TR | 2.000.000 | 1 juta langsung + 1 juta deret |

Semua parameter ada di bagian atas skrip (`\set`). Skrip melepas index sebelum
menyisipkan dan membangunnya kembali di akhir (termasuk index trigram untuk
pencarian), lalu me-refresh ringkasan kepadatan. Pada peta: kepadatan tampil
sampai zoom 10, SKTM mulai zoom 11, GD zoom 12, JTR zoom 14, pelanggan/SR zoom
15 (semua dapat diubah di *Pengaturan Layer*).

Hasil terukur di mesin uji (Docker Desktop, VM 4 GB, 2,7 juta node + 2,7 juta
segmen):

| Operasi | Waktu |
|---|---|
| Seed massal (`make seed-bulk`) | ±3 menit |
| Muat graf trace saat backend start | 20–35 detik + pengelompokan penyulang/zona/jurusan ±6 detik; memori backend ±1,0 GB (`GOMEMLIMIT` 1200MiB) |
| Manuver satu penyulang penuh (50 GD, 2.000 pelanggan, 5.400 objek) | buka 1,3 detik, tutup 0,9 detik (hitung graf inkremental 0,05–0,2 detik, sisanya tulis DB) |
| Manuver recloser / LBS di simulasi Gambir | 0,1–0,3 detik |
| Rekap monitoring kelistrikan (`/api/power/summary`) | ±0,3 detik, cache 5 detik |
| Tile vektor, semua zoom (z6 kepadatan Jawa s.d. z17 SR/pelanggan) | < 100 ms tanpa cache, ±20 ms dari cache Redis |
| Pindah tampilan peta (tile + label, diukur event `idle` MapLibre) | 1,5–2,2 detik pada z12/z14/z17 |
| Pencarian kode/nama (index trigram) | 35–70 ms |
| Trace hilir satu GI (10 penyulang, 500 GD, 20.000 pelanggan) | ±0,4 detik hangat; 3–4 detik pada trace pertama setelah restart |
| Trace hulu pelanggan → GI | < 1 ms |
| Validasi topologi | ±1 detik |
| Statistik per tipe (`/api/gis/stats`) | ±6 detik, hasil di-cache 60 detik |

Catatan performa: SQL tile dirangkai sepenuhnya sebagai literal (daftar tipe dan
kotak tile), bukan parameter — dengan literal, planner PostgreSQL memakai
statistik per nilai sehingga zoom rendah memakai index tipe dan zoom tinggi
memakai index spasial; dengan parameter/CTE bersama, zoom rendah sempat memindai
2,3 juta baris (7 detik per tile).

## Struktur proyek

```
backend/   cmd/server, internal/{api,auth,cache,config,database,gis,middleware,
           models,monitor,realtime,repo,stream}, migrations SQL (embedded)
frontend/  app/(app)/{map,admin/*,profile}, components/{map,charts,ui}, lib
nginx/     nginx.conf, certs/
scripts/   gen-cert.sh|ps1, seed_bulk.sql
```
