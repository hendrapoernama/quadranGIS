-- =====================================================================
-- 014: peralatan rak TR & switch jurusan TR, simbol standar kelistrikan,
--      kategori pemadaman MANUVER, dan izin operasi buka/tutup per role
--      (switching TM / TR, energize / deenergize TM / TR).
-- =====================================================================

-- ---------------- tipe peralatan baru ----------------
INSERT INTO component_types (code, name, name_en, geom_kind, category, is_source, is_switch, is_sink, voltage_kv, color, icon,
                             min_zoom, label_zoom, size, sort_order, topology, ways, attributes) VALUES
 ('rak_tr', 'Rak TR (PHB-TR)', 'LV Rack (LV distribution board)', 'point', 'peralatan', false, false, false, 0.4, '#0e7490', 'sym_rak',
  15, 17, 6, 82, true, 0,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"rating_a","label":"Rating arus","label_en":"Current rating","type":"number","unit":"A"},
    {"key":"jumlah_jurusan","label":"Jumlah jurusan","label_en":"Number of LV routes","type":"number"},
    {"key":"merk","label":"Merk","label_en":"Brand","type":"text"}]'::jsonb),
 ('switch_jurusan_tr', 'Switch Jurusan TR', 'LV Route Switch', 'point', 'pengaman', false, true, false, 0.4, '#0f766e', 'sym_fuse',
  15, 17, 5.5, 84, true, 2,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"jenis","label":"Jenis","label_en":"Type","type":"select","options":["NH fuse","NFB","MCCB","Saklar pisau"]},
    {"key":"rating_a","label":"Rating arus","label_en":"Current rating","type":"number","unit":"A"},
    {"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]}]'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- ---------------- simbol standar (diagram satu garis IEC 60617) ----------------
UPDATE component_types SET icon = CASE code
  WHEN 'power_grid'        THEN 'sym_source'
  WHEN 'gi'                THEN 'sym_gi'
  WHEN 'trafo_gi'          THEN 'sym_trafo'
  WHEN 'kubikel_20kv'      THEN 'sym_cb'
  WHEN 'recloser'          THEN 'sym_recloser'
  WHEN 'lbs_2way'          THEN 'sym_lbs'
  WHEN 'lbs_3way'          THEN 'sym_lbs3'
  WHEN 'gh'                THEN 'sym_gh'
  WHEN 'gd'                THEN 'sym_gd'
  WHEN 'trafo_distribusi'  THEN 'sym_trafo'
  WHEN 'rak_tr'            THEN 'sym_rak'
  WHEN 'switch_jurusan_tr' THEN 'sym_fuse'
  WHEN 'pelanggan_tt'      THEN 'sym_house'
  WHEN 'pelanggan_tm'      THEN 'sym_house'
  WHEN 'pelanggan_tr'      THEN 'sym_house'
  WHEN 'tiang_tm'          THEN 'sym_pole'
  WHEN 'tiang_tr'          THEN 'sym_pole'
  ELSE icon END
WHERE geom_kind <> 'line';

-- ---------------- kategori pemadaman MANUVER ----------------
ALTER TABLE maneuvers DROP CONSTRAINT IF EXISTS maneuvers_kind_check;
ALTER TABLE maneuvers ADD CONSTRAINT maneuvers_kind_check CHECK (kind IN ('GANGGUAN','PEMELIHARAAN','MLS','MANUVER'));

-- ---------------- izin operasi per role ----------------
-- gis.maneuver diganti 4 izin terpisah: switching TM, switching TR, energize/deenergize TM, TR
UPDATE roles SET permissions = (
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(permissions) AS p
      UNION ALL SELECT unnest(ARRAY['power.switch_tm','power.switch_tr','power.energize_tm','power.energize_tr'])
    ) x WHERE p <> 'gis.maneuver')
 WHERE permissions ? 'gis.maneuver';

INSERT INTO roles (name, description, permissions, is_system) VALUES
 ('operator', 'Operator / dispatcher jaringan: buka/tutup & energize/deenergize TM dan TR',
  '["gis.view","gis.trace","ai.use","power.switch_tm","power.switch_tr","power.energize_tm","power.energize_tr"]'::jsonb, false),
 ('operator_tr', 'Operator TR (ULP): buka/tutup switch jurusan & energize/deenergize jaringan TR saja',
  '["gis.view","gis.trace","power.switch_tr","power.energize_tr"]'::jsonb, false)
ON CONFLICT (name) DO NOTHING;

