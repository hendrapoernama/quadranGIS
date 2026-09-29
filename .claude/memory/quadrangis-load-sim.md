---
name: quadrangis-load-sim
description: "Fitur Pembebanan QuadranGIS memakai simulator SCADA/AMR (load.simulator=true); data beban, gardu & susut di DB dev sintetis dan harus dimatikan saat SCADA asli terhubung"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-27T03:48:36.077Z
---

Sejak 27 Sep 2026 fitur Pembebanan (/load, migrasi 027 + 028) berjalan dengan simulator: `load.simulator=true` mengisi riwayat (backfill langsung ke DB saat bootstrap bila tak ada data > 2 hari) lalu mengirim tiap slot 30 menit ke Kafka `scada.load.30m`. Basis beban = MW (daya mampu = MVA × `load.cap_pf` 0,85). Titik: 203 trafo GI, 1.005 penyulang, 788 gardu (semua gardu 5 penyulang nyata + 15 penyulang massal, `load.sim_gd_feeders`). Riwayat: titik nyata 400 hari, massal 35 hari → laporan bulanan/tahunan & "tahun lalu" tampak aneh (artefak data). Simulator bottom-up: penyulang bergardu = Σ gardu + susut (tetap + non-teknis + I²R), trafo = Σ penyulang × (1+susut GI) — penyulang nyata jadi kecil karena GIS-nya hanya ±8 gardu.

**Why:** Semua angka beban, energi, susut, anomali sintetis. Reset data = stop backend, TRUNCATE load_30m/load_daily/load_baseline/load_anomalies/scada_registers, `UPDATE scada_points SET last_ts=NULL`, hapus periodic_reports kategori load, start → backfill ±20 menit.

**How to apply:** Saat SCADA/AMR asli tersambung, set `load.simulator=false`, hapus data sintetis di atas; titik baru dari pesan didaftarkan otomatis (`load.auto_register`). UID diasumsikan `JAKARTA RAYA`. kWh pelanggan bulanan (fitur susut gardu → pelanggan, migrasi 033) juga sintetis: impor uji id 1–2 (periode 2026-07 & 2026-08, IDPEL = kode pelanggan, ±3.200 baris, susut gardu dirancang 4–25%, 1 gardu negatif, 1 gardu tagihan kurang); hapus lewat riwayat impor saat data billing asli masuk. Energi gardu simulasi > daya kontrak pelanggan GIS, sehingga jam nyala > 744 jam dan tanda "melebihi daya" muncul. Terkait: [[quadrangis-bulk-sim-state]].
