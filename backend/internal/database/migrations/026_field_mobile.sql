-- Versi mobile (PWA) & fitur lapangan: foto aset, langganan Web Push, laporan offline idempoten.

CREATE TABLE IF NOT EXISTS asset_photos (
    id              bigserial PRIMARY KEY,
    client_id       text UNIQUE,                       -- kunci idempoten dari antrean offline
    target_kind     text NOT NULL CHECK (target_kind IN ('node','edge','report')),
    target_id       bigint NOT NULL,
    mime            text NOT NULL DEFAULT 'image/jpeg',
    image           bytea NOT NULL,
    thumb           bytea,
    width           int NOT NULL DEFAULT 0,
    height          int NOT NULL DEFAULT 0,
    bytes           int NOT NULL DEFAULT 0,
    lng             double precision,
    lat             double precision,
    accuracy_m      double precision,
    taken_at        timestamptz NOT NULL DEFAULT now(),
    note            text NOT NULL DEFAULT '',
    created_by      uuid,
    created_by_name text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_photos_target_idx ON asset_photos (target_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          bigserial PRIMARY KEY,
    user_id     uuid,
    username    text NOT NULL DEFAULT '',
    endpoint    text NOT NULL UNIQUE,
    p256dh      text NOT NULL,
    auth        text NOT NULL,
    topics      text[] NOT NULL DEFAULT ARRAY['outage','report','plan']::text[],
    user_agent  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_ok_at  timestamptz,
    fail_count  int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

-- laporan gangguan yang dibuat offline dikirim ulang dengan client_id yang sama (tidak dobel)
ALTER TABLE customer_reports ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS customer_reports_client_idx ON customer_reports (client_id) WHERE client_id IS NOT NULL;

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('push.vapid_public',  '', 'string', 'mobile', 'Kunci publik VAPID Web Push (dibuat otomatis saat pertama start)'),
 ('push.vapid_private', '', 'secret', 'mobile', 'Kunci privat VAPID Web Push (dibuat otomatis, jangan dibagikan)'),
 ('push.subject', 'mailto:admin@quadrangis.local', 'string', 'mobile', 'Kontak VAPID (mailto: atau https:) yang dikirim ke layanan push'),
 ('mobile.photo_max_kb', '1500', 'int', 'mobile', 'Ukuran maksimum foto aset (KB) setelah dikompres di ponsel'),
 ('mobile.nearby_radius_m', '500', 'int', 'mobile', 'Radius bawaan pencarian aset terdekat (meter)'),
 ('mobile.offline_basemap', 'false', 'bool', 'mobile', 'Ikut unduh peta dasar saat menyimpan area kerja offline (aktifkan hanya bila server peta dasar mengizinkan unduhan massal; OpenStreetMap tidak)'),
 ('mobile.offline_max_tiles', '1500', 'int', 'mobile', 'Batas jumlah tile per unduhan area kerja offline')
ON CONFLICT (key) DO NOTHING;

-- izin foto lapangan
UPDATE roles SET permissions = (
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(permissions) AS p
      UNION ALL SELECT unnest(CASE WHEN name IN ('admin','editor','operator','operator_tr') THEN ARRAY['field.photo'] ELSE ARRAY[]::text[] END)
    ) x)
 WHERE name IN ('admin','editor','operator','operator_tr');

-- menu Lapangan
INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000017', NULL, 'Lapangan', 'Field', '/field', 'point', 24)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000017' FROM roles r WHERE r.name IN ('admin','editor','viewer','operator','operator_tr')
ON CONFLICT DO NOTHING;
