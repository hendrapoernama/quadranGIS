-- =====================================================================================
-- Impor jaringan dari File Geodatabase PLN (geometric network ESRI) yang sudah dimuat ke
-- skema staging (ogr2ogr PGDump, lihat gdbimport.go). Dipakai menu Administrasi › Impor GDB; dapat
-- juga dijalankan manual dalam satu transaksi:
--   psql -v src=stg_kjt -v tag=KJT-05082026 -f backend/internal/gdbimport/import_staging.sql
--
-- Langkah:
--   1. titik jaringan disatukan per posisi (grid 1 cm); bila beberapa objek berimpit dipilih menurut
--      prioritas (trafo GI > kubikel > trafo > PHB-TR > switch > gardu > pelanggan > joint > junction)
--   2. garis dipotong di setiap titik jaringan yang berada di tengahnya (complex edge ESRI)
--   3. tipe & atribut dipetakan ke tipe komponen QuadranGIS
--   4. tiang disimpan sebagai objek pendukung (tidak terhubung); ujung saluran di tiang = junction
--   5. status GDB INACTIVE → status_operasi "Non aktif", DECOMMISSIONED → "Bongkar" (gardu, trafo, PHB-TR, pelanggan);
--      pelanggan tanpa SR → "Tidak operasi"; gardu berkode REN / RENCANA → "Rencana" (tidak dihitung di rekap);
--      denah gardu miniatur diperbesar (qgis_expand_gardu_layout, migrasi 044)
--   6. GI → trafo GI disambung; kepala penyulang (kubikel) disintesis di dalam GI bila JTM tidak
--      tersambung ke switch penyulang (celah di data sumber), ditandai "sintesis": true
-- Semua objek hasil impor memiliki properti "import" = tag agar dapat dihapus / diulang.
-- =====================================================================================
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('search_path', :'src' || ', public', true);
SELECT set_config('imp.tag', :'tag', true);

-- ---------------------------------------------------------------- 0. ulang aman: hapus impor sebelumnya dengan tag sama
DELETE FROM public.gis_edges WHERE properties->>'import' = current_setting('imp.tag');
DELETE FROM public.gis_nodes WHERE properties->>'import' = current_setting('imp.tag');
DELETE FROM public.gis_layout_backup WHERE tag = current_setting('imp.tag');

