-- Menu induk "Map Editor" (Editor Peta Jaringan + Persetujuan Perubahan sebagai submenu)
-- dan nama menu Pembebanan menjadi "Analisa Beban & Energi".

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000022', NULL, 'Map Editor', 'Map Editor', '', 'map', 10)
ON CONFLICT (id) DO NOTHING;

UPDATE menus SET parent_id = 'a0000000-0000-0000-0000-000000000022', sort_order = 10, icon = 'edit', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000001';
UPDATE menus SET parent_id = 'a0000000-0000-0000-0000-000000000022', sort_order = 20, updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000021';

-- menu induk tampil bagi peran yang boleh membuka salah satu submenunya
INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, 'a0000000-0000-0000-0000-000000000022'::uuid FROM role_menus rm
 WHERE rm.menu_id IN ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000021')
ON CONFLICT DO NOTHING;

UPDATE menus SET title = 'Analisa Beban & Energi', title_en = 'Load & Energy Analysis', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000018';
