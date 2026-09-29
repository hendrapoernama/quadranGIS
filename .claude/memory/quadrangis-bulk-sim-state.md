---
name: quadrangis-bulk-sim-state
description: "Status data simulasi massal QuadranGIS di DB dev (2,7 juta node/edge sejak 25 Sep 2026), efeknya pada restart backend, dan jebakan pengukuran Playwright map.loaded()"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-25T17:02:01.901Z
---

Sejak 25 Sep 2026 DB dev QuadranGIS (container qgis-postgres) berisi data simulasi massal dari `make seed-bulk` (±2,7 juta node + 2,7 juta edge, properti `"bulk": true`, DB ±2 GB). Hapus dengan `make remove-bulk`.

- Setelah restart backend, graf trace dimuat 20–35 detik lalu pengelompokan ±6 detik; selama itu API belum melayani (login/curl gagal). Tunggu log `[graph] pengelompokan` sebelum uji. Memori backend ±1,0 GB dengan `GOMEMLIMIT` 1200MiB di compose; VM Docker hanya 3,8 GB, jadi hindari menambah struktur per-node di graf tanpa mengukur.
- Tunggu `domcontentloaded`, bukan `networkidle`, di Playwright: WebSocket realtime dan polling status membuat `networkidle` sering timeout.
- Objek yang padam tanpa kejadian padam aktif (25 Sep 2026): GD-TBT-002 (di belakang kubikel normally-open KBK-CWG-02, benar), pelanggan PLG-TR-GMB-03-0329 tanpa SR, dan garis antara junction #1045–#1046. Dua terakhir sisa uji editing sebelumnya; belum dihapus karena menunggu keputusan pengguna.
- Trace pertama setelah restart 3–4 detik (dingin), berikutnya ±0,4 detik. `/api/gis/stats` ±6 detik tanpa cache (cache 60 detik).
- Jebakan uji: `page.waitForFunction(() => map.loaded())` di Playwright headless (swiftshader) melaporkan 15–70 detik meski semua request selesai < 1 detik; ukur di dalam halaman lewat event `idle` MapLibre (hasil nyata 1,5–2,2 detik per tampilan). Pola uji Playwright ada di skill proyek `uji-quadrangis`.

**Why:** Angka palsu dari waitForFunction sempat mengarah ke pencarian bottleneck yang tidak ada; API yang diam saat graf dimuat sempat disangka crash.

**How to apply:** Saat menguji performa peta, pakai pengukuran in-page; saat restart backend dengan data massal, tunggu graf selesai dimuat. Terkait: [[quadrangis-dev-env-quirks]], [[quadrangis-host-ports]].
