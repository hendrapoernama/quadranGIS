-- Estimasi lokasi gangguan dari arus gangguan relai (Pusat Operasi › FLISR).
-- Parameter bawaan di konfigurasi; daya hubung singkat busbar 20 kV & NGR dapat diisi per trafo GI / GI.

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('fault.source_mva', '500', 'float', 'powerflow', 'Lokasi gangguan: daya hubung singkat 3 fasa di busbar 20 kV GI (MVA), bila atribut trafo GI / GI kosong'),
 ('fault.source_xr',  '10',  'float', 'powerflow', 'Lokasi gangguan: rasio X/R impedansi sumber'),
 ('fault.kv',         '20',  'float', 'powerflow', 'Lokasi gangguan: tegangan nominal jaringan TM (kV)'),
 ('fault.ngr_ohm',    '40',  'float', 'powerflow', 'Lokasi gangguan: tahanan pentanahan netral (NGR) trafo GI (ohm) untuk gangguan fasa-tanah'),
 ('fault.fault_ohm',  '0',   'float', 'powerflow', 'Lokasi gangguan: tahanan gangguan bawaan (ohm)'),
 ('fault.z0_ratio',   '3',   'float', 'powerflow', 'Lokasi gangguan: rasio impedansi urutan nol terhadap urutan positif saluran (Z0/Z1)'),
 ('fault.tol_pct',    '10',  'float', 'powerflow', 'Lokasi gangguan: toleransi pencocokan arus gangguan (%)')
ON CONFLICT (key) DO NOTHING;

-- atribut sumber hubung singkat pada trafo GI dan GI
UPDATE component_types SET attributes = attributes ||
  '[{"key":"daya_hs_mva","label":"Daya hubung singkat busbar 20 kV","label_en":"20 kV busbar short-circuit power","type":"number","unit":"MVA"},
    {"key":"ngr_ohm","label":"NGR (tahanan pentanahan netral)","label_en":"Neutral grounding resistor","type":"number","unit":"ohm"}]'::jsonb
 WHERE code IN ('trafo_gi', 'gi') AND NOT (attributes @> '[{"key":"daya_hs_mva"}]'::jsonb);
