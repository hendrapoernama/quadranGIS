-- =====================================================================
-- 007: objek pengaman (recloser, LBS 2/3 way), objek pendukung (tiang TM/TR,
--      bukan bagian topologi), atribut SSOT per tipe, manuver jaringan
--      (open/close dengan jenis GANGGUAN/PEMELIHARAAN/MLS), status nyala/padam,
--      group penyulang/jurusan/zona, kejadian padam & menu monitoring kelistrikan.
-- =====================================================================

-- ---------------- katalog tipe ----------------
ALTER TABLE component_types ADD COLUMN IF NOT EXISTS topology   boolean NOT NULL DEFAULT true; -- ikut membentuk graf jaringan
ALTER TABLE component_types ADD COLUMN IF NOT EXISTS ways       int     NOT NULL DEFAULT 0;    -- jumlah arah switch (2 / 3), 0 = bukan switch
ALTER TABLE component_types ADD COLUMN IF NOT EXISTS attributes jsonb   NOT NULL DEFAULT '[]'::jsonb; -- skema atribut SSOT

INSERT INTO component_types (code, name, name_en, geom_kind, category, is_source, is_switch, is_sink, voltage_kv, color, icon, min_zoom, label_zoom, size, sort_order, topology, ways) VALUES
 ('recloser', 'Recloser',            'Recloser',            'point', 'pengaman',  false, true,  false, 20, '#c2410c', 'diamond', 13, 15, 6.5, 55, true, 2),
 ('lbs_2way', 'LBS 2 Way',           'LBS 2 Way',           'point', 'pengaman',  false, true,  false, 20, '#65a30d', 'diamond', 13, 15, 6.5, 56, true, 2),
 ('lbs_3way', 'LBS 3 Way',           'LBS 3 Way',           'point', 'pengaman',  false, true,  false, 20, '#3f6212', 'diamond', 13, 15, 7,   57, true, 3),
 ('tiang_tm', 'Tiang TM',            'MV Pole',             'point', 'pendukung', false, false, false, 20, '#78716c', 'circle',  15, 18, 3.5, 175, false, 0),
 ('tiang_tr', 'Tiang TR',            'LV Pole',             'point', 'pendukung', false, false, false, 0.4,'#a8a29e', 'circle',  16, 19, 3,   176, false, 0)
ON CONFLICT (code) DO NOTHING;
UPDATE component_types SET ways = 2 WHERE code = 'kubikel_20kv' AND ways = 0;

