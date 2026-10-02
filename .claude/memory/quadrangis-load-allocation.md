---
name: quadrangis-load-allocation
description: "Opsi beban padam = alokasi beban penyulang ke pelanggan sesuai komposisi daya kontrak (monitoring.load_basis, 2 Okt 2026); keputusan desain, data, uji"
metadata:
  node_type: memory
  type: project
  originSessionId: c6f0a2fc-1fcf-4a30-9b21-93226146c3a0
  modified: 2026-10-01T14:57:23.927Z
---

Dibangun 1–2 Okt 2026 atas permintaan pengguna ("opsi hitungan saat padam rekap beban pelanggan ... beban penyulang yang didistribusikan ke pelanggan sesuai komposisi kapasitas terpasang"). Pengguna menyetujui usulan desain berikut ("ok lanjutkan implementasi"):

- Konfigurasi `monitoring.load_basis` = `kontrak` (bawaan) | `alokasi_penyulang`; `monitoring.load_alloc_max_age_min` = 120 (migrasi 049).
- Rumus: beban pelanggan = daya kontrak ÷ Σ daya kontrak pelanggan beroperasi penyulang × beban penyulang. Faktor dibatasi 0,05–3, sama dengan kalibrasi FLISR (`loadCalibration`, puncak 7 hari ÷ kontrak) yang sudah ada.
- Beban penyulang diambil **sebelum padam**: sampel 30 menit lengkap terakhir → profil dasar (`load_baseline`, median MW) → estimasi kontrak × `reliability.load_factor` (× cos φ untuk kW).
- Penyebut: keanggotaan aktual (`liveOf`) dari `Graph.FeederContractVA()`. Bagian yang padam ikut penyulang normal.
- Dibekukan per kejadian saat padam dimulai: `summary.beban_per_penyulang` + `summary.beban_alokasi` (api/load_alloc.go, jalur manuver & lanjutan FLISR). ENS = `beban_alokasi.w` × jam bila basis alokasi (`ApplyReliability`, `ens_basis`/`load_kw`). Kejadian lama tanpa alokasi tetap memakai kontrak.
- UI Pusat Operasi: KPI "Beban alok." (`load_alloc` di /api/power/summary, cache 30 dtk; penyulang dengan padam aktif memakai faktor yang dibekukan), baris "Beban teralokasi" di kartu kejadian, label dasar ENS.
- Data: penyulang KJT (68) belum punya titik SCADA, sehingga di KJT semuanya "estimasi" sampai beban penyulang asli masuk. Penyulang demo GMB-01..05 & simulasi massal punya data sintetis; total teralokasi lokal ±5.970 MVA vs kontrak ±3.411 MVA karena beban sintetis massal tidak cocok dengan kontrak.
- Uji lokal 2 Okt: REC-GMB-02-05 → 1.028 kVA dari 1.642 kVA × 0,50 MVA = 312 kVA / 285 kW (terukur). Meninggalkan kejadian padam #104 dan #105 di riwayat. Konfigurasi dikembalikan ke kontrak.
- Belum dideploy ke server 10.3.187.7.

**Why:** rekap beban padam & ENS berbasis daya kontrak terlalu tinggi (faktor tetap 0,6).

**How to apply:** saat menyentuh rekap beban / ENS, jaga kedua basis. Kunci JSON ringkasan kejadian (`beban_alokasi`) dipakai frontend & ENS. Terkait: [[quadrangis-load-sim]], [[quadrangis-scada-cmms-requirements]].
