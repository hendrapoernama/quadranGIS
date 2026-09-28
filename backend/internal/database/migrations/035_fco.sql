-- Objek jaringan FCO (Fuse Cut Out): pengaman lebur TM 20 kV di tiang, umumnya tepat sebelum trafo
-- distribusi (FCO trafo) atau di awal saluran cabang (FCO percabangan). Dapat dibuka/ditutup
-- (izin power.switch_tm); fuse putus diperlakukan sebagai posisi terbuka.
-- Topologi: FCO trafo (bertetangga dengan trafo distribusi) termasuk gardu dan tidak membentuk zona;
-- FCO percabangan membentuk zona seperti LBS / recloser.

INSERT INTO component_types (code, name, name_en, geom_kind, category, is_source, is_switch, is_sink, voltage_kv, color, icon,
                             min_zoom, label_zoom, size, sort_order, topology, ways, attributes) VALUES
 ('fco', 'FCO (Fuse Cut Out)', 'Fuse Cut-Out (FCO)', 'point', 'pengaman', false, true, false, 20, '#b45309', 'sym_fco',
  14, 17, 5.5, 78, true, 2,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"fungsi","label":"Fungsi","label_en":"Function","type":"select","options":["Trafo","Percabangan"]},
    {"key":"jenis_fuse","label":"Jenis fuse link","label_en":"Fuse link type","type":"select","options":["K","T","H","N"]},
    {"key":"rating_a","label":"Rating fuse link","label_en":"Fuse link rating","type":"number","unit":"A"},
    {"key":"merek","label":"Merek","label_en":"Brand","type":"text"},
    {"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]},
    {"key":"tahun","label":"Tahun pasang","label_en":"Year installed","type":"number"}]'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- ---------------- data contoh: FCO pada kabel gardu → trafo distribusi ----------------
-- gd -[sktm]- trafo  menjadi  gd -[sktm]- FCO -[sktm]- trafo
DO $$
DECLARE
  e record; f double precision; p geometry; fco_id bigint; suffix text; rating int;
BEGIN
  FOR e IN
    SELECT x.*, t.code AS td_code, t.id AS td_id, (a.type_code = 'gd') AS gd_first,
           NULLIF(t.properties->>'daya_kva', '')::float AS kva
    FROM gis_edges x
    JOIN gis_nodes a ON a.id = x.from_node_id
    JOIN gis_nodes b ON b.id = x.to_node_id
    JOIN gis_nodes t ON t.id = CASE WHEN a.type_code = 'trafo_distribusi' THEN a.id ELSE b.id END
    WHERE ((a.type_code = 'gd' AND b.type_code = 'trafo_distribusi') OR (a.type_code = 'trafo_distribusi' AND b.type_code = 'gd'))
      AND x.type_code IN ('sktm', 'sutm')
  LOOP
    suffix := regexp_replace(e.td_code, '^TD-', '');
    CONTINUE WHEN EXISTS (SELECT 1 FROM gis_nodes WHERE code = 'FCO-' || suffix);
    f := CASE WHEN e.gd_first THEN 0.6 ELSE 0.4 END;          -- lebih dekat ke trafo
    p := ST_LineInterpolatePoint(e.geom, f);
    -- fuse link ≈ arus nominal sisi TM trafo × 2 (dibulatkan ke rating standar)
    rating := CASE WHEN COALESCE(e.kva, 0) <= 100 THEN 6 WHEN e.kva <= 200 THEN 10 WHEN e.kva <= 400 THEN 20 ELSE 25 END;
    INSERT INTO gis_nodes (type_code, code, name, geom, properties)
    VALUES ('fco', 'FCO-' || suffix, 'FCO trafo ' || suffix, p,
            jsonb_build_object('fungsi', 'Trafo', 'jenis_fuse', 'K', 'rating_a', rating, 'normal', 'closed'))
    RETURNING id INTO fco_id;
    INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, properties)
    VALUES (e.type_code, e.code || '-FCO', COALESCE(e.name, '') || ' (FCO - ujung)', ST_LineSubstring(e.geom, f, 1), fco_id, e.to_node_id,
            ST_Length(ST_LineSubstring(e.geom, f, 1)::geography), e.properties);
    UPDATE gis_edges SET to_node_id = fco_id, geom = ST_LineSubstring(geom, 0, f),
           length_m = ST_Length(ST_LineSubstring(geom, 0, f)::geography), updated_at = now()
     WHERE id = e.id;
  END LOOP;
END $$;
