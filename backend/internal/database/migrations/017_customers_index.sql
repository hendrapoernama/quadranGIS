-- =====================================================================
-- 017: indeks daftar pelanggan nyala / padam (tab Pelanggan di Monitoring
--      Kelistrikan): urut padam dulu, lalu kode, dengan paging cepat.
-- =====================================================================
CREATE INDEX IF NOT EXISTS gis_nodes_energized_code_idx ON gis_nodes (energized, code, id);
