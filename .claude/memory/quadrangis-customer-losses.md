---
name: quadrangis-customer-losses
description: "Fitur susut gardu → kWh pelanggan (impor tagihan bulanan CSV/XLSX) dibangun 27 Sep 2026; keputusan desain, asumsi yang belum dikonfirmasi pengguna, dan prasyarat data asli"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-27T10:40:26.619Z
---

Dibangun 27 Sep 2026 atas permintaan pengguna: data kWh pelanggan hanya tersedia bulanan dan tidak tersambung ke SCADA, sehingga harus diimpor. Letak: Analisa Beban & Energi › tab Susut › mode "Gardu → pelanggan (bulanan)" (mode lama "Neraca AMR" tetap). Migrasi 033 (`customer_kwh`, `customer_kwh_imports`, indeks `idpel`, config `load.lv_*`) dan 034 (`load.lv_billing_lag_months`). Kode: `backend/internal/load/billing.go` (parser CSV/XLSX tanpa pustaka, repo), `backend/internal/api/load_billing.go`, `frontend/components/load/CustomerLosses.tsx` + `i18nCustomer.ts`. nginx punya lokasi khusus `/api/load/customer-kwh/import` (200 MB).

Keputusan yang diambil sendiri (pengguna belum mengonfirmasi):
- Pencocokan IDPEL: atribut `idpel` GIS → `kode_ssot` → kode objek.
- Susut gardu = energi AMR gardu sebulan (diskalakan dari hari sah) − Σ kWh pelanggan; gardu dihitung bila AMR ≥ 80% hari dan pelanggan bertagihan ≥ 90%.
- Pergeseran BLTH vs bulan energi bawaan 0 (bulan sama). Pengguna diberi tahu bahwa BLTH PLN umumnya = pemakaian bulan sebelumnya dan diminta memutuskan apakah bawaan jadi 1 — belum dijawab.

Prasyarat data asli: atribut `idpel` pelanggan GIS masih kosong semua (seed tidak mengisinya) — perlu dilengkapi (mis. impor GeoJSON) sebelum impor billing asli; gardu harus punya meter AMR agar susutnya bisa dihitung.

**Why:** Konteks ini tidak terlihat dari kode: mana yang asumsi, mana yang masih menunggu keputusan pengguna.

**How to apply:** Bila pengguna membahas susut pelanggan/P2TL/billing, tanyakan atau ingatkan keputusan lag BLTH dan kebutuhan idpel. Data contoh sintetis dijelaskan di [[quadrangis-load-sim]]; daftar usulan terkait (#8 susut teknis/non-teknis) di [[quadrangis-feature-backlog]].
