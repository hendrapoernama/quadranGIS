-- Pewarnaan peta per penyulang.
--   * feeder_id: keanggotaan penyulang menurut posisi normal switch (id kepala penyulang / kubikel
--     outgoing; NULL = di luar penyulang). Diisi backend dari graf setelah pengelompokan (hanya yang berubah).
--   * *_feeder_live: penyulang penyuplai saat ini yang BERBEDA dari keanggotaan normal (bagian yang
--     dilimpahkan lewat manuver). Biasanya kosong; feeder_id 0 = bertegangan tanpa penyulang.
--   * feeder_colors: indeks warna palet per penyulang (penyulang bertetangga dibedakan, stabil).

ALTER TABLE gis_nodes ADD COLUMN IF NOT EXISTS feeder_id bigint;
ALTER TABLE gis_edges ADD COLUMN IF NOT EXISTS feeder_id bigint;
CREATE INDEX IF NOT EXISTS gis_edges_feeder_idx ON gis_edges (feeder_id) WHERE feeder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gis_node_feeder_live (
  id        bigint PRIMARY KEY,
  feeder_id bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS gis_edge_feeder_live (
  id        bigint PRIMARY KEY,
  feeder_id bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS gis_edge_feeder_live_feeder_idx ON gis_edge_feeder_live (feeder_id);

CREATE TABLE IF NOT EXISTS feeder_colors (
  head_id    bigint PRIMARY KEY,
  color      smallint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
