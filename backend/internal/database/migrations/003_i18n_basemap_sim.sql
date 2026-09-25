-- =====================================================================
-- 003: dwibahasa (label EN), basemap terang/gelap, dan data simulasi
--      5 penyulang dari GI Gambir (Jakarta Pusat) sampai pelanggan.
-- =====================================================================

-- ---------------- label bahasa Inggris ----------------
ALTER TABLE menus ADD COLUMN IF NOT EXISTS title_en text NOT NULL DEFAULT '';
ALTER TABLE component_types ADD COLUMN IF NOT EXISTS name_en text NOT NULL DEFAULT '';

UPDATE menus SET title_en = CASE id::text
    WHEN 'a0000000-0000-0000-0000-000000000001' THEN 'Network Map'
    WHEN 'a0000000-0000-0000-0000-000000000002' THEN 'Administration'
    WHEN 'a0000000-0000-0000-0000-000000000003' THEN 'Users'
    WHEN 'a0000000-0000-0000-0000-000000000004' THEN 'Roles'
    WHEN 'a0000000-0000-0000-0000-000000000005' THEN 'Menus'
    WHEN 'a0000000-0000-0000-0000-000000000006' THEN 'Configuration'
    WHEN 'a0000000-0000-0000-0000-000000000007' THEN 'Layer Settings'
    WHEN 'a0000000-0000-0000-0000-000000000008' THEN 'System Monitoring'
    ELSE title_en END
WHERE title_en = '';

UPDATE component_types SET name_en = CASE code
    WHEN 'power_grid'       THEN 'Power Grid (Source / Transmission)'
    WHEN 'gi'               THEN 'Main Substation (GI)'
    WHEN 'trafo_gi'         THEN 'Substation Transformer'
    WHEN 'busbar'           THEN 'Busbar'
    WHEN 'kubikel_20kv'     THEN '20 kV Switchgear Cubicle'
    WHEN 'gh'               THEN 'Switching Substation (GH)'
    WHEN 'gd'               THEN 'Distribution Substation'
    WHEN 'trafo_distribusi' THEN 'Distribution Transformer'
    WHEN 'sktm'             THEN 'MV Underground Cable (SKTM)'
    WHEN 'sutm'             THEN 'MV Overhead Line (SUTM)'
    WHEN 'skutr'            THEN 'LV Aerial Bundled Cable (SKUTR)'
    WHEN 'sktr'             THEN 'LV Underground Cable (SKTR)'
    WHEN 'sr'               THEN 'Service Drop (SR)'
    WHEN 'pelanggan_tt'     THEN 'HV Customer'
    WHEN 'pelanggan_tm'     THEN 'MV Customer'
    WHEN 'pelanggan_tr'     THEN 'LV Customer'
    WHEN 'junction'         THEN 'Junction (automatic connection point)'
    ELSE name_en END
WHERE name_en = '';

-- ---------------- basemap terang / gelap & preferensi bawaan ----------------
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('app.basemap_light_url',   'https://tile.openstreetmap.org/{z}/{x}/{y}.png',            'string', 'general', 'Basemap OpenStreetMap terang (XYZ)'),
 ('app.basemap_dark_url',    'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',    'string', 'general', 'Basemap OpenStreetMap gelap (CARTO Dark Matter, XYZ)'),
 ('app.basemap_attribution', '&copy; OpenStreetMap contributors &copy; CARTO',            'string', 'general', 'Atribusi basemap'),
 ('app.default_locale',      'id',     'string', 'general', 'Bahasa bawaan antarmuka (id / en)'),
 ('app.default_theme',       'system', 'string', 'general', 'Tema bawaan (light / dark / system)')
ON CONFLICT (key) DO NOTHING;

-- pusat peta pindah ke Jakarta Pusat (GI Gambir) bila masih nilai bawaan lama
UPDATE app_configs SET value = '106.8330,-6.1760' WHERE key = 'app.map_center' AND value = '106.8456,-6.2088';
UPDATE app_configs SET value = '13' WHERE key = 'app.map_zoom' AND value = '12';

