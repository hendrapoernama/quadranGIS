-- Energize / de-energize objek jaringan oleh sistem eksternal (SCADA, DMS, AMI, ...) lewat Kafka.
-- Pesan JSON: kode / nama objek, jenis objek, status open / close, kategori padam (wajib untuk open), tanggal.
-- Setiap pesan dicatat beserta hasilnya (applied | skipped | duplicate | error).

CREATE TABLE IF NOT EXISTS switch_events (
  id              bigserial PRIMARY KEY,
  received_at     timestamptz NOT NULL DEFAULT now(),
  event_id        text NOT NULL DEFAULT '',
  source          text NOT NULL DEFAULT '',
  channel         text NOT NULL DEFAULT 'kafka',      -- kafka | uji (dikirim dari halaman admin tanpa Kafka)
  topic           text NOT NULL DEFAULT '',
  kafka_partition integer,
  kafka_offset    bigint,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  code            text NOT NULL DEFAULT '',
  type_text       text NOT NULL DEFAULT '',
  action          text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT '',
  event_at        timestamptz,
  target_kind     text NOT NULL DEFAULT '',
  target_id       bigint,
  target_code     text NOT NULL DEFAULT '',
  target_type     text NOT NULL DEFAULT '',
  result          text NOT NULL,                      -- applied | skipped | duplicate | error
  message         text NOT NULL DEFAULT '',
  maneuver_id     bigint,
  outage_id       bigint,
  duration_ms     integer
);
CREATE INDEX IF NOT EXISTS switch_events_received_idx ON switch_events (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS switch_events_event_idx ON switch_events (event_id) WHERE event_id <> '';

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('scada.switch_enabled',  'true',                'bool',   'monitoring', 'Terima perintah energize / de-energize dari sistem eksternal lewat Kafka'),
 ('scada.switch_topic',    'scada.switch.events', 'string', 'monitoring', 'Topik Kafka perintah energize / de-energize (ubah = mulai ulang backend)'),
 ('scada.switch_group',    'quadrangis-switch',   'string', 'monitoring', 'Consumer group Kafka perintah energize / de-energize'),
 ('scada.switch_username', 'scada',               'string', 'monitoring', 'Nama pelaku yang dicatat di SOE / riwayat manuver untuk perintah eksternal'),
 ('scada.switch_max_future_sec', '120',           'int',    'monitoring', 'Tanggal perintah lebih dari N detik di masa depan diganti waktu terima')
ON CONFLICT (key) DO NOTHING;

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000027', 'a0000000-0000-0000-0000-000000000002', 'Integrasi Kafka', 'Kafka Integration', '/admin/switch-events', 'link', 57)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_menus (role_id, menu_id)
SELECT DISTINCT rm.role_id, 'a0000000-0000-0000-0000-000000000027'::uuid FROM role_menus rm
 WHERE rm.menu_id = 'a0000000-0000-0000-0000-000000000006'
ON CONFLICT DO NOTHING;