-- ---------------------------------------------------------------- 1. garis sumber (meter, UTM 48S)
DROP TABLE IF EXISTS imp_line;
CREATE TABLE imp_line AS
WITH gi_area AS (SELECT ST_Transform(ST_Union(geom), 32748) g FROM gi)
SELECT row_number() OVER () lid, x.* FROM (
  SELECT 'jtm' layer, fid,
    CASE WHEN upper(coalesce(jenis_kabel, '')) LIKE '%XLPE%' OR upper(coalesce(jenis_kabel, '')) LIKE 'KABEL%' THEN 'sktm' ELSE 'sutm' END type_code,
    coalesce(kode_peralatan, '') code, coalesce(kodefeeder, '') name,
    CASE WHEN status = 'INACTIVE' THEN 'open' ELSE 'closed' END status,
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'penyulang', kodefeeder, 'penghantar', nullif(trim(coalesce(jenis_kabel, '') || ' ' || coalesce(ukuran_kawat, '')), ''),
      'gdb_status', status, 'gdb_globalid', globalid)) props,
    ST_LineMerge(ST_Transform(geom, 32748)) g FROM jtm
  UNION ALL SELECT 'mvcable', fid, 'sktm', coalesce(kode_peralatan, ''), coalesce(kodefeeder, ''),
    CASE WHEN status = 'INACTIVE' THEN 'open' ELSE 'closed' END,
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'penyulang', kodefeeder, 'penghantar', nullif(trim(coalesce(jenis_mvcable, '') || ' ' || coalesce(ukuran_kawat, '')), ''), 'gdb_globalid', globalid)),
    ST_LineMerge(ST_Transform(geom, 32748)) FROM mvcable
  UNION ALL SELECT 'jtr', fid, 'skutr', coalesce(kode_peralatan, ''), coalesce(kodejurusan, ''),
    CASE WHEN status = 'INACTIVE' THEN 'open' ELSE 'closed' END,
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'penyulang', kodefeeder, 'kodegd', kodegd, 'jurusan', kodejurusan,
      'penghantar', nullif(trim(coalesce(jenis_kabel, '') || ' ' || coalesce(ukuran_kawat, '')), ''), 'gdb_globalid', globalid)),
    ST_LineMerge(ST_Transform(geom, 32748)) FROM jtr
  UNION ALL SELECT 'lvcable', fid, 'sktr', coalesce(kode_peralatan, ''), '',
    CASE WHEN status = 'INACTIVE' THEN 'open' ELSE 'closed' END,
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'penyulang', kodefeeder, 'kodegd', kodegd, 'jurusan', kodejurusan, 'gdb_globalid', globalid)),
    ST_LineMerge(ST_Transform(geom, 32748)) FROM lvcable
  UNION ALL SELECT 'sr', fid, 'sr', coalesce(kode_peralatan, ''), '', 'closed',
    jsonb_strip_nulls(jsonb_build_object('idpel', nullif(idpelanggan, ''), 'penyulang', kodefeeder, 'kodegd', kodegd, 'gdb_globalid', globalid)),
    ST_LineMerge(ST_Transform(geom, 32748)) FROM sr
  UNION ALL SELECT 'busbar', b.fid,
    CASE WHEN b.keterangan LIKE '%\_TR' THEN 'sktr'
         WHEN ST_Intersects(ST_Transform(b.geom, 32748), (SELECT g FROM gi_area)) THEN 'busbar'
         ELSE 'busbar_gardu' END,
    '', coalesce(b.keterangan, ''), 'closed', jsonb_strip_nulls(jsonb_build_object('rel', b.keterangan, 'gdb_globalid', b.globalid)),
    ST_LineMerge(ST_Transform(b.geom, 32748)) FROM busbar_line b
) x WHERE GeometryType(x.g) = 'LINESTRING' AND ST_Length(x.g) > 0;
CREATE INDEX ON imp_line USING gist (g);

-- ---------------------------------------------------------------- 2. titik objek jaringan
DROP TABLE IF EXISTS imp_feat;
CREATE TABLE imp_feat AS
SELECT x.layer, x.fid, x.prio, x.type_code, x.code, x.name, x.props, x.status,
       ST_SnapToGrid(ST_Transform(ST_GeometryN(x.geom, 1), 32748), 0.01) g
