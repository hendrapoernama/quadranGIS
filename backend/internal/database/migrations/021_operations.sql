-- =====================================================================
-- 021: Pusat Operasi: rencana manuver & simulasi what-if, FLISR,
--      dan manajemen laporan gangguan pelanggan.
-- =====================================================================

-- ---------------- rencana manuver ----------------
CREATE TABLE IF NOT EXISTS switching_plans (
    id               bigserial PRIMARY KEY,
    title            text NOT NULL,
    kind             text NOT NULL DEFAULT 'MANUVER',  -- kategori pemadaman untuk langkah buka
    status           text NOT NULL DEFAULT 'draft',    -- draft | approved | executing | done | cancelled
    source           text NOT NULL DEFAULT 'manual',   -- manual | flisr
    outage_id        bigint,
    fault            jsonb,                            -- FLISR: lokasi gangguan
    note             text NOT NULL DEFAULT '',
    created_by       uuid,
    created_by_name  text NOT NULL DEFAULT '',
    approved_by_name text NOT NULL DEFAULT '',
    approved_at      timestamptz,
    started_at       timestamptz,
    finished_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS switching_plans_status_idx ON switching_plans (status, created_at DESC);

CREATE TABLE IF NOT EXISTS switching_plan_steps (
    id          bigserial PRIMARY KEY,
    plan_id     bigint NOT NULL REFERENCES switching_plans(id) ON DELETE CASCADE,
    seq         int NOT NULL,
    target_kind text NOT NULL DEFAULT 'node',
    target_id   bigint NOT NULL,
    target_code text NOT NULL DEFAULT '',
    target_type text NOT NULL DEFAULT '',
    action      text NOT NULL CHECK (action IN ('open','close')),
    way_edge_id bigint,
    note        text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'pending',      -- pending | done | skipped | failed
    executed_at timestamptz,
    executed_by text NOT NULL DEFAULT '',
    maneuver_id bigint,
    error       text NOT NULL DEFAULT '',
    UNIQUE (plan_id, seq)
);

-- ---------------- laporan gangguan pelanggan ----------------
CREATE TABLE IF NOT EXISTS customer_reports (
    id             bigserial PRIMARY KEY,
    ticket         text NOT NULL UNIQUE,
    received_at    timestamptz NOT NULL DEFAULT now(),
    channel        text NOT NULL DEFAULT 'TELEPON',   -- TELEPON | WA | APLIKASI | CALL_CENTER | LANGSUNG | MEDSOS
    reporter_name  text NOT NULL DEFAULT '',
    reporter_phone text NOT NULL DEFAULT '',
    customer_id    bigint,                            -- node pelanggan (bila dikenali)
    customer_code  text NOT NULL DEFAULT '',
    address        text NOT NULL DEFAULT '',
    lng            double precision,
    lat            double precision,
    category       text NOT NULL DEFAULT 'PADAM',     -- PADAM | PADAM_SEBAGIAN | TEGANGAN | KABEL_PUTUS | TIANG | BAHAYA | LAINNYA
    description    text NOT NULL DEFAULT '',
    priority       text NOT NULL DEFAULT 'NORMAL',    -- NORMAL | TINGGI | DARURAT
    status         text NOT NULL DEFAULT 'BARU',      -- BARU | DIVERIFIKASI | DIKERJAKAN | SELESAI | BATAL
    energized      boolean,                           -- status pasokan saat laporan diterima
    outage_id      bigint,                            -- kejadian padam yang terkait
    gd_id          bigint,
    feeder_id      bigint,
    route_id       bigint,
    assigned_to    text NOT NULL DEFAULT '',
    note           text NOT NULL DEFAULT '',
    history        jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by     uuid,
    created_by_name text NOT NULL DEFAULT '',
    resolved_at    timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_reports_status_idx ON customer_reports (status, received_at DESC);
CREATE INDEX IF NOT EXISTS customer_reports_customer_idx ON customer_reports (customer_id);
CREATE INDEX IF NOT EXISTS customer_reports_outage_idx ON customer_reports (outage_id) WHERE outage_id IS NOT NULL;

-- ---------------- konfigurasi ----------------
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('ops.feeder_capacity_a', '400', 'float', 'monitoring', 'Kapasitas arus penyulang 20 kV (A) untuk cek beban simulasi / FLISR'),
 ('ops.feeder_kv',         '20',  'float', 'monitoring', 'Tegangan penyulang (kV) untuk menghitung kapasitas (VA)'),
 ('ops.report_sla_minutes','120', 'int',   'monitoring', 'Target waktu penyelesaian laporan gangguan pelanggan (menit)')
ON CONFLICT (key) DO NOTHING;

-- ---------------- izin ----------------
UPDATE roles SET permissions = (
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(permissions) AS p
      UNION ALL SELECT unnest(CASE name
        WHEN 'admin'       THEN ARRAY['power.plan','power.plan_approve','report.manage']
        WHEN 'operator'    THEN ARRAY['power.plan','power.plan_approve','report.manage']
        WHEN 'editor'      THEN ARRAY['power.plan','report.manage']
        WHEN 'operator_tr' THEN ARRAY['power.plan','report.manage']
        ELSE ARRAY[]::text[] END)
    ) x)
 WHERE name IN ('admin','operator','editor','operator_tr');

-- ---------------- menu ----------------
INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000014', NULL, 'Pusat Operasi', 'Operations Center', '/operations', 'target', 22)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000014' FROM roles r WHERE r.name IN ('admin','editor','viewer','operator','operator_tr')
ON CONFLICT DO NOTHING;
