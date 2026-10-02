---
name: quadrangis-gdb-kjt-import
description: "GDB ULP Kramat Jati diimpor ke DB dev (tag KJT-05082026, 28 Sep 2026); menu Administrasi › Impor GDB; keterbatasan data sumber"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-10-01T13:54:13.796Z
---

Data `docs/mapping/kjt 05082026.gdb` sudah ada di DB dev sejak 28 Sep 2026. Isinya 248.744 node dan 227.143 edge, semuanya bertanda `properties->>'import' = 'KJT-05082026'`. Data simulasi massal tetap ada (lihat [[quadrangis-bulk-sim-state]]).

- Diimpor ulang lewat menu **Administrasi › Impor GDB** (ZIP 85 MB, ±5,5 menit), dengan hasil identik dengan impor skrip. Unit pemilik sudah ditetapkan (sebagian besar ke ULP CONDET, di bawah UP3 KRAMATJATI).
- Skema staging stg_kjt sudah di-DROP; skema staging tidak disimpan.
- Sejak 1 Okt 2026 impor bertahap (lihat [[quadrangis-gdb-import-sync]]): `import_staging.sql` diganti `build_staging.sql` / `diff_staging.sql` / `apply_staging.sql`. Tag yang sama = pembaruan batch per objek (id tetap), bukan ganti total. Batch KJT dev sudah punya baseline (`gdb_import_objects`, 475.887 baris).
- Riwayat batch ada di tabel `gdb_imports`.
- Keterbatasan data sumber:
  - tidak ada titik normally-open;
  - 7.977 pelanggan tanpa SR diberi status_operasi = Tidak operasi (migrasi 041; keputusan pengguna 28 Sep 2026: tanpa SR = tidak operasi/bongkar, dikecualikan dari rekap); 112 pelanggan lain tetap padam karena SR/TR-nya tidak tersambung ke sumber;
  - 7 gardu berkode REN/RENCANA diberi status_operasi = Rencana (migrasi 042; keputusan pengguna 28 Sep 2026: gardu rencana tidak masuk rekap padam). Status operasi Rencana/Tidak operasi/Bongkar berlaku untuk semua objek titik bertopologi;
  - status GDB INACTIVE → status_operasi Non aktif (18 gardu, 1 trafo, 226 pelanggan ber-SR), DECOMMISSIONED → Bongkar (rak PHB-267); nilai asli di properti gdb_status (migrasi 043 + perbaikan data 28 Sep 2026, keputusan pengguna: gardu bongkar/non aktif tidak masuk rekap padam). Setelahnya gardu padam = 0, pelanggan padam = 88;
  - denah gardu GDB = miniatur skematik (median 1,6 m, komponen berjarak 3–5 cm) → simbol menumpuk di zoom 24; 321 gardu KJT diperbesar ke ±10 m dengan qgis_expand_gardu_layout (migrasi 044, 29 Sep 2026); posisi asli di gis_layout_backup;
  - GI KEMANG/CIPINANG tidak punya kubikel/trafo GI di area data, sehingga penyulangnya kosong;
  - ada 15 sambungan sintesis (`sintesis: true`).

**Why:** pengguna meminta "lanjut import", lalu "lanjutkan" (unit, menu impor, cek peta).
**How to apply:** pelanggan Tidak operasi/Bongkar bukan sink di graf (lihat gis.SQLNonOperating; graf melewatinya di PowerSummary & Summarize); hapus batch lewat menu (ada pratinjau).