FROM (
  SELECT 'trafo_gi' layer, fid, 1 prio, 'trafo_gi' type_code, trim(coalesce(kdgi, '') || ' ' || coalesce(kdtrafogi, '')) code, trim(coalesce(kdgi, '') || ' ' || coalesce(kdtrafogi, '')) name,
    jsonb_strip_nulls(jsonb_build_object('gi', kdgi, 'gdb_globalid', globalid)) props, 'closed' status, geom FROM trafo_gi
  UNION ALL SELECT 'mvcell', fid, 2,
    CASE WHEN upper(coalesce(fungsi_mv_ghgd, '')) = 'TRAFO' THEN 'fco'
         WHEN upper(coalesce(fungsi_mv_ghgd, '')) = 'METERING' OR upper(coalesce(jenis_mvcell, '')) LIKE 'CB%' THEN 'pmt_20kv'
         ELSE 'lbs_2way' END,
    coalesce(kode_peralatan, ''), trim(coalesce(jenis_mvcell, '') || ' ' || coalesce(fungsi_mv_ghgd, '') || ' ' || coalesce(kodegd, '')),
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'jenis_kubikel', jenis_mvcell, 'fungsi_kubikel', fungsi_mv_ghgd, 'merek', merk_mvcell,
      'penyulang', kodefeeder, 'kodegd', kodegd, 'gdb_globalid', globalid,
      'fungsi', CASE WHEN upper(coalesce(fungsi_mv_ghgd, '')) = 'TRAFO' THEN 'Trafo' END,
      'pembatas_zona', CASE WHEN upper(coalesce(fungsi_mv_ghgd, '')) = 'METERING' OR upper(coalesce(jenis_mvcell, '')) LIKE 'CB%' THEN 'Tidak' END,
      'normal', CASE WHEN status = 'INACTIVE' THEN 'open' ELSE 'closed' END)),
    CASE WHEN status = 'INACTIVE' THEN 'open' ELSE 'closed' END, geom FROM mvcell
  UNION ALL SELECT 'trafo', fid, 3, 'trafo_distribusi', coalesce(nullif(kode_peralatan, ''), 'TD-' || coalesce(kodegd, fid::text)), 'Trafo ' || coalesce(kapasitas::int::text || ' kVA ', '') || coalesce(kodegd, ''),
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'daya_kva', kapasitas, 'penyulang', kodefeeder, 'kodegd', kodegd, 'merek', manufacturer, 'gdb_globalid', globalid,
      'gdb_status', status, 'status_operasi', CASE status WHEN 'INACTIVE' THEN 'Non aktif' WHEN 'DECOMMISSIONED' THEN 'Bongkar' END,
      'keterangan_operasi', CASE WHEN status IN ('INACTIVE', 'DECOMMISSIONED') THEN 'status GDB ' || status END)),
    'closed', geom FROM trafo
  UNION ALL SELECT 'phbtr', fid, 4, 'rak_tr', coalesce(nullif(kode_peralatan, ''), 'PHB-' || coalesce(kodegd, fid::text)), 'PHB-TR ' || coalesce(kodegd, ''),
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'jumlah_jurusan', nullif(jur_aktif, ''), 'penyulang', kodefeeder, 'kodegd', kodegd, 'gdb_globalid', globalid,
      'gdb_status', status, 'status_operasi', CASE status WHEN 'INACTIVE' THEN 'Non aktif' WHEN 'DECOMMISSIONED' THEN 'Bongkar' END,
      'keterangan_operasi', CASE WHEN status IN ('INACTIVE', 'DECOMMISSIONED') THEN 'status GDB ' || status END)),
    'closed', geom FROM phbtr
  UNION ALL SELECT 'switch', fid, 5, 'switch', coalesce(kode_peralatan, ''), '',
    jsonb_strip_nulls(jsonb_build_object('kode_ssot', nullif(ssotnumber, ''), 'penyulang', penyulang, 'gdb_globalid', globalid)), 'closed', geom FROM switch
  UNION ALL SELECT 'gd', fid, 6, 'gd', coalesce(nullif(kodegd, ''), 'GD-' || fid), 'Gardu ' || coalesce(kodegd, '') || coalesce(' ' || nullif(alamat, ''), ''),
    jsonb_strip_nulls(jsonb_build_object('nomor_gd', nomorgd, 'kapasitas_kva', kapasitasgd, 'jumlah_trafo', jmltrafo, 'alamat', alamat, 'jenis', jenisgd,
      'penyulang', kodefeeder, 'gdb_globalid', globalid,
      'gdb_status', status, 'status_operasi', CASE status WHEN 'INACTIVE' THEN 'Non aktif' WHEN 'DECOMMISSIONED' THEN 'Bongkar' END,
      'keterangan_operasi', CASE WHEN status IN ('INACTIVE', 'DECOMMISSIONED') THEN 'status GDB ' || status END)), 'closed', geom FROM gd
  UNION ALL SELECT 'pelanggan', fid, 7, 'pelanggan_tr', coalesce(nullif(idpelanggan, ''), 'PLG-' || fid), coalesce(namapelanggan, ''),
    jsonb_strip_nulls(jsonb_build_object('idpel', nullif(idpelanggan, ''), 'tarif', tarif, 'daya_va', daya, 'no_meter', nokwhmeter, 'alamat', alamatlengkap,
      'fasa', fasa, 'penyulang', kodefeeder, 'kodegd', kodegd, 'jurusan', kodejurusan, 'gdb_globalid', globalid,
      'gdb_status', status, 'status_operasi', CASE status WHEN 'INACTIVE' THEN 'Non aktif' WHEN 'DECOMMISSIONED' THEN 'Bongkar' END,
      'keterangan_operasi', CASE WHEN status IN ('INACTIVE', 'DECOMMISSIONED') THEN 'status GDB ' || status END)), 'closed', geom FROM pelanggan
  UNION ALL SELECT 'jointing', fid, 8, 'junction', coalesce(kode_peralatan, ''), coalesce(type_jointing, ''),
    jsonb_strip_nulls(jsonb_build_object('jenis', 'jointing', 'type_jointing', type_jointing, 'gdb_globalid', globalid)), 'closed', geom FROM jointing
  UNION ALL SELECT 'junction', fid, 9, 'junction', '', '', '{}'::jsonb, 'closed', geom FROM jaringanlistrik_net_junctions
) x WHERE x.geom IS NOT NULL AND NOT ST_IsEmpty(x.geom);
CREATE INDEX ON imp_feat USING gist (g);
CREATE INDEX ON imp_feat (ST_AsText(g));

