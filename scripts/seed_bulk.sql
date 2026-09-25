-- =====================================================================
-- Simulasi massal jaringan kelistrikan (uji beban) - topologi konsisten
--   100 power grid, 100 GI, 200 trafo GI, 1.000 kubikel PMT outgoing,
--   200.000 segmen SKTM, 50.000 gardu distribusi, 500.000 segmen JTR,
--   1.000.000 tarikan SR (x2 segmen deret), 2.000.000 pelanggan TR.
-- Wilayah: Jawa Barat - Jawa Tengah (grid 20 x 5 GI, jarak antar GI ~20 km).
-- Jalankan: make seed-bulk   (psql -v ON_ERROR_STOP=1 -f scripts/seed_bulk.sql)
-- Perkiraan waktu 5-15 menit. Hapus dengan scripts/remove_bulk.sql.
-- Parameter dapat diubah di bawah (jtr_per_gd harus genap).
-- =====================================================================
\set ON_ERROR_STOP on
\timing on
\set n_gi 100
\set feeders_per_gi 10
\set gd_per_feeder 50
\set sktm_seg_per_span 4
\set jtr_per_gd 10
\set sr_per_pole 2
\set cust_per_sr 2

SET synchronous_commit = off;
SET work_mem = '256MB';
SET maintenance_work_mem = '768MB';
SET jit = off;
SELECT setseed(0.2026);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM gis_nodes WHERE code = 'GI-BULK-0001') THEN
    RAISE EXCEPTION 'Data simulasi massal sudah ada (GI-BULK-0001). Jalankan scripts/remove_bulk.sql terlebih dahulu.';
  END IF;
END $$;

-- ---------------------------------------------------------------- offset id
CREATE TEMP TABLE sim_off AS
SELECT n0, e0, nf, ngd, npole, nsr,
  n0                                                   AS o_pg,
  n0 + :n_gi                                           AS o_gi,
  n0 + 2*:n_gi                                         AS o_trf,
  n0 + 4*:n_gi                                         AS o_bb,
  n0 + 6*:n_gi                                         AS o_kbk,
  n0 + 6*:n_gi + nf                                    AS o_sj,
  n0 + 6*:n_gi + nf + ngd*(:sktm_seg_per_span-1)       AS o_gd,
  n0 + 6*:n_gi + nf + ngd*(:sktm_seg_per_span-1) + ngd AS o_pole,
  n0 + 6*:n_gi + nf + ngd*(:sktm_seg_per_span-1) + ngd + npole        AS o_ca,
  n0 + 6*:n_gi + nf + ngd*(:sktm_seg_per_span-1) + ngd + npole + nsr  AS o_cb,
  e0                                                   AS e_pg,
  e0 + :n_gi                                           AS e_trf,
  e0 + 5*:n_gi                                         AS e_bb,
  e0 + 5*:n_gi + (:feeders_per_gi+1)*:n_gi             AS e_sktm,
  e0 + 5*:n_gi + (:feeders_per_gi+1)*:n_gi + ngd*:sktm_seg_per_span          AS e_jtr,
  e0 + 5*:n_gi + (:feeders_per_gi+1)*:n_gi + ngd*:sktm_seg_per_span + npole  AS e_sra,
  e0 + 5*:n_gi + (:feeders_per_gi+1)*:n_gi + ngd*:sktm_seg_per_span + npole + nsr AS e_srb
FROM (
  SELECT (SELECT COALESCE(max(id),0)+1 FROM gis_nodes)::bigint AS n0,
         (SELECT COALESCE(max(id),0)+1 FROM gis_edges)::bigint AS e0,
         (:n_gi*:feeders_per_gi)::bigint AS nf,
         (:n_gi*:feeders_per_gi*:gd_per_feeder)::bigint AS ngd,
         (:n_gi*:feeders_per_gi*:gd_per_feeder*:jtr_per_gd)::bigint AS npole,
         (:n_gi*:feeders_per_gi*:gd_per_feeder*:jtr_per_gd*:sr_per_pole)::bigint AS nsr
) b;

-- ---------------------------------------------------------------- lepas index agar insert cepat
DROP INDEX IF EXISTS gis_nodes_geom_idx, gis_nodes_type_idx, gis_nodes_code_idx, gis_nodes_name_idx, gis_nodes_footprint_idx,
  gis_nodes_code_trgm_idx, gis_nodes_name_trgm_idx;
