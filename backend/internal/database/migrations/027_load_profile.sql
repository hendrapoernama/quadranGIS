-- Pembebanan (load profile) trafo GI & penyulang dari Kafka SCADA per 30 menit:
-- titik ukur, data 30 menit (hypertable), rekap harian, profil dasar, anomali, laporan beban.

-- titik ukur SCADA ↔ objek GIS (+ hierarki hasil sinkronisasi dengan graf & batas wilayah)
CREATE TABLE IF NOT EXISTS scada_points (
    id           serial PRIMARY KEY,
    code         text NOT NULL UNIQUE,          -- kode titik pada pesan SCADA
    kind         text NOT NULL CHECK (kind IN ('feeder','trafo_gi')),
    node_id      bigint,                        -- kubikel outgoing (penyulang) / trafo GI
    name         text NOT NULL DEFAULT '',
    rating_a     double precision,              -- penyulang: arus nominal (A)
    rating_mva   double precision,              -- trafo GI: daya (MVA)
    kv           double precision NOT NULL DEFAULT 20,
    active       boolean NOT NULL DEFAULT true,
    gi_id        bigint,
    trafo_gi_id  bigint,
    up3          text NOT NULL DEFAULT '',
    ulp          text NOT NULL DEFAULT '',
    uid          text NOT NULL DEFAULT '',
    last_ts      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scada_points_node_idx ON scada_points (node_id);

-- kode titik pada pesan SCADA yang belum dipetakan
CREATE TABLE IF NOT EXISTS scada_unmapped (
    code        text PRIMARY KEY,
    kind        text NOT NULL DEFAULT '',
    first_seen  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now(),
    messages    bigint NOT NULL DEFAULT 0,
    sample      jsonb
);

-- data beban 30 menit (ts = awal periode)
CREATE TABLE IF NOT EXISTS load_30m (
    point_id  int NOT NULL,
    ts        timestamptz NOT NULL,
    i_r       real,
    i_s       real,
    i_t       real,
    i_avg     real,
    v_kv      real,
    p_mw      real,
    q_mvar    real,
    s_mva     real,
    pf        real,
    util      real,                 -- % terhadap rating (arus fasa maks / MVA)
    quality   smallint NOT NULL DEFAULT 0,  -- 0 baik, 1 estimasi, 2 meragukan
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (point_id, ts)
);
SELECT create_hypertable('load_30m', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
ALTER TABLE load_30m SET (timescaledb.compress, timescaledb.compress_segmentby = 'point_id', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('load_30m', INTERVAL '21 days', if_not_exists => TRUE);

-- rekap harian per titik (WIB)
CREATE TABLE IF NOT EXISTS load_daily (
    point_id       int NOT NULL,
    day            date NOT NULL,
    samples        int NOT NULL DEFAULT 0,
    zero_slots     int NOT NULL DEFAULT 0,
    peak_s         real,
    peak_ts        timestamptz,
    peak_p         real,
    peak_i         real,
    peak_util      real,
    wbp_peak_s     real,        -- waktu beban puncak 17.00–22.00
    wbp_peak_ts    timestamptz,
    lwbp_peak_s    real,
    min_s          real,
    avg_s          real,
    energy_mwh     real,
    load_factor    real,
    max_imbalance  real,
    min_pf         real,
    min_v          real,
    max_v          real,
    hours_over80   real NOT NULL DEFAULT 0,
    hours_over100  real NOT NULL DEFAULT 0,
    PRIMARY KEY (point_id, day)
);
CREATE INDEX IF NOT EXISTS load_daily_day_idx ON load_daily (day);

-- profil dasar per titik: median & MAD per jenis hari & slot (4 minggu terakhir)
CREATE TABLE IF NOT EXISTS load_baseline (
    point_id  int NOT NULL,
    daytype   smallint NOT NULL,   -- 0 hari kerja, 1 Sabtu, 2 Minggu/libur
    slot      smallint NOT NULL,   -- 0..47
    median_s  real NOT NULL,
    mad_s     real NOT NULL,
    samples   int NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (point_id, daytype, slot)
);

-- anomali data & kondisi beban
CREATE TABLE IF NOT EXISTS load_anomalies (
    id          bigserial PRIMARY KEY,
    point_id    int NOT NULL,
    kind        text NOT NULL,     -- missing | stale | out_of_range | zero_load | spike | drop | level_shift | imbalance | low_pf | voltage | overload | mismatch
    severity    text NOT NULL,     -- info | warning | serious | critical
    start_ts    timestamptz NOT NULL,
    end_ts      timestamptz NOT NULL,
    slots       int NOT NULL DEFAULT 1,
    value       real,
    expected    real,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    explanation text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'open',  -- open | ack | closed
    note        text NOT NULL DEFAULT '',
    handled_by  text NOT NULL DEFAULT '',
    notified    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (point_id, kind, start_ts)
);
CREATE INDEX IF NOT EXISTS load_anomalies_time_idx ON load_anomalies (start_ts DESC);
CREATE INDEX IF NOT EXISTS load_anomalies_open_idx ON load_anomalies (status, severity) WHERE status <> 'closed';

-- UID untuk tiap UP3 (bisa diubah di Konfigurasi / data batas wilayah)
UPDATE gis_boundaries SET properties = properties || jsonb_build_object('uid', 'JAKARTA RAYA')
 WHERE level = 'up3' AND NOT properties ? 'uid';

-- laporan berkala: kategori (keandalan / beban) & jenis tahunan
ALTER TABLE periodic_reports ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'reliability';
ALTER TABLE periodic_reports DROP CONSTRAINT IF EXISTS periodic_reports_kind_check;
ALTER TABLE periodic_reports ADD CONSTRAINT periodic_reports_kind_check CHECK (kind IN ('daily','weekly','monthly','yearly'));
ALTER TABLE periodic_reports DROP CONSTRAINT IF EXISTS periodic_reports_kind_period_start_key;
CREATE UNIQUE INDEX IF NOT EXISTS periodic_reports_cat_kind_start_idx ON periodic_reports (category, kind, period_start);

-- ---------------- konfigurasi ----------------
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('load.kafka_topic',       'scada.load.30m', 'string', 'load', 'Topik Kafka data beban SCADA 30 menit'),
 ('load.kafka_group',       'quadrangis-load', 'string', 'load', 'Consumer group Kafka data beban'),
 ('load.simulator',         'true',  'bool',  'load', 'Simulator SCADA: kirim data beban tiap 30 menit ke Kafka (matikan bila SCADA asli sudah tersambung)'),
 ('load.default_uid',       'JAKARTA RAYA', 'string', 'load', 'UID bawaan untuk GI di luar batas wilayah / UP3 tanpa atribut uid'),
 ('load.default_pf',        '0.9',   'float', 'load', 'Faktor daya bawaan bila pesan SCADA tidak membawa MW/MVAr'),
 ('load.warn_pct',          '80',    'float', 'load', 'Batas peringatan pembebanan (%)'),
 ('load.over_pct',          '100',   'float', 'load', 'Batas beban lebih (%)'),
 ('load.imbalance_pct',     '20',    'float', 'load', 'Batas ketidakseimbangan fasa (%)'),
 ('load.min_pf',            '0.85',  'float', 'load', 'Batas faktor daya rendah'),
 ('load.v_high_pct',        '5',     'float', 'load', 'Batas tegangan lebih (% di atas nominal)'),
 ('load.v_low_pct',         '10',    'float', 'load', 'Batas tegangan kurang (% di bawah nominal)'),
 ('load.spike_pct',         '50',    'float', 'load', 'Selisih minimum terhadap profil dasar untuk lonjakan/penurunan (%)'),
 ('load.mismatch_pct',      '15',    'float', 'load', 'Selisih maksimum incoming trafo GI vs jumlah penyulang (%)'),
 ('load.default_gd_kva',    '200',   'float', 'load', 'Kapasitas gardu distribusi bawaan (kVA) bila atribut trafo tidak ada'),
 ('load.calibrate_sim',     'true',  'bool',  'load', 'Pakai beban ukur SCADA untuk simulasi manuver & FLISR (kalibrasi beban & rating per penyulang)'),
 ('load.holidays',          '2026-01-01,2026-03-20,2026-03-21,2026-04-03,2026-05-01,2026-05-14,2026-05-27,2026-06-01,2026-06-16,2026-08-17,2026-08-25,2026-12-25', 'string', 'load', 'Tanggal libur nasional (YYYY-MM-DD, koma) untuk profil & prakiraan beban')
ON CONFLICT (key) DO NOTHING;

-- ---------------- izin ----------------
UPDATE roles SET permissions = (
    SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(permissions) AS p
      UNION ALL SELECT unnest(CASE name
        WHEN 'admin'    THEN ARRAY['load.view','load.manage']
        WHEN 'operator' THEN ARRAY['load.view','load.manage']
        WHEN 'editor'   THEN ARRAY['load.view']
        WHEN 'viewer'   THEN ARRAY['load.view']
        ELSE ARRAY[]::text[] END)
    ) x)
 WHERE name IN ('admin','operator','editor','viewer');

-- ---------------- menu ----------------
INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000018', NULL, 'Pembebanan', 'Loading', '/load', 'chart', 26)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000018' FROM roles r WHERE r.name IN ('admin','editor','viewer','operator')
ON CONFLICT DO NOTHING;