-- klasifikasi SWITCH (atributnya kosong di sumber) dari garis yang disentuh:
-- menyentuh sisi TR (rel TR, kabel TR, JTR) → switch jurusan TR; hanya TM → PMS (hanya pemutus)
UPDATE imp_feat f SET
  type_code = CASE WHEN EXISTS (SELECT 1 FROM imp_line l WHERE l.type_code IN ('sktr', 'skutr') AND ST_DWithin(l.g, f.g, 0.01)) THEN 'switch_jurusan_tr' ELSE 'pms_20kv' END,
  props = f.props || CASE WHEN EXISTS (SELECT 1 FROM imp_line l WHERE l.type_code IN ('sktr', 'skutr') AND ST_DWithin(l.g, f.g, 0.01))
                          THEN '{"jenis":"NH fuse","normal":"closed"}'::jsonb ELSE '{"pembatas_zona":"Tidak","jenis":"PMS kubikel","normal":"closed"}'::jsonb END
WHERE f.type_code = 'switch';

-- ---------------------------------------------------------------- 3. posisi simpul = titik objek + ujung garis
DROP TABLE IF EXISTS imp_pos;
CREATE TABLE imp_pos AS
SELECT DISTINCT ON (k) k, g FROM (
  SELECT ST_AsText(g) k, g FROM imp_feat
  UNION ALL SELECT ST_AsText(p), p FROM (SELECT ST_SnapToGrid(ST_StartPoint(g), 0.01) p FROM imp_line UNION ALL SELECT ST_SnapToGrid(ST_EndPoint(g), 0.01) FROM imp_line) e
) s ORDER BY k;
CREATE INDEX ON imp_pos USING gist (g);
CREATE UNIQUE INDEX ON imp_pos (k);

-- simpul: objek berprioritas tertinggi di posisi itu, selain itu junction
DROP TABLE IF EXISTS imp_node;
CREATE TABLE imp_node AS
SELECT p.k, p.g, coalesce(f.type_code, 'junction') type_code, coalesce(f.code, '') code, coalesce(f.name, '') name,
  coalesce(f.props, '{}'::jsonb) || jsonb_build_object('import', current_setting('imp.tag'), 'gdb_layer', coalesce(f.layer, 'ujung_garis')) props,
  coalesce(f.status, 'closed') status, f.layer, f.fid, 0::bigint id
FROM imp_pos p
LEFT JOIN LATERAL (SELECT * FROM imp_feat f WHERE ST_AsText(f.g) = p.k ORDER BY f.prio, f.fid LIMIT 1) f ON true;
CREATE UNIQUE INDEX ON imp_node (k);
CREATE INDEX ON imp_node USING gist (g);
UPDATE imp_node SET id = nextval('public.gis_nodes_id_seq');

-- ---------------------------------------------------------------- 4. potong garis di simpul yang berada di tengahnya
DROP TABLE IF EXISTS imp_cut;
CREATE TABLE imp_cut AS
SELECT l.lid, ST_LineLocatePoint(l.g, n.g) f
FROM imp_line l JOIN imp_node n ON ST_DWithin(l.g, n.g, 0.01)
WHERE ST_Distance(n.g, ST_StartPoint(l.g)) > 0.01 AND ST_Distance(n.g, ST_EndPoint(l.g)) > 0.01;

DROP TABLE IF EXISTS imp_seg;
CREATE TABLE imp_seg AS
WITH cuts AS (
  SELECT lid, f FROM imp_cut
  UNION ALL SELECT lid, 0 FROM imp_line UNION ALL SELECT lid, 1 FROM imp_line),
