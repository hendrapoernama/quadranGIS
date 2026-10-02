-- Dashboard › Infografis: infografis pemulihan kelistrikan (kejadian padam, pemulihan per level, pelanggan prioritas,
-- keandalan per UP3). Menu tampil bagi peran yang dapat membuka Dashboard › Keandalan & Operasi.

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000028', 'a0000000-0000-0000-0000-000000000024', 'Infografis', 'Infographic', '/infographic', 'monitor', 20)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, 'a0000000-0000-0000-0000-000000000028'::uuid FROM role_menus rm
 WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000015'
ON CONFLICT DO NOTHING;

-- Atribut SSOT "prioritas" pada pelanggan (VVIP / VIP / KTT / Prioritas) untuk kartu Prioritas Pelanggan.
-- Pelanggan TT (pelanggan_tt) dihitung sebagai KTT walau atribut kosong.
UPDATE component_types SET attributes = attributes || '[{"key": "prioritas", "type": "select", "label": "Prioritas", "label_en": "Priority", "options": ["VVIP", "VIP", "KTT", "Prioritas"]}]'::jsonb
 WHERE code IN ('pelanggan_tr', 'pelanggan_tm', 'pelanggan_tt', 'pelanggan_bulk')
   AND jsonb_typeof(attributes) = 'array'
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(attributes) a WHERE a->>'key' = 'prioritas');