-- ---------------- fungsi bantu simulasi ----------------
CREATE OR REPLACE FUNCTION sim_pt(lng double precision, lat double precision) RETURNS geometry AS $$
    SELECT ST_SetSRID(ST_MakePoint(lng, lat), 4326)
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION sim_node(p_type text, p_code text, p_name text, p_lng double precision, p_lat double precision, p_status text, p_props jsonb)
RETURNS bigint AS $$
    INSERT INTO gis_nodes (type_code, code, name, geom, status, properties)
    VALUES (p_type, p_code, p_name, sim_pt(p_lng, p_lat), p_status, p_props)
    RETURNING id
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sim_edge(p_type text, p_code text, p_name text, p_from bigint, p_to bigint, p_props jsonb, p_mid geometry DEFAULT NULL)
RETURNS bigint AS $$
    INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
    SELECT p_type, p_code, p_name, g, p_from, p_to, ST_Length(g::geography), 'closed', p_props
    FROM (
        SELECT CASE WHEN p_mid IS NULL THEN ST_MakeLine(a.geom, b.geom)
                    ELSE ST_MakeLine(ARRAY[a.geom, p_mid, b.geom]) END AS g
        FROM gis_nodes a, gis_nodes b WHERE a.id = p_from AND b.id = p_to
    ) s
    RETURNING id
$$ LANGUAGE sql;

-- ---------------- simulasi: GI Gambir, 5 penyulang, sampai pelanggan ----------------
DO $$
DECLARE
    m2lng   constant double precision := 1.0 / (111320.0 * cos(radians(-6.176)));
    m2lat   constant double precision := 1.0 / 110574.0;
    gi_lng  constant double precision := 106.8330;
    gi_lat  constant double precision := -6.1760;
    feeders constant text[] := ARRAY['GMB-01','GMB-02','GMB-03','GMB-04','GMB-05'];
    areas   constant text[] := ARRAY['Kemayoran','Senen','Menteng','Tanah Abang','Petojo'];
    angles  constant double precision[] := ARRAY[15, 90, 160, 230, 300];
    lv_type constant text[] := ARRAY['skutr','skutr','sktr','skutr','sktr'];
    streets constant text[][] := ARRAY[
        ARRAY['Jl. Gunung Sahari','Jl. Kemayoran Gempol','Jl. Garuda','Jl. Angkasa','Jl. Bungur Besar','Jl. Kran Raya','Jl. Sumur Batu','Jl. Serdang'],
        ARRAY['Jl. Kwitang','Jl. Senen Raya','Jl. Kramat Raya','Jl. Kramat Sentiong','Jl. Kalibaru Timur','Jl. Cempaka Putih Barat','Jl. Letjen Suprapto','Jl. Rawasari'],
        ARRAY['Jl. Kebon Sirih','Jl. Cikini Raya','Jl. Cut Meutia','Jl. Diponegoro','Jl. Cokroaminoto','Jl. Teuku Umar','Jl. Sutan Syahrir','Jl. Latuharhary'],
        ARRAY['Jl. Budi Kemuliaan','Jl. Fachrudin','Jl. KH Mas Mansyur','Jl. Kebon Kacang','Jl. Jati Baru','Jl. Karet Pasar Baru','Jl. Penjernihan','Jl. Bendungan Hilir'],
        ARRAY['Jl. Abdul Muis','Jl. Petojo Utara','Jl. Cideng Barat','Jl. Hasyim Ashari','Jl. Biak','Jl. Roxy','Jl. Duri Pulo','Jl. Tomang Raya']
    ];
    daya    constant int[]  := ARRAY[450, 900, 1300, 2200, 3500, 4400, 5500];
    tarif   constant text[] := ARRAY['R1','R1M','R2','B1','S2'];
    kva     constant int[]  := ARRAY[160, 200, 250, 315, 400];

    pg_id bigint; gi_id bigint; tt_id bigint; trf1 bigint; trf2 bigint; kin1 bigint; kin2 bigint;
    kub bigint[] := ARRAY[]::bigint[]; lastgd bigint[] := ARRAY[0,0,0,0,0]::bigint[];
    prev_bb bigint; k bigint; prev_id bigint; gd_id bigint; td_id bigint; gh_id bigint; tm_id bigint;
    pole bigint; prev_pole bigint; plg bigint; tie bigint;
    f int; g int; j int; p int; c int; cnt_plg int := 0;
    ang double precision; a2 double precision; dist double precision;
    x double precision; y double precision; mx double precision; my double precision;
    tx double precision; ty double precision; jx double precision; jy double precision; px double precision; py double precision;
    seg_type text;