ord AS (SELECT lid, f, lead(f) OVER (PARTITION BY lid ORDER BY f) f2 FROM (SELECT DISTINCT lid, f FROM cuts) c)
SELECT l.lid, l.layer, l.fid, l.type_code, l.code, l.name, l.status, l.props, o.f, o.f2,
  ST_LineSubstring(l.g, o.f, o.f2) g
FROM ord o JOIN imp_line l USING (lid)
WHERE o.f2 IS NOT NULL AND o.f2 - o.f > 1e-9;

-- ujung potongan → simpul (posisi grid 1 cm; bila tidak tepat, simpul terdekat ≤ 2 cm)
ALTER TABLE imp_seg ADD COLUMN a bigint, ADD COLUMN b bigint;
UPDATE imp_seg s SET a = (SELECT n.id FROM imp_node n WHERE ST_DWithin(n.g, ST_StartPoint(s.g), 0.02) ORDER BY n.g <-> ST_StartPoint(s.g) LIMIT 1),
                     b = (SELECT n.id FROM imp_node n WHERE ST_DWithin(n.g, ST_EndPoint(s.g), 0.02) ORDER BY n.g <-> ST_EndPoint(s.g) LIMIT 1);
DELETE FROM imp_seg WHERE a IS NULL OR b IS NULL OR a = b;

-- ---------------------------------------------------------------- 5. GI: simpul poligon, sambungan ke trafo GI, kepala penyulang
DROP TABLE IF EXISTS imp_gi;
CREATE TABLE imp_gi AS
SELECT fid, coalesce(nullif(namagi, ''), description, 'GI ' || fid) nama, ST_Transform(ST_MakeValid(geom), 32748) poly, nextval('public.gis_nodes_id_seq') id FROM gi;

-- sambungan sintesis antar-simpul
DROP TABLE IF EXISTS imp_syn;
CREATE TABLE imp_syn (a bigint, b bigint, type_code text, note text);

-- GI → trafo GI (di dalam / ≤ 50 m dari poligon)
INSERT INTO imp_syn
SELECT gi.id, n.id, 'sktm', 'GI - trafo GI'
FROM imp_node n JOIN LATERAL (SELECT * FROM imp_gi ORDER BY imp_gi.poly <-> n.g LIMIT 1) gi ON ST_DWithin(gi.poly, n.g, 50)
WHERE n.type_code = 'trafo_gi';

-- derajat simpul (potongan garis)
DROP TABLE IF EXISTS imp_deg;
CREATE TABLE imp_deg AS SELECT id, count(*) d FROM (SELECT a id FROM imp_seg UNION ALL SELECT b FROM imp_seg) x GROUP BY id;

-- ujung JTM / kabel TM di dalam GI yang tidak tersambung ke apa pun (celah data sumber)
DROP TABLE IF EXISTS imp_feed;
CREATE TABLE imp_feed AS
SELECT DISTINCT ON (n.id) n.id node, gi.id gi, s.name feeder, n.g
FROM imp_seg s JOIN imp_node n ON n.id IN (s.a, s.b)
JOIN imp_gi gi ON ST_Intersects(gi.poly, n.g)
JOIN imp_deg d ON d.id = n.id AND d.d = 1
WHERE s.layer IN ('jtm', 'mvcable');

-- pasangkan dengan switch penyulang terdekat di GI yang sama (satu-satu, terdekat lebih dulu)
DROP TABLE IF EXISTS imp_feed_sw;
CREATE TABLE imp_feed_sw (node bigint, sw bigint, dist float8);
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT f.node, n.id sw, ST_Distance(f.g, n.g) dist
    FROM imp_feed f JOIN imp_node n ON n.type_code IN ('pms_20kv', 'lbs_2way', 'pmt_20kv')
      AND ST_Intersects((SELECT poly FROM imp_gi WHERE id = f.gi), n.g) AND ST_DWithin(f.g, n.g, 15)
    ORDER BY dist
  LOOP
    IF NOT EXISTS (SELECT 1 FROM imp_feed_sw WHERE node = r.node OR sw = r.sw) THEN
      INSERT INTO imp_feed_sw VALUES (r.node, r.sw, r.dist);
    END IF;
  END LOOP;
END $$;

