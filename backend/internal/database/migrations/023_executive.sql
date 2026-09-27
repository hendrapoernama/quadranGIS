-- Dasbor eksekutif, laporan berkala, keandalan per wilayah UP3/ULP, AI operasi.

-- pelanggan terdampak per ULP untuk tiap kejadian padam: {"<id gis_boundaries ULP>": jumlah}
-- NULL = belum dihitung (diisi backend saat kejadian dibuka & saat start untuk data lama)
ALTER TABLE outages ADD COLUMN IF NOT EXISTS regions jsonb;

-- snapshot laporan berkala (harian / mingguan / bulanan)
CREATE TABLE IF NOT EXISTS periodic_reports (
    id              bigserial PRIMARY KEY,
    kind            text NOT NULL CHECK (kind IN ('daily','weekly','monthly')),
    period_start    timestamptz NOT NULL,
    period_end      timestamptz NOT NULL,
    title           text NOT NULL DEFAULT '',
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    narrative       text NOT NULL DEFAULT '',          -- ringkasan eksekutif (AI / manual)
    narrative_by    text NOT NULL DEFAULT '',
    generated_by    text NOT NULL DEFAULT 'system',    -- system | username
    generated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, period_start)
);
CREATE INDEX IF NOT EXISTS periodic_reports_kind_idx ON periodic_reports (kind, period_start DESC);

-- ---------------- konfigurasi ----------------
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('reliability.target_saidi_year', '120', 'float', 'monitoring', 'Target SAIDI setahun (menit/pelanggan), dipakai dasbor eksekutif & keandalan wilayah'),
 ('reliability.target_saifi_year', '2',   'float', 'monitoring', 'Target SAIFI setahun (kali/pelanggan)'),
 ('report.auto_daily',   'true', 'bool', 'monitoring', 'Buat laporan berkala harian otomatis (hari sebelumnya, 00:15 WIB)'),
 ('report.auto_weekly',  'true', 'bool', 'monitoring', 'Buat laporan berkala mingguan otomatis (Senin–Minggu sebelumnya)'),
 ('report.auto_monthly', 'true', 'bool', 'monitoring', 'Buat laporan berkala bulanan otomatis (bulan sebelumnya)')
ON CONFLICT (key) DO NOTHING;

-- ---------------- izin ----------------
UPDATE roles SET permissions = (
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(permissions) AS p
      UNION ALL SELECT unnest(CASE name
        WHEN 'admin'    THEN ARRAY['exec.view','exec.report']
        WHEN 'operator' THEN ARRAY['exec.view','exec.report']
        WHEN 'editor'   THEN ARRAY['exec.view']
        WHEN 'viewer'   THEN ARRAY['exec.view']
        ELSE ARRAY[]::text[] END)
    ) x)
 WHERE name IN ('admin','operator','editor','viewer');

-- ---------------- menu ----------------
INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000015', NULL, 'Dasbor Eksekutif',  'Executive Dashboard',  '/executive',   'home',  5),
 ('a0000000-0000-0000-0000-000000000016', NULL, 'Keandalan Wilayah', 'Regional Reliability', '/reliability', 'globe', 21)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, m.id FROM roles r
CROSS JOIN (VALUES ('a0000000-0000-0000-0000-000000000015'::uuid), ('a0000000-0000-0000-0000-000000000016'::uuid)) m(id)
WHERE r.name IN ('admin','editor','viewer','operator')
ON CONFLICT DO NOTHING;
