-- =====================================================================
-- 006: penyetelan skala besar (jutaan objek)
--   - index trigram untuk pencarian kode/nama (ILIKE '%teks%')
--   - zoom minimum layer yang lebih hemat & kepadatan sampai zoom 10
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS gis_nodes_code_trgm_idx ON gis_nodes USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS gis_nodes_name_trgm_idx ON gis_nodes USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS gis_edges_code_trgm_idx ON gis_edges USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS gis_edges_name_trgm_idx ON gis_edges USING gin (name gin_trgm_ops);

-- bawaan loading yang lebih ringan untuk skala jutaan objek (hanya bila masih nilai lama)
UPDATE component_types SET min_zoom = 11 WHERE code IN ('sktm','sutm') AND min_zoom = 10;
UPDATE component_types SET min_zoom = 12 WHERE code = 'gd' AND min_zoom = 11;
UPDATE component_types SET min_zoom = 13 WHERE code = 'trafo_distribusi' AND min_zoom = 12;
UPDATE component_types SET min_zoom = 14 WHERE code = 'kubikel_20kv' AND min_zoom = 13;
UPDATE component_types SET min_zoom = 14 WHERE code IN ('skutr','sktr') AND min_zoom = 13;
UPDATE app_configs SET value = '11' WHERE key = 'loading.density_max_zoom' AND value = '9';
UPDATE app_configs SET value = '12000' WHERE key = 'loading.max_features_per_tile' AND value = '20000';
