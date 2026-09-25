-- =====================================================================
-- 008: atribut "Kode SSOT" (kode unik objek pada sistem sumber kebenaran)
--      di urutan pertama skema atribut SSOT setiap tipe komponen.
--      Disimpan di properties->>'kode_ssot'; unik lintas node & edge;
--      dapat dicari dari kotak pencarian peta.
-- =====================================================================
UPDATE component_types
   SET attributes = '[{"key":"kode_ssot","label":"Kode SSOT","label_en":"SSOT code","type":"text","required":false}]'::jsonb
                    || COALESCE(attributes, '[]'::jsonb)
 WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(attributes, '[]'::jsonb)) a WHERE a->>'key' = 'kode_ssot');

-- index parsial: hanya objek yang punya kode SSOT (ringan walau tabel berisi jutaan baris)
CREATE INDEX IF NOT EXISTS gis_nodes_ssot_idx      ON gis_nodes ((properties->>'kode_ssot')) WHERE properties ? 'kode_ssot';
CREATE INDEX IF NOT EXISTS gis_edges_ssot_idx      ON gis_edges ((properties->>'kode_ssot')) WHERE properties ? 'kode_ssot';
CREATE INDEX IF NOT EXISTS gis_nodes_ssot_trgm_idx ON gis_nodes USING gin ((properties->>'kode_ssot') gin_trgm_ops) WHERE properties ? 'kode_ssot';
CREATE INDEX IF NOT EXISTS gis_edges_ssot_trgm_idx ON gis_edges USING gin ((properties->>'kode_ssot') gin_trgm_ops) WHERE properties ? 'kode_ssot';
