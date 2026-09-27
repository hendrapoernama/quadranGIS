-- Menu Peta Jaringan Listrik (/monitoring) kini berisi monitoring & operasi: diganti nama menjadi Pusat Operasi.
UPDATE menus SET title = 'Pusat Operasi', title_en = 'Operations Center', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000009';
