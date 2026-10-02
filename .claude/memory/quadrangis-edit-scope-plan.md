---
name: quadrangis-edit-scope-plan
description: "Usulan pembatasan editing jaringan per wilayah UP3 (lintas batas → level atas), direview 2 Okt 2026; belum dikerjakan, 5 keputusan menunggu pengguna"
metadata:
  node_type: memory
  type: project
  originSessionId: c6f0a2fc-1fcf-4a30-9b21-93226146c3a0
  modified: 2026-10-01T15:25:28.288Z
---

Permintaan pengguna (2 Okt 2026): editing jaringan dibatasi per wilayah UP3. Hanya pengguna UP3 tersebut yang bisa menambah, mengedit, dan menghapus. Jaringan yang lintas batas hanya bisa diubah pengguna level di atasnya. Sudah direview, lalu pengguna minta "simpan ke memori". **Belum dikerjakan.**

**Kondisi saat review:**
- Sudah ada:
  - hirarki `org_units` (PUSAT → REGION → UID/UP2B → UP3/UP2D → ULP; 16 UP3, 27 ULP);
  - poligon `gis_boundaries` level up3/ulp;
  - `unit_id` pemilik di gis_nodes/gis_edges;
  - alur persetujuan (gis_changesets; peran editor `gis.edit`, supervisor `gis.approve`, manajer `gis.approve`+`gis.release`).
- Belum ada:
  - **unit kerja pengguna** (tabel `users` tanpa kolom unit);
  - pemeriksaan cakupan wilayah di mana pun.

**Usulan aturan:**
1. Pengguna diberi unit kerja.
2. Wilayah perubahan = himpunan UP3 dari semua objek yang disentuh, termasuk efek topologi (garis terpotong / ujung tersambung). Cek di dalam transaksi editor, berdasarkan objek yang benar-benar berubah.
3. Boleh bila unit pengguna = UP3 itu atau leluhurnya. Bila lintas batas (> 1 UP3): unit induk bersama terendah (LCA, mis. UID) atau di atasnya.
4. Berlaku saat draf, persetujuan, rilis, dan editing langsung. Melihat peta, trace, dan manuver tidak dibatasi.
5. Editor Peta: tampilkan batas wilayah kerja; tombol edit nonaktif + alasan di luar wilayah; daftar paket disaring per wilayah.

**Data KJT (dev, 2 Okt 2026):**
- 631 simpul KJT berada di poligon UP3 tetangga (Pondok Gede 421, Ciracas 106, Jatinegara 93, Lenteng Agung 11).
- 196 saluran KJT melintasi batas UP3.
- `unit_id` baru terisi 22.042 dari 248.744 simpul KJT (AutoAssign hanya tipe aset tertentu).

**Keputusan yang ditanyakan ke pengguna (belum dijawab):**
1. Penentu wilayah: lokasi geometri vs poligon UP3 (saran) atau kepemilikan aset (perlu dilengkapi dulu).
2. "Level di atasnya": UP2D Jakarta Raya sejajar UP3 di hirarki — apakah UP2D boleh lintas UP3, atau hanya UID/PUSAT?
3. Pengguna ULP: hanya ULP-nya atau seluruh UP3-nya?
4. Apakah supervisor/manajer juga dibatasi wilayah (paket lintas batas → penyetuju level atas)?
5. Pengguna tanpa unit (admin): tidak dibatasi (saran) atau unit wajib.

Estimasi cakupan menengah: kolom unit di menu Pengguna, pemeriksaan di editor & alur persetujuan, tampilan wilayah di Editor.

**Why:** pengguna ingin fitur ini tercatat untuk dikerjakan nanti tanpa mengulang review.

**How to apply:** jangan mulai sebelum pengguna meminta. Saat diminta, tanyakan dulu 5 keputusan di atas bila belum dijawab, dan cek ulang kode (bisa sudah berubah). Terkait: [[quadrangis-approval-workflow]], [[quadrangis-gdb-kjt-import]].
