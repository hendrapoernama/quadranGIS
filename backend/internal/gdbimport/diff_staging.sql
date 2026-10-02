-- =====================================================================================
-- Tahap 2 impor GDB: bandingkan jaringan hasil pemetaan (imp_out_node / imp_out_edge, build_staging.sql) dengan
-- objek batch yang sudah ada. Dijalankan dalam satu transaksi (dibungkus gdbimport.go); tidak mengubah jaringan.
-- Variabel psql: src (skema staging), tag, since (waktu penerapan terakhir, untuk batch tanpa baseline).
--
-- Pencocokan per kunci identitas (gdb_import_objects; batch impor lama: dihitung ulang dengan aturan build_staging.sql).
-- Perbandingan tiga arah dengan sidik isi milik GDB: S = GDB baru, B = baseline (GDB saat terakhir diterapkan),
-- C = kondisi QuadranGIS sekarang (geometri asli sebelum denah gardu diperbesar).
--   insert   : ada di GDB, belum ada di QuadranGIS
--   update   : berubah di GDB, tidak diubah lokal
--   delete   : tidak ada lagi di GDB, tidak diubah lokal
--   same     : sama
--   local    : diubah / dihapus lokal, GDB tidak berubah (dipertahankan)
--   conflict : both_changed (diubah lokal & di GDB) | deleted_local (dihapus lokal, berubah di GDB)
--              | changed_local (diubah lokal, dihapus di GDB) | used_by_local (dipakai saluran lain)
-- Batch tanpa baseline: objek dianggap diubah lokal bila diedit lewat editor setelah impor terakhir (feature_history).
-- =====================================================================================
SELECT set_config('search_path', :'src' || ', public', true);
SELECT set_config('imp.tag', :'tag', true);

-- ---------------------------------------------------------------- 1. objek batch saat ini
-- geometri & denah asli (sebelum denah gardu diperbesar) dari gis_layout_backup; kunci terhitung & sidik isi
DROP TABLE IF EXISTS cur_node;
CREATE TABLE cur_node AS
SELECT x.*, qgis_gdb_node_key(x.code, x.props, x.geom) ckey, qgis_gdb_hash(x.type_code, x.code, x.name, x.geom, x.footprint, x.props) hash
FROM (SELECT n.id, n.type_code, n.code, n.name, n.properties props, n.geom live,
        coalesce(bk.geom, n.geom) geom, CASE WHEN bk.geom IS NULL THEN n.footprint ELSE bk.footprint END footprint
      FROM public.gis_nodes n
      LEFT JOIN LATERAL (SELECT b.geom, b.footprint FROM public.gis_layout_backup b WHERE b.kind = 'node' AND b.id = n.id ORDER BY b.created_at LIMIT 1) bk ON true
      WHERE n.properties ? 'import' AND n.properties->>'import' = current_setting('imp.tag')) x;
CREATE UNIQUE INDEX ON cur_node (id);

DROP TABLE IF EXISTS cur_edge;
CREATE TABLE cur_edge AS
SELECT x.*, qgis_gdb_hash(x.type_code, x.code, x.name, x.geom, NULL, x.props) hash
FROM (SELECT e.id, e.type_code, e.code, e.name, e.properties props, e.from_node_id a, e.to_node_id b, e.geom live, coalesce(bk.geom, e.geom) geom
      FROM public.gis_edges e
      LEFT JOIN LATERAL (SELECT b.geom FROM public.gis_layout_backup b WHERE b.kind = 'edge' AND b.id = e.id ORDER BY b.created_at LIMIT 1) bk ON true
      WHERE e.properties ? 'import' AND e.properties->>'import' = current_setting('imp.tag')) x;
CREATE UNIQUE INDEX ON cur_edge (id);

-- ---------------------------------------------------------------- 2. kunci & baseline
ALTER TABLE cur_node ADD COLUMN key text, ADD COLUMN base text, ADD COLUMN edited boolean NOT NULL DEFAULT false;
UPDATE cur_node c SET key = o.key, base = o.hash FROM public.gdb_import_objects o
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'node' AND o.obj_id = c.id;
UPDATE cur_node SET key = ckey WHERE key IS NULL;
-- objek tanpa catatan: kunci ganda diurutkan seperti build_staging.sql; bentrok dengan kunci tercatat → ~id (tidak cocok)
UPDATE cur_node n SET key = d.key || '@' || d.rn
FROM (SELECT id, key, row_number() OVER (PARTITION BY key ORDER BY qgis_gdb_geomtext(geom), type_code, code, name, qgis_gdb_props(props)::text, id) rn,
             count(*) OVER (PARTITION BY key) c
      FROM cur_node WHERE base IS NULL) d