DROP INDEX IF EXISTS gis_edges_geom_idx, gis_edges_type_idx, gis_edges_from_idx, gis_edges_to_idx, gis_edges_code_idx,
  gis_edges_code_trgm_idx, gis_edges_name_trgm_idx;

-- ---------------------------------------------------------------- GI (grid 20 kolom, jitter)
CREATE TEMP TABLE sim_gi AS
SELECT i,
  106.25 + ((i-1) % 20) * 0.2 + (random()-0.5)*0.08 AS lng,
  -7.25 + ((i-1) / 20) * 0.18 + (random()-0.5)*0.06 AS lat,
  radians(random()*360) AS pg_ang
FROM generate_series(1, :n_gi) i;

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT o.o_pg + (g.i-1), 'power_grid', 'PG-BULK-'||lpad(g.i::text,4,'0'), 'Power Grid 150 kV #'||g.i,
  ST_SetSRID(ST_MakePoint(g.lng + 6000*sin(g.pg_ang)/(111320*cos(radians(g.lat))), g.lat + 6000*cos(g.pg_ang)/110574),4326),
  'closed', '{"tegangan_kv":150,"bulk":true}'
FROM sim_gi g, sim_off o;

INSERT INTO gis_nodes (id, type_code, code, name, geom, footprint, status, properties)
SELECT o.o_gi + (g.i-1), 'gi', 'GI-BULK-'||lpad(g.i::text,4,'0'), 'GI Simulasi #'||g.i,
  ST_SetSRID(ST_MakePoint(g.lng, g.lat),4326),
  ST_MakeEnvelope(g.lng - 40/(111320*cos(radians(g.lat))), g.lat - 40/110574.0, g.lng + 40/(111320*cos(radians(g.lat))), g.lat + 40/110574.0, 4326),
  'closed', jsonb_build_object('kapasitas_mva',120,'jumlah_trafo',2,'bulk',true)
FROM sim_gi g, sim_off o;

-- trafo GI (2), junction busbar (2), kubikel outgoing (feeders_per_gi)
INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT o.o_trf + 2*(g.i-1) + t, 'trafo_gi', 'TRF-BULK-'||lpad(g.i::text,4,'0')||'-'||(t+1), 'Trafo GI #'||g.i||' unit '||(t+1)||' 60 MVA',
  ST_SetSRID(ST_MakePoint(g.lng + (CASE WHEN t=0 THEN -40 ELSE 40 END)/(111320*cos(radians(g.lat))), g.lat + 25/110574.0),4326),
  'closed', '{"daya_mva":60,"ratio":"150/20 kV","bulk":true}'
FROM sim_gi g, sim_off o, generate_series(0,1) t;

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT o.o_bb + 2*(g.i-1) + s, 'junction', '', '',
  ST_SetSRID(ST_MakePoint(g.lng + (CASE WHEN s=0 THEN -45 ELSE 45 END)/(111320*cos(radians(g.lat))), g.lat - 6/110574.0),4326),
  'closed', '{"bulk":true}'
FROM sim_gi g, sim_off o, generate_series(0,1) s;

CREATE TEMP TABLE sim_feeder AS
SELECT g.i AS gi, f, (g.i-1)*:feeders_per_gi + (f-1) AS fidx,
  radians((f-1)*360.0/:feeders_per_gi + (random()-0.5)*20) AS ang0,
  g.lng AS glng, g.lat AS glat,
  g.lng + (-36 + 8*(f-1))/(111320*cos(radians(g.lat))) AS klng,
  g.lat - 6/110574.0 AS klat,
  o.o_kbk + (g.i-1)*:feeders_per_gi + (f-1) AS kid,
  CASE WHEN f % 2 = 0 THEN 'skutr' ELSE 'sktr' END AS lv_type
FROM sim_gi g, sim_off o, generate_series(1, :feeders_per_gi) f;

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT fe.kid, 'kubikel_20kv', 'KBK-B'||lpad(fe.fidx::text,5,'0'), 'Kubikel PMT Outgoing B'||fe.fidx,
  ST_SetSRID(ST_MakePoint(fe.klng, fe.klat),4326), 'closed',
  jsonb_build_object('fungsi','outgoing','penyulang','B'||fe.fidx,'bulk',true)
FROM sim_feeder fe;