BEGIN
    IF EXISTS (SELECT 1 FROM gis_nodes WHERE code = 'GI-GMB') THEN
        RETURN;
    END IF;
    PERFORM setseed(0.4242);

    -- ===== sumber, GI, pelanggan TT =====
    pg_id := sim_node('power_grid', 'PG-JKT-150', 'Transmisi 150 kV Jakarta (Gandul - Gambir)',
                      gi_lng - 3200*m2lng, gi_lat - 400*m2lat, 'closed', '{"tegangan_kv":150,"simulasi":true}');
    gi_id := sim_node('gi', 'GI-GMB', 'GI Gambir', gi_lng, gi_lat, 'closed',
                      '{"kapasitas_mva":120,"jumlah_trafo":2,"alamat":"Jl. Merdeka Timur, Gambir, Jakarta Pusat","simulasi":true}');
    PERFORM sim_edge('sktm', 'TRX-150-GMB', 'Transmisi 150 kV ke GI Gambir', pg_id, gi_id, '{"tegangan_kv":150}',
                     sim_pt(gi_lng - 1600*m2lng, gi_lat + 300*m2lat));
    tt_id := sim_node('pelanggan_tt', 'PLG-TT-GMB-01', 'Pelanggan TT Kawasan Kemayoran', gi_lng + 1500*m2lng, gi_lat + 1800*m2lat, 'closed',
                      '{"daya_mva":12,"tarif":"I4","simulasi":true}');
    PERFORM sim_edge('sktm', 'TRX-150-TT-01', 'Transmisi 150 kV ke Pelanggan TT', gi_id, tt_id, '{"tegangan_kv":150}');

    -- ===== di dalam GI: 2 trafo, kubikel incoming, busbar 20 kV, 5 kubikel outgoing =====
    trf1 := sim_node('trafo_gi', 'TRF-GMB-1', 'Trafo GI Gambir #1 60 MVA', gi_lng - 40*m2lng, gi_lat + 25*m2lat, 'closed', '{"daya_mva":60,"ratio":"150/20 kV"}');
    trf2 := sim_node('trafo_gi', 'TRF-GMB-2', 'Trafo GI Gambir #2 60 MVA', gi_lng + 40*m2lng, gi_lat + 25*m2lat, 'closed', '{"daya_mva":60,"ratio":"150/20 kV"}');
    PERFORM sim_edge('sktm', 'INT-GMB-TRF1', 'GI Gambir - Trafo #1', gi_id, trf1, '{"tegangan_kv":150}');
    PERFORM sim_edge('sktm', 'INT-GMB-TRF2', 'GI Gambir - Trafo #2', gi_id, trf2, '{"tegangan_kv":150}');
    kin1 := sim_node('kubikel_20kv', 'KBK-GMB-IN1', 'Kubikel Incoming Trafo #1', gi_lng - 40*m2lng, gi_lat + 4*m2lat, 'closed', '{"fungsi":"incoming"}');
    kin2 := sim_node('kubikel_20kv', 'KBK-GMB-IN2', 'Kubikel Incoming Trafo #2', gi_lng + 40*m2lng, gi_lat + 4*m2lat, 'closed', '{"fungsi":"incoming"}');
    PERFORM sim_edge('sktm', 'INT-GMB-TRF1-IN', 'Trafo #1 - Kubikel Incoming', trf1, kin1, '{"tegangan_kv":20}');
    PERFORM sim_edge('sktm', 'INT-GMB-TRF2-IN', 'Trafo #2 - Kubikel Incoming', trf2, kin2, '{"tegangan_kv":20}');
    prev_bb := kin1;
    FOR f IN 1..5 LOOP
        k := sim_node('kubikel_20kv', 'KBK-' || feeders[f], 'Kubikel Outgoing ' || feeders[f],
                      gi_lng + (-36 + 12*f)*m2lng, gi_lat - 6*m2lat, 'closed',
                      jsonb_build_object('fungsi', 'outgoing', 'penyulang', feeders[f]));
        kub := kub || k;
        PERFORM sim_edge('busbar', 'BB-GMB-' || f, 'Busbar 20 kV GI Gambir seg.' || f, prev_bb, k, '{"tegangan_kv":20}');
        prev_bb := k;
    END LOOP;
    PERFORM sim_edge('busbar', 'BB-GMB-6', 'Busbar 20 kV GI Gambir seg.6', prev_bb, kin2, '{"tegangan_kv":20}');

    -- ===== 5 penyulang =====
    FOR f IN 1..5 LOOP
        ang := radians(angles[f]);
        prev_id := kub[f];
        x := gi_lng + (-36 + 12*f)*m2lng;
        y := gi_lat - 6*m2lat;
        FOR g IN 1..8 LOOP
            a2 := ang + radians((random() - 0.5) * 24);
            dist := CASE WHEN g = 1 THEN 550 + random()*150 ELSE 300 + random()*140 END;
            mx := x + (dist*0.5)*sin(a2)*m2lng + (random()-0.5)*50*m2lng;
            my := y + (dist*0.5)*cos(a2)*m2lat + (random()-0.5)*50*m2lat;
            x := x + dist*sin(a2)*m2lng;
            y := y + dist*cos(a2)*m2lat;
            seg_type := CASE WHEN g <= 3 THEN 'sktm' ELSE 'sutm' END;

            -- GH di tengah penyulang 1 dan 3
            IF g = 4 AND f IN (1, 3) THEN
                gh_id := sim_node('gh', 'GH-' || feeders[f], 'GH ' || areas[f], x, y, 'closed',
                                  jsonb_build_object('penyulang', feeders[f], 'jumlah_kubikel', 6, 'simulasi', true));
                PERFORM sim_edge(seg_type, upper(seg_type) || '-' || feeders[f] || '-' || lpad(g::text, 2, '0'),
                                 upper(seg_type) || ' ' || feeders[f] || ' seg.' || g, prev_id, gh_id,
                                 jsonb_build_object('penyulang', feeders[f], 'penghantar', 'XLPE 3x240 mm2'), sim_pt(mx, my));
                prev_id := gh_id;
                CONTINUE;
            END IF;

            gd_id := sim_node('gd', 'GD-' || feeders[f] || '-' || lpad(g::text, 2, '0'), 'GD ' || areas[f] || ' ' || streets[f][g], x, y, 'closed',
                              jsonb_build_object('penyulang', feeders[f], 'jenis', CASE WHEN g % 2 = 0 THEN 'beton' ELSE 'portal' END,
                                                 'alamat', streets[f][g] || ', ' || areas[f] || ', Jakarta Pusat', 'simulasi', true));
            PERFORM sim_edge(seg_type, upper(seg_type) || '-' || feeders[f] || '-' || lpad(g::text, 2, '0'),
                             upper(seg_type) || ' ' || feeders[f] || ' seg.' || g, prev_id, gd_id,
                             jsonb_build_object('penyulang', feeders[f], 'penghantar',
                                 CASE WHEN seg_type = 'sktm' THEN 'XLPE 3x240 mm2' ELSE 'AAAC 150 mm2' END), sim_pt(mx, my));
            prev_id := gd_id;
            lastgd[f] := gd_id;

            -- pelanggan TM pada GD ke-2 dan ke-6
            IF g IN (2, 6) THEN
                tm_id := sim_node('pelanggan_tm', 'PLG-TM-' || feeders[f] || '-' || g, 'Pelanggan TM ' || areas[f] || ' ' || g,
                                  x + 100*sin(a2 + radians(60))*m2lng, y + 100*cos(a2 + radians(60))*m2lat, 'closed',
                                  jsonb_build_object('daya_kva', 240 + 200*(g/2), 'tarif', 'B3', 'simulasi', true));
                PERFORM sim_edge('sktm', 'SKTM-TM-' || feeders[f] || '-' || g, 'SKTM ke pelanggan TM', gd_id, tm_id,
                                 jsonb_build_object('penyulang', feeders[f]));
            END IF;

            -- trafo distribusi (offset diagonal 12 m)
            tx := x + 12*(cos(a2) + sin(a2))*m2lng;
            ty := y + 12*(cos(a2) - sin(a2))*m2lat;
            td_id := sim_node('trafo_distribusi', 'TD-' || feeders[f] || '-' || lpad(g::text, 2, '0'),
                              'Trafo ' || kva[1 + (g % 5)] || ' kVA ' || areas[f] || ' ' || g, tx, ty, 'closed',
                              jsonb_build_object('daya_kva', kva[1 + (g % 5)], 'penyulang', feeders[f], 'simulasi', true));
            PERFORM sim_edge('sktm', 'INT-' || feeders[f] || '-' || g || '-TD', 'GD - Trafo distribusi', gd_id, td_id, '{"tegangan_kv":20}');

            -- 2 jurusan TR tegak lurus trunk, 4 tiang/junction, 2 pelanggan per tiang
            FOR j IN 1..2 LOOP
                jx := CASE WHEN j = 1 THEN cos(a2) ELSE -cos(a2) END;
                jy := CASE WHEN j = 1 THEN -sin(a2) ELSE sin(a2) END;
                prev_pole := td_id;
                px := tx; py := ty;
                FOR p IN 1..4 LOOP
                    px := px + 55*jx*m2lng;
                    py := py + 55*jy*m2lat;
                    pole := sim_node('junction', '', '', px, py, 'closed', '{}');
                    PERFORM sim_edge(lv_type[f], upper(lv_type[f]) || '-' || feeders[f] || '-' || g || '-J' || j || '-' || p,
                                     upper(lv_type[f]) || ' jurusan ' || j || ' seg.' || p, prev_pole, pole,
                                     jsonb_build_object('penghantar', CASE WHEN lv_type[f] = 'skutr' THEN 'LVTC 3x70+50 mm2' ELSE 'NYFGbY 4x70 mm2' END,
                                                        'penyulang', feeders[f]));
                    prev_pole := pole;
                    FOR c IN 1..2 LOOP
                        cnt_plg := cnt_plg + 1;
                        plg := sim_node('pelanggan_tr', 'PLG-TR-' || feeders[f] || '-' || lpad(cnt_plg::text, 4, '0'),
                                        'Pelanggan ' || streets[f][g] || ' No. ' || ((p*2 + c) * 3 + j),
                                        px + (CASE WHEN c = 1 THEN 22 ELSE -22 END)*(-jy)*m2lng,
                                        py + (CASE WHEN c = 1 THEN 22 ELSE -22 END)*(jx)*m2lat, 'closed',
                                        jsonb_build_object('daya_va', daya[1 + floor(random()*7)::int], 'tarif', tarif[1 + floor(random()*5)::int],
                                                           'penyulang', feeders[f], 'simulasi', true));
                        PERFORM sim_edge('sr', 'SR-' || feeders[f] || '-' || lpad(cnt_plg::text, 4, '0'), 'SR pelanggan', pole, plg, '{}');
                    END LOOP;
                END LOOP;
            END LOOP;
        END LOOP;
    END LOOP;

    -- ===== tie switch (normally open) antar ujung penyulang: 1-2 dan 3-4 =====
    FOR f IN 1..2 LOOP
        SELECT sim_node('kubikel_20kv', 'KBK-TIE-' || feeders[2*f-1] || '-' || feeders[2*f],
                        'Tie Switch ' || feeders[2*f-1] || ' / ' || feeders[2*f] || ' (NO)',
                        (ST_X(a.geom) + ST_X(b.geom)) / 2, (ST_Y(a.geom) + ST_Y(b.geom)) / 2, 'open',
                        jsonb_build_object('fungsi', 'tie', 'normal', 'open', 'simulasi', true))
        INTO tie FROM gis_nodes a, gis_nodes b WHERE a.id = lastgd[2*f-1] AND b.id = lastgd[2*f];
        PERFORM sim_edge('sutm', 'SUTM-TIE-' || feeders[2*f-1], 'SUTM tie ' || feeders[2*f-1], lastgd[2*f-1], tie, jsonb_build_object('penyulang', feeders[2*f-1]));
        PERFORM sim_edge('sutm', 'SUTM-TIE-' || feeders[2*f],   'SUTM tie ' || feeders[2*f],   tie, lastgd[2*f],   jsonb_build_object('penyulang', feeders[2*f]));
    END LOOP;

    REFRESH MATERIALIZED VIEW gis_nodes_density;
END $$;

DROP FUNCTION IF EXISTS sim_edge(text, text, text, bigint, bigint, jsonb, geometry);
DROP FUNCTION IF EXISTS sim_node(text, text, text, double precision, double precision, text, jsonb);
DROP FUNCTION IF EXISTS sim_pt(double precision, double precision);
