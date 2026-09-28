-- Pelanggan kolektif (bulk customer): satu objek mewakili sekelompok pelanggan (mis. perumahan, rusun,
-- kawasan) dengan jumlah pelanggan dan total daya tersambung. Seluruh perhitungan (rekap Pusat Operasi,
-- pelanggan padam per kejadian, SAIDI / SAIFI / ENS, FLISR, simulasi manuver, SLD, Data Aset, susut gardu →
-- pelanggan) memakai atribut jumlah_pelanggan sebagai bobot; beban memakai total daya (daya_kva).

INSERT INTO component_types (code, name, name_en, geom_kind, category, is_source, is_switch, is_sink, voltage_kv, color, icon,
                             min_zoom, label_zoom, size, sort_order, topology, ways, attributes) VALUES
 ('pelanggan_bulk', 'Pelanggan Kolektif (bulk)', 'Bulk Customer', 'point', 'pelanggan', false, false, true, 0.4, '#0d9488', 'sym_bulk',
  13, 16, 6, 165, true, 0,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"jumlah_pelanggan","label":"Jumlah pelanggan","label_en":"Number of customers","type":"number","required":true},
    {"key":"daya_kva","label":"Total daya tersambung","label_en":"Total connected power","type":"number","unit":"kVA"},
    {"key":"tarif","label":"Tarif dominan","label_en":"Dominant tariff","type":"select","options":["R1","R1M","R2","R3","B1","B2","S2","I1","P1","Campuran"]},
    {"key":"idpel","label":"IDPEL induk / kolektif","label_en":"Parent / collective IDPEL","type":"text"},
    {"key":"kawasan","label":"Kawasan","label_en":"Area","type":"text"},
    {"key":"alamat","label":"Alamat","label_en":"Address","type":"text"}]'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- ---------------- data contoh: satu pelanggan kolektif di ujung jurusan TR penyulang GMB-01 ----------------
DO $$
DECLARE
  j record; nid bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM gis_nodes WHERE code = 'PLG-KOL-GMB-01-1') THEN
    RETURN;
  END IF;
  SELECT n.id, n.geom INTO j FROM gis_edges e JOIN gis_nodes n ON n.id = e.to_node_id
   WHERE e.code = 'SKUTR-GMB-01-1-J1-4' AND n.type_code = 'junction' LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO gis_nodes (type_code, code, name, geom, properties)
  VALUES ('pelanggan_bulk', 'PLG-KOL-GMB-01-1', 'Rusun Kemayoran Blok A (kolektif)',
          ST_Project(j.geom::geography, 25, radians(90))::geometry,
          '{"jumlah_pelanggan":120,"daya_kva":250,"tarif":"R1","kawasan":"Rusun Kemayoran Blok A"}'::jsonb)
  RETURNING id INTO nid;
  INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, properties)
  SELECT 'sr', 'SR-KOL-GMB-01-1', 'SR rusun Kemayoran Blok A', ST_MakeLine(j.geom, p.geom), j.id, nid,
         ST_Length(ST_MakeLine(j.geom, p.geom)::geography), '{"penghantar":"NFA2X 4x70 mm2"}'::jsonb
  FROM gis_nodes p WHERE p.id = nid;
END $$;
