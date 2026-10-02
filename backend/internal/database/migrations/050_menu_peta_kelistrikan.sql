-- Nama menu: induk "Map Editor" menjadi "Peta Kelistrikan", submenu "Editor Peta Jaringan" menjadi "Peta Jaringan".

UPDATE menus SET title = 'Peta Kelistrikan', title_en = 'Electrical Map', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000022';
UPDATE menus SET title = 'Peta Jaringan', title_en = 'Network Map', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000001';