-- edges di dalam GI: PG->GI, GI->trafo, trafo->busbar, busbar bbA->k1..kF->bbB
INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_pg + (g.i-1), 'sktm', 'TRX-BULK-'||lpad(g.i::text,4,'0'), 'Transmisi 150 kV ke GI #'||g.i,
  l.g, o.o_pg + (g.i-1), o.o_gi + (g.i-1), ST_Length(l.g::geography), 'closed', '{"tegangan_kv":150,"bulk":true}'
FROM sim_gi g, sim_off o,
LATERAL (SELECT ST_MakeLine(a.geom, b.geom) AS g FROM gis_nodes a, gis_nodes b WHERE a.id = o.o_pg + (g.i-1) AND b.id = o.o_gi + (g.i-1)) l;

INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_trf + 4*(g.i-1) + t, 'sktm', 'INT-B'||lpad(g.i::text,4,'0')||'-TRF'||(t+1), 'GI - Trafo '||(t+1),
  l.g, o.o_gi + (g.i-1), o.o_trf + 2*(g.i-1) + t, ST_Length(l.g::geography), 'closed', '{"tegangan_kv":150,"bulk":true}'
FROM sim_gi g, sim_off o, generate_series(0,1) t,
LATERAL (SELECT ST_MakeLine(a.geom, b.geom) AS g FROM gis_nodes a, gis_nodes b WHERE a.id = o.o_gi + (g.i-1) AND b.id = o.o_trf + 2*(g.i-1) + t) l;

INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_trf + 4*(g.i-1) + 2 + t, 'sktm', 'INT-B'||lpad(g.i::text,4,'0')||'-BB'||(t+1), 'Trafo '||(t+1)||' - Busbar',
  l.g, o.o_trf + 2*(g.i-1) + t, o.o_bb + 2*(g.i-1) + t, ST_Length(l.g::geography), 'closed', '{"tegangan_kv":20,"bulk":true}'
FROM sim_gi g, sim_off o, generate_series(0,1) t,
LATERAL (SELECT ST_MakeLine(a.geom, b.geom) AS g FROM gis_nodes a, gis_nodes b WHERE a.id = o.o_trf + 2*(g.i-1) + t AND b.id = o.o_bb + 2*(g.i-1) + t) l;

-- busbar: urutan node per GI = bbA, k1..kF, bbB
CREATE TEMP TABLE sim_bb AS
SELECT gi, pos, node_id FROM (
  SELECT g.i AS gi, 0 AS pos, o.o_bb + 2*(g.i-1) AS node_id FROM sim_gi g, sim_off o
  UNION ALL SELECT fe.gi, fe.f, fe.kid FROM sim_feeder fe
  UNION ALL SELECT g.i, :feeders_per_gi + 1, o.o_bb + 2*(g.i-1) + 1 FROM sim_gi g, sim_off o
) s;
INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_bb + (:feeders_per_gi+1)*(a.gi-1) + a.pos, 'busbar', 'BB-B'||lpad(a.gi::text,4,'0')||'-'||(a.pos+1), 'Busbar 20 kV GI #'||a.gi,
  l.g, a.node_id, b.node_id, ST_Length(l.g::geography), 'closed', '{"tegangan_kv":20,"bulk":true}'
FROM sim_bb a JOIN sim_bb b ON b.gi = a.gi AND b.pos = a.pos + 1, sim_off o,
LATERAL (SELECT ST_MakeLine(x.geom, y.geom) AS g FROM gis_nodes x, gis_nodes y WHERE x.id = a.node_id AND y.id = b.node_id) l;

-- ---------------------------------------------------------------- gardu distribusi sepanjang trunk penyulang
CREATE TEMP TABLE sim_gd AS
SELECT x.fidx, x.gi, x.f, x.g, x.gdidx, x.lv_type, x.ang,
  x.glng + (sum(x.dx) OVER w) / (111320*cos(radians(x.glat))) AS lng,
  x.glat + (sum(x.dy) OVER w) / 110574 AS lat
FROM (
  SELECT fe.fidx, fe.gi, fe.f, s.g, fe.fidx*:gd_per_feeder + (s.g-1) AS gdidx, fe.lv_type, fe.glng, fe.glat, a.ang,
    d.dist*sin(a.ang) AS dx, d.dist*cos(a.ang) AS dy
  FROM sim_feeder fe
  CROSS JOIN generate_series(1, :gd_per_feeder) s(g)
  CROSS JOIN LATERAL (SELECT fe.ang0 + (random()-0.5)*0.4 AS ang) a
  CROSS JOIN LATERAL (SELECT (CASE WHEN s.g = 1 THEN 700 ELSE 300 END) + random()*100 AS dist) d
) x
WINDOW w AS (PARTITION BY x.fidx ORDER BY x.g ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW);

