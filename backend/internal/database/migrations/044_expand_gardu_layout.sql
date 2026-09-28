-- Denah gardu skematik dari GDB PLN sering berupa miniatur (median ±1,6 m, mis. 0,5 m dengan komponen berjarak
-- 3–5 cm) sehingga simbol LBS / PMS / FCO / trafo / rak / switch jurusan menumpuk bahkan di zoom maksimum peta (24).
-- qgis_expand_gardu_layout memperbesar denah gardu kecil satu batch impor mengelilingi titik pusatnya (skala =
-- target / ukuran denah, maks. p_max): komponen di dalam denah (dan peralatan gardu ≤ 0,6 m di luarnya), vertex saluran
-- di dalam denah, ujung saluran yang menempel, dan poligon denah. Topologi (from / to) tidak berubah. Posisi asli
-- disimpan di gis_layout_backup; gardu yang sudah diperbesar ditandai properties.denah_skala (tidak diulang).

CREATE TABLE IF NOT EXISTS gis_layout_backup (
  kind       text NOT NULL,             -- node | edge
  id         bigint NOT NULL,
  geom       geometry NOT NULL,
  footprint  geometry,
  length_m   double precision,
  reason     text NOT NULL DEFAULT 'expand_gardu',
  tag        text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_layout_backup_idx ON gis_layout_backup (kind, id);

CREATE OR REPLACE FUNCTION qgis_expand_gardu_layout(p_tag text, p_target double precision DEFAULT 10, p_max double precision DEFAULT 25)
RETURNS TABLE (gardu integer, nodes integer, edges integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_gardu integer; v_nodes integer; v_edges integer;
BEGIN
  DROP TABLE IF EXISTS _xg_gd, _xg_node, _xg_edge;

  -- gardu berdenah kecil pada batch; proyeksi UTM zona gardu (meter). Ukuran target dibatasi 90% jarak ke pusat
  -- denah gardu terdekat agar denah yang diperbesar tidak saling menumpuk.
  CREATE TEMP TABLE _xg_gd AS
  SELECT g.id, g.srid, g.f4, fp, ST_Centroid(fp) c, sz, least(p_max, tg / greatest(sz, 0.01)) k
  FROM (SELECT n.id, n.footprint f4,
               (CASE WHEN ST_Y(ST_Centroid(n.footprint)) < 0 THEN 32700 ELSE 32600 END) + floor((ST_X(ST_Centroid(n.footprint)) + 180) / 6)::int + 1 srid
        FROM gis_nodes n
        WHERE n.type_code IN ('gd', 'gh') AND n.footprint IS NOT NULL AND n.properties ? 'import' AND n.properties->>'import' = p_tag
          AND NOT (n.properties ? 'denah_skala')) g
  CROSS JOIN LATERAL (SELECT ST_Transform(g.f4, g.srid) fp) t
  CROSS JOIN LATERAL (SELECT greatest(ST_XMax(t.fp) - ST_XMin(t.fp), ST_YMax(t.fp) - ST_YMin(t.fp)) sz) s
  CROSS JOIN LATERAL (
    SELECT least(p_target, coalesce(0.9 * (
      SELECT ST_Distance(ST_Transform(ST_Centroid(o.footprint), g.srid), ST_Centroid(t.fp)) FROM gis_nodes o
      WHERE o.footprint IS NOT NULL AND o.type_code IN ('gd', 'gh') AND o.id <> g.id
      ORDER BY o.footprint <-> g.f4 LIMIT 1), p_target)) tg) q
  WHERE q.tg > s.sz * 1.2;
  CREATE INDEX ON _xg_gd USING gist (f4);

  -- node yang dipindah: di dalam denah (≤ 5 cm) atau peralatan gardu ≤ 0,6 m dari denah; satu gardu terdekat per node
  CREATE TEMP TABLE _xg_node AS
  SELECT DISTINCT ON (n.id) n.id, n.geom old, ST_Transform(ST_Scale(ST_Transform(n.geom, d.srid), ST_MakePoint(d.k, d.k), d.c), 4326) new
  FROM _xg_gd d JOIN gis_nodes n ON n.geom && ST_Expand(d.f4, 0.00001)
  CROSS JOIN LATERAL (SELECT ST_Distance(ST_Transform(n.geom, d.srid), d.fp) dist) x
  WHERE x.dist <= 0.05
     OR (x.dist <= 0.6 AND n.type_code IN ('gd', 'gh', 'fco', 'lbs_2way', 'lbs_3way', 'pms_20kv', 'pmt_20kv', 'kubikel_20kv', 'recloser',
                                            'trafo_distribusi', 'rak_tr', 'switch_jurusan_tr'))
  ORDER BY n.id, x.dist;
  CREATE UNIQUE INDEX ON _xg_node (id);

  -- saluran terdampak: melintasi denah atau menempel ke node yang dipindah
  CREATE TEMP TABLE _xg_edge AS
  SELECT DISTINCT e.id FROM (
    SELECT e.id FROM _xg_gd d JOIN gis_edges e ON e.geom && ST_Expand(d.f4, 0.00001)
    UNION ALL SELECT e.id FROM _xg_node m JOIN gis_edges e ON e.from_node_id = m.id
    UNION ALL SELECT e.id FROM _xg_node m JOIN gis_edges e ON e.to_node_id = m.id) e;

  INSERT INTO gis_layout_backup (kind, id, geom, footprint, tag)
  SELECT 'node', n.id, n.geom, n.footprint, p_tag FROM gis_nodes n WHERE n.id IN (SELECT id FROM _xg_node);
  INSERT INTO gis_layout_backup (kind, id, geom, length_m, tag)
  SELECT 'edge', e.id, e.geom, e.length_m, p_tag FROM gis_edges e WHERE e.id IN (SELECT id FROM _xg_edge);

  UPDATE gis_nodes n SET geom = m.new FROM _xg_node m WHERE n.id = m.id;
  UPDATE gis_nodes n SET footprint = ST_Transform(ST_Scale(d.fp, ST_MakePoint(d.k, d.k), d.c), 4326),
         properties = n.properties || jsonb_build_object('denah_skala', round(d.k::numeric, 2))
  FROM _xg_gd d WHERE n.id = d.id;

  -- vertex di dalam denah diskalakan; ujung saluran mengikuti posisi node (baru)
  UPDATE gis_edges e SET geom = y.g, length_m = ST_Length(y.g::geography)
  FROM (
    SELECT l.id, ST_SetPoint(ST_SetPoint(l.line, 0, nf.geom), ST_NPoints(l.line) - 1, nt.geom) g
    FROM (
      SELECT e.id, e.from_node_id, e.to_node_id, ST_MakeLine(array_agg(coalesce(v.p, dp.geom) ORDER BY dp.path)) line
      FROM _xg_edge x JOIN gis_edges e ON e.id = x.id
      CROSS JOIN LATERAL ST_DumpPoints(e.geom) dp
      LEFT JOIN LATERAL (
        SELECT ST_Transform(ST_Scale(ST_Transform(dp.geom, d.srid), ST_MakePoint(d.k, d.k), d.c), 4326) p
        FROM _xg_gd d WHERE dp.geom && ST_Expand(d.f4, 0.000001) AND ST_DWithin(ST_Transform(dp.geom, d.srid), d.fp, 0.05)
        ORDER BY ST_Distance(ST_Transform(dp.geom, d.srid), d.fp) LIMIT 1) v ON true
      GROUP BY e.id, e.from_node_id, e.to_node_id) l
    JOIN gis_nodes nf ON nf.id = l.from_node_id
    JOIN gis_nodes nt ON nt.id = l.to_node_id) y
  WHERE e.id = y.id;

  SELECT count(*) INTO v_gardu FROM _xg_gd;
  SELECT count(*) INTO v_nodes FROM _xg_node;
  SELECT count(*) INTO v_edges FROM _xg_edge;
  DROP TABLE IF EXISTS _xg_gd, _xg_node, _xg_edge;
  RETURN QUERY SELECT v_gardu, v_nodes, v_edges;
END $$;
