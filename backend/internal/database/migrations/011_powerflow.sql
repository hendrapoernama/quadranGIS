-- =====================================================================
-- 011: perhitungan aliran daya (power flow) - parameter, menu, index.
--   Parameter penghantar per tipe dapat diganti lewat powerflow.line_params (JSON
--   {"sutm":{"r":0.2162,"x":0.3305,"ampacity":425}, ...}) atau per saluran lewat
--   atribut r_ohm_km / x_ohm_km / kha_a. Kapasitas trafo dari atribut daya_kva
--   trafo distribusi / gardu.
-- =====================================================================
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('powerflow.source_pu',         '1.0',  'float',  'powerflow', 'Tegangan kirim di kepala penyulang (pu, 1.0 = 20 kV)'),
 ('powerflow.load_factor',       '0.6',  'float',  'powerflow', 'Faktor beban: beban = daya kontrak pelanggan x faktor ini'),
 ('powerflow.power_factor',      '0.85', 'float',  'powerflow', 'Faktor daya (cos phi) beban'),
 ('powerflow.v_min_pu',          '0.9',  'float',  'powerflow', 'Batas bawah tegangan (pu); SPLN 1: -10%'),
 ('powerflow.v_max_pu',          '1.05', 'float',  'powerflow', 'Batas atas tegangan (pu); SPLN 1: +5%'),
 ('powerflow.trafo_z_pct',       '4',    'float',  'powerflow', 'Impedansi trafo distribusi (%)'),
 ('powerflow.trafo_xr',          '3',    'float',  'powerflow', 'Rasio X/R trafo distribusi'),
 ('powerflow.default_trafo_kva', '200',  'float',  'powerflow', 'Kapasitas trafo (kVA) bila atribut daya_kva kosong'),
 ('powerflow.max_iter',          '30',   'int',    'powerflow', 'Iterasi maksimum backward/forward sweep'),
 ('powerflow.line_params',       '',     'string', 'powerflow', 'Override parameter penghantar per tipe (JSON: {"sutm":{"r":0.2162,"x":0.3305,"ampacity":425}})')
ON CONFLICT (key) DO NOTHING;

-- atribut SSOT untuk parameter khusus per saluran (tipe saluran distribusi)
UPDATE component_types t
   SET attributes = COALESCE(attributes, '[]'::jsonb) || '[
     {"key":"r_ohm_km","label":"Resistansi","label_en":"Resistance","type":"number","unit":"ohm/km"},
     {"key":"x_ohm_km","label":"Reaktansi","label_en":"Reactance","type":"number","unit":"ohm/km"},
     {"key":"kha_a","label":"KHA (kuat hantar arus)","label_en":"Ampacity","type":"number","unit":"A"}]'::jsonb
 WHERE code IN ('sktm','sutm','skutr','sktr','sr')
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.attributes,'[]'::jsonb)) a WHERE a->>'key' = 'r_ohm_km');

-- saluran dengan parameter khusus (index parsial kecil; dipakai pemuatan override)
CREATE INDEX IF NOT EXISTS gis_edges_pf_override_idx ON gis_edges (id) WHERE properties ?| array['r_ohm_km','x_ohm_km','kha_a'];

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000011', NULL, 'Aliran Daya', 'Power Flow', '/powerflow', 'bolt', 25)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000011' FROM roles r WHERE r.name IN ('admin','editor','viewer')
ON CONFLICT DO NOTHING;