CREATE TEMP TABLE sim_gd2 AS
SELECT gd.*, o.o_gd + gd.gdidx AS node_id,
  COALESCE(LAG(gd.lng) OVER w, fe.klng) AS plng,
  COALESCE(LAG(gd.lat) OVER w, fe.klat) AS plat,
  COALESCE(LAG(o.o_gd + gd.gdidx) OVER w, fe.kid) AS prev_node_id
FROM sim_gd gd JOIN sim_feeder fe USING (fidx), sim_off o
WINDOW w AS (PARTITION BY gd.fidx ORDER BY gd.g);
CREATE INDEX ON sim_gd2 (gdidx);

INSERT INTO gis_nodes (id, type_code, code, name, geom, footprint, status, properties)
SELECT g2.node_id, 'gd', 'GD-B'||lpad(g2.fidx::text,5,'0')||'-'||lpad(g2.g::text,3,'0'), 'GD B'||g2.fidx||'/'||g2.g,
  ST_SetSRID(ST_MakePoint(g2.lng, g2.lat),4326),
  ST_MakeEnvelope(g2.lng - 4/(111320*cos(radians(g2.lat))), g2.lat - 4/110574.0, g2.lng + 4/(111320*cos(radians(g2.lat))), g2.lat + 4/110574.0, 4326),
  'closed', jsonb_build_object('penyulang','B'||g2.fidx,'daya_kva',(ARRAY[160,200,250,315,400])[1 + (g2.gdidx % 5)],'bulk',true)
FROM sim_gd2 g2;

-- junction SKTM di antara gardu (seg-1 per bentang)
CREATE TEMP TABLE sim_sj AS
SELECT g2.gdidx, g2.fidx, g2.g, q, o.o_sj + g2.gdidx*(:sktm_seg_per_span-1) + (q-1) AS node_id,
  g2.plng + (g2.lng-g2.plng)*q/(:sktm_seg_per_span)::float + (random()-0.5)*30/(111320*cos(radians(g2.lat))) AS lng,
  g2.plat + (g2.lat-g2.plat)*q/(:sktm_seg_per_span)::float + (random()-0.5)*30/110574 AS lat
FROM sim_gd2 g2 CROSS JOIN generate_series(1, :sktm_seg_per_span-1) q, sim_off o;

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT node_id, 'junction', '', '', ST_SetSRID(ST_MakePoint(lng, lat),4326), 'closed', '{"bulk":true}' FROM sim_sj;

CREATE TEMP TABLE sim_sktm_pts AS
SELECT gdidx, fidx, g, 0 AS pos, prev_node_id AS node_id, plng AS lng, plat AS lat FROM sim_gd2
UNION ALL SELECT gdidx, fidx, g, q, node_id, lng, lat FROM sim_sj
UNION ALL SELECT gdidx, fidx, g, :sktm_seg_per_span, node_id, lng, lat FROM sim_gd2;
CREATE INDEX ON sim_sktm_pts (gdidx, pos);

INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_sktm + a.gdidx*:sktm_seg_per_span + a.pos, 'sktm',
  'SKTM-B'||lpad(a.fidx::text,5,'0')||'-'||lpad(a.g::text,3,'0')||'-'||(a.pos+1), 'SKTM penyulang B'||a.fidx,
  l.g, a.node_id, b.node_id, ST_Length(l.g::geography), 'closed',
  jsonb_build_object('penyulang','B'||a.fidx,'penghantar','XLPE 3x240 mm2','bulk',true)
FROM sim_sktm_pts a JOIN sim_sktm_pts b ON b.gdidx = a.gdidx AND b.pos = a.pos + 1, sim_off o,
LATERAL (SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(a.lng,a.lat),4326), ST_SetSRID(ST_MakePoint(b.lng,b.lat),4326)) AS g) l;

