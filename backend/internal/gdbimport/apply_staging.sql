-- =====================================================================================
-- Tahap 3 impor GDB: terapkan perbedaan (imp_diff_*, diff_staging.sql — dijalankan ulang tepat sebelum skrip ini dalam
-- transaksi yang sama) ke tabel jaringan per objek: id objek yang sudah ada tidak berubah.
-- Variabel psql: conflict = keep (pertahankan data QuadranGIS) | gdb (pakai data GDB); deletes = 1 | 0 (hapus objek yang
-- tidak ada lagi di GDB). Kolom operasional (status buka/tutup, open_ways, energized, unit, penyulang) tidak disentuh;
-- atribut isian pengguna (di luar qgis_gdb_prop_keys) dipertahankan.
-- =====================================================================================

-- ---------------------------------------------------------------- 1. keputusan akhir per objek
ALTER TABLE imp_diff_node ADD COLUMN final text;
ALTER TABLE imp_diff_edge ADD COLUMN final text;
UPDATE imp_diff_node SET final = CASE action
  WHEN 'insert' THEN 'insert' WHEN 'update' THEN 'update' WHEN 'same' THEN 'same'
  WHEN 'delete' THEN CASE WHEN :'deletes' = '1' THEN 'delete' ELSE 'keep' END
  WHEN 'conflict' THEN CASE WHEN :'conflict' <> 'gdb' THEN 'keep'
    WHEN reason = 'both_changed' THEN 'update'
    WHEN reason = 'deleted_local' THEN 'insert'
    WHEN reason = 'changed_local' AND :'deletes' = '1' THEN 'delete'
    ELSE 'keep' END
  ELSE 'keep' END;
UPDATE imp_diff_edge SET final = CASE action
  WHEN 'insert' THEN 'insert' WHEN 'update' THEN 'update' WHEN 'same' THEN 'same'
  WHEN 'delete' THEN CASE WHEN :'deletes' = '1' THEN 'delete' ELSE 'keep' END
  WHEN 'conflict' THEN CASE WHEN :'conflict' <> 'gdb' THEN 'keep'
    WHEN reason = 'both_changed' THEN 'update'
    WHEN reason = 'deleted_local' THEN 'insert'
    WHEN reason = 'changed_local' AND :'deletes' = '1' THEN 'delete'
    ELSE 'keep' END
  ELSE 'keep' END;

-- simpul hanya dihapus bila semua saluran yang menempel ikut dihapus (FK cascade tidak boleh menghapus saluran lain)
UPDATE imp_diff_node d SET final = 'keep'
WHERE d.final = 'delete' AND EXISTS (
  SELECT 1 FROM public.gis_edges e WHERE (e.from_node_id = d.cur_id OR e.to_node_id = d.cur_id)
    AND NOT EXISTS (SELECT 1 FROM imp_diff_edge x WHERE x.cur_id = e.id AND x.final = 'delete'));

-- id akhir simpul hasil GDB: objek yang sudah ada tetap, objek baru dari urutan id jaringan
DROP TABLE IF EXISTS imp_map;
CREATE TABLE imp_map AS
SELECT d.sid, d.key, d.final, CASE WHEN d.final = 'insert' THEN nextval('public.gis_nodes_id_seq') ELSE d.cur_id END id
FROM imp_diff_node d
WHERE d.sid IS NOT NULL AND (d.final IN ('insert', 'update', 'same') OR (d.final = 'keep' AND d.cur_id IS NOT NULL));
CREATE UNIQUE INDEX ON imp_map (sid);

-- saluran baru / diubah hanya bila kedua ujungnya ada setelah diterapkan
UPDATE imp_diff_edge d SET final = 'skip'
FROM imp_out_edge s
WHERE s.eid = d.sid AND d.final IN ('insert', 'update')
  AND (NOT EXISTS (SELECT 1 FROM imp_map m WHERE m.sid = s.a) OR NOT EXISTS (SELECT 1 FROM imp_map m WHERE m.sid = s.b));

DROP TABLE IF EXISTS imp_emap;
CREATE TABLE imp_emap AS
SELECT d.sid, d.key, d.final, CASE WHEN d.final = 'insert' THEN nextval('public.gis_edges_id_seq') ELSE d.cur_id END id
FROM imp_diff_edge d
WHERE d.sid IS NOT NULL AND (d.final IN ('insert', 'update', 'same') OR (d.final = 'keep' AND d.cur_id IS NOT NULL));
CREATE UNIQUE INDEX ON imp_emap (sid);

-- ---------------------------------------------------------------- 2. denah gardu terdampak dikembalikan ke posisi asli
-- gardu batch yang denahnya sudah diperbesar (footprint asli dari gis_layout_backup)
DROP TABLE IF EXISTS imp_xg_all;
CREATE TABLE imp_xg_all AS
SELECT c.id, c.footprint fp FROM cur_node c
WHERE c.type_code IN ('gd', 'gh') AND c.props ? 'denah_skala' AND c.footprint IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.gis_nodes n WHERE n.id = c.id);
CREATE INDEX ON imp_xg_all USING gist (fp);

