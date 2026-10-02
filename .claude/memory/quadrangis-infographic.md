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
- Judul "Infografis Pemulihan Kelistrikan" + nama org_units UID ("UID JAKARTA RAYA"), bukan "DKI JAKARTA"; logo kepala = logo PLN (permintaan pengguna 2 Okt 2026; aset statis frontend/public/brand/pln-logo.png 88×88 dipotong dari PDF contoh di Downloads), logo Danantara Indonesia di kanan (permintaan pengguna 2 Okt 2026; brand/danantara-logo.png 231×64, latar teal dibuat transparan); teks di samping logo masih nama aplikasi + UP2D.
- UP3 = poligon gis_boundaries (sama dengan Keandalan Wilayah); detail pelanggan maks. 100 (prioritas, TT/TM, lalu TR).
- Peta (permintaan 2 Okt 2026): saluran JTM/JTR/SR & pelanggan yang SEDANG padam dari kejadian aktif terpilih (gis_edges.energized=false yang menyentuh affected_nodes); jaringan kejadian yang sudah pulih tidak digambar.
- Peta juga menampilkan seluruh GI (ikon kanvas "GI", peran padam/pulih/induk/lain dari gi_ids & parent_gi_ids kejadian terpilih); ikon GI terkait kejadian dibuat lebih besar dari penanda penyebab agar tidak tertutup.
- Gardu padam berkedip (pola useOffMarkers: 2 keadaan 700 ms, hanya saat terlihat). JTR/SR/trafo distribusi/pelanggan padam memakai min_zoom component_types (backend mengirim map.zoom). Peta diekspos sebagai window.__qgisInfoMap untuk uji.
- Log event terdampak: tab GI…Gardu + Trafo distribusi & Pelanggan, dimuat per halaman lewat /api/exec/infographic/log (pencarian di SQL untuk gd/trafo/pelanggan, UP3 hanya untuk baris halaman; jumlah tab dari log_totals; infoSelect/infoSel dipakai bersama).
- Detail pelanggan terdampak juga berhalaman: /api/exec/infographic/customers (sortCustomers, infoPage, infoFillPage); frontend hook usePaged + Pager dipakai log & detail.
- Uji Playwright: jangan screenshot elemen lebih tinggi dari viewport (Playwright mengubah viewport → halaman ditata ulang, foto salah).
- Tab jenis menampilkan MLS & Manuver bila ada data (PDF hanya Gangguan/Pemeliharaan/Bencana Alam).

**Why:** pengguna mungkin ingin judul/logo/kategori prioritas berbeda; data uji dev didominasi kejadian momentary dari skrip uji.

**How to apply:** bila pengguna minta ubah tampilan infografis, cek dulu keputusan di atas. Belum dideploy ke server dan belum di-commit. Terkait: [[quadrangis-load-allocation]], [[quadrangis-scada-cmms-requirements]].
