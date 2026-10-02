---
name: quadrangis-ops-type-filter-plan
description: "Usulan filter 'by type' di toolbar peta Pusat Operasi (30 Sep 2026) — sudah direview, pengguna minta JANGAN diimplementasikan dulu; rancangan yang disepakati"
metadata:
  node_type: memory
  type: project
  originSessionId: 3919e078-2a03-41b5-89c0-7d709c4e8b37
  modified: 2026-09-29T23:16:41.594Z
---

Permintaan pengguna (30 Sep 2026): di peta Pusat Operasi, selain filter Nyala / Padam, tambahkan filter **by type**, diletakkan tepat **setelah tombol "Semua"**. Sudah direview. Pengguna minta **disimpan dulu, belum dikerjakan**.

**Rancangan hasil review:**
- Toolbar menjadi **[Semua | Tipe ▾ | Nyala | Padam]**.
- **Tipe ▾**: popover daftar centang tipe komponen per kelompok (seperti panel Layer Editor), dengan:
  - tombol Semua / Kosongkan;
  - preset (Jaringan TM saja, Gardu & trafo, Alat switching);
  - label tombol "Tipe (n)" bila sebagian dipilih.
- Digabung (AND) dengan filter status. "Semua" mengembalikan semua tipe + semua status.
- Tersimpan per browser (localStorage), **terpisah** dari pilihan layer Editor Peta (saran; belum dikonfirmasi).

**Fakta kode (cek ulang sebelum mulai):**
- `MapCanvas` sudah punya `setVisibleTypes` yang digabung dengan `setEnergyFilter` di `applyFilters`. Penanda padam dan layer density ikut filter tipe.
- `PowerMonitor.tsx` saat ini memanggil `setVisibleTypes(semua tipe)` di `onReady`.
- Daftar tipe berkelompok bisa diambil dari `LayerPanel.tsx`.
- Penanda paralel tidak berbasis tipe.
- Sejak 2 Okt 2026 sudah ada filter penyulang di toolbar yang sama ([Semua | Nyala | Padam] [Semua penyulang ▾] ...) dan `applyFilters` juga menggabungkan filter penyulang. Filter tipe tinggal ditambahkan sebagai bagian lain (lihat [[quadrangis-feeder-coloring-plan]]).

**Estimasi:** kecil (±setengah hari termasuk uji mode gelap & ponsel; toolbar ponsel sudah flex-wrap).

**Why:** Pengguna ingin fitur ini dikerjakan belakangan tanpa mengulang review.

**How to apply:** Jangan mulai sebelum pengguna meminta. Saat diminta, konfirmasi dulu soal pemisahan dari pilihan layer Editor. Terkait: [[quadrangis-feature-backlog]], [[quadrangis-feeder-coloring-plan]].
