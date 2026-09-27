-- =====================================================================
-- 022: kejadian padam lanjutan: pelanggan yang masih padam setelah pemulihan
--      sebagian (mis. seksi yang diisolasi FLISR) dicatat sebagai kejadian baru
--      yang merujuk kejadian asal. Menambah SAIDI & ENS, tidak menambah SAIFI.
-- =====================================================================
ALTER TABLE outages ADD COLUMN IF NOT EXISTS parent_id bigint;
CREATE INDEX IF NOT EXISTS outages_parent_idx ON outages (parent_id) WHERE parent_id IS NOT NULL;
