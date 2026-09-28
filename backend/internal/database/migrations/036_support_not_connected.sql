-- Objek pendukung (kategori 'pendukung': tiang TM, tiang TR, dsb.) wajib tidak terhubung ke jaringan
-- listrik: bukan bagian topologi, tidak menjadi ujung saluran, dan objek yang masih tersambung tidak
-- boleh diubah menjadi tipe pendukung. Ditegakkan di basis data agar berlaku untuk semua jalur
-- (editor, impor GeoJSON, rilis paket perubahan, skrip).

UPDATE component_types SET topology = false WHERE category = 'pendukung' AND topology;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'component_types_support_no_topology') THEN
    ALTER TABLE component_types ADD CONSTRAINT component_types_support_no_topology
      CHECK (category <> 'pendukung' OR topology = false);
  END IF;
END $$;

-- saluran tidak boleh berujung di objek non-topologi
CREATE OR REPLACE FUNCTION gis_edges_no_support_endpoint() RETURNS trigger AS $$
DECLARE
  bad record;
BEGIN
  SELECT n.id, n.type_code, t.name INTO bad
  FROM gis_nodes n JOIN component_types t ON t.code = n.type_code
  WHERE n.id IN (NEW.from_node_id, NEW.to_node_id) AND NOT t.topology
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'objek pendukung % #% tidak boleh terhubung ke jaringan listrik', bad.name, bad.id
      USING ERRCODE = 'check_violation', HINT = 'support_connected';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gis_edges_no_support_endpoint ON gis_edges;
CREATE TRIGGER gis_edges_no_support_endpoint
  BEFORE INSERT OR UPDATE OF from_node_id, to_node_id ON gis_edges
  FOR EACH ROW EXECUTE FUNCTION gis_edges_no_support_endpoint();

-- objek yang masih tersambung tidak boleh diubah menjadi tipe non-topologi
CREATE OR REPLACE FUNCTION gis_nodes_support_type_check() RETURNS trigger AS $$
BEGIN
  IF NEW.type_code IS DISTINCT FROM OLD.type_code
     AND EXISTS (SELECT 1 FROM component_types t WHERE t.code = NEW.type_code AND NOT t.topology)
     AND EXISTS (SELECT 1 FROM gis_edges e WHERE e.from_node_id = NEW.id OR e.to_node_id = NEW.id) THEN
    RAISE EXCEPTION 'objek #% masih terhubung ke jaringan sehingga tidak dapat diubah menjadi objek pendukung (%)', NEW.id, NEW.type_code
      USING ERRCODE = 'check_violation', HINT = 'support_connected';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gis_nodes_support_type_check ON gis_nodes;
CREATE TRIGGER gis_nodes_support_type_check
  BEFORE UPDATE OF type_code ON gis_nodes
  FOR EACH ROW EXECUTE FUNCTION gis_nodes_support_type_check();
