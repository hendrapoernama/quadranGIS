-- Peralatan gardu beton / gardu hubung:
--  * pmt_20kv  PMT (pemutus tenaga / circuit breaker) 20 kV
--  * pms_20kv  PMS (pemisah / disconnector) 20 kV
--  * busbar_gardu  rel / busbar TM di dalam gardu (terpisah dari busbar GI yang menandai kepala penyulang)
-- PMT / PMS dapat berfungsi sebagai pembatas zona atau hanya pemutus (atribut pembatas_zona; bawaan
-- PMT = Ya, PMS = Tidak). Pemodelan: gardu (GH / GD) bertindak sebagai busbar, PMT / PMS disisipkan
-- pada kabel masuk / keluar dekat gardu; busbar_gardu dipakai bila rel di dalam gardu digambar rinci.

INSERT INTO component_types (code, name, name_en, geom_kind, category, is_source, is_switch, is_sink, voltage_kv, color, icon,
                             min_zoom, label_zoom, size, sort_order, topology, ways, attributes) VALUES
 ('pmt_20kv', 'PMT 20 kV (Pemutus Tenaga)', 'Circuit Breaker 20 kV (PMT)', 'point', 'pengaman', false, true, false, 20, '#be123c', 'sym_pmt',
  14, 17, 6, 58, true, 2,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"pembatas_zona","label":"Pembatas zona","label_en":"Zone boundary","type":"select","options":["Ya","Tidak"]},
    {"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"},
    {"key":"relai","label":"Relai proteksi","label_en":"Protection relay","type":"select","options":["OCR + GFR","OCR","GFR","Tanpa relai"]},
    {"key":"merek","label":"Merek","label_en":"Brand","type":"text"},
    {"key":"scada","label":"Terhubung SCADA","label_en":"SCADA connected","type":"bool"},
    {"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]},
    {"key":"tahun","label":"Tahun pasang","label_en":"Year installed","type":"number"}]'::jsonb),
 ('pms_20kv', 'PMS 20 kV (Pemisah)', 'Disconnector 20 kV (PMS)', 'point', 'pengaman', false, true, false, 20, '#0e7490', 'sym_pms',
  14, 17, 6, 59, true, 2,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"pembatas_zona","label":"Pembatas zona","label_en":"Zone boundary","type":"select","options":["Tidak","Ya"]},
    {"key":"jenis","label":"Jenis","label_en":"Type","type":"select","options":["PMS kubikel","PMS tiang (air break)","PMS tanah (earthing)"]},
    {"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"},
    {"key":"merek","label":"Merek","label_en":"Brand","type":"text"},
    {"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]},
    {"key":"tahun","label":"Tahun pasang","label_en":"Year installed","type":"number"}]'::jsonb),
 ('busbar_gardu', 'Busbar Gardu (rel TM)', 'Substation Busbar (MV)', 'line', 'peralatan', false, false, false, 20, '#d97706', 'line',
  15, 17, 5, 41, true, 0,
  '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text"},
    {"key":"jenis","label":"Jenis rel","label_en":"Bar type","type":"select","options":["Rel tembaga","Rel aluminium"]},
    {"key":"rating_a","label":"Rating arus","label_en":"Current rating","type":"number","unit":"A"}]'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- ---------------- data contoh: PMT / PMS pada kabel keluar gardu hubung ----------------
-- GH-GMB-01: PMT (pembatas zona) · GH-GMB-03: PMS (hanya pemutus)
DO $$
DECLARE
  e record; f double precision; p geometry; sw_id bigint; k int := 0; tc text; props jsonb; label text; prev text := '';
BEGIN
  FOR e IN
    SELECT x.*, gh.code AS gh_code, (x.from_node_id = gh.id) AS gh_first
    FROM gis_edges x JOIN gis_nodes gh ON gh.id IN (x.from_node_id, x.to_node_id)
    WHERE gh.type_code = 'gh' AND gh.code IN ('GH-GMB-01', 'GH-GMB-03') AND x.type_code IN ('sutm', 'sktm')
    ORDER BY gh.code, x.code, x.id
  LOOP
    IF e.gh_code <> prev THEN k := 0; prev := e.gh_code; END IF;   -- nomor urut per gardu hubung
    k := k + 1;
    IF e.gh_code = 'GH-GMB-01' THEN
      tc := 'pmt_20kv'; label := 'PMT';
      props := '{"pembatas_zona":"Ya","relai":"OCR + GFR","arus_nominal_a":630,"normal":"closed"}'::jsonb;
    ELSE
      tc := 'pms_20kv'; label := 'PMS';
      props := '{"pembatas_zona":"Tidak","jenis":"PMS kubikel","arus_nominal_a":630,"normal":"closed"}'::jsonb;
    END IF;
    CONTINUE WHEN EXISTS (SELECT 1 FROM gis_nodes WHERE code = label || '-' || regexp_replace(e.gh_code, '^GH-', '') || '-' || k);
    f := CASE WHEN e.gh_first THEN 0.08 ELSE 0.92 END;          -- dekat gardu hubung
    p := ST_LineInterpolatePoint(e.geom, f);
    INSERT INTO gis_nodes (type_code, code, name, geom, properties)
    VALUES (tc, label || '-' || regexp_replace(e.gh_code, '^GH-', '') || '-' || k, label || ' ' || e.gh_code || ' keluar ' || k, p, props)
    RETURNING id INTO sw_id;
    INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, properties)
    VALUES (e.type_code, e.code || '-' || label, COALESCE(e.name, ''), ST_LineSubstring(e.geom, f, 1), sw_id, e.to_node_id,
            ST_Length(ST_LineSubstring(e.geom, f, 1)::geography), e.properties);
    UPDATE gis_edges SET to_node_id = sw_id, geom = ST_LineSubstring(geom, 0, f),
           length_m = ST_Length(ST_LineSubstring(geom, 0, f)::geography), updated_at = now()
     WHERE id = e.id;
  END LOOP;
END $$;
