-- Impor Esri File Geodatabase (ZIP) dari menu Administrasi › Impor GDB.
-- Setiap objek hasil impor memiliki properties.import = tag batch; indeks parsial agar daftar /
-- penghapusan per batch tidak memindai seluruh tabel.

CREATE INDEX IF NOT EXISTS gis_nodes_import_idx ON gis_nodes ((properties->>'import')) WHERE properties ? 'import';
CREATE INDEX IF NOT EXISTS gis_edges_import_idx ON gis_edges ((properties->>'import')) WHERE properties ? 'import';

-- riwayat job impor
CREATE TABLE IF NOT EXISTS gdb_imports (
  id          bigserial PRIMARY KEY,
  tag         text NOT NULL,
  file_name   text NOT NULL DEFAULT '',
  file_bytes  bigint NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'running',   -- running | done | failed | replaced | deleted
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text NOT NULL DEFAULT '',
  created_by  text NOT NULL DEFAULT '',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS gdb_imports_tag_idx ON gdb_imports (tag, started_at DESC);

-- batch yang sudah ada sebelum menu ini dibuat (impor lewat skrip)
INSERT INTO gdb_imports (tag, file_name, status, created_by, started_at, finished_at)
SELECT t, '(skrip)', 'done', 'system', now(), now()
FROM (SELECT DISTINCT properties->>'import' t FROM gis_nodes WHERE properties ? 'import') x
WHERE t IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gdb_imports g WHERE g.tag = x.t);

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000026', 'a0000000-0000-0000-0000-000000000002', 'Impor GDB', 'GDB Import', '/admin/gdb-import', 'database', 55)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, 'a0000000-0000-0000-0000-000000000026'::uuid FROM role_menus rm
 WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000006'
ON CONFLICT DO NOTHING;
