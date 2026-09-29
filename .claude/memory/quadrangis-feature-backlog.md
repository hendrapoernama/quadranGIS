---
name: quadrangis-feature-backlog
description: "Daftar usulan fitur lanjutan QuadranGIS (27 Sep 2026) yang belum diputuskan pengguna, dengan rekomendasi urutan; plus pekerjaan terbuka dari fitur sebelumnya"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-27T01:41:26.738Z
---

Usulan fitur lanjutan yang disampaikan 27 Sep 2026 dan diminta disimpan pengguna ("simpan ke memori"). Belum ada yang dipilih untuk dikerjakan.

Prioritas tinggi:
1. Integrasi SCADA / realtime (IEC 60870-5-104, Modbus, MQTT): status alat & arus/tegangan otomatis, trip → kejadian padam + FLISR.
2. Work Order regu lapangan: laporan/rencana → tugas regu, status berangkat/tiba/selesai di menu Lapangan, foto sebelum/sesudah, pelacakan posisi & waktu respons.
3. Notifikasi pelanggan otomatis (WhatsApp/SMS) padam/pemeliharaan & pulih, memakai draf pesan AI operasi.
4. Jadwal pemeliharaan terencana & izin kerja K3 (kalender, grounding, tag "jangan dioperasikan" di peta/SLD).

Prioritas menengah: 5. manajemen aset & inspeksi berkala + skor kondisi; 6. estimasi titik gangguan dari arus gangguan relay + impedansi saluran; 7. prakiraan beban & hosting capacity PLTS; 8. analisis susut teknis/non-teknis per gardu (target P2TL).

Pendukung: 9. integrasi AMI/meter pintar (last gasp); 10. versi & riwayat perubahan data GIS + alur persetujuan; 11. integrasi SSOT/AP2T & webhook; 12. SSO/LDAP, 2FA, backup/DR, Prometheus/Grafana, uji beban.

Sudah dibangun sejak daftar dibuat: #10 (alur persetujuan editing); #6 (lokasi gangguan dari arus relai + impedansi, panel di FLISR, migrasi 039; parameter sumber default 500 MVA / NGR 40 ohm belum dikonfirmasi pengguna); sebagian #8 (susut gardu → kWh pelanggan bulanan, lihat [[quadrangis-customer-losses]]; pemisahan teknis/non-teknis & target P2TL belum); sebagian #1 (load profile SCADA/AMR via Kafka, tanpa status alat/trip); sebagian #7 (prakiraan & N-1, tanpa hosting capacity PLTS). Juga menu Master Data › Data Aset (hirarki GI → pelanggan), Dashboard › Keandalan & Operasi, Master Data › Titik SCADA.

Rekomendasi urutan yang disampaikan: mulai dari #2 (Work Order, menyambung laporan gangguan + FLISR + menu Lapangan), lalu #1 (SCADA) bila sumber data tersedia.

Pekerjaan terbuka dari fitur sebelumnya: menu Dokumentasi & deck presentasi (artifact Slides https://claude.ai/artifact/1mGd4Wu1ra1xBXTEiKQ61p, 31 slide, generator di scratchpad deck-v2/gen.py) sudah diperbarui 27 Sep 2026 untuk semua fitur s.d. menu Dashboard & Titik SCADA; berkas docs/Presentasi QuadranGIS.pptx di repo masih versi lama sampai diunduh ulang; uji PWA di ponsel nyata dengan HTTPS bersertifikat resmi; commit & push ke GitHub belum dilakukan (menunggu permintaan pengguna).

**Why:** pengguna ingin daftar ini tersedia untuk dipilih di sesi berikutnya.

**How to apply:** bila pengguna bertanya "lanjut fitur apa" atau memilih nomor, rujuk daftar ini dan cek dulu apakah sebagian sudah dibangun sejak tanggal di atas. Terkait: [[quadrangis-mobile-plan]], [[quadrangis-testing-approach]].
