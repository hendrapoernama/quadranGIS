---
name: quadrangis-mobile-plan
description: "Versi mobile QuadranGIS dibangun sebagai PWA (tahap 1–3) pada 27 Sep 2026; asumsi pengguna & offline yang dipakai, dan batasan yang belum teruji di perangkat nyata"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-27T01:25:58.747Z
---

Versi mobile QuadranGIS dikerjakan 27 Sep 2026 sebagai PWA, tahap 1+2+3 sekaligus atas permintaan pengguna ("1+2+3 dikerjakan"). Dua keputusan tidak dijawab eksplisit, jadi dipakai asumsi: pengguna = lapangan + dispatcher + pimpinan; offline = mode lapangan penuh (antrean IndexedDB + area kerja tile).

Tidak dijadikan mobile: menggambar/edit jaringan (Editor Peta hanya tampil banner + panel tertutup), impor/ekspor QGIS, admin, cetak SLD.

Belum teruji di perangkat nyata (hanya Playwright Chromium emulasi 390×844): cubit-zoom SLD, pengiriman push ke layanan asli (FCM/APNs), instalasi iOS. Push & SW butuh HTTPS dengan sertifikat tepercaya; sertifikat self-signed dev tidak diterima ponsel.

**Why:** pengguna meminta tahap 1–3 langsung tanpa menjawab pertanyaan pengguna utama/offline.

**How to apply:** bila pengguna melaporkan masalah di ponsel, cek dulu syarat HTTPS/sertifikat dan versi service worker (`VERSION` di `frontend/public/sw.js` harus dinaikkan setiap perubahan strategi cache). Lihat juga [[quadrangis-testing-approach]], [[user-prefs-quadrangis]].