-- geometri (koordinat asli) objek yang baru / dihapus / bergeser
DROP TABLE IF EXISTS imp_chg_geom;
CREATE TABLE imp_chg_geom AS
SELECT s.geom g FROM imp_diff_node d JOIN imp_out_node s ON s.sid = d.sid WHERE d.final = 'insert' OR (d.final = 'update' AND (d.geom_changed OR d.fp_changed))
UNION ALL SELECT s.footprint FROM imp_diff_node d JOIN imp_out_node s ON s.sid = d.sid WHERE s.footprint IS NOT NULL AND (d.final = 'insert' OR (d.final = 'update' AND d.fp_changed))
UNION ALL SELECT c.geom FROM imp_diff_node d JOIN cur_node c ON c.id = d.cur_id WHERE d.final = 'delete' OR (d.final = 'update' AND (d.geom_changed OR d.fp_changed))
UNION ALL SELECT s.geom FROM imp_diff_edge d JOIN imp_out_edge s ON s.eid = d.sid WHERE d.final = 'insert' OR (d.final = 'update' AND d.geom_changed)
UNION ALL SELECT c.geom FROM imp_diff_edge d JOIN cur_edge c ON c.id = d.cur_id WHERE d.final = 'delete' OR (d.final = 'update' AND d.geom_changed);
CREATE INDEX ON imp_chg_geom USING gist (g);

-- gardu terdampak: ≤ 0,6 m dari perubahan (aturan sama dengan qgis_expand_gardu_layout)
DROP TABLE IF EXISTS imp_xg;
CREATE TABLE imp_xg AS
SELECT DISTINCT x.id, x.fp FROM imp_xg_all x JOIN imp_chg_geom c ON c.g && ST_Expand(x.fp, 0.00001)
WHERE ST_DWithin(ST_Transform(x.fp, 32748), ST_Transform(c.g, 32748), 0.6);

-- simpul yang dipindah perbesaran gardu terdampak (gardu diperbesar terdekat) & saluran yang melintasi / menempel
DROP TABLE IF EXISTS imp_rs_node;
CREATE TABLE imp_rs_node AS
SELECT b.id, b.geom, b.footprint FROM public.gis_layout_backup b
JOIN LATERAL (SELECT x.id FROM imp_xg_all x WHERE b.geom && ST_Expand(x.fp, 0.00001)
              ORDER BY ST_Distance(ST_Transform(x.fp, 32748), ST_Transform(b.geom, 32748)) LIMIT 1) g ON true
WHERE b.kind = 'node' AND b.tag = current_setting('imp.tag') AND g.id IN (SELECT id FROM imp_xg);
DROP TABLE IF EXISTS imp_rs_edge;
CREATE TABLE imp_rs_edge AS
SELECT DISTINCT ON (b.id) b.id, b.geom, b.length_m FROM public.gis_layout_backup b JOIN public.gis_edges e ON e.id = b.id
WHERE b.kind = 'edge' AND b.tag = current_setting('imp.tag')
  AND (e.from_node_id IN (SELECT id FROM imp_rs_node) OR e.to_node_id IN (SELECT id FROM imp_rs_node)
       OR EXISTS (SELECT 1 FROM imp_xg x WHERE b.geom && ST_Expand(x.fp, 0.00001) AND ST_DWithin(ST_Transform(x.fp, 32748), ST_Transform(b.geom, 32748), 0.05)))
ORDER BY b.id, b.created_at;

-- saluran yang dikembalikan juga melintasi denah gardu diperbesar lain → gardu itu ikut dikembalikan (satu putaran)
INSERT INTO imp_xg
SELECT DISTINCT x.id, x.fp FROM imp_xg_all x JOIN imp_rs_edge r ON r.geom && ST_Expand(x.fp, 0.00001)
WHERE x.id NOT IN (SELECT id FROM imp_xg) AND ST_DWithin(ST_Transform(x.fp, 32748), ST_Transform(r.geom, 32748), 0.05);
INSERT INTO imp_rs_node
SELECT b.id, b.geom, b.footprint FROM public.gis_layout_backup b
JOIN LATERAL (SELECT x.id FROM imp_xg_all x WHERE b.geom && ST_Expand(x.fp, 0.00001)
              ORDER BY ST_Distance(ST_Transform(x.fp, 32748), ST_Transform(b.geom, 32748)) LIMIT 1) g ON true
