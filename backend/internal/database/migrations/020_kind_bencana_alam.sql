-- =====================================================================
-- 020: kategori pemadaman BENCANA ALAM (banjir, gempa, angin kencang, ...)
-- =====================================================================
ALTER TABLE maneuvers DROP CONSTRAINT IF EXISTS maneuvers_kind_check;
ALTER TABLE maneuvers ADD CONSTRAINT maneuvers_kind_check CHECK (kind IN ('GANGGUAN','PEMELIHARAAN','MLS','MANUVER','BENCANA ALAM'));
