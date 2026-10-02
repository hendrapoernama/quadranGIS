---
name: quadrangis-scada-cmms-requirements
description: "Kebutuhan modul Fasilitas Operasi SCADA, CMMS, Aset Register, Executive Reporting (30 Sep 2026): status per butir (3 ada / 6 sebagian / 9 belum), catatan, urutan usulan, pertanyaan terbuka"
metadata:
  node_type: memory
  type: project
  originSessionId: c6f0a2fc-1fcf-4a30-9b21-93226146c3a0
  modified: 2026-09-30T06:22:10.648Z
---

Pada 30 Sep 2026 pengguna mengirim daftar kebutuhan dan meminta review, lalu meminta hasilnya disimpan ke memori. Penomoran asli 1, 2, 5, 6; nomor 3 & 4 tidak ada dan belum dikonfirmasi. "Execute" kemungkinan maksudnya Executive. Belum ada yang dipilih untuk dikerjakan.

**1. Fasilitas Operasi SCADA**
- Peta & status RTU GI/GH/MP (zona yang di-remote): BELUM. Fondasi yang ada: GI/GH di peta, atribut `scada`/`motorized` pada alat switching, layer penanda berkedip bisa dipakai ulang.
- Validitas telesignal: BELUM. Belum ada daftar titik TS; status alat hanya lewat perintah Kafka `scada.switch.events` ([[quadrangis-kafka-switch]]).
- Validitas telemetering: SEBAGIAN. Anomali kualitas telemetri (data hilang, nilai macet, di luar batas, lonjakan) dan kelengkapan data, hanya untuk beban 30 menit penyulang/trafo GI/gardu; belum ada flag kualitas per titik dari SCADA.
- Status master: BELUM. Monitoring sistem yang ada hanya memantau server QuadranGIS.
- Peta & status jaringan telekomunikasi: BELUM.
- Laporan kinerja SCADA (histori, grafik harian/bulanan/tahunan): BELUM. Mesin laporan berkala & grafik bisa dipakai ulang.

**2. CMMS aset jaringan listrik & SCADA**
- Korektif: BELUM (tidak ada Work Order). Pemicunya sudah ada: kejadian padam, laporan pelanggan + SLA, anomali, menu Lapangan (PWA + foto).
- Preventif: BELUM (tidak ada jadwal interval / checklist inspeksi).
- Planning pemeliharaan: SEBAGIAN. Rencana manuver + persetujuan + kategori PEMELIHARAAN; belum ada kalender / rencana tahunan.
- Health index: SEBAGIAN. `HealthIndex` di backend/internal/load/analysis.go hanya untuk trafo GI & penyulang, dari pembebanan 12 bulan, umur, anomali 90 hari; tanpa inspeksi/riwayat gangguan; gardu, alat switching, dan alat SCADA belum.
- Laporan kondisi & KPI: SEBAGIAN. Hanya atribut `kondisi` (baik / rusak ringan / rusak berat) di sebagian tipe; belum ada laporan.

**5. Aset register**
- Aset jaringan listrik: ADA. Data Aset (hirarki GI → pelanggan), atribut SSOT, impor GDB, ekspor CSV, foto, riwayat. Kurang: kolom register (nomor aset, tanggal operasi) dan mutasi.
- Aset SCADA & telekomunikasi: BELUM (RTU, IED, modem/radio, link FO, server master, UPS).

**6. Executive management reporting**
- Rekap aset + grafik: SEBAGIAN (jumlah per tingkat ada, belum dashboard grafik).
- Rekap kinerja SCADA: BELUM (bergantung modul 1).
- Rekap gangguan + grafik: ADA. Dashboard Keandalan & Operasi (SAIDI/SAIFI/ENS, target, tren 12 bulan), Laporan Berkala harian/mingguan/bulanan, Keandalan Wilayah; laporan tahunan belum.
- Pembebanan & neraca energi: ADA. Laporan beban per UID/UP3/GI, neraca energi & susut trafo GI → penyulang → gardu, susut gardu → pelanggan dari impor kWh ([[quadrangis-customer-losses]]).
- Rekap KPI: SEBAGIAN (baru SAIDI/SAIFI/ENS vs target).

**Catatan review yang disampaikan**
1. Modul 1 bergantung pada data dari SCADA master: status komunikasi RTU, daftar titik TS/TM + flag kualitas (invalid, not topical, substituted), status server master/failover, status link telekom. Saat ini ingest hanya beban 30 menit & perintah switch via Kafka, dan data di server sintetis ([[quadrangis-load-sim]]). Di server 10.3.187.7 ada skrip `~/program/sync_ems.py`, sync_gi, sync_tbl_feeder, sync_tbl_trafo_gi (Oracle instantclient) yang mungkin sudah menarik data EMS/SCADA; belum ditelusuri, tanyakan pemiliknya ([[quadrangis-server-deploy]]).
2. Validitas & kinerja SCADA butuh definisi baku (rumus availability RTU, validitas TS/TM, keberhasilan remote control, target, periode) sesuai standar UP2D.
3. Aset register SCADA & telekom adalah fondasi modul 1, CMMS alat SCADA, dan modul 6. Usulan: RTU sebagai objek peta tertaut ke GI/GH/recloser-LBS (MP), link FO sebagai garis, radio/GSM sebagai relasi logis.
4. CMMS paling besar. Pastikan dulu ada/tidaknya sistem pemeliharaan korporat (hindari input ganda) dan siapa penyetuju (belum ada akun supervisor/manajer, lihat [[quadrangis-approval-workflow]]).
5. Grafik saat ini SVG buatan sendiri (tooltip, tanpa zoom/drill-down/ekspor gambar). Untuk laporan eksekutif "menarik dan interaktif", usulkan pustaka grafik seperti ECharts.

**Usulan urutan:** (1) aset register SCADA & telekom + lengkapi register jaringan → (2) monitoring SCADA setelah antarmuka data jelas (boleh mulai dengan simulator untuk demo) → (3) CMMS: WO korektif tertaut padam/anomali/RTU gagal, rencana preventif, health index v2 → (4) executive reporting & KPI, termasuk laporan tahunan.

**Pertanyaan terbuka ke pengguna:** vendor SCADA master & cara akses data (DB/historian, IEC 104, Kafka, ekspor); dokumen definisi kinerja SCADA (rumus & target); sistem CMMS korporat yang ada; apakah modul 3 & 4 ada.

**Why:** pengguna meminta review daftar ini lalu "simpan ke memori", untuk dipilih/dikerjakan di sesi berikutnya.

**How to apply:** bila pengguna meminta mengerjakan salah satu modul, mulai dari status di atas, cek ulang kode (bisa sudah berubah), dan tanyakan dulu pertanyaan terbuka yang relevan. Terkait: [[quadrangis-feature-backlog]].