WHERE b.kind = 'node' AND b.tag = current_setting('imp.tag') AND g.id IN (SELECT id FROM imp_xg) AND b.id NOT IN (SELECT id FROM imp_rs_node);
INSERT INTO imp_rs_edge
SELECT DISTINCT ON (b.id) b.id, b.geom, b.length_m FROM public.gis_layout_backup b JOIN public.gis_edges e ON e.id = b.id
WHERE b.kind = 'edge' AND b.tag = current_setting('imp.tag') AND b.id NOT IN (SELECT id FROM imp_rs_edge)
  AND (e.from_node_id IN (SELECT id FROM imp_rs_node) OR e.to_node_id IN (SELECT id FROM imp_rs_node)
       OR EXISTS (SELECT 1 FROM imp_xg x WHERE b.geom && ST_Expand(x.fp, 0.00001) AND ST_DWithin(ST_Transform(x.fp, 32748), ST_Transform(b.geom, 32748), 0.05)))
ORDER BY b.id, b.created_at;

UPDATE public.gis_nodes n SET geom = r.geom, footprint = r.footprint FROM imp_rs_node r WHERE n.id = r.id;
UPDATE public.gis_nodes n SET properties = n.properties - 'denah_skala' WHERE n.id IN (SELECT id FROM imp_xg);
UPDATE public.gis_edges e SET geom = r.geom, length_m = r.length_m FROM imp_rs_edge r WHERE e.id = r.id;
DELETE FROM public.gis_layout_backup b
WHERE (b.kind = 'node' AND b.id IN (SELECT id FROM imp_rs_node)) OR (b.kind = 'edge' AND b.id IN (SELECT id FROM imp_rs_edge));

-- ---------------------------------------------------------------- 3. hapus
INSERT INTO public.feature_history (kind, feature_id, action, username, data)
SELECT 'edge', d.cur_id, 'delete', 'gdb-import', jsonb_build_object('import', current_setting('imp.tag'), 'key', d.key, 'reason', d.reason)
FROM imp_diff_edge d WHERE d.final = 'delete'
UNION ALL
SELECT 'node', d.cur_id, 'delete', 'gdb-import', jsonb_build_object('import', current_setting('imp.tag'), 'key', d.key, 'reason', d.reason)
FROM imp_diff_node d WHERE d.final = 'delete';
DELETE FROM public.gis_edges WHERE id IN (SELECT cur_id FROM imp_diff_edge WHERE final = 'delete');
DELETE FROM public.gis_nodes WHERE id IN (SELECT cur_id FROM imp_diff_node WHERE final = 'delete');
DELETE FROM public.gis_layout_backup b
WHERE (b.kind = 'edge' AND b.id IN (SELECT cur_id FROM imp_diff_edge WHERE final = 'delete'))
   OR (b.kind = 'node' AND b.id IN (SELECT cur_id FROM imp_diff_node WHERE final = 'delete'));

-- ---------------------------------------------------------------- 4. simpul: ubah & tambah
UPDATE public.gis_nodes n SET type_code = s.type_code, code = s.code, name = s.name,
  geom = CASE WHEN d.geom_changed THEN s.geom ELSE n.geom END,
  footprint = CASE WHEN d.fp_changed THEN s.footprint ELSE n.footprint END,
  properties = (n.properties - qgis_gdb_prop_keys()) || s.props,
  updated_at = now()
FROM imp_diff_node d JOIN imp_out_node s ON s.sid = d.sid
WHERE d.final = 'update' AND n.id = d.cur_id;

INSERT INTO public.gis_nodes (id, type_code, code, name, geom, footprint, status, properties)
SELECT m.id, s.type_code, s.code, s.name, s.geom, s.footprint, s.status, s.props
FROM imp_map m JOIN imp_out_node s ON s.sid = m.sid WHERE m.final = 'insert';

-- ---------------------------------------------------------------- 5. saluran: ubah & tambah
UPDATE public.gis_edges e SET type_code = s.type_code, code = s.code, name = s.name,
  geom = CASE WHEN d.geom_changed THEN s.geom ELSE e.geom END,
  length_m = CASE WHEN d.geom_changed THEN s.length_m ELSE e.length_m END,
  from_node_id = ma.id, to_node_id = mb.id,
  properties = (e.properties - qgis_gdb_prop_keys()) || s.props,
  updated_at = now()
FROM imp_diff_edge d JOIN imp_out_edge s ON s.eid = d.sid JOIN imp_map ma ON ma.sid = s.a JOIN imp_map mb ON mb.sid = s.b
WHERE d.final = 'update' AND e.id = d.cur_id;

INSERT INTO public.gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT m.id, s.type_code, s.code, s.name, s.geom, ma.id, mb.id, s.length_m, s.status, s.props
FROM imp_emap m JOIN imp_out_edge s ON s.eid = m.sid JOIN imp_map ma ON ma.sid = s.a JOIN imp_map mb ON mb.sid = s.b
WHERE m.final = 'insert';

