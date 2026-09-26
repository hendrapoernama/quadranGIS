-- =====================================================================
-- 018: Single Line Diagram (SLD) otomatis dari GIS: menu, posisi manual
--      elemen diagram, dan konfigurasi.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sld_positions (
    scope      text NOT NULL,            -- mis. feeder:123 | gi:45 | gd:678
    node_id    bigint NOT NULL,
    dx         real NOT NULL DEFAULT 0,  -- geser dari posisi otomatis (satuan px diagram)
    dy         real NOT NULL DEFAULT 0,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, node_id)
);

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('sld.max_elements', '3000', 'int',    'general', 'Batas elemen diagram satu garis setelah penyederhanaan'),
 ('sld.default_level', 'tm',  'string', 'general', 'Tingkat detail bawaan SLD: tm | gd | jurusan | pelanggan')
ON CONFLICT (key) DO NOTHING;

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000012', NULL, 'Single Line Diagram', 'Single Line Diagram', '/sld', 'diagram', 23)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000012' FROM roles r WHERE r.name IN ('admin','editor','viewer','operator','operator_tr')
ON CONFLICT DO NOTHING;