-- ---------------------------------------------------------------- JTR: tiang (junction) & segmen
CREATE TEMP TABLE sim_pole AS
SELECT g2.gdidx, g2.fidx, g2.g, j, p, g2.lv_type,
  g2.gdidx*:jtr_per_gd + (j-1)*(:jtr_per_gd/2) + (p-1) AS poleidx,
  o.o_pole + g2.gdidx*:jtr_per_gd + (j-1)*(:jtr_per_gd/2) + (p-1) AS node_id,
  g2.node_id AS gd_node_id, g2.lng AS gd_lng, g2.lat AS gd_lat,
  g2.lng + (55*p*d.jx + (random()-0.5)*8)/(111320*cos(radians(g2.lat))) AS lng,
  g2.lat + (55*p*d.jy + (random()-0.5)*8)/110574 AS lat,
  d.jx, d.jy
FROM sim_gd2 g2
CROSS JOIN generate_series(1,2) j
CROSS JOIN generate_series(1, :jtr_per_gd/2) p
CROSS JOIN LATERAL (SELECT CASE WHEN j=1 THEN cos(g2.ang) ELSE -cos(g2.ang) END AS jx, CASE WHEN j=1 THEN -sin(g2.ang) ELSE sin(g2.ang) END AS jy) d,
sim_off o;
CREATE INDEX ON sim_pole (gdidx, j, p);

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT node_id, 'junction', '', '', ST_SetSRID(ST_MakePoint(lng, lat),4326), 'closed', '{"bulk":true}' FROM sim_pole;

INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_jtr + a.poleidx, a.lv_type,
  upper(a.lv_type)||'-B'||lpad(a.fidx::text,5,'0')||'-'||lpad(a.g::text,3,'0')||'-J'||a.j||'-'||a.p, 'JTR jurusan '||a.j,
  l.g, CASE WHEN a.p = 1 THEN a.gd_node_id ELSE a.node_id - 1 END, a.node_id, ST_Length(l.g::geography), 'closed',
  jsonb_build_object('penyulang','B'||a.fidx,'penghantar', CASE WHEN a.lv_type='skutr' THEN 'LVTC 3x70+50 mm2' ELSE 'NYFGbY 4x70 mm2' END,'bulk',true)
FROM (
  SELECT pl.*, COALESCE(LAG(pl.lng) OVER w, pl.gd_lng) AS plng, COALESCE(LAG(pl.lat) OVER w, pl.gd_lat) AS plat
  FROM sim_pole pl WINDOW w AS (PARTITION BY pl.gdidx, pl.j ORDER BY pl.p)
) a, sim_off o,
LATERAL (SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(a.plng,a.plat),4326), ST_SetSRID(ST_MakePoint(a.lng,a.lat),4326)) AS g) l;

-- ---------------------------------------------------------------- SR tarikan & pelanggan
CREATE TEMP TABLE sim_ca AS
SELECT pl.poleidx, pl.node_id AS pole_id, pl.fidx, s,
  pl.poleidx*:sr_per_pole + (s-1) AS sridx,
  o.o_ca + pl.poleidx*:sr_per_pole + (s-1) AS ca_id,
  sd.side, pl.jx, pl.jy, pl.lng AS plng, pl.lat AS plat,
  pl.lng + (sd.side*(20 + 14*((s-1)/2))*(-pl.jy) + (random()-0.5)*10*pl.jx)/(111320*cos(radians(pl.lat))) AS alng,
  pl.lat + (sd.side*(20 + 14*((s-1)/2))*(pl.jx) + (random()-0.5)*10*pl.jy)/110574 AS alat
FROM sim_pole pl CROSS JOIN generate_series(1, :sr_per_pole) s
CROSS JOIN LATERAL (SELECT CASE WHEN s % 2 = 1 THEN 1 ELSE -1 END AS side) sd, sim_off o;

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT ca_id, 'pelanggan_tr', 'PLG-B'||lpad(sridx::text,7,'0'), 'Pelanggan B'||sridx,
  ST_SetSRID(ST_MakePoint(alng, alat),4326), 'closed',
  jsonb_build_object('daya_va',(ARRAY[450,900,1300,2200,3500])[1 + (sridx % 5)],'tarif',(ARRAY['R1','R1M','R2','B1','S2'])[1 + (sridx % 5)],'bulk',true)
FROM sim_ca;

INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_sra + c.sridx, 'sr', 'SR-B'||lpad(c.sridx::text,7,'0'), 'SR tarikan',
  l.g, c.pole_id, c.ca_id, ST_Length(l.g::geography), 'closed', jsonb_build_object('penyulang','B'||c.fidx,'bulk',true)
