-- Menu Master Data › Data Aset: hirarki aset GI → trafo GI → penyulang → gardu → trafo → jurusan → pelanggan
-- (tampilan tree & tabel). Tampil bagi peran yang dapat membuka menu Master Data › Unit.

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000023', 'a0000000-0000-0000-0000-000000000019', 'Data Aset', 'Asset Data', '/master/assets', 'list', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, 'a0000000-0000-0000-0000-000000000023'::uuid FROM role_menus rm
 WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000020'
ON CONFLICT DO NOTHING;
