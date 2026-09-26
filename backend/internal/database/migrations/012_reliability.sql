-- =====================================================================
-- 012: indeks keandalan (SAIDI, SAIFI, ENS kWh & Rupiah) dan manuver /
--      pemutusan pada objek non-switch & saluran (level kejadian sampai
--      trafo gardu distribusi, jurusan TR, pelanggan).
-- =====================================================================
ALTER TABLE maneuvers ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'node'; -- node | edge
ALTER TABLE outages   ADD COLUMN IF NOT EXISTS cause_kind  text NOT NULL DEFAULT 'node'; -- node | edge
CREATE INDEX IF NOT EXISTS outages_ended_idx ON outages (ended_at);

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('reliability.tariff_rp_per_kwh', '1444.70', 'float', 'reliability', 'Harga energi per kWh (Rp) untuk ENS Rupiah'),
 ('reliability.load_factor',       '0.6',     'float', 'reliability', 'Faktor beban untuk ENS: energi = daya terpasang x faktor beban x cos phi x durasi'),
 ('reliability.power_factor',      '0.85',    'float', 'reliability', 'Faktor daya (cos phi) untuk ENS'),
 ('reliability.sustained_minutes', '5',       'float', 'reliability', 'Padam kurang dari nilai ini (menit) = momentary, tidak dihitung dalam SAIDI/SAIFI')
ON CONFLICT (key) DO NOTHING;