WHERE n.id = d.id AND d.c > 1;
UPDATE cur_node n SET key = n.key || '~' || n.id
WHERE n.base IS NULL AND EXISTS (SELECT 1 FROM cur_node m WHERE m.key = n.key AND m.base IS NOT NULL);
UPDATE cur_node c SET edited = true
WHERE c.base IS NULL AND EXISTS (SELECT 1 FROM public.feature_history h
  WHERE h.kind = 'node' AND h.feature_id = c.id AND h.time > :'since'::timestamptz AND h.username <> 'gdb-import');
CREATE UNIQUE INDEX ON cur_node (key);

ALTER TABLE cur_edge ADD COLUMN key text, ADD COLUMN base text, ADD COLUMN edited boolean NOT NULL DEFAULT false;
UPDATE cur_edge c SET key = o.key, base = o.hash FROM public.gdb_import_objects o
WHERE o.tag = current_setting('imp.tag') AND o.kind = 'edge' AND o.obj_id = c.id;
UPDATE cur_edge c SET key = qgis_gdb_edge_key(c.type_code, c.props,
    coalesce((SELECT n.key FROM cur_node n WHERE n.id = c.a), 'n:' || c.a), coalesce((SELECT n.key FROM cur_node n WHERE n.id = c.b), 'n:' || c.b))
WHERE c.key IS NULL;
UPDATE cur_edge e SET key = d.key || '#' || d.rn
FROM (SELECT id, key, row_number() OVER (PARTITION BY key ORDER BY qgis_gdb_geomtext(geom), type_code, code, name, qgis_gdb_props(props)::text, id) rn,
             count(*) OVER (PARTITION BY key) c
      FROM cur_edge WHERE base IS NULL) d
WHERE e.id = d.id AND d.c > 1;
UPDATE cur_edge n SET key = n.key || '~' || n.id
WHERE n.base IS NULL AND EXISTS (SELECT 1 FROM cur_edge m WHERE m.key = n.key AND m.base IS NOT NULL);
UPDATE cur_edge c SET edited = true
WHERE c.base IS NULL AND EXISTS (SELECT 1 FROM public.feature_history h
  WHERE h.kind = 'edge' AND h.feature_id = c.id AND h.time > :'since'::timestamptz AND h.username <> 'gdb-import');
CREATE UNIQUE INDEX ON cur_edge (key);

-- ---------------------------------------------------------------- 3. pencocokan & klasifikasi
DROP TABLE IF EXISTS imp_diff_node;
CREATE TABLE imp_diff_node AS
SELECT coalesce(s.key, c.key) key, s.sid, c.id cur_id, s.hash s_hash, c.hash c_hash, coalesce(c.base, o.hash) base,
  (c.id IS NULL AND o.key IS NOT NULL) deleted_local,
  CASE WHEN c.id IS NULL THEN false WHEN c.base IS NOT NULL THEN c.hash <> c.base ELSE c.edited END local_mod,
  coalesce(s.type_code, c.type_code) type_code, c.type_code old_type, coalesce(s.code, c.code) code, coalesce(s.name, c.name) name,
  ST_X(coalesce(s.geom, c.live)) lng, ST_Y(coalesce(s.geom, c.live)) lat,
  ''::text action, ''::text reason, false geom_changed, false fp_changed, NULL::jsonb changes, 0 refs
FROM imp_out_node s
FULL JOIN cur_node c ON c.key = s.key
LEFT JOIN public.gdb_import_objects o ON c.id IS NULL AND o.tag = current_setting('imp.tag') AND o.kind = 'node' AND o.key = s.key;

DROP TABLE IF EXISTS imp_diff_edge;
CREATE TABLE imp_diff_edge AS
SELECT coalesce(s.key, c.key) key, s.eid sid, c.id cur_id, s.hash s_hash, c.hash c_hash, coalesce(c.base, o.hash) base,
  (c.id IS NULL AND o.key IS NOT NULL) deleted_local,
  CASE WHEN c.id IS NULL THEN false WHEN c.base IS NOT NULL THEN c.hash <> c.base ELSE c.edited END local_mod,
  coalesce(s.type_code, c.type_code) type_code, c.type_code old_type, coalesce(s.code, c.code) code, coalesce(s.name, c.name) name,
  ST_X(ST_LineInterpolatePoint(coalesce(s.geom, c.live), 0.5)) lng, ST_Y(ST_LineInterpolatePoint(coalesce(s.geom, c.live), 0.5)) lat,
  coalesce(s.length_m, 0) length_m,
  ''::text action, ''::text reason, false geom_changed, false fp_changed, NULL::jsonb changes, 0 refs