-- skema atribut SSOT (single source of truth) per tipe: key, label (id/en), type (text|number|select|bool), unit, options
UPDATE component_types t SET attributes = s.attrs::jsonb FROM (VALUES
 ('power_grid', '[{"key":"tegangan_kv","label":"Tegangan","label_en":"Voltage","type":"number","unit":"kV"},{"key":"pemilik","label":"Pemilik / pengelola","label_en":"Owner / operator","type":"text"},{"key":"sumber","label":"Sumber daya","label_en":"Power source","type":"text"}]'),
 ('gi', '[{"key":"kapasitas_mva","label":"Kapasitas","label_en":"Capacity","type":"number","unit":"MVA"},{"key":"jumlah_trafo","label":"Jumlah trafo","label_en":"Transformers","type":"number"},{"key":"alamat","label":"Alamat","label_en":"Address","type":"text"},{"key":"up3","label":"UP3","label_en":"UP3","type":"text"},{"key":"ulp","label":"ULP","label_en":"ULP","type":"text"},{"key":"tahun_operasi","label":"Tahun operasi","label_en":"Year commissioned","type":"number"}]'),
 ('trafo_gi', '[{"key":"daya_mva","label":"Daya","label_en":"Rating","type":"number","unit":"MVA"},{"key":"ratio","label":"Rasio tegangan","label_en":"Voltage ratio","type":"text"},{"key":"merek","label":"Merek","label_en":"Brand","type":"text"},{"key":"vektor_group","label":"Vektor group","label_en":"Vector group","type":"text"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('busbar', '[{"key":"tegangan_kv","label":"Tegangan","label_en":"Voltage","type":"number","unit":"kV"},{"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"}]'),
 ('kubikel_20kv', '[{"key":"fungsi","label":"Fungsi","label_en":"Function","type":"select","options":["incoming","outgoing","kopel","tie","pengukuran"]},{"key":"penyulang","label":"Penyulang","label_en":"Feeder","type":"text"},{"key":"merek","label":"Merek","label_en":"Brand","type":"text"},{"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"},{"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]}]'),
 ('recloser', '[{"key":"merek","label":"Merek","label_en":"Brand","type":"text"},{"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"},{"key":"scada","label":"Terhubung SCADA","label_en":"SCADA connected","type":"bool"},{"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('lbs_2way', '[{"key":"merek","label":"Merek","label_en":"Brand","type":"text"},{"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"},{"key":"motorized","label":"Motorized","label_en":"Motorized","type":"bool"},{"key":"scada","label":"Terhubung SCADA","label_en":"SCADA connected","type":"bool"},{"key":"normal","label":"Posisi normal","label_en":"Normal position","type":"select","options":["closed","open"]},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('lbs_3way', '[{"key":"merek","label":"Merek","label_en":"Brand","type":"text"},{"key":"arus_nominal_a","label":"Arus nominal","label_en":"Rated current","type":"number","unit":"A"},{"key":"motorized","label":"Motorized","label_en":"Motorized","type":"bool"},{"key":"scada","label":"Terhubung SCADA","label_en":"SCADA connected","type":"bool"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('gh', '[{"key":"jumlah_kubikel","label":"Jumlah kubikel","label_en":"Cubicles","type":"number"},{"key":"jenis","label":"Jenis bangunan","label_en":"Building type","type":"select","options":["beton","kios"]},{"key":"alamat","label":"Alamat","label_en":"Address","type":"text"},{"key":"penyulang","label":"Penyulang","label_en":"Feeder","type":"text"}]'),
 ('gd', '[{"key":"jenis","label":"Jenis gardu","label_en":"Substation type","type":"select","options":["beton","portal","cantol","kios"]},{"key":"alamat","label":"Alamat","label_en":"Address","type":"text"},{"key":"ulp","label":"ULP","label_en":"ULP","type":"text"},{"key":"penyulang","label":"Penyulang","label_en":"Feeder","type":"text"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('trafo_distribusi', '[{"key":"daya_kva","label":"Daya","label_en":"Rating","type":"number","unit":"kVA"},{"key":"merek","label":"Merek","label_en":"Brand","type":"text"},{"key":"fasa","label":"Fasa","label_en":"Phases","type":"select","options":["1","3"]},{"key":"jumlah_jurusan","label":"Jumlah jurusan","label_en":"LV routes","type":"number"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('sktm', '[{"key":"penghantar","label":"Penghantar","label_en":"Conductor","type":"text"},{"key":"penampang_mm2","label":"Penampang","label_en":"Cross-section","type":"number","unit":"mm2"},{"key":"tegangan_kv","label":"Tegangan","label_en":"Voltage","type":"number","unit":"kV"},{"key":"penyulang","label":"Penyulang","label_en":"Feeder","type":"text"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('sutm', '[{"key":"penghantar","label":"Penghantar","label_en":"Conductor","type":"text"},{"key":"penampang_mm2","label":"Penampang","label_en":"Cross-section","type":"number","unit":"mm2"},{"key":"tegangan_kv","label":"Tegangan","label_en":"Voltage","type":"number","unit":"kV"},{"key":"penyulang","label":"Penyulang","label_en":"Feeder","type":"text"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('skutr', '[{"key":"penghantar","label":"Penghantar","label_en":"Conductor","type":"text"},{"key":"penampang_mm2","label":"Penampang","label_en":"Cross-section","type":"number","unit":"mm2"},{"key":"jurusan","label":"Jurusan","label_en":"LV route","type":"text"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('sktr', '[{"key":"penghantar","label":"Penghantar","label_en":"Conductor","type":"text"},{"key":"penampang_mm2","label":"Penampang","label_en":"Cross-section","type":"number","unit":"mm2"},{"key":"jurusan","label":"Jurusan","label_en":"LV route","type":"text"},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('sr', '[{"key":"jenis_kabel","label":"Jenis kabel","label_en":"Cable type","type":"text"},{"key":"fasa","label":"Fasa","label_en":"Phases","type":"select","options":["1","3"]}]'),
 ('pelanggan_tt', '[{"key":"idpel","label":"ID pelanggan","label_en":"Customer ID","type":"text"},{"key":"tarif","label":"Tarif","label_en":"Tariff","type":"text"},{"key":"daya_mva","label":"Daya","label_en":"Contracted power","type":"number","unit":"MVA"},{"key":"alamat","label":"Alamat","label_en":"Address","type":"text"}]'),
 ('pelanggan_tm', '[{"key":"idpel","label":"ID pelanggan","label_en":"Customer ID","type":"text"},{"key":"tarif","label":"Tarif","label_en":"Tariff","type":"text"},{"key":"daya_kva","label":"Daya","label_en":"Contracted power","type":"number","unit":"kVA"},{"key":"alamat","label":"Alamat","label_en":"Address","type":"text"}]'),
 ('pelanggan_tr', '[{"key":"idpel","label":"ID pelanggan","label_en":"Customer ID","type":"text"},{"key":"tarif","label":"Tarif","label_en":"Tariff","type":"select","options":["R1","R1M","R2","R3","B1","B2","S2","I1","P1"]},{"key":"daya_va","label":"Daya","label_en":"Contracted power","type":"number","unit":"VA"},{"key":"no_meter","label":"No. meter","label_en":"Meter no.","type":"text"},{"key":"alamat","label":"Alamat","label_en":"Address","type":"text"}]'),
 ('tiang_tm', '[{"key":"jenis","label":"Jenis tiang","label_en":"Pole type","type":"select","options":["beton","besi","kayu"]},{"key":"tinggi_m","label":"Tinggi","label_en":"Height","type":"number","unit":"m"},{"key":"kekuatan_dan","label":"Kekuatan","label_en":"Strength","type":"number","unit":"daN"},{"key":"kondisi","label":"Kondisi","label_en":"Condition","type":"select","options":["baik","rusak ringan","rusak berat"]},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]'),
 ('tiang_tr', '[{"key":"jenis","label":"Jenis tiang","label_en":"Pole type","type":"select","options":["beton","besi","kayu"]},{"key":"tinggi_m","label":"Tinggi","label_en":"Height","type":"number","unit":"m"},{"key":"kekuatan_dan","label":"Kekuatan","label_en":"Strength","type":"number","unit":"daN"},{"key":"kondisi","label":"Kondisi","label_en":"Condition","type":"select","options":["baik","rusak ringan","rusak berat"]},{"key":"tahun","label":"Tahun","label_en":"Year","type":"number"}]')
) AS s(code, attrs) WHERE t.code = s.code AND t.attributes = '[]'::jsonb;

-- ---------------- status energisasi & open per arah ----------------
ALTER TABLE gis_nodes ADD COLUMN IF NOT EXISTS energized boolean NOT NULL DEFAULT true;
ALTER TABLE gis_edges ADD COLUMN IF NOT EXISTS energized boolean NOT NULL DEFAULT true;
ALTER TABLE gis_nodes ADD COLUMN IF NOT EXISTS open_ways bigint[] NOT NULL DEFAULT '{}'; -- edge yang terbuka pada switch multi-arah (LBS 3 way)
CREATE INDEX IF NOT EXISTS gis_nodes_off_idx ON gis_nodes (id) WHERE NOT energized;
CREATE INDEX IF NOT EXISTS gis_edges_off_idx ON gis_edges (id) WHERE NOT energized;

-- angka aman dari properti jsonb (NULL bila bukan angka)
CREATE OR REPLACE FUNCTION qgis_num(t text) RETURNS double precision AS $$
    SELECT CASE WHEN t ~ '^-?[0-9]+(\.[0-9]+)?$' THEN t::double precision ELSE NULL END
$$ LANGUAGE sql IMMUTABLE STRICT;

-- ---------------- manuver & kejadian padam ----------------
CREATE TABLE IF NOT EXISTS maneuvers (
    id           bigserial PRIMARY KEY,
    node_id      bigint NOT NULL,
    node_code    text NOT NULL DEFAULT '',
    node_type    text NOT NULL DEFAULT '',
    action       text NOT NULL CHECK (action IN ('open','close')),
    way_edge_id  bigint,                                  -- arah tertentu (LBS 3 way), NULL = seluruh alat
    kind         text NOT NULL CHECK (kind IN ('GANGGUAN','PEMELIHARAAN','MLS')),
    note         text NOT NULL DEFAULT '',
    user_id      uuid,
    username     text NOT NULL DEFAULT '',
    affected     jsonb NOT NULL DEFAULT '{}'::jsonb,      -- ringkasan dampak (padam/nyala per group)
    outage_id    bigint,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maneuvers_created_idx ON maneuvers (created_at DESC);
CREATE INDEX IF NOT EXISTS maneuvers_node_idx ON maneuvers (node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outages (
    id                bigserial PRIMARY KEY,
    kind              text NOT NULL,                      -- GANGGUAN | PEMELIHARAAN | MLS
    level             text NOT NULL,                      -- gi | trafo_gi | penyulang | zona | gardu_distribusi | lainnya
    group_code        text NOT NULL DEFAULT '',           -- kode group penyebab (kode objek yang dimanuver)
    cause_node_id     bigint NOT NULL,
    cause_node_code   text NOT NULL DEFAULT '',
    cause_node_type   text NOT NULL DEFAULT '',
    way_edge_id       bigint,
    open_maneuver_id  bigint,
    close_maneuver_id bigint,
    started_at        timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz,
    summary           jsonb NOT NULL DEFAULT '{}'::jsonb, -- {counts:{...}, gi:[], trafo_gi:[], penyulang:[], zona:[]}
    restored          jsonb,                              -- ringkasan saat dinyalakan kembali
    affected_nodes    bigint[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS outages_active_idx ON outages (started_at DESC) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS outages_started_idx ON outages (started_at DESC);
CREATE INDEX IF NOT EXISTS outages_cause_idx ON outages (cause_node_id) WHERE ended_at IS NULL;

-- ---------------- izin, menu, konfigurasi ----------------
UPDATE roles SET permissions = permissions || '["gis.maneuver"]'::jsonb
 WHERE name IN ('admin','editor') AND NOT permissions ? 'gis.maneuver';

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000009', NULL, 'Monitoring Kelistrikan', 'Power Monitoring', '/monitoring', 'activity', 20)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000009' FROM roles r WHERE r.name IN ('admin','editor','viewer')
ON CONFLICT DO NOTHING;

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('monitoring.default_daya_va',    '1300', 'int', 'monitoring', 'Daya (VA) pelanggan TR bila atribut daya_va kosong (rekap beban)'),
 ('monitoring.power_refresh_seconds', '15', 'int', 'monitoring', 'Interval refresh halaman monitoring kelistrikan (detik)')
ON CONFLICT (key) DO NOTHING;

-- ---------------- data contoh pada simulasi Gambir ----------------
-- recloser, LBS 2 way, LBS 3 way (arah ke-3 = tie normally open ke penyulang lain), tiang TM/TR
CREATE OR REPLACE FUNCTION sim_insert_switch(p_type text, p_code text, p_name text, p_edge_code text, p_frac double precision, p_status text, p_props jsonb)
RETURNS bigint AS $$
DECLARE e gis_edges%ROWTYPE; nid bigint;
BEGIN
    SELECT * INTO e FROM gis_edges WHERE code = p_edge_code ORDER BY id LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    INSERT INTO gis_nodes (type_code, code, name, geom, status, properties)
    VALUES (p_type, p_code, p_name, ST_LineInterpolatePoint(e.geom, p_frac), p_status, p_props) RETURNING id INTO nid;
    INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
    VALUES (e.type_code, e.code || 'B', e.name || ' (b)', ST_LineSubstring(e.geom, p_frac, 1), nid, e.to_node_id,
            ST_Length(ST_LineSubstring(e.geom, p_frac, 1)::geography), e.status, e.properties);
    UPDATE gis_edges SET geom = ST_LineSubstring(geom, 0, p_frac), to_node_id = nid,
           length_m = ST_Length(ST_LineSubstring(geom, 0, p_frac)::geography), code = code || 'A', name = name || ' (a)'
     WHERE id = e.id;
    RETURN nid;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE lbs3 bigint; gd5 bigint; tie_edge bigint;
BEGIN
    IF EXISTS (SELECT 1 FROM gis_nodes WHERE code = 'REC-GMB-02-05') OR NOT EXISTS (SELECT 1 FROM gis_nodes WHERE code = 'GI-GMB') THEN
        RETURN;
    END IF;
    PERFORM sim_insert_switch('recloser', 'REC-GMB-02-05', 'Recloser Senen (GMB-02)', 'SUTM-GMB-02-05', 0.5, 'closed',
        '{"merek":"Schneider","arus_nominal_a":630,"scada":true,"normal":"closed","penyulang":"GMB-02","simulasi":true}');
    PERFORM sim_insert_switch('recloser', 'REC-GMB-05-05', 'Recloser Petojo (GMB-05)', 'SUTM-GMB-05-05', 0.5, 'closed',
        '{"merek":"ABB","arus_nominal_a":630,"scada":true,"normal":"closed","penyulang":"GMB-05","simulasi":true}');
    PERFORM sim_insert_switch('lbs_2way', 'LBS-GMB-04-03', 'LBS Tanah Abang (GMB-04)', 'SKTM-GMB-04-03', 0.5, 'closed',
        '{"merek":"Siemens","arus_nominal_a":400,"motorized":true,"scada":false,"normal":"closed","penyulang":"GMB-04","simulasi":true}');
    PERFORM sim_insert_switch('lbs_2way', 'LBS-GMB-01-06', 'LBS Kemayoran (GMB-01)', 'SUTM-GMB-01-06', 0.5, 'closed',
        '{"merek":"Siemens","arus_nominal_a":400,"motorized":true,"scada":true,"normal":"closed","penyulang":"GMB-01","simulasi":true}');
    -- LBS 3 way pada penyulang GMB-03: arah 1-2 di penyulang, arah 3 = tie normally open ke GD terakhir GMB-05
    lbs3 := sim_insert_switch('lbs_3way', 'LBS3-GMB-03-07', 'LBS 3 Way Menteng (GMB-03 / tie GMB-05)', 'SUTM-GMB-03-07', 0.5, 'closed',
        '{"merek":"Schneider","arus_nominal_a":630,"motorized":true,"scada":true,"penyulang":"GMB-03","simulasi":true}');
    SELECT id INTO gd5 FROM gis_nodes WHERE code = 'GD-GMB-05-08';
    IF lbs3 IS NOT NULL AND gd5 IS NOT NULL THEN
        INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
        SELECT 'sutm', 'SUTM-TIE-LBS3-GMB-03', 'SUTM tie LBS 3 way GMB-03 / GMB-05', ST_MakeLine(a.geom, b.geom), lbs3, gd5,
               ST_Length(ST_MakeLine(a.geom, b.geom)::geography), 'closed', '{"penyulang":"GMB-03","tie":true,"simulasi":true}'
        FROM gis_nodes a, gis_nodes b WHERE a.id = lbs3 AND b.id = gd5 RETURNING id INTO tie_edge;
        UPDATE gis_nodes SET open_ways = ARRAY[tie_edge] WHERE id = lbs3;  -- arah ke-3 normally open
    END IF;

    -- tiang TM setiap ±45 m di sepanjang SUTM simulasi (bukan node topologi)
    INSERT INTO gis_nodes (type_code, code, name, geom, status, properties)
    SELECT 'tiang_tm', 'TTM-' || replace(e.code, 'SUTM-', '') || '-' || lpad(d.path[1]::text, 2, '0'), 'Tiang TM ' || e.code, d.geom, 'closed',
           jsonb_build_object('jenis', 'beton', 'tinggi_m', 12, 'kekuatan_dan', 200, 'kondisi', 'baik', 'tahun', 2015 + (d.path[1] % 8), 'simulasi', true)
    FROM gis_edges e
    CROSS JOIN LATERAL ST_DumpPoints(ST_LineInterpolatePoints(e.geom, LEAST(0.5, 45.0 / GREATEST(e.length_m, 1)), true)) d
    WHERE e.type_code = 'sutm' AND e.code LIKE 'SUTM-GMB-%' AND e.length_m > 60;

    -- tiang TR pada setiap ujung segmen SKUTR simulasi (posisi tiang = titik sambung jurusan)
    INSERT INTO gis_nodes (type_code, code, name, geom, status, properties)
    SELECT 'tiang_tr', 'TTR-' || replace(e.code, 'SKUTR-', ''), 'Tiang TR ' || e.code, ST_EndPoint(e.geom), 'closed',
           jsonb_build_object('jenis', 'beton', 'tinggi_m', 9, 'kekuatan_dan', 100, 'kondisi', 'baik', 'tahun', 2018, 'simulasi', true)
    FROM gis_edges e WHERE e.type_code = 'skutr' AND e.code LIKE 'SKUTR-GMB-%';

    REFRESH MATERIALIZED VIEW gis_nodes_density;
END $$;

DROP FUNCTION IF EXISTS sim_insert_switch(text, text, text, text, double precision, text, jsonb);