-- menu yang sama dengan role viewer untuk role operator baru
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, rm.menu_id FROM roles r
JOIN roles v ON v.name = 'viewer'
JOIN role_menus rm ON rm.role_id = v.id
WHERE r.name IN ('operator','operator_tr')
ON CONFLICT DO NOTHING;

-- ---------------- data contoh: rak TR + switch jurusan per trafo distribusi ----------------
-- trafo -[kabel TR]- rak TR -[kabel TR]- switch jurusan -[saluran jurusan yang sudah ada]
DO $$
DECLARE
  t record; e record; rak_id bigint; sw_id bigint; sw_geom geometry; far geometry; k int; suffix text; n_routes int;
BEGIN
  FOR t IN
    SELECT n.id, n.code, n.geom FROM gis_nodes n
    WHERE n.type_code = 'trafo_distribusi'
      AND NOT EXISTS (SELECT 1 FROM gis_edges x JOIN gis_nodes r ON r.id = CASE WHEN x.from_node_id = n.id THEN x.to_node_id ELSE x.from_node_id END
                      WHERE n.id IN (x.from_node_id, x.to_node_id) AND r.type_code = 'rak_tr')
      AND EXISTS (SELECT 1 FROM gis_edges x WHERE n.id IN (x.from_node_id, x.to_node_id) AND x.type_code IN ('skutr','sktr'))
  LOOP
    suffix := regexp_replace(t.code, '^TD-', '');
    SELECT count(*) INTO n_routes FROM gis_edges x WHERE t.id IN (x.from_node_id, x.to_node_id) AND x.type_code IN ('skutr','sktr');
    INSERT INTO gis_nodes (type_code, code, name, geom, properties)
    VALUES ('rak_tr', 'RAK-' || suffix, 'Rak TR ' || suffix,
            ST_Project(t.geom::geography, 6, radians(180))::geometry,
            jsonb_build_object('rating_a', 630, 'jumlah_jurusan', n_routes))
    RETURNING id INTO rak_id;
    INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, properties)
    SELECT 'sktr', 'KTR-' || suffix, 'Kabel trafo - rak TR', ST_MakeLine(t.geom, r.geom), t.id, rak_id,
           ST_Length(ST_MakeLine(t.geom, r.geom)::geography), '{"penghantar":"NYY 4x240 mm2"}'::jsonb
    FROM gis_nodes r WHERE r.id = rak_id;

    k := 0;
    FOR e IN
      SELECT x.* FROM gis_edges x WHERE t.id IN (x.from_node_id, x.to_node_id) AND x.type_code IN ('skutr','sktr') AND x.code <> 'KTR-' || suffix
      ORDER BY x.code, x.id
    LOOP
      k := k + 1;
      far := CASE WHEN e.from_node_id = t.id THEN ST_PointN(e.geom, 2) ELSE ST_PointN(e.geom, ST_NPoints(e.geom) - 1) END;
      SELECT ST_Project(r.geom::geography, 5, ST_Azimuth(r.geom, far))::geometry INTO sw_geom FROM gis_nodes r WHERE r.id = rak_id;
      INSERT INTO gis_nodes (type_code, code, name, geom, properties)
      VALUES ('switch_jurusan_tr', 'SWJ-' || suffix || '-J' || k, 'Switch jurusan ' || k || ' ' || suffix, sw_geom,
              '{"jenis":"NH fuse","rating_a":250,"normal":"closed"}'::jsonb)
      RETURNING id INTO sw_id;
      INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, properties)
      SELECT 'sktr', 'KTR-' || suffix || '-J' || k, 'Kabel rak - switch jurusan ' || k, ST_MakeLine(r.geom, sw_geom), rak_id, sw_id,
             ST_Length(ST_MakeLine(r.geom, sw_geom)::geography), '{"penghantar":"NYY 4x150 mm2"}'::jsonb
      FROM gis_nodes r WHERE r.id = rak_id;
      -- saluran jurusan kini berawal dari switch jurusan
      IF e.from_node_id = t.id THEN
        UPDATE gis_edges SET from_node_id = sw_id, geom = ST_SetPoint(geom, 0, sw_geom) WHERE id = e.id;
      ELSE
        UPDATE gis_edges SET to_node_id = sw_id, geom = ST_SetPoint(geom, ST_NPoints(geom) - 1, sw_geom) WHERE id = e.id;
      END IF;
      UPDATE gis_edges SET length_m = ST_Length(geom::geography), updated_at = now() WHERE id = e.id;
    END LOOP;
  END LOOP;
END $$;
