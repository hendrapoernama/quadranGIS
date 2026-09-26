-- =====================================================================
-- 016: hapus batas UP3 Cikupa, Teluk Naga, Serpong, dan Cikokol
--      beserta wilayah ULP di bawahnya dari overlay batas wilayah.
-- =====================================================================
DELETE FROM gis_boundaries
 WHERE (level = 'up3' AND name   IN ('CIKUPA', 'TELUK NAGA', 'SERPONG', 'CIKOKOL'))
    OR (level = 'ulp' AND parent IN ('CIKUPA', 'TELUK NAGA', 'SERPONG', 'CIKOKOL'));
