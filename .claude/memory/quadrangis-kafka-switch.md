---
name: quadrangis-kafka-switch
description: Energize/de-energize objek jaringan dari sistem eksternal lewat Kafka (topik scada.switch.events) sejak 29 Sep 2026; cara uji & pulihkan
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-28T18:04:27.707Z
---

Sistem eksternal mengirim JSON ke topik Kafka `scada.switch.events` untuk membuka/menutup objek jaringan. Fitur dibangun 29 Sep 2026 atas permintaan pengguna.
- Isi pesan: kode/nama objek, jenis, status open/close, outage_category (wajib untuk open), tanggal, event_id opsional.
- Pesan diproses lewat `execManeuver`, jalur yang sama dengan panel operator (hasil refaktor dari `powerManeuver`).
- Tanggal dari pesan dipakai sebagai waktu manuver, mulai/selesai padam, dan SOE.
- Log tersimpan di tabel `switch_events`. Halaman: Administrasi › Integrasi Kafka (`/admin/switch-events`).

**Why:** SCADA/DMS perlu memicu padam/nyala tanpa operator. Pesan tidak memakai izin role; kepercayaan bergantung pada akses ke Kafka.

**How to apply:**
- Uji di REC-GMB-02-05 (lihat [[quadrangis-testing-approach]]) dengan tombol "Proses langsung" atau "Kirim ke Kafka", lalu selalu kirim close untuk memulihkan.
- Setiap uji meninggalkan catatan manuver/outage/SOE di riwayat (outage #92 dan #93 dari uji 29 Sep).
- Perubahan topik atau group baru berlaku setelah backend dimulai ulang.
- Peringatan "Not Leader For Partition" saat topik baru dibuat bersifat sementara.