-- switch penyulang terpasang → kubikel kepala penyulang, disambung ke JTM
UPDATE imp_node n SET type_code = 'kubikel_20kv', code = coalesce(nullif(f.feeder, ''), n.code), name = 'Kubikel ' || coalesce(nullif(f.feeder, ''), ''),
  props = (n.props - 'pembatas_zona' - 'jenis') || jsonb_build_object('penyulang', f.feeder, 'kepala_penyulang', true)
FROM imp_feed_sw s JOIN imp_feed f ON f.node = s.node WHERE n.id = s.sw;
INSERT INTO imp_syn SELECT s.sw, s.node, 'sktm', 'kabel keluar GI (celah data sumber)' FROM imp_feed_sw s;

-- ujung JTM tanpa pasangan switch: jadikan kubikel dan sambungkan ke simpul rel GI terdekat
UPDATE imp_node n SET type_code = 'kubikel_20kv', code = coalesce(nullif(f.feeder, ''), 'KBK-' || n.id), name = 'Kubikel ' || coalesce(f.feeder, ''),
  props = n.props || jsonb_build_object('penyulang', f.feeder, 'kepala_penyulang', true, 'sintesis', true)
FROM imp_feed f WHERE n.id = f.node AND NOT EXISTS (SELECT 1 FROM imp_feed_sw s WHERE s.node = f.node);
INSERT INTO imp_syn
SELECT f.node, bb.id, 'busbar', 'rel GI - kubikel (sintesis)'
FROM imp_feed f
JOIN LATERAL (SELECT n.id FROM imp_node n JOIN imp_seg s ON n.id IN (s.a, s.b) AND s.type_code = 'busbar'
              WHERE ST_DWithin(n.g, f.g, 60) ORDER BY n.g <-> f.g LIMIT 1) bb ON true
WHERE NOT EXISTS (SELECT 1 FROM imp_feed_sw s WHERE s.node = f.node);

-- switch penyulang yang memang sudah tersambung (rel GI + JTM) → kubikel
UPDATE imp_node n SET type_code = 'kubikel_20kv', props = (n.props - 'pembatas_zona') || '{"kepala_penyulang":true}'::jsonb,
  code = coalesce(nullif(n.code, ''), (SELECT s.name FROM imp_seg s WHERE n.id IN (s.a, s.b) AND s.layer IN ('jtm', 'mvcable') AND s.name <> '' LIMIT 1), n.code)
WHERE n.type_code IN ('pms_20kv', 'lbs_2way', 'pmt_20kv')
  AND EXISTS (SELECT 1 FROM imp_seg s WHERE n.id IN (s.a, s.b) AND s.type_code = 'busbar')
  AND EXISTS (SELECT 1 FROM imp_seg s WHERE n.id IN (s.a, s.b) AND s.layer IN ('jtm', 'mvcable'));

-- ---------------------------------------------------------------- 6. tulis ke tabel jaringan
INSERT INTO public.gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT id, type_code, left(code, 200), left(name, 300), ST_Transform(g, 4326), status, props FROM imp_node;

INSERT INTO public.gis_nodes (id, type_code, code, name, geom, status, properties, footprint)
SELECT gi.id, 'gi', upper(left(gi.nama, 60)), 'GI ' || gi.nama, ST_Transform(ST_PointOnSurface(gi.poly), 4326), 'closed',
  jsonb_build_object('import', current_setting('imp.tag'), 'gdb_layer', 'gi'), ST_Transform(ST_GeometryN(gi.poly, 1), 4326)
FROM imp_gi gi;

-- blok gardu → footprint gardu
UPDATE public.gis_nodes n SET footprint = ST_GeometryN(ST_MakeValid(b.geom), 1)
FROM blokgardu b
WHERE n.properties->>'import' = current_setting('imp.tag') AND n.type_code = 'gd' AND ST_Intersects(b.geom, n.geom)
  AND GeometryType(ST_GeometryN(ST_MakeValid(b.geom), 1)) = 'POLYGON';

INSERT INTO public.gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT s.type_code, left(s.code, 200), left(s.name, 300),
  ST_Transform(ST_SetPoint(ST_SetPoint(s.g, 0, na.g), -1, nb.g), 4326), s.a, s.b, ST_Length(s.g), s.status,
  s.props || jsonb_build_object('import', current_setting('imp.tag'), 'gdb_layer', s.layer)
