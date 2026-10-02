---
name: quadrangis-gdb-import-sync
description: "Impor GDB bertahap (1 Okt 2026): pratinjau perbandingan GDB baru vs batch, penerapan per objek dengan id tetap; desain kunci/baseline, hasil uji, jebakan"
metadata:
  node_type: memory
  type: project
  originSessionId: c6f0a2fc-1fcf-4a30-9b21-93226146c3a0
  modified: 2026-10-01T13:54:27.088Z
---

Dibangun 1 Okt 2026 atas permintaan pengguna ("iya dibuatkan fiturnya"), setelah pengguna bertanya apakah menu Impor GDB sudah membandingkan data yang sudah diunggah dengan yang akan diunggah. Jawabannya waktu itu: belum ada; impor lama menghapus lalu memasukkan ulang semua objek, sehingga id berubah dan rujukan putus.

- Alur job: extract → stage → map (`build_staging.sql`, hanya staging) → diff (`diff_staging.sql`) → status **review** → Apply (`diff` + `apply_staging.sql` dalam satu transaksi) / Cancel → units → cleanup → reload. Migrasi `048_gdb_import_sync.sql`: tabel `gdb_import_objects` (tag, kind, key, obj_id, hash) dan fungsi `qgis_gdb_*`.
- Kunci: `g:<GlobalID>`, `p:<POINT UTM 1 cm>` (junction / ujung garis), `gi:<kode>`; saluran = GlobalID garis | kunci ujung a > kunci ujung b. Kunci ganda diurutkan menurut geometri, lalu atribut (SR kembar tanpa GlobalID dibedakan menurut IDPEL).
- Hash memakai geometri asli dari `gis_layout_backup` (sebelum denah gardu diperbesar). Penerapan mengembalikan denah gardu yang tersentuh perubahan (≤ 0,6 m), lalu memperbesarnya ulang.
- Aturan diselaraskan dengan data yang sudah disetujui: pelanggan tanpa SR = "Tidak operasi" mengalahkan status GDB INACTIVE (sebelumnya SQL memberi "Non aktif" untuk 7.885 pelanggan, tidak selaras dengan perbaikan data 28 Sep).
- Uji di dev, batch KJT: sinkron pertama → 185.342 simpul "berubah" murni karena `gdb_status` belum ada di impor lama, lalu diterapkan. Unggah ulang → 475.887 sama. Skenario 10 kasus (hapus / ubah / baru / pindah / gardu bergeser / editan lokal / konflik / used_by_local) semuanya benar, termasuk uji balik ke GDB asli (denah gardu kembali 0,000 m). Waktu: stage 3,5 menit + map 1,5 menit + diff 1 menit; apply ±1,5 menit + reload graf.
- Jebakan: CTE yang memanggil `qgis_gdb_props` harus `MATERIALIZED` (bila di-inline, 84 detik vs 12 detik). Skrip uji di staging tabel `t_*` ikut terhapus saat cleanup.
- Belum dideploy ke server 10.3.187.7 (lihat [[quadrangis-server-deploy]]); batch KJT server belum punya baseline, jadi sinkron pertama akan menampilkan ±185 ribu perubahan `gdb_status` yang sama.

**Why:** rujukan (manuver, padam, foto, titik SCADA, rencana) harus tetap terhubung saat GDB diperbarui.

**How to apply:** saat menyentuh pemetaan GDB, ubah `build_staging.sql` dan daftar `qgis_gdb_prop_keys()` (migrasi baru bila perlu) bersama-sama. Atribut GDB baru akan tampil sebagai "berubah" pada sinkron berikutnya. Terkait: [[quadrangis-gdb-kjt-import]].
