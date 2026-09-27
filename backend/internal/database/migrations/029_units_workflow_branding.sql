-- Master data unit organisasi & kepemilikan aset, alur persetujuan editing jaringan (paket perubahan:
-- draf → diajukan → disetujui → dirilis), identitas operator di SOE, dan identitas (branding) aplikasi.

-- ============================================================ master data unit
-- jenjang: PUSAT → REGION → UID / UP2B → UP3 / UP2D → ULP
CREATE TABLE IF NOT EXISTS org_units (
    id             serial PRIMARY KEY,
    code           text NOT NULL UNIQUE,
    name           text NOT NULL,
    kind           text NOT NULL CHECK (kind IN ('PUSAT','REGION','UID','UP2B','UP3','UP2D','ULP')),
    parent_id      int REFERENCES org_units(id) ON DELETE RESTRICT,
    address        text NOT NULL DEFAULT '',
    lng            double precision,
    lat            double precision,
    phone          text NOT NULL DEFAULT '',
    email          text NOT NULL DEFAULT '',
    boundary_name  text NOT NULL DEFAULT '',   -- poligon batas wilayah (gis_boundaries) yang menjadi wilayah kerja
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS org_units_parent_idx ON org_units (parent_id);

-- kepemilikan / pengelola aset
ALTER TABLE gis_nodes ADD COLUMN IF NOT EXISTS unit_id int;
ALTER TABLE gis_edges ADD COLUMN IF NOT EXISTS unit_id int;
CREATE INDEX IF NOT EXISTS gis_nodes_unit_idx ON gis_nodes (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gis_edges_unit_idx ON gis_edges (unit_id) WHERE unit_id IS NOT NULL;
ALTER TABLE scada_points ADD COLUMN IF NOT EXISTS unit_id int;

-- isi awal dari batas wilayah yang ada (dapat diubah di menu Master Data → Unit)
INSERT INTO org_units (code, name, kind) VALUES ('PUSAT', 'Kantor Pusat', 'PUSAT') ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id)
SELECT 'REG-JMB', 'Regional Jawa, Madura & Bali', 'REGION', id FROM org_units WHERE code = 'PUSAT' ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id)
SELECT 'UP2B-JKB', 'UP2B DKI Jakarta & Banten', 'UP2B', id FROM org_units WHERE code = 'REG-JMB' ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id)
SELECT DISTINCT 'UID-' || upper(regexp_replace(COALESCE(NULLIF(b.properties->>'uid', ''), 'JAKARTA RAYA'), '[^A-Za-z0-9]+', '-', 'g')),
       'UID ' || COALESCE(NULLIF(b.properties->>'uid', ''), 'JAKARTA RAYA'), 'UID', r.id
  FROM gis_boundaries b, org_units r WHERE b.level = 'up3' AND r.code = 'REG-JMB'
ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id)
SELECT 'UID-JAKARTA-RAYA', 'UID JAKARTA RAYA', 'UID', id FROM org_units WHERE code = 'REG-JMB' ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id)
SELECT 'UP2D-JAKARTA-RAYA', 'UP2D JAKARTA RAYA', 'UP2D', id FROM org_units WHERE code = 'UID-JAKARTA-RAYA' ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id, boundary_name, lng, lat)
SELECT 'UP3-' || upper(regexp_replace(b.name, '[^A-Za-z0-9]+', '-', 'g')), 'UP3 ' || b.name, 'UP3', u.id, b.name,
       ST_X(ST_PointOnSurface(b.geom)), ST_Y(ST_PointOnSurface(b.geom))
  FROM gis_boundaries b
  JOIN org_units u ON u.code = 'UID-' || upper(regexp_replace(COALESCE(NULLIF(b.properties->>'uid', ''), 'JAKARTA RAYA'), '[^A-Za-z0-9]+', '-', 'g'))
 WHERE b.level = 'up3'
