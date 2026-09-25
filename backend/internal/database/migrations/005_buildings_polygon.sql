-- =====================================================================
-- 005: Gardu Induk, Gardu Hubung, Gardu Distribusi sebagai bangunan (poligon).
--      Node titik tetap dipakai sebagai titik sambung topologi; footprint
--      poligon disimpan pada kolom baru gis_nodes.footprint.
-- =====================================================================
ALTER TABLE component_types DROP CONSTRAINT IF EXISTS component_types_geom_kind_check;
ALTER TABLE component_types ADD CONSTRAINT component_types_geom_kind_check CHECK (geom_kind IN ('point','line','polygon'));
ALTER TABLE component_types ADD COLUMN IF NOT EXISTS footprint_size_m double precision NOT NULL DEFAULT 0;

UPDATE component_types SET geom_kind = 'polygon', icon = 'square', footprint_size_m = 80 WHERE code = 'gi';
UPDATE component_types SET geom_kind = 'polygon', icon = 'square', footprint_size_m = 18 WHERE code = 'gh';
UPDATE component_types SET geom_kind = 'polygon', icon = 'square', footprint_size_m = 8  WHERE code = 'gd';

ALTER TABLE gis_nodes ADD COLUMN IF NOT EXISTS footprint geometry(Polygon, 4326);
CREATE INDEX IF NOT EXISTS gis_nodes_footprint_idx ON gis_nodes USING GIST (footprint) WHERE footprint IS NOT NULL;

-- footprint persegi bawaan untuk bangunan yang sudah ada (simulasi & contoh)
UPDATE gis_nodes n
   SET footprint = ST_MakeEnvelope(
        ST_X(n.geom) - (t.footprint_size_m / 2.0) / (111320.0 * cos(radians(ST_Y(n.geom)))),
        ST_Y(n.geom) - (t.footprint_size_m / 2.0) / 110574.0,
        ST_X(n.geom) + (t.footprint_size_m / 2.0) / (111320.0 * cos(radians(ST_Y(n.geom)))),
        ST_Y(n.geom) + (t.footprint_size_m / 2.0) / 110574.0, 4326)
  FROM component_types t
 WHERE t.code = n.type_code AND t.geom_kind = 'polygon' AND n.footprint IS NULL;