FROM imp_out_edge s
FULL JOIN cur_edge c ON c.key = s.key
LEFT JOIN public.gdb_import_objects o ON c.id IS NULL AND o.tag = current_setting('imp.tag') AND o.kind = 'edge' AND o.key = s.key;

UPDATE imp_diff_node SET
  action = CASE
    WHEN sid IS NOT NULL AND cur_id IS NOT NULL THEN
      CASE WHEN s_hash = c_hash THEN 'same' WHEN NOT local_mod THEN 'update' WHEN base = s_hash THEN 'local' ELSE 'conflict' END
    WHEN sid IS NOT NULL THEN CASE WHEN NOT deleted_local THEN 'insert' WHEN base = s_hash THEN 'local' ELSE 'conflict' END
    ELSE CASE WHEN base = '' THEN 'local' WHEN local_mod THEN 'conflict' ELSE 'delete' END END,
  reason = CASE
    WHEN sid IS NOT NULL AND cur_id IS NOT NULL AND s_hash <> c_hash AND local_mod THEN CASE WHEN base = s_hash THEN 'edited' ELSE 'both_changed' END
    WHEN sid IS NOT NULL AND deleted_local THEN CASE WHEN base = s_hash THEN 'deleted' ELSE 'deleted_local' END
    WHEN sid IS NULL AND base = '' THEN 'kept'
    WHEN sid IS NULL AND local_mod THEN 'changed_local'
    ELSE '' END;

UPDATE imp_diff_edge SET
  action = CASE
    WHEN sid IS NOT NULL AND cur_id IS NOT NULL THEN
      CASE WHEN s_hash = c_hash THEN 'same' WHEN NOT local_mod THEN 'update' WHEN base = s_hash THEN 'local' ELSE 'conflict' END
    WHEN sid IS NOT NULL THEN CASE WHEN NOT deleted_local THEN 'insert' WHEN base = s_hash THEN 'local' ELSE 'conflict' END
    ELSE CASE WHEN base = '' THEN 'local' WHEN local_mod THEN 'conflict' ELSE 'delete' END END,
  reason = CASE
    WHEN sid IS NOT NULL AND cur_id IS NOT NULL AND s_hash <> c_hash AND local_mod THEN CASE WHEN base = s_hash THEN 'edited' ELSE 'both_changed' END
    WHEN sid IS NOT NULL AND deleted_local THEN CASE WHEN base = s_hash THEN 'deleted' ELSE 'deleted_local' END
    WHEN sid IS NULL AND base = '' THEN 'kept'
    WHEN sid IS NULL AND local_mod THEN 'changed_local'
    ELSE '' END;

-- simpul yang akan dihapus tetapi masih dipakai saluran yang tidak ikut dihapus (mis. saluran digambar manual)
UPDATE imp_diff_node d SET action = 'conflict', reason = 'used_by_local'
WHERE d.action = 'delete' AND EXISTS (
  SELECT 1 FROM public.gis_edges e WHERE (e.from_node_id = d.cur_id OR e.to_node_id = d.cur_id)
    AND NOT EXISTS (SELECT 1 FROM imp_diff_edge x WHERE x.cur_id = e.id AND x.action = 'delete'));

-- ---------------------------------------------------------------- 4. rincian perubahan (S ≠ C)
CREATE INDEX ON imp_diff_node (cur_id);
CREATE INDEX ON imp_diff_edge (cur_id);
-- move_m: jarak geser (simpul) / jarak Hausdorff (saluran) dalam meter; props: atribut GDB [lama, baru]
WITH x AS MATERIALIZED (
  SELECT d.cur_id, s.type_code st, c.type_code ct, s.code sc, c.code cc, s.name sn, c.name cn, s.geom sg, c.geom cg,
    qgis_gdb_geomtext(s.geom) sgt, qgis_gdb_geomtext(c.geom) cgt, qgis_gdb_geomtext(s.footprint) sft, qgis_gdb_geomtext(c.footprint) cft,
    qgis_gdb_props(s.props) sp, qgis_gdb_props(c.props) cp
  FROM imp_diff_node d JOIN imp_out_node s ON s.sid = d.sid JOIN cur_node c ON c.id = d.cur_id
  WHERE d.s_hash <> d.c_hash)