FROM imp_seg s JOIN imp_node na ON na.id = s.a JOIN imp_node nb ON nb.id = s.b;

INSERT INTO public.gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT y.type_code, '', y.note, ST_MakeLine(a.geom, b.geom), y.a, y.b, ST_Length(ST_MakeLine(a.geom, b.geom)::geography), 'closed',
  jsonb_build_object('import', current_setting('imp.tag'), 'sintesis', true, 'keterangan', y.note)
FROM imp_syn y JOIN public.gis_nodes a ON a.id = y.a JOIN public.gis_nodes b ON b.id = y.b WHERE y.a <> y.b;

-- pelanggan tanpa SR (tidak tersambung ke saluran apa pun) = tidak operasi / dibongkar: tidak dihitung di rekap
UPDATE public.gis_nodes n SET properties = n.properties || '{"status_operasi":"Tidak operasi","keterangan_operasi":"tanpa SR (tidak tersambung)"}'::jsonb
WHERE n.properties->>'import' = current_setting('imp.tag') AND n.type_code = 'pelanggan_tr' AND NOT (n.properties ? 'status_operasi')
  AND NOT EXISTS (SELECT 1 FROM public.gis_edges e WHERE e.from_node_id = n.id)
  AND NOT EXISTS (SELECT 1 FROM public.gis_edges e WHERE e.to_node_id = n.id);

-- gardu rencana: kode / nomor gardu mengandung kata REN / RENCANA (mis. "REN GARDU BARU", "REN_GD_WING_461")
UPDATE public.gis_nodes n SET properties = n.properties || '{"status_operasi":"Rencana","keterangan_operasi":"kode gardu REN (rencana)"}'::jsonb
WHERE n.properties->>'import' = current_setting('imp.tag') AND n.type_code = 'gd'
  AND (n.code ~* '(^|[^a-z])(ren|rencana)([^a-z]|$)' OR coalesce(n.properties->>'nomor_gd', '') ~* '(^|[^a-z])(ren|rencana)([^a-z]|$)');

-- tiang: objek pendukung (tidak terhubung); TM bila ada JTM di titiknya
INSERT INTO public.gis_nodes (type_code, code, name, geom, status, properties)
SELECT CASE WHEN EXISTS (SELECT 1 FROM imp_line l WHERE l.type_code IN ('sutm', 'sktm') AND ST_DWithin(l.g, ST_Transform(ST_GeometryN(t.geom, 1), 32748), 0.05)) THEN 'tiang_tm' ELSE 'tiang_tr' END,
  coalesce(t.kode_peralatan, ''), coalesce(t.jenis_tiang, ''), ST_GeometryN(t.geom, 1), 'closed',
  jsonb_strip_nulls(jsonb_build_object('import', current_setting('imp.tag'), 'gdb_layer', 'tiang', 'jenis_tiang', t.jenis_tiang, 'ukuran', t.ukuran_tiang,
    'kode_ssot', nullif(t.ssotnumber, ''), 'penyulang', t.kodefeeder, 'gdb_globalid', t.globalid))
FROM tiang t WHERE t.geom IS NOT NULL AND upper(coalesce(t.jenis_tiang, '')) <> 'NODE';

-- denah gardu miniatur (skematik) diperbesar agar komponen di dalamnya tidak menumpuk di peta
SELECT * FROM public.qgis_expand_gardu_layout(current_setting('imp.tag'));

-- ---------------------------------------------------------------- 7. ringkasan
SELECT type_code, count(*) FROM public.gis_nodes WHERE properties->>'import' = current_setting('imp.tag') GROUP BY 1 ORDER BY 2 DESC;
SELECT type_code, count(*), round(sum(length_m)::numeric / 1000, 1) km FROM public.gis_edges WHERE properties->>'import' = current_setting('imp.tag') GROUP BY 1 ORDER BY 2 DESC;
SELECT (SELECT count(*) FROM imp_feed) ujung_jtm_di_gi_terputus, (SELECT count(*) FROM imp_feed_sw) dipasangkan_ke_switch,
       (SELECT count(*) FROM imp_cut) potongan_tengah_garis, (SELECT count(*) FROM imp_syn) sambungan_sintesis;

COMMIT;