ON CONFLICT (code) DO NOTHING;
INSERT INTO org_units (code, name, kind, parent_id, boundary_name, lng, lat)
SELECT 'ULP-' || upper(regexp_replace(b.name, '[^A-Za-z0-9]+', '-', 'g')), 'ULP ' || b.name, 'ULP', u.id, b.name,
       ST_X(ST_PointOnSurface(b.geom)), ST_Y(ST_PointOnSurface(b.geom))
  FROM gis_boundaries b
  JOIN org_units u ON u.code = 'UP3-' || upper(regexp_replace(b.parent, '[^A-Za-z0-9]+', '-', 'g'))
 WHERE b.level = 'ulp'
ON CONFLICT (code) DO NOTHING;

-- ============================================================ paket perubahan (alur persetujuan editing)
-- Perubahan editor disimpan sebagai operasi tertunda; jaringan aktif baru berubah saat paket DIRILIS
-- (operasi diputar ulang berurutan lewat editor bertopologi).
CREATE TABLE IF NOT EXISTS gis_changesets (
    id               bigserial PRIMARY KEY,
    title            text NOT NULL,
    description      text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','released','rejected','cancelled')),
    source           text NOT NULL DEFAULT 'editor',   -- editor | import
    unit_id          int,
    created_by       uuid,
    created_by_name  text NOT NULL DEFAULT '',
    submitted_at     timestamptz,
    submitted_by     text NOT NULL DEFAULT '',
    reviewed_at      timestamptz,
    reviewed_by      text NOT NULL DEFAULT '',
    review_note      text NOT NULL DEFAULT '',
    released_at      timestamptz,
    released_by      text NOT NULL DEFAULT '',
    release_note     text NOT NULL DEFAULT '',
    applied          int NOT NULL DEFAULT 0,
    failed           int NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_changesets_status_idx ON gis_changesets (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS gis_change_items (
    id                 bigserial PRIMARY KEY,
    changeset_id       bigint NOT NULL REFERENCES gis_changesets(id) ON DELETE CASCADE,
    seq                int NOT NULL,
    op                 text NOT NULL CHECK (op IN ('create','update','delete','split','merge')),
    kind               text NOT NULL CHECK (kind IN ('node','edge')),
    target_id          bigint,                      -- objek aktif yang diubah (kosong untuk create)
    type_code          text NOT NULL DEFAULT '',
    code               text NOT NULL DEFAULT '',
    name               text NOT NULL DEFAULT '',
    body               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- masukan editor (FeatureInput / titik pisah)
    before             jsonb,                       -- salinan objek saat diusulkan (audit & pratinjau)
    target_updated_at  timestamptz,                 -- deteksi konflik saat rilis
    status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed')),
    result_id          bigint,
    error              text NOT NULL DEFAULT '',
    created_by_name    text NOT NULL DEFAULT '',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_change_items_cs_idx ON gis_change_items (changeset_id, seq);
CREATE INDEX IF NOT EXISTS gis_change_items_target_idx ON gis_change_items (kind, target_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS gis_changeset_log (
    id            bigserial PRIMARY KEY,
    changeset_id  bigint NOT NULL REFERENCES gis_changesets(id) ON DELETE CASCADE,
    action        text NOT NULL,     -- create | submit | approve | reject | release | cancel | reopen | item
    username      text NOT NULL DEFAULT '',
    full_name     text NOT NULL DEFAULT '',
    role          text NOT NULL DEFAULT '',
    note          text NOT NULL DEFAULT '',
    at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_changeset_log_cs_idx ON gis_changeset_log (changeset_id, at);

-- ============================================================ SOE & manuver: identitas operator
ALTER TABLE soe_events ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE soe_events ADD COLUMN IF NOT EXISTS full_name text NOT NULL DEFAULT '';
ALTER TABLE soe_events ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT '';
ALTER TABLE soe_events ADD COLUMN IF NOT EXISTS client_ip text NOT NULL DEFAULT '';
ALTER TABLE soe_events ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT '';   -- web | mobile | sld | api | sistem
ALTER TABLE maneuvers ADD COLUMN IF NOT EXISTS full_name text NOT NULL DEFAULT '';
ALTER TABLE maneuvers ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT '';
ALTER TABLE maneuvers ADD COLUMN IF NOT EXISTS client_ip text NOT NULL DEFAULT '';
ALTER TABLE maneuvers ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT '';
-- isi nama lengkap operator pada riwayat yang sudah ada
UPDATE soe_events s SET user_id = u.id, full_name = u.full_name, role = COALESCE(r.name, '')
  FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE s.username = u.username AND s.full_name = '';
UPDATE maneuvers m SET full_name = u.full_name, role = COALESCE(r.name, '')
  FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE m.username = u.username AND m.full_name = '';

-- ============================================================ konfigurasi
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('app.description',          'GIS Kelistrikan', 'string', 'general', 'Deskripsi / subjudul aplikasi (sidebar, halaman masuk, laporan)'),
 ('app.logo',                 '',       'string', 'branding', 'Logo aplikasi (data URL gambar; diubah lewat bagian Identitas Aplikasi)'),
 ('app.logo_version',         '0',      'int',    'branding', 'Versi logo (naik tiap logo diganti, untuk cache peramban)'),
 ('gis.approval_enabled',     'true',   'bool',   'topology', 'Editing jaringan lewat persetujuan: draf → diajukan → disetujui → dirilis'),
 ('gis.approval_allow_self',  'false',  'bool',   'topology', 'Penyusun paket perubahan boleh menyetujui paketnya sendiri'),
 ('unit.auto_max_km',         '25',     'float',  'general',  'Jarak maksimum ke wilayah ULP/UP3 terdekat saat kepemilikan aset ditetapkan otomatis (km)'),
 ('unit.default_code',        'UID-JAKARTA-RAYA', 'string', 'general', 'Unit bawaan untuk aset di luar semua wilayah kerja')
ON CONFLICT (key) DO NOTHING;
UPDATE app_configs SET "group" = 'branding' WHERE key IN ('app.name', 'app.description');

-- ============================================================ izin & role
UPDATE roles SET permissions = (
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(permissions) AS p
      UNION ALL SELECT unnest(CASE name
        WHEN 'admin' THEN ARRAY['gis.approve','gis.release','master.view','master.manage']
        ELSE ARRAY['master.view'] END)
    ) x)
 WHERE name IN ('admin','editor','operator','viewer','operator_tr');

INSERT INTO roles (name, description, permissions, is_system) VALUES
 ('supervisor', 'Supervisor: memeriksa & menyetujui paket perubahan jaringan',
  '["gis.view","gis.trace","gis.approve","exec.view","load.view","master.view","ai.use"]'::jsonb, false),
 ('manajer', 'Manajer: menyetujui & merilis paket perubahan ke jaringan aktif',
  '["gis.view","gis.trace","gis.approve","gis.release","exec.view","exec.report","load.view","master.view","master.manage","ai.use"]'::jsonb, false)
ON CONFLICT DO NOTHING;

-- ============================================================ menu
INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000019', NULL, 'Master Data', 'Master Data', '', 'database', 85),
 ('a0000000-0000-0000-0000-000000000020', 'a0000000-0000-0000-0000-000000000019', 'Unit', 'Units', '/master/units', 'globe', 10),
 ('a0000000-0000-0000-0000-000000000021', NULL, 'Persetujuan Perubahan', 'Change Approval', '/changes', 'check', 12)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, m.id FROM roles r, (VALUES ('a0000000-0000-0000-0000-000000000019'::uuid), ('a0000000-0000-0000-0000-000000000020'::uuid)) m(id)
 WHERE r.name IN ('admin','editor','operator','viewer','supervisor','manajer')
ON CONFLICT DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000021' FROM roles r WHERE r.name IN ('admin','editor','supervisor','manajer')
ON CONFLICT DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, m.id FROM roles r, menus m WHERE r.name IN ('supervisor','manajer') AND m.path IN ('/map','/executive','/load','/docs')
ON CONFLICT DO NOTHING;
