-- Menu Pusat Operasi dihapus: FLISR, rencana manuver, laporan gangguan & AI operasi
-- kini menjadi grup tab "Operasi" di menu Peta Jaringan Listrik (/monitoring).

-- peran yang punya menu Pusat Operasi tetap bisa membuka Peta Jaringan Listrik
INSERT INTO role_menus (role_id, menu_id)
SELECT rm.role_id, m.id FROM role_menus rm
JOIN menus m ON m.path = '/monitoring'
WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000014'
ON CONFLICT DO NOTHING;

DELETE FROM role_menus WHERE menu_id = 'a0000000-0000-0000-0000-000000000014';
DELETE FROM menus WHERE id = 'a0000000-0000-0000-0000-000000000014';
