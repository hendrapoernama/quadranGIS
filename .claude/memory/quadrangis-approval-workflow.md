---
name: quadrangis-approval-workflow
description: Sejak 27 Sep 2026 editing jaringan QuadranGIS lewat paket perubahan (gis.approval_enabled=true); edit editor tidak langsung mengubah jaringan — penting untuk uji & pemulihan data
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-27T05:00:39.797Z
---

Sejak 27 Sep 2026 (migrasi 029) `gis.approval_enabled=true`: POST/PUT/DELETE fitur, split/merge, dan impor GeoJSON menjadi operasi tertunda di `gis_changesets`/`gis_change_items` (draf → diajukan → disetujui → dirilis). Jaringan aktif berubah hanya saat rilis. Objek usulan ber-id negatif (−id item). Role baru: supervisor (gis.approve), manajer (gis.approve+gis.release). Penyusun tidak boleh menyetujui paket sendiri, jadi uji alur butuh pengguna kedua (skrip scratchpad `api_wf.sh` membuat & menghapus uji_supervisor/uji_manajer).

Per 27 Sep 2026 DB dev hanya punya pengguna `admin` dan `viewer1` — belum ada supervisor/manajer, sehingga paket #1 (usulan uji pengguna sendiri: pelanggan "123" & SR "2121", diajukan admin) tidak bisa disetujui siapa pun. Pengguna sudah diberi opsi: buat akun supervisor/manajer, atau set `gis.approval_allow_self=true`; belum dijawab.

**Why:** Uji yang mengedit lewat API tidak lagi mengubah data langsung; pemulihan data uji paling mudah dengan mematikan sementara `gis.approval_enabled`, lalu memulihkan & menghapus paket uji (`DELETE FROM gis_changesets` + reset sequence).

**How to apply:** Saat menguji editing, kirim `?cs=` atau matikan alur sementara; selalu hapus paket uji & pengguna uji di akhir. Terkait: [[quadrangis-testing-approach]], [[quadrangis-dev-env-quirks]] (nginx: upstream frontend dicantumkan dua kali + proxy_next_upstream karena Next.js sesekali me-reset koneksi → 502/ChunkLoadError).
