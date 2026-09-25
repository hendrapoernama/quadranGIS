-- =====================================================================
-- Data awal: tipe komponen, role, menu, konfigurasi, contoh jaringan
-- =====================================================================

-- ---------------- Tipe komponen kelistrikan ----------------
INSERT INTO component_types (code, name, geom_kind, category, is_source, is_switch, is_sink, voltage_kv, color, icon, min_zoom, label_zoom, size, sort_order) VALUES
 ('power_grid',       'Power Grid (Sumber / Transmisi)',          'point', 'sumber',     true,  false, false, 150, '#dc2626', 'bolt',     0,  8,  10, 10),
 ('gi',               'Gardu Induk (GI)',                          'point', 'bangunan',   true,  false, false, 150, '#b91c1c', 'square',   0,  9,  9,  20),
 ('trafo_gi',         'Trafo GI',                                  'point', 'peralatan',  false, false, false, 150, '#ea580c', 'triangle', 10, 14, 7,  30),
 ('busbar',           'Busbar',                                    'line',  'peralatan',  false, false, false, 20,  '#f59e0b', 'line',     10, 16, 4,  40),
 ('kubikel_20kv',     'Kubikel 20 kV',                             'point', 'peralatan',  false, true,  false, 20,  '#7c3aed', 'diamond',  13, 16, 6,  50),
 ('gh',               'Gardu Hubung (GH)',                         'point', 'bangunan',   false, false, false, 20,  '#9333ea', 'square',   8,  12, 8,  60),
 ('gd',               'Gardu Distribusi',                          'point', 'bangunan',   false, false, false, 20,  '#2563eb', 'square',   11, 14, 7,  70),
 ('trafo_distribusi', 'Trafo Distribusi',                          'point', 'peralatan',  false, false, false, 0.4, '#0891b2', 'triangle', 12, 15, 6,  80),
 ('sktm',             'SKTM (Saluran Kabel Tegangan Menengah)',    'line',  'jaringan',   false, false, false, 20,  '#dc2626', 'line',     10, 16, 3,  90),
 ('sutm',             'SUTM (Saluran Udara Tegangan Menengah)',    'line',  'jaringan',   false, false, false, 20,  '#ef4444', 'line',     10, 16, 3,  100),
 ('skutr',            'SKUTR (Saluran Kabel Udara Tegangan Rendah)','line', 'jaringan',   false, false, false, 0.4, '#0284c7', 'line',     13, 17, 2,  110),
 ('sktr',             'SKTR (Saluran Kabel Tegangan Rendah)',      'line',  'jaringan',   false, false, false, 0.4, '#0369a1', 'line',     13, 17, 2,  120),
 ('sr',               'SR (Sambungan Rumah)',                      'line',  'jaringan',   false, false, false, 0.22,'#16a34a', 'line',     15, 18, 1.5,130),
 ('pelanggan_tt',     'Pelanggan Tegangan Tinggi (TT)',            'point', 'pelanggan',  false, false, true,  150, '#be123c', 'circle',   10, 14, 7,  140),
 ('pelanggan_tm',     'Pelanggan Tegangan Menengah (TM)',          'point', 'pelanggan',  false, false, true,  20,  '#c026d3', 'circle',   13, 16, 6,  150),
 ('pelanggan_tr',     'Pelanggan Tegangan Rendah (TR)',            'point', 'pelanggan',  false, false, true,  0.22,'#15803d', 'circle',   15, 18, 4,  160),
 ('junction',         'Junction (titik sambung otomatis)',         'point', 'topologi',   false, false, false, 0,   '#6b7280', 'circle',   16, 19, 3,  170)
ON CONFLICT (code) DO NOTHING;

-- ---------------- Roles ----------------
INSERT INTO roles (id, name, description, permissions, is_system) VALUES
 ('11111111-1111-1111-1111-111111111111', 'admin',  'Administrator penuh',
   '["admin.users","admin.roles","admin.menus","admin.config","admin.monitoring","gis.view","gis.edit","gis.trace","gis.settings"]', true),
 ('22222222-2222-2222-2222-222222222222', 'editor', 'Editor GIS (menggambar & mengubah jaringan)',
   '["gis.view","gis.edit","gis.trace"]', true),
 ('33333333-3333-3333-3333-333333333333', 'viewer', 'Hanya melihat peta & trace',
   '["gis.view","gis.trace"]', true)
