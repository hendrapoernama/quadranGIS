---
name: quadrangis-infographic
description: "Dashboard › Infografis (2 Okt 2026) meniru PDF Infografis Pemulihan UP2D Jakarta; keputusan data yang diambil sendiri & belum dikonfirmasi"
metadata:
  type: project
---

Dibangun 2 Okt 2026 atas permintaan pengguna (contoh: PDF "Infografis-Pemulihan-2026-10-02_1124", PLN UP2D Jakarta). Halaman `/infographic`, menu `a0000000-…-028` di bawah Dashboard (migrasi 051), API `GET /api/exec/infographic`.

Keputusan yang diambil sendiri (belum dikonfirmasi pengguna):
- Data prioritas pelanggan belum ada → atribut SSOT baru `prioritas` (VVIP/VIP/KTT/Prioritas) di tipe pelanggan; pelanggan_tt otomatis KTT. Kartu VVIP/VIP/Prioritas bernilai 0 sampai atribut diisi.
- Definisi: terdampak = isi kejadian induk; padam = kejadian aktif (termasuk lanjutan); nyala = selisih. Beban MW = alokasi penyulang bila ada, selain itu kontrak × faktor beban × cos φ.
- Judul "Infografis Pemulihan Kelistrikan" + nama org_units UID ("UID JAKARTA RAYA"), bukan "DKI JAKARTA"; logo kepala = logo PLN (permintaan pengguna 2 Okt 2026; aset statis frontend/public/brand/pln-logo.png 88×88 dipotong dari PDF contoh di Downloads), logo Danantara Indonesia di kanan (permintaan pengguna 2 Okt 2026; brand/danantara-logo.png 231×64, latar teal dibuat transparan); teks di samping logo PLN = "PT. PLN (Persero) " + nama org_units UID (baris 2: UP2D), permintaan 2 Okt 2026.
- UP3 = poligon gis_boundaries (sama dengan Keandalan Wilayah); detail pelanggan maks. 100 (prioritas, TT/TM, lalu TR).
- Peta (permintaan 2 Okt 2026): saluran JTM/JTR/SR & pelanggan yang SEDANG padam dari kejadian aktif terpilih (gis_edges.energized=false yang menyentuh affected_nodes); jaringan kejadian yang sudah pulih tidak digambar.
- Peta juga menampilkan seluruh GI (ikon kanvas "GI", peran padam/pulih/induk/lain dari gi_ids & parent_gi_ids kejadian terpilih); ikon GI terkait kejadian dibuat lebih besar dari penanda penyebab agar tidak tertutup.
- Gardu padam berkedip (pola useOffMarkers: 2 keadaan 700 ms, hanya saat terlihat). JTR/SR/trafo distribusi/pelanggan padam memakai min_zoom component_types (backend mengirim map.zoom). Peta diekspos sebagai window.__qgisInfoMap untuk uji.
- Log event terdampak: tab GI…Gardu + Trafo distribusi & Pelanggan, dimuat per halaman lewat /api/exec/infographic/log (pencarian di SQL untuk gd/trafo/pelanggan, UP3 hanya untuk baris halaman; jumlah tab dari log_totals; infoSelect/infoSel dipakai bersama).
- Detail pelanggan terdampak juga berhalaman: /api/exec/infographic/customers (sortCustomers, infoPage, infoFillPage); frontend hook usePaged + Pager dipakai log & detail.
- Uji Playwright: jangan screenshot elemen lebih tinggi dari viewport (Playwright mengubah viewport → halaman ditata ulang, foto salah).
- Kepala berlogo dijadikan komponen OrgBanner (2 Okt 2026) dan dipasang juga di Dashboard › Keandalan & Operasi (menggantikan PageHeader; tab Ringkasan/Laporan Berkala di bawahnya).
- Widget bergaya infografis dipindah ke components/exec/InfoWidgets.tsx (CardTitle, SectionTitle, Pill, BigTile+TileBadge/TileDelta, SplitCard, ValueCard) dan dipakai juga Keandalan & Operasi (permintaan 2 Okt 2026: "eye catching"); warna indeks: SAIDI rose, SAIFI cyan, ENS orange-600, kejadian violet, lama padam indigo, SLA emerald.
- Label gardu distribusi di peta (2 Okt 2026): layer gd-label, kode mulai z12, + nama mulai z16 (map.gd kini membawa name). Muat ulang otomatis "Saat ada perubahan" (nilai -1, bawaan baru; sebelumnya bawaan tak sengaja Mati karena localStorage kosong → 0): poll /api/exec/infographic/version tiap 30 s + event realtime; Mati kini benar-benar mati (dulu tetap muat ulang sesudah manuver).
- Label pelanggan padam di peta (2 Okt 2026): layer cust-label-<tipe>, kode mulai label_zoom component_types (map.label_zoom; TT14/TM16/bulk16/TR18, min. = min_zoom titik), + nama mulai label_zoom+1.
- Header semua menu (2 Okt 2026): OrgBanner dipindah ke layout (components/PageBanner.tsx, judul = menu aktif, subjudul = induk), halaman mengganti isi lewat usePageBanner; config app.page_banner (grup branding, sakelar di Identitas Aplikasi, migrasi 052); org & page_banner lewat /api/auth/me. Infografis: header selalu tercetak; tidak dipasang di MobileShell (keputusan sendiri).
- Tab jenis menampilkan MLS & Manuver bila ada data (PDF hanya Gangguan/Pemeliharaan/Bencana Alam).
- Popup objek Peta Kejadian (2 Okt 2026, permintaan "dilengkapi seperti info log event padam"): GET /api/exec/infographic/object (info node + riwayat event dari infoSelect/merge), isi dirender React ke popup (createRoot), satu klik = semua objek di titik itu (trafo KJT ±1,2 m dari gardunya → pilihan tombol), closeOnClick bawaan dimatikan (menutup popup baru), popup z-index di atas kontrol peta. Trafo GI terdampak tampil (map.tgi); GI-nya = GI terdekat ≤ 500 m (1 trafo GI hasil impor tanpa kode/nama). Uji trafo/pelanggan memakai route mock (tidak ada kejadian aktif) — skrip scratchpad info-popup.js.

**Why:** pengguna mungkin ingin judul/logo/kategori prioritas berbeda; data uji dev didominasi kejadian momentary dari skrip uji.

**How to apply:** bila pengguna minta ubah tampilan infografis, cek dulu keputusan di atas. Belum dideploy ke server dan belum di-commit. Terkait: [[quadrangis-load-allocation]], [[quadrangis-scada-cmms-requirements]].
