-- Menu induk "Dashboard": Dasbor Eksekutif menjadi submenu "Keandalan & Operasi" (Reliability and Operations).
-- Titik SCADA dipindah dari tab Analisa Beban & Energi menjadi menu Master Data › Titik SCADA.

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000024', NULL, 'Dashboard', 'Dashboard', '', 'home', 5)
ON CONFLICT (id) DO NOTHING;

UPDATE menus SET parent_id = 'a0000000-0000-0000-0000-000000000024', sort_order = 10, icon = 'chart',
       title = 'Keandalan & Operasi', title_en = 'Reliability and Operations', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000015';

INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, 'a0000000-0000-0000-0000-000000000024'::uuid FROM role_menus rm
 WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000015'
ON CONFLICT DO NOTHING;

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000025', 'a0000000-0000-0000-0000-000000000019', 'Titik SCADA', 'SCADA Points', '/master/scada-points', 'wifi', 20)
ON CONFLICT (id) DO NOTHING;

-- tampil bagi peran yang dapat membuka Analisa Beban & Energi (izin load.view), beserta induk Master Data
INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, m.id FROM role_menus rm
 CROSS JOIN (VALUES ('a0000000-0000-0000-0000-000000000025'::uuid), ('a0000000-0000-0000-0000-000000000019'::uuid)) AS m(id)
 WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000018'
ON CONFLICT DO NOTHING;
