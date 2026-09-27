-- Pergeseran bulan tagihan (BLTH) terhadap bulan energi gardu untuk susut gardu → pelanggan.
-- BLTH umumnya memuat pemakaian bulan sebelumnya (pembacaan meter akhir bulan): nilai 1 = energi
-- gardu bulan sebelum BLTH.
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('load.lv_billing_lag_months', '0', 'int', 'load', 'Susut gardu → pelanggan: energi gardu diambil N bulan sebelum periode tagihan (BLTH); 0 = bulan yang sama, 1 = bulan sebelumnya')
ON CONFLICT (key) DO NOTHING;