FROM sim_ca c, sim_off o,
LATERAL (SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(c.plng,c.plat),4326), ST_SetSRID(ST_MakePoint(c.alng,c.alat),4326)) AS g) l;

-- pelanggan deret (SR lanjutan dari pelanggan sebelumnya)
CREATE TEMP TABLE sim_cb AS
SELECT c.sridx, c.fidx, k,
  o.o_cb + c.sridx*(:cust_per_sr-1) + (k-2) AS cb_id,
  CASE WHEN k = 2 THEN c.ca_id ELSE o.o_cb + c.sridx*(:cust_per_sr-1) + (k-3) END AS prev_id,
  c.alng + (c.side*12*(k-1)*(-c.jy) + (random()-0.5)*4*c.jx)/(111320*cos(radians(c.alat))) AS blng,
  c.alat + (c.side*12*(k-1)*(c.jx) + (random()-0.5)*4*c.jy)/110574 AS blat,
  c.alng + (c.side*12*(k-2)*(-c.jy))/(111320*cos(radians(c.alat))) AS plng,
  c.alat + (c.side*12*(k-2)*(c.jx))/110574 AS plat
FROM sim_ca c CROSS JOIN generate_series(2, :cust_per_sr) k, sim_off o;

INSERT INTO gis_nodes (id, type_code, code, name, geom, status, properties)
SELECT cb_id, 'pelanggan_tr', 'PLG-B'||lpad(sridx::text,7,'0')||'-'||k, 'Pelanggan B'||sridx||' deret '||k,
  ST_SetSRID(ST_MakePoint(blng, blat),4326), 'closed',
  jsonb_build_object('daya_va',(ARRAY[450,900,1300,2200])[1 + (sridx % 4)],'tarif','R1','bulk',true)
FROM sim_cb;

INSERT INTO gis_edges (id, type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties)
SELECT o.e_srb + b.sridx*(:cust_per_sr-1) + (b.k-2), 'sr', 'SR-B'||lpad(b.sridx::text,7,'0')||'-D'||(b.k-1), 'SR deret',
  l.g, b.prev_id, b.cb_id, ST_Length(l.g::geography), 'closed', jsonb_build_object('penyulang','B'||b.fidx,'deret',true,'bulk',true)
FROM sim_cb b, sim_off o,
LATERAL (SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(b.plng,b.plat),4326), ST_SetSRID(ST_MakePoint(b.blng,b.blat),4326)) AS g) l;

-- ---------------------------------------------------------------- selesaikan: sequence, index, statistik
SELECT setval('gis_nodes_id_seq', (SELECT max(id) FROM gis_nodes));
SELECT setval('gis_edges_id_seq', (SELECT max(id) FROM gis_edges));

CREATE INDEX gis_nodes_geom_idx ON gis_nodes USING GIST (geom);
CREATE INDEX gis_nodes_type_idx ON gis_nodes (type_code);
CREATE INDEX gis_nodes_code_idx ON gis_nodes (code);
CREATE INDEX gis_nodes_name_idx ON gis_nodes (lower(name) text_pattern_ops);
CREATE INDEX gis_nodes_footprint_idx ON gis_nodes USING GIST (footprint) WHERE footprint IS NOT NULL;
CREATE INDEX gis_edges_geom_idx ON gis_edges USING GIST (geom);
CREATE INDEX gis_edges_type_idx ON gis_edges (type_code);
CREATE INDEX gis_edges_from_idx ON gis_edges (from_node_id);
CREATE INDEX gis_edges_to_idx   ON gis_edges (to_node_id);
CREATE INDEX gis_edges_code_idx ON gis_edges (code);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX gis_nodes_code_trgm_idx ON gis_nodes USING gin (code gin_trgm_ops);
CREATE INDEX gis_nodes_name_trgm_idx ON gis_nodes USING gin (name gin_trgm_ops);
CREATE INDEX gis_edges_code_trgm_idx ON gis_edges USING gin (code gin_trgm_ops);
CREATE INDEX gis_edges_name_trgm_idx ON gis_edges USING gin (name gin_trgm_ops);
VACUUM ANALYZE gis_nodes;
VACUUM ANALYZE gis_edges;
REFRESH MATERIALIZED VIEW gis_nodes_density;

SELECT 'nodes' AS tabel, type_code, count(*) FROM gis_nodes GROUP BY 2
UNION ALL SELECT 'edges', type_code, count(*) FROM gis_edges GROUP BY 2
ORDER BY 1, 3 DESC;
