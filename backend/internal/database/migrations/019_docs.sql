-- =====================================================================
-- 019: menu Dokumentasi (overview, fitur, arsitektur, proses bisnis,
--      instalasi & konfigurasi, buku panduan) untuk semua role.
-- =====================================================================
INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000013', NULL, 'Dokumentasi', 'Documentation', '/docs', 'book', 80)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000013' FROM roles r
ON CONFLICT DO NOTHING;
