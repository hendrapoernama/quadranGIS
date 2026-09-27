-- Pembebanan tahap lanjut: besaran SCADA lengkap (tegangan per fasa, frekuensi, energi kWh/kvarh impor-ekspor),
-- pembebanan berbasis MW, load profile trafo gardu distribusi, dan analisa susut (losses).

-- titik ukur: jenis gardu distribusi + penyulang pemasok
ALTER TABLE scada_points DROP CONSTRAINT IF EXISTS scada_points_kind_check;
ALTER TABLE scada_points ADD CONSTRAINT scada_points_kind_check CHECK (kind IN ('feeder','trafo_gi','gd'));
ALTER TABLE scada_points ADD COLUMN IF NOT EXISTS feeder_id bigint;   -- kubikel penyulang (penyulang: dirinya, gardu: pemasok)
CREATE INDEX IF NOT EXISTS scada_points_feeder_idx ON scada_points (feeder_id);
CREATE INDEX IF NOT EXISTS scada_points_kind_idx ON scada_points (kind);

-- data 30 menit: tegangan per fasa (kV sesuai pesan), frekuensi, energi per periode (kWh / kvarh)
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS v_r real;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS v_s real;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS v_t real;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS f_hz real;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS kwh_imp double precision;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS kwh_exp double precision;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS kvarh_imp double precision;
ALTER TABLE load_30m ADD COLUMN IF NOT EXISTS kvarh_exp double precision;

-- register meter terakhir per titik (mode energi kumulatif: energi periode = selisih register)
CREATE TABLE IF NOT EXISTS scada_registers (
    point_id   int PRIMARY KEY,
    ts         timestamptz NOT NULL,
    kwh_imp    double precision,
    kwh_exp    double precision,
    kvarh_imp  double precision,
    kvarh_exp  double precision
);

-- rekap harian & profil dasar kini berbasis MW (tabel turunan: dihitung ulang dari load_30m)
DROP TABLE IF EXISTS load_daily;
CREATE TABLE load_daily (
    point_id        int NOT NULL,
    day             date NOT NULL,
    samples         int NOT NULL DEFAULT 0,
    zero_slots      int NOT NULL DEFAULT 0,
    metered_slots   int NOT NULL DEFAULT 0,      -- slot dengan energi dari meter (sisanya integrasi MW × 0,5 jam)
    peak_mw         real,
    peak_ts         timestamptz,
    peak_mva        real,
    peak_i          real,
    peak_util       real,
    wbp_peak_mw     real,                        -- waktu beban puncak 17.00–22.00
    wbp_peak_ts     timestamptz,
    lwbp_peak_mw    real,
    min_mw          real,
    avg_mw          real,
    energy_mwh      double precision,            -- energi impor
    energy_exp_mwh  double precision,            -- energi ekspor
    mvarh_imp       double precision,
    mvarh_exp       double precision,
    load_factor     real,
    max_imbalance   real,
    min_pf          real,
    avg_pf          real,
    min_v           real,
    max_v           real,
    min_f           real,
    max_f           real,
    hours_over80    real NOT NULL DEFAULT 0,
    hours_over100   real NOT NULL DEFAULT 0,
    PRIMARY KEY (point_id, day)
);
CREATE INDEX IF NOT EXISTS load_daily_day_idx ON load_daily (day);

DROP TABLE IF EXISTS load_baseline;
CREATE TABLE load_baseline (
    point_id   int NOT NULL,
    daytype    smallint NOT NULL,   -- 0 hari kerja, 1 Sabtu, 2 Minggu/libur
    slot       smallint NOT NULL,   -- 0..47
    median_mw  real NOT NULL,
    mad_mw     real NOT NULL,
    samples    int NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (point_id, daytype, slot)
);

-- laporan beban lama memakai MVA: disusun ulang otomatis oleh penjadwal
DELETE FROM periodic_reports WHERE category = 'load';

-- ---------------- konfigurasi ----------------
INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('load.cap_pf',               '0.85',  'float',  'load', 'Faktor daya untuk kapasitas MW (daya mampu MW = rating MVA × faktor); pembebanan % = MW ÷ daya mampu'),
 ('load.energy_mode',          'interval', 'string', 'load', 'Energi kWh/kvarh pada pesan SCADA: interval (energi per 30 menit) atau cumulative (register meter, energi = selisih)'),
 ('load.f_nominal',            '50',    'float',  'load', 'Frekuensi nominal (Hz)'),
 ('load.f_dev',                '0.5',   'float',  'load', 'Batas simpangan frekuensi (Hz)'),
 ('load.energy_dev_pct',       '10',    'float',  'load', 'Selisih maksimum energi meter (kWh) terhadap integrasi MW × 0,5 jam (%)'),
 ('load.losses_high_pct',      '12',    'float',  'load', 'Batas susut distribusi penyulang tinggi (%)'),
 ('load.losses_gi_pct',        '3',     'float',  'load', 'Batas selisih energi trafo GI vs Σ penyulang (%)'),
 ('load.losses_min_coverage',  '90',    'float',  'load', 'Cakupan minimum meter gardu (% kapasitas trafo gardu penyulang) agar susut penyulang dihitung'),
 ('load.auto_register',        'true',  'bool',   'load', 'Daftarkan otomatis titik baru dari pesan SCADA/AMR bila kodenya sama dengan kode objek GIS (kubikel, trafo GI, gardu)'),
 ('load.gd_kv',                '0.4',   'float',  'load', 'Tegangan nominal sisi ukur gardu distribusi (kV)'),
 ('load.sim_gd_feeders',       '15',    'int',    'load', 'Simulator: jumlah penyulang simulasi massal yang seluruh gardunya diberi meter (penyulang nyata selalu)')
ON CONFLICT (key) DO NOTHING;

UPDATE app_configs SET description = 'Simulator SCADA/AMR: kirim data beban trafo GI, penyulang & gardu tiap 30 menit ke Kafka (matikan bila SCADA asli sudah tersambung)'
 WHERE key = 'load.simulator';
UPDATE app_configs SET description = 'Kapasitas gardu distribusi bawaan (kVA) bila atribut daya trafo tidak ada'
 WHERE key = 'load.default_gd_kva';
