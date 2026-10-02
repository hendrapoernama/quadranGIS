---
name: quadrangis-kafka-switch
description: Energize/de-energize objek jaringan dari sistem eksternal lewat Kafka (topik scada.switch.events) sejak 29 Sep 2026; cara uji & pulihkan
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-30T04:08:13.533Z
---

Sistem eksternal mengirim JSON ke topik Kafka `scada.switch.events` untuk membuka/menutup objek jaringan. Fitur dibangun 29 Sep 2026 atas permintaan pengguna.
- Isi pesan: kode/nama objek, jenis, status open/close, outage_category (wajib untuk open), tanggal, event_id opsional.
- Pesan diproses lewat `execManeuver`, jalur yang sama dengan panel operator (hasil refaktor dari `powerManeuver`).
- Tanggal dari pesan dipakai sebagai waktu manuver, mulai/selesai padam, dan SOE.
- Log tersimpan di tabel `switch_events`. Halaman: Administrasi › Integrasi Kafka (`/admin/switch-events`).
- Kolom `type` dicocokkan oleh `switchTypes` ke kode/nama tipe bertopologi (`component_types`). Tidak ada tipe/alias "feeder"/"penyulang"; pesan dengan type itu ditolak. Penyulang = kubikel keluar di GI: `type` `kubikel_20kv`, `code` = nama penyulang. Sejak 30 Sep 2026 halaman admin punya kartu "Kode tipe objek" (daftar dari `/api/gis/types`).
- Data KJT: kubikel `BECA` ganda (id 3058757 & 3068782, tanpa kode SSOT), sehingga pesan untuk BECA harus memakai `id`.
- Di server 10.3.187.7 Kafka masih hanya di 127.0.0.1. Membukanya ke jaringan (advertised `10.3.187.7:29093`) ditolak pengaman mode otomatis Claude Code (30 Sep 2026), jadi pengguna perlu menjalankannya sendiri atau memberi izin. Lihat [[quadrangis-server-deploy]].

**Why:** SCADA/DMS perlu memicu padam/nyala tanpa operator. Pesan tidak memakai izin role; kepercayaan bergantung pada akses ke Kafka.

**How to apply:**
- Uji di REC-GMB-02-05 (lihat [[quadrangis-testing-approach]]) dengan tombol "Proses langsung" atau "Kirim ke Kafka", lalu selalu kirim close untuk memulihkan.
- Setiap uji meninggalkan catatan manuver/outage/SOE di riwayat (outage #92 dan #93 dari uji 29 Sep).
- Perubahan topik atau group baru berlaku setelah backend dimulai ulang.
- Peringatan "Not Leader For Partition" saat topik baru dibuat bersifat sementara.
