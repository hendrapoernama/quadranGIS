---
name: quadrangis-feeder-coloring-plan
description: "Pewarnaan per penyulang (Normal + Aktual) di Pusat Operasi, Editor Peta & SLD, plus penanda penyulang paralel — dibangun 29 Sep 2026; keputusan, angka kinerja, temuan data KJT"
metadata:
  type: project
---

Dibangun 29 Sep 2026 (belum di-commit saat ditulis).

**Pewarnaan per penyulang:**
- Pusat Operasi (tombol Warna peta), Editor Peta (LayerPanel › Penyulang), dan SLD (Warna › Penyulang + Normal/Aktual).
- Pilihan Normal/Aktual disimpan bersama di localStorage `qgis_feeder_live`.
- Di ponsel legenda ada di tumpukan atas, tertutup bawaan (panel bawah menutupi kiri-bawah).
- Kode:
  - backend `backend/internal/gis/feeders.go` + migrasi `047_feeder_coloring.sql`;
  - frontend `components/map/FeederColoring.tsx` (`useFeederColors`, `useFeederColoring`, `FeederLegend`).
- Angka:
  - pengisian awal ±4,5 menit (tabel +1,9 GB dead tuple); restart berikutnya 0 baris ditulis;
  - 1.013 pasangan tie, 0 berwarna sama / mirip (`feederSimilar` harus sesuai urutan `FEEDER_PALETTE`).

**Penanda paralel** (`GET /api/power/parallel`, `components/map/ParallelFeeders.tsx`):
- Titik temu = saluran tertutup & bertegangan yang kedua ujungnya beda penyulang aktual.
- Saluran yang menempel kepala penyulang dikecualikan (busbar antar-kubikel GI dimodelkan sebagai edge; tanpa ini tiap pasangan kubikel bertetangga terbaca paralel).
- Tie = switch / arah LBS normally-open yang kini tertutup.
- **Temuan data:** 103 pasangan penyulang impor GDB Kramat Jati sudah ber-loop pada posisi normal (kemungkinan tie di data sumber tidak bertanda normally-open). Loop ini dipisahkan sebagai `normal_loop` dan hanya ditampilkan sebagai jumlah di legenda, bukan peringatan. Belum dikonfirmasi pengguna.

**Filter penyulang Pusat Operasi** (2 Okt 2026, atas permintaan pengguna):
- Tombol "Semua penyulang ▾" setelah [Semua | Nyala | Padam]; panel per GI (`components/map/FeederFilter.tsx`).
- `MapCanvas.setFeederFilter(ids, live)` digabung di `applyFilters`. Penanda padam (API off-markers kini membawa `fdr`/`fdl`) dan penanda paralel ikut tersaring; kepadatan disembunyikan.
- Mengikuti Normal/Aktual bersama (`feeder.live`). Pilihan disimpan di localStorage `qgis_ops_feeders`.
- Uji: ABIMANYU 144 objek 1 penyulang; GI CAWANG 39 penyulang; penanda padam GMB-02 4 → 0 dengan filter lain. Meninggalkan kejadian padam #106.
- Di ponsel, Pusat Operasi berganti tata letak (komponen dimuat ulang), sehingga panel filter tertutup tetapi pilihan tetap.
- Juga di **Editor Peta** (2 Okt 2026): tombol di samping kotak pencarian, kunci terpisah `qgis_editor_feeders` (`useFeederFilter(..., EDITOR_FEEDERS_KEY)`). Snapping/topologi server tetap memakai semua objek, sehingga ada catatan di panel. Uji: 144 objek ABIMANYU, kunci Pusat Operasi tidak tersentuh.

**Tombol warna di bilah atas Editor Peta** (2 Okt 2026, permintaan pengguna "seperti Pusat Operasi"): Tipe | Status | Penyulang di samping filter penyulang, satu state dengan tab Layer, disimpan di `qgis_editor_color_by` (bawaan Tipe). Di ponsel filter + tombol warna pindah ke baris kedua (sebelumnya tombol filter terdorong keluar layar).

**Posisi aktual → normal** (2 Okt 2026, permintaan pengguna: tombol di Editor Peta untuk tim data):
- Tab "Normal" di Editor Peta (`NormalPositionsPanel.tsx`, `api/normalpos_handlers.go`, `gis/normalpos.go`).
- Daftar switch yang posisinya berbeda dari normal + dampak perpindahan penyulang. "Disarankan" = kedua sisi bertegangan & bukan penyebab padam.
- Menulis atribut `normal` dan atribut baru `normal_open_ways` (LBS multi-arah). Status buka/tutup tidak diubah.
- Mengikuti mode editor: paket perubahan bila `gis.approval_enabled`, langsung bila tidak (dev = false).
- Sekaligus menutup celah: arah normal LBS 3-arah dulu hanya diambil dari arah terbuka saat graf dimuat.
- Diuji lewat API dengan skenario pelimpahan GMB-03 → GMB-05: 2 penyimpangan, dampak 218 objek / 114 pelanggan, sesudah diterapkan 0 penyimpangan & 0 override. UI diuji dengan respons tiruan (gelap, ponsel).
- Skrip uji sempat menimpa atribut node 29 & 2702661 dan menyalakan persetujuan; sudah dipulihkan (SQL + restart backend). Jejak: 4 catatan manuver uji 2 Okt 2026 di kedua alat.

**Belum:** penanda paralel di SLD (SLD hanya menggambar tie/loop seperti biasa).

**Why:** Agar pekerjaan lanjutan tidak mengulang analisis, dan temuan 103 loop KJT bisa ditindaklanjuti (perbaikan atribut normal di data).

**How to apply:** Uji mode Aktual / paralel dengan skenario pelimpahan di skill `uji-quadrangis`. Pengguna juga memanuver objek sendiri saat sesi berjalan (mis. GD1 dibuka lewat browsernya 29 Sep 2026 08:13); cek user-agent di log nginx sebelum menganggap kejadian padam aktif sebagai sisa uji. Terkait: [[quadrangis-gdb-kjt-import]], [[quadrangis-testing-approach]], [[quadrangis-bulk-sim-state]].
