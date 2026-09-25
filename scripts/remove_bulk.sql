-- Menghapus seluruh data simulasi massal (properti "bulk": true) yang dibuat scripts/seed_bulk.sql.
\set ON_ERROR_STOP on
\timing on
SET synchronous_commit = off;
DELETE FROM gis_edges WHERE properties @> '{"bulk": true}'::jsonb;
DELETE FROM gis_nodes WHERE properties @> '{"bulk": true}'::jsonb;
VACUUM ANALYZE gis_edges;
VACUUM ANALYZE gis_nodes;
REFRESH MATERIALIZED VIEW gis_nodes_density;
SELECT 'nodes' AS tabel, count(*) FROM gis_nodes UNION ALL SELECT 'edges', count(*) FROM gis_edges;