-- riwayat perubahan (batch baru tanpa objek lama tidak dicatat per objek)
INSERT INTO public.feature_history (kind, feature_id, action, username, data)
SELECT 'node', m.id, CASE m.final WHEN 'insert' THEN 'create' ELSE 'update' END, 'gdb-import',
  jsonb_strip_nulls(jsonb_build_object('import', current_setting('imp.tag'), 'key', m.key, 'changes', d.changes))
FROM imp_map m JOIN imp_diff_node d ON d.sid = m.sid
WHERE m.final = 'update' OR (m.final = 'insert' AND EXISTS (SELECT 1 FROM cur_node))
UNION ALL
SELECT 'edge', m.id, CASE m.final WHEN 'insert' THEN 'create' ELSE 'update' END, 'gdb-import',
  jsonb_strip_nulls(jsonb_build_object('import', current_setting('imp.tag'), 'key', m.key, 'changes', d.changes))
FROM imp_emap m JOIN imp_diff_edge d ON d.sid = m.sid
WHERE m.final = 'update' OR (m.final = 'insert' AND EXISTS (SELECT 1 FROM cur_edge));

-- ---------------------------------------------------------------- 6. kunci → id & baseline
-- baseline = isi GDB terakhir yang diputuskan; '' = tidak ada lagi di GDB tetapi dipertahankan; objek yang penghapusannya
-- belum diterapkan memakai sidik saat ini sehingga diusulkan lagi pada impor berikutnya
DELETE FROM public.gdb_import_objects o USING imp_diff_node d
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'node' AND o.key = d.key AND d.final = 'delete';
DELETE FROM public.gdb_import_objects o USING imp_diff_edge d
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'edge' AND o.key = d.key AND d.final = 'delete';

INSERT INTO public.gdb_import_objects (tag, kind, key, obj_id, hash)
SELECT current_setting('imp.tag'), 'node', d.key, coalesce(m.id, d.cur_id),
  CASE WHEN d.sid IS NOT NULL THEN d.s_hash WHEN d.action = 'delete' OR d.reason = 'used_by_local' THEN d.c_hash ELSE '' END
FROM imp_diff_node d LEFT JOIN imp_map m ON m.sid = d.sid
WHERE d.final <> 'delete' AND coalesce(m.id, d.cur_id) IS NOT NULL
ON CONFLICT (tag, kind, key) DO UPDATE SET obj_id = EXCLUDED.obj_id, hash = EXCLUDED.hash, updated_at = now();
INSERT INTO public.gdb_import_objects (tag, kind, key, obj_id, hash)
SELECT current_setting('imp.tag'), 'edge', d.key, coalesce(m.id, d.cur_id),
  CASE WHEN d.sid IS NOT NULL THEN d.s_hash WHEN d.action = 'delete' THEN d.c_hash ELSE '' END
FROM imp_diff_edge d LEFT JOIN imp_emap m ON m.sid = d.sid
WHERE d.final NOT IN ('delete', 'skip') AND coalesce(m.id, d.cur_id) IS NOT NULL
ON CONFLICT (tag, kind, key) DO UPDATE SET obj_id = EXCLUDED.obj_id, hash = EXCLUDED.hash, updated_at = now();

-- dihapus lokal & dipertahankan terhapus: baseline mengikuti GDB terbaru
UPDATE public.gdb_import_objects o SET hash = d.s_hash, updated_at = now() FROM imp_diff_node d
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'node' AND o.key = d.key AND d.deleted_local AND d.final = 'keep';
UPDATE public.gdb_import_objects o SET hash = d.s_hash, updated_at = now() FROM imp_diff_edge d
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'edge' AND o.key = d.key AND d.deleted_local AND d.final IN ('keep', 'skip');

-- catatan basi: objeknya sudah tidak ada dan kuncinya tidak ada lagi di GDB
DELETE FROM public.gdb_import_objects o
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'node'
  AND NOT EXISTS (SELECT 1 FROM public.gis_nodes n WHERE n.id = o.obj_id) AND NOT EXISTS (SELECT 1 FROM imp_out_node s WHERE s.key = o.key);
DELETE FROM public.gdb_import_objects o
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'edge'
  AND NOT EXISTS (SELECT 1 FROM public.gis_edges e WHERE e.id = o.obj_id) AND NOT EXISTS (SELECT 1 FROM imp_out_edge s WHERE s.key = o.key);

-- ---------------------------------------------------------------- 7. denah gardu miniatur diperbesar (gardu baru & yang dikembalikan)
DROP TABLE IF EXISTS imp_layout;
CREATE TABLE imp_layout AS
SELECT (SELECT count(*) FROM imp_xg) restored, x.gardu, x.nodes, x.edges FROM public.qgis_expand_gardu_layout(current_setting('imp.tag')) x;
