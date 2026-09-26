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
- **Menu Monitoring Kelistrikan** (`/monitoring`): peta nyala/padam, rekap
  GI, trafo GI, penyulang (nyala / sebagian / padam), zona, gardu distribusi,
  trafo distribusi, pelanggan, beban; daftar kejadian padam aktif & riwayat dengan
  rekap per group dan tombol *Tampilkan di peta* (area terdampak); daftar
  penyulang dengan filter status. Diperbarui otomatis (`monitoring.power_refresh_seconds`)
  dan lewat WebSocket.
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
- **Monitoring Kelistrikan**: baris *Keandalan* di bawah pita rekap (pilihan periode,
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
- **Simbol standar kelistrikan** (gaya diagram satu garis IEC 60617): sumber AC, gardu
  induk, gardu hubung, gardu distribusi, transformator (dua lingkaran), pemutus tenaga /
  kubikel, recloser, LBS 2/3 arah, switch jurusan (NH fuse), rak TR (busbar), tiang,
  dan pelanggan (rumah). Alat switching punya varian **terbuka** (kotak berongga / pisau
  miring). Simbol digambar sebagai ikon SDF sehingga tetap berwarna per tipe atau
  nyala/padam, dengan tepi merah bila padam / terbuka. Simbol per tipe dapat diganti di
  *Pengaturan Layer* (kolom *Simbol*, `component_types.icon`, mis. `sym_trafo`); legenda
  di tab *Layer* memakai simbol yang sama.
- **Operasi dari Monitoring Kelistrikan**: popup objek terpilih punya kotak *Buka / tutup*
  (alat switching, termasuk per arah LBS 3 way) atau *Energize / deenergize* (objek
  non-switch & saluran). Saat membuka / deenergize **kategori pemadaman wajib**:
  GANGGUAN, PEMELIHARAAN, MLS, atau MANUVER. Saat menutup / energize kategori boleh
  kosong (mengikuti kejadian padam yang ditutup). Kotak yang sama dipakai di panel Fitur
  Editor Peta. Status objek topologi tidak lagi diubah lewat formulir edit, hanya lewat
  operasi (tercatat sebagai manuver, kejadian padam, dan SOE).
- **Tab GI (gardu induk)** di Monitoring Kelistrikan (setelah tab *Trace*;
  `GET /api/power/gi?state=all|on|partial|off&q=`): tiap GI dengan status nyala /
  sebagian / padam (padam bila GI padam atau seluruh penyulangnya padam; sebagian bila ada
  penyulang padam/sebagian atau trafo GI padam), trafo GI, penyulang, gardu distribusi,
  pelanggan, dan beban (nyala/total). Filter status, pencarian, klik kode untuk menuju GI,
  dan *Lihat n penyulang* membuka tab *Penyulang* yang tersaring ke GI itu.
- **Tab Pelanggan** di Monitoring Kelistrikan (setelah tab *Gardu*;
  `GET /api/power/customers?state=all|on|off&q=&limit=&offset=`): daftar pelanggan nyala /
  padam dengan paging di server (100 per halaman, *Muat berikutnya*), padam ditampilkan
  lebih dulu. Tiap baris: tipe, daya, penyulang, gardu distribusi, jurusan, kode SSOT; untuk
  pelanggan padam: waktu mulai padam, kategori, dan nomor kejadian aktif. Pencarian kode /
  nama / kode SSOT. Klik widget rekap *Pelanggan* membuka tab ini (filter padam bila ada).
  Indeks `gis_nodes (energized, code, id)` (migrasi 017) menjaga paging tetap < 0,4 detik
  pada 2 juta pelanggan.
- **Downtrace / uptrace di Monitoring Kelistrikan** (izin `gis.trace`): tombol di popup
  objek terpilih dan tab *Trace* (hilir / hulu, kedalaman maks, berhenti pada tipe,
  unduh hasil). Hasil disorot di peta dan dirangkum: jumlah node / garis, panjang,
  pelanggan, sumber, switch terbuka, rekap per tipe; klik baris untuk memilih objek.
- **Hak akses per role** (menggantikan `gis.maneuver`):

  | Izin | Untuk |
  |---|---|
  | `power.switch_tm` | buka / tutup alat switching TM (kubikel, recloser, LBS) |
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
- Di **Editor Peta** (tab *Layer*) dan **Monitoring Kelistrikan** (tombol *UP3* di toolbar
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
- **Keparahan**: normal (pemulihan), peringatan, serius (manuver GANGGUAN; padam
  zona / gardu distribusi), kritis (padam GI / trafo GI / penyulang).
- **Realtime**: setiap event disiarkan lewat WebSocket (`type: "soe"`) dan Kafka.
  Klien yang tersambung ulang menyinkronkan event yang terlewat (`after_id`).
- **Tab SOE** di Monitoring Kelistrikan: daftar terbaru di atas dengan jam
  `hh:mm:ss.mmm`, sorot baris baru, *Jeda* / *Lanjut* (event baru ditahan selama
  dijeda), filter kategori / keparahan / jenis, pencarian, *Muat lebih lama*,
  unduh CSV, bunyi alarm opsional untuk event serius & kritis, badge jumlah event
  belum dibaca saat tab lain aktif; klik kode objek untuk memilih & terbang ke objek.
- **API**: `GET /api/power/soe?limit&before_id&after_id&category&severity&kind&q&from&to&target_kind&target_id`.
- **Retensi**: `monitoring.soe_retention_days` (bawaan 365 hari), dibersihkan tiap 6 jam.

## Export / import data GIS

- **Peta Jaringan → tab Data**: export **GeoJSON** dan import kembali hasil edit
  **QGIS**. **Monitoring Kelistrikan → tab Export**: export **Esri File
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
  dihapus. Selalu ada pratinjau sebelum diterapkan.
- API: `POST /api/exchange/export {format: geojson|gdb, dry, bbox|polygon, types, energized}`,
  `POST /api/exchange/import?apply=0|1` (badan GeoJSON).

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
   dan kejadian tercatat di menu Monitoring Kelistrikan.
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
| POST | `/api/gis/maneuver` | `{node_id\|edge_id,action:open|close,kind:GANGGUAN|PEMELIHARAAN|MLS|MANUVER (wajib saat open),note,way_edge_id?}`; izin `power.switch_*` / `power.energize_*` |
| GET  | `/api/power/summary` | rekap nyala/padam (GI, trafo GI, penyulang, zona, GD, pelanggan, beban) |
| GET  | `/api/power/feeders?state&q` | daftar penyulang beserta status |
| GET  | `/api/power/gi?state&q` | daftar gardu induk beserta rekap penyulang |
| GET  | `/api/power/customers?state&q&limit&offset` | daftar pelanggan nyala / padam (paging) |
| GET  | `/api/power/outages?active=1\|period=` / `/{id}` | kejadian padam per level, dengan ENS per kejadian (+ GeoJSON area terdampak) |
| GET  | `/api/power/maneuvers?node_id` | riwayat manuver |
| GET  | `/api/power/soe?limit&before_id&after_id&category&severity&q` | SOE (Sequence of Events), terbaru dulu |
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