UPDATE imp_diff_node d SET
  geom_changed = x.sgt <> x.cgt,
  fp_changed = x.sft <> x.cft,
  changes = jsonb_strip_nulls(jsonb_build_object(
    'type', CASE WHEN x.st <> x.ct THEN jsonb_build_array(x.ct, x.st) END,
    'code', CASE WHEN x.sc <> x.cc THEN jsonb_build_array(x.cc, x.sc) END,
    'name', CASE WHEN x.sn <> x.cn THEN jsonb_build_array(x.cn, x.sn) END,
    'move_m', CASE WHEN x.sgt <> x.cgt THEN round(ST_Distance(ST_Transform(x.sg, 32748), ST_Transform(x.cg, 32748))::numeric, 2) END,
    'footprint', CASE WHEN x.sft <> x.cft THEN true END,
    'props', (SELECT jsonb_object_agg(k, jsonb_build_array(x.cp->k, x.sp->k))
              FROM jsonb_object_keys(x.cp || x.sp) k WHERE (x.cp->k) IS DISTINCT FROM (x.sp->k))))
FROM x WHERE d.cur_id = x.cur_id;

WITH x AS MATERIALIZED (
  SELECT d.cur_id, s.type_code st, c.type_code ct, s.code sc, c.code cc, s.name sn, c.name cn, s.geom sg, c.geom cg,
    qgis_gdb_geomtext(s.geom) sgt, qgis_gdb_geomtext(c.geom) cgt, qgis_gdb_props(s.props) sp, qgis_gdb_props(c.props) cp
  FROM imp_diff_edge d JOIN imp_out_edge s ON s.eid = d.sid JOIN cur_edge c ON c.id = d.cur_id
  WHERE d.s_hash <> d.c_hash)
UPDATE imp_diff_edge d SET
  geom_changed = x.sgt <> x.cgt,
  changes = jsonb_strip_nulls(jsonb_build_object(
    'type', CASE WHEN x.st <> x.ct THEN jsonb_build_array(x.ct, x.st) END,
    'code', CASE WHEN x.sc <> x.cc THEN jsonb_build_array(x.cc, x.sc) END,
    'name', CASE WHEN x.sn <> x.cn THEN jsonb_build_array(x.cn, x.sn) END,
    'move_m', CASE WHEN x.sgt <> x.cgt THEN round(ST_HausdorffDistance(ST_Transform(x.sg, 32748), ST_Transform(x.cg, 32748))::numeric, 2) END,
    'props', (SELECT jsonb_object_agg(k, jsonb_build_array(x.cp->k, x.sp->k))
              FROM jsonb_object_keys(x.cp || x.sp) k WHERE (x.cp->k) IS DISTINCT FROM (x.sp->k))))
FROM x WHERE d.cur_id = x.cur_id;

CREATE INDEX ON imp_diff_node (action, type_code);
CREATE INDEX ON imp_diff_edge (action, type_code);
CREATE INDEX ON imp_diff_node (sid);
CREATE INDEX ON imp_diff_edge (sid);

-- ---------------------------------------------------------------- 5. rujukan objek yang akan / mungkin dihapus
DROP TABLE IF EXISTS imp_refs;
CREATE TABLE imp_refs AS
WITH ids AS (SELECT cur_id id FROM imp_diff_node WHERE action IN ('delete', 'conflict') AND cur_id IS NOT NULL)
SELECT 'maneuvers' src, m.node_id id FROM public.maneuvers m JOIN ids ON ids.id = m.node_id
UNION ALL SELECT 'outages', o.cause_node_id FROM public.outages o JOIN ids ON ids.id = o.cause_node_id
UNION ALL SELECT 'photos', p.target_id FROM public.asset_photos p JOIN ids ON ids.id = p.target_id AND p.target_kind = 'node'
UNION ALL SELECT 'scada_points', sp.node_id FROM public.scada_points sp JOIN ids ON ids.id = sp.node_id
UNION ALL SELECT 'plan_steps', st.target_id FROM public.switching_plan_steps st JOIN ids ON ids.id = st.target_id AND st.target_kind = 'node'
UNION ALL SELECT 'customer_kwh', k.node_id FROM public.customer_kwh k JOIN ids ON ids.id = k.node_id;
UPDATE imp_diff_node d SET refs = r.n FROM (SELECT id, count(*)::int n FROM imp_refs GROUP BY id) r WHERE d.cur_id = r.id;

-- ---------------------------------------------------------------- 6. GlobalID yang sudah dipakai batch lain (tumpang tindih)
DROP TABLE IF EXISTS imp_overlap;
CREATE TABLE imp_overlap AS
SELECT coalesce(n.properties->>'import', '') tag, count(*) n
FROM imp_out_node s JOIN public.gis_nodes n ON n.properties ? 'gdb_globalid' AND n.properties->>'gdb_globalid' = s.props->>'gdb_globalid'
WHERE s.props ? 'gdb_globalid' AND coalesce(n.properties->>'import', '') <> current_setting('imp.tag')
GROUP BY 1;
