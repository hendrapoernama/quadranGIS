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

**Belum:** penanda paralel di SLD (SLD hanya menggambar tie/loop seperti biasa).

**Why:** Agar pekerjaan lanjutan tidak mengulang analisis, dan temuan 103 loop KJT bisa ditindaklanjuti (perbaikan atribut normal di data).

**How to apply:** Uji mode Aktual / paralel dengan skenario pelimpahan di skill `uji-quadrangis`. Pengguna juga memanuver objek sendiri saat sesi berjalan (mis. GD1 dibuka lewat browsernya 29 Sep 2026 08:13); cek user-agent di log nginx sebelum menganggap kejadian padam aktif sebagai sisa uji. Terkait: [[quadrangis-gdb-kjt-import]], [[quadrangis-testing-approach]], [[quadrangis-bulk-sim-state]].
