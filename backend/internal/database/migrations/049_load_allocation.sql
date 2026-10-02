-- Beban pelanggan padam: selain daya kontrak (bawaan), dapat dialokasikan dari beban penyulang sesuai komposisi daya
-- kontrak pelanggan: beban pelanggan = daya kontrak pelanggan ÷ Σ daya kontrak pelanggan penyulang × beban penyulang
-- (api/load_alloc.go). Alokasi setiap kejadian padam dibekukan di ringkasannya (beban_alokasi) saat padam dimulai.

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('monitoring.load_basis', 'kontrak', 'string', 'monitoring',
  'Dasar beban pelanggan padam (rekap beban padam & ENS): kontrak = daya kontrak terpasang (ENS × faktor beban); alokasi_penyulang = beban penyulang sebelum padam dibagi ke pelanggan sesuai komposisi daya kontrak (tanpa data ukur: estimasi daya kontrak × faktor beban)'),
 ('monitoring.load_alloc_max_age_min', '120', 'int', 'monitoring',
  'Alokasi beban penyulang: umur maksimum data beban 30 menit sebelum padam (menit); lebih lama → profil beban dasar slot itu')
ON CONFLICT (key) DO NOTHING;