ON CONFLICT (name) DO NOTHING;

-- ---------------- Menus ----------------
INSERT INTO menus (id, parent_id, title, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000001', NULL, 'Peta Jaringan',      '/map',             'map',      10),
 ('a0000000-0000-0000-0000-000000000002', NULL, 'Administrasi',       '',                 'settings', 90),
 ('a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'Pengguna',        '/admin/users',      'users',    10),
 ('a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000002', 'Roles',           '/admin/roles',      'shield',   20),
 ('a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000002', 'Menu',            '/admin/menus',      'menu',     30),
 ('a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000002', 'Konfigurasi',     '/admin/config',     'sliders',  40),
 ('a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000002', 'Pengaturan Layer','/admin/layers',     'layers',   50),
 ('a0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000002', 'Monitoring Sistem','/admin/monitoring','activity', 60)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_menus (role_id, menu_id)
SELECT '11111111-1111-1111-1111-111111111111', id FROM menus
ON CONFLICT DO NOTHING;
INSERT INTO role_menus (role_id, menu_id) VALUES
 ('22222222-2222-2222-2222-222222222222', 'a0000000-0000-0000-0000-000000000001'),
 ('33333333-3333-3333-3333-333333333333', 'a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---------------- Konfigurasi aplikasi ----------------
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('app.name',                     'QuadranGIS',  'string', 'general', 'Nama aplikasi'),
 ('app.map_center',               '106.8456,-6.2088', 'string', 'general', 'Pusat peta awal (lng,lat)'),
 ('app.map_zoom',                 '12',          'int',    'general', 'Zoom peta awal'),
 ('app.basemap_url',              'https://tile.openstreetmap.org/{z}/{x}/{y}.png', 'string', 'general', 'URL basemap raster XYZ'),
 ('app.glyphs_url',               'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', 'string', 'general', 'URL glyph font untuk label peta'),
 ('app.text_font',                'Open Sans Semibold', 'string', 'general', 'Nama font label peta (harus tersedia di glyphs_url)'),
 ('auth.session_hours',           '12',          'int',    'auth',    'Lama sesi login (jam)'),
 ('auth.max_login_attempts',      '10',          'int',    'auth',    'Batas percobaan login gagal per 15 menit'),
 ('auth.captcha_ttl_seconds',     '300',         'int',    'auth',    'Masa berlaku captcha (detik)'),
 ('loading.tile_cache_ttl_seconds','300',        'int',    'loading', 'TTL cache tile di Redis (detik)'),
 ('loading.max_features_per_tile','20000',       'int',    'loading', 'Batas fitur per tile (menjaga ukuran tile ringan)'),
 ('loading.density_max_zoom',     '9',           'int',    'loading', 'Di bawah zoom ini titik ditampilkan sebagai kepadatan (cluster)'),
 ('loading.simplify_tolerance_px','1',           'float',  'loading', 'Toleransi simplifikasi garis (piksel) pada zoom rendah'),
 ('loading.density_refresh_seconds','300',       'int',    'loading', 'Interval refresh kepadatan (detik)'),
 ('loading.max_bbox_features',    '5000',        'int',    'loading', 'Batas fitur pada query bbox GeoJSON'),
 ('loading.realtime_debounce_ms', '500',         'int',    'loading', 'Jeda refresh tile di client setelah event realtime (ms)'),
 ('topology.snap_tolerance_m',    '2',           'float',  'topology','Toleransi snapping otomatis (meter)'),
 ('topology.auto_split_edges',    'true',        'bool',   'topology','Pisahkan garis otomatis saat titik diletakkan di atas garis'),
 ('topology.auto_junction',       'true',        'bool',   'topology','Buat junction otomatis di ujung garis yang bebas'),
 ('trace.max_depth',              '5000',        'int',    'trace',   'Kedalaman maksimum trace'),
 ('trace.max_result_features',    '5000',        'int',    'trace',   'Batas fitur GeoJSON hasil trace yang dikirim ke client'),
 ('monitoring.interval_seconds',  '15',          'int',    'monitoring','Interval pengambilan metrik sistem (detik)')
ON CONFLICT (key) DO NOTHING;

-- ---------------- Contoh jaringan kecil (Jakarta) ----------------
-- Hanya diisi jika tabel masih kosong.
DO $$
BEGIN
  IF (SELECT count(*) FROM gis_nodes) = 0 THEN
    INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties) VALUES
     (1,  'power_grid',       'PG-JKT-01',  'Power Grid Jawa-Bali 150kV', ST_SetSRID(ST_MakePoint(106.8300, -6.2000),4326), 'closed', '{"tegangan_kv":150}'),
     (2,  'gi',               'GI-CWG',     'GI Cawang',                  ST_SetSRID(ST_MakePoint(106.8456, -6.2088),4326), 'closed', '{"kapasitas_mva":120}'),
     (3,  'trafo_gi',         'TRF-GI-CWG-1','Trafo GI Cawang #1 60MVA',  ST_SetSRID(ST_MakePoint(106.8462, -6.2090),4326), 'closed', '{"daya_mva":60,"ratio":"150/20 kV"}'),
     (4,  'junction',         '',           '',                           ST_SetSRID(ST_MakePoint(106.8468, -6.2092),4326), 'closed', '{}'),
     (5,  'junction',         '',           '',                           ST_SetSRID(ST_MakePoint(106.8480, -6.2092),4326), 'closed', '{}'),
     (6,  'kubikel_20kv',     'KBK-CWG-01', 'Kubikel Outgoing CWG-01',    ST_SetSRID(ST_MakePoint(106.8472, -6.2094),4326), 'closed', '{"penyulang":"CWG-01"}'),
     (7,  'kubikel_20kv',     'KBK-CWG-02', 'Kubikel Outgoing CWG-02',    ST_SetSRID(ST_MakePoint(106.8478, -6.2094),4326), 'open',   '{"penyulang":"CWG-02"}'),
     (8,  'gh',               'GH-TBT',     'GH Tebet',                   ST_SetSRID(ST_MakePoint(106.8560, -6.2250),4326), 'closed', '{}'),
     (9,  'gd',               'GD-TBT-001', 'GD Tebet Timur 001',         ST_SetSRID(ST_MakePoint(106.8600, -6.2300),4326), 'closed', '{"jenis":"beton"}'),
     (10, 'trafo_distribusi', 'TD-TBT-001', 'Trafo 250 kVA Tebet 001',    ST_SetSRID(ST_MakePoint(106.8602, -6.2302),4326), 'closed', '{"daya_kva":250}'),
     (11, 'junction',         '',           '',                           ST_SetSRID(ST_MakePoint(106.8620, -6.2310),4326), 'closed', '{}'),
     (12, 'pelanggan_tr',     'PLG-TR-0001','Pelanggan TR Jl. Tebet Timur 1', ST_SetSRID(ST_MakePoint(106.8625, -6.2305),4326), 'closed', '{"daya_va":2200}'),
     (13, 'pelanggan_tr',     'PLG-TR-0002','Pelanggan TR Jl. Tebet Timur 2', ST_SetSRID(ST_MakePoint(106.8628, -6.2315),4326), 'closed', '{"daya_va":1300}'),
     (14, 'pelanggan_tm',     'PLG-TM-0001','Pelanggan TM Mall Tebet',    ST_SetSRID(ST_MakePoint(106.8580, -6.2280),4326), 'closed', '{"daya_kva":555}'),
     (15, 'gd',               'GD-TBT-002', 'GD Tebet Barat 002',         ST_SetSRID(ST_MakePoint(106.8520, -6.2320),4326), 'closed', '{}'),
     (16, 'pelanggan_tt',     'PLG-TT-0001','Pelanggan TT Industri Cawang', ST_SetSRID(ST_MakePoint(106.8400, -6.2150),4326), 'closed', '{"daya_mva":10}');

    INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, status, properties) VALUES
     (1, 'sktm',  'TRX-150-01', 'Transmisi 150kV PG-GI Cawang', ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8300,-6.2000),4326), ST_SetSRID(ST_MakePoint(106.8456,-6.2088),4326)]), 1, 2, 'closed', '{"tegangan_kv":150}'),
     (2, 'sktm',  'INT-GI-TRF', 'Koneksi GI - Trafo GI',        ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8456,-6.2088),4326), ST_SetSRID(ST_MakePoint(106.8462,-6.2090),4326)]), 2, 3, 'closed', '{}'),
     (3, 'sktm',  'INT-TRF-BB', 'Koneksi Trafo - Busbar',       ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8462,-6.2090),4326), ST_SetSRID(ST_MakePoint(106.8468,-6.2092),4326)]), 3, 4, 'closed', '{}'),
     (4, 'busbar','BB-CWG-20',  'Busbar 20kV GI Cawang',        ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8468,-6.2092),4326), ST_SetSRID(ST_MakePoint(106.8480,-6.2092),4326)]), 4, 5, 'closed', '{}'),
     (5, 'sktm',  'INT-BB-K1',  'Busbar - Kubikel 01',          ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8468,-6.2092),4326), ST_SetSRID(ST_MakePoint(106.8472,-6.2094),4326)]), 4, 6, 'closed', '{}'),
     (6, 'sktm',  'INT-BB-K2',  'Busbar - Kubikel 02',          ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8480,-6.2092),4326), ST_SetSRID(ST_MakePoint(106.8478,-6.2094),4326)]), 5, 7, 'closed', '{}'),
     (7, 'sktm',  'SKTM-CWG01-1','SKTM Penyulang CWG-01 seg.1',  ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8472,-6.2094),4326), ST_SetSRID(ST_MakePoint(106.8560,-6.2250),4326)]), 6, 8, 'closed', '{"penampang":"XLPE 240mm2"}'),
     (8, 'sutm',  'SUTM-CWG01-2','SUTM Penyulang CWG-01 seg.2',  ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8560,-6.2250),4326), ST_SetSRID(ST_MakePoint(106.8600,-6.2300),4326)]), 8, 9, 'closed', '{"penghantar":"AAAC 150mm2"}'),
     (9, 'sutm',  'SUTM-CWG01-3','SUTM ke Pelanggan TM',         ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8560,-6.2250),4326), ST_SetSRID(ST_MakePoint(106.8580,-6.2280),4326)]), 8, 14, 'closed', '{}'),
     (10,'sktm',  'INT-GD-TD',  'GD - Trafo Distribusi',        ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8600,-6.2300),4326), ST_SetSRID(ST_MakePoint(106.8602,-6.2302),4326)]), 9, 10, 'closed', '{}'),
     (11,'skutr', 'SKUTR-TBT-1','SKUTR Tebet 001 jurusan A',     ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8602,-6.2302),4326), ST_SetSRID(ST_MakePoint(106.8620,-6.2310),4326)]), 10, 11, 'closed', '{"penghantar":"LVTC 3x70+50"}'),
     (12,'sr',    'SR-0001',    'SR Pelanggan 0001',            ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8620,-6.2310),4326), ST_SetSRID(ST_MakePoint(106.8625,-6.2305),4326)]), 11, 12, 'closed', '{}'),
     (13,'sr',    'SR-0002',    'SR Pelanggan 0002',            ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8620,-6.2310),4326), ST_SetSRID(ST_MakePoint(106.8628,-6.2315),4326)]), 11, 13, 'closed', '{}'),
     (14,'sutm',  'SUTM-CWG02-1','SUTM Penyulang CWG-02 seg.1',  ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8478,-6.2094),4326), ST_SetSRID(ST_MakePoint(106.8520,-6.2320),4326)]), 7, 15, 'closed', '{}'),
     (15,'sktm',  'TRX-150-02', 'Transmisi 150kV ke Pelanggan TT', ST_MakeLine(ARRAY[ST_SetSRID(ST_MakePoint(106.8456,-6.2088),4326), ST_SetSRID(ST_MakePoint(106.8400,-6.2150),4326)]), 2, 16, 'closed', '{}');

    UPDATE gis_edges SET length_m = qgis_length_m(geom);
    PERFORM setval('gis_nodes_id_seq', (SELECT max(id) FROM gis_nodes));
    PERFORM setval('gis_edges_id_seq', (SELECT max(id) FROM gis_edges));
    REFRESH MATERIALIZED VIEW gis_nodes_density;
  END IF;
END $$;
