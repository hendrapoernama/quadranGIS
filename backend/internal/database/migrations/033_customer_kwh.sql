-- kWh pelanggan bulanan (hasil billing / AP2T, diimpor dari CSV / XLSX) untuk analisa susut
-- gardu distribusi terhadap energi terjual ke pelanggan.

CREATE TABLE IF NOT EXISTS customer_kwh_imports (
    id          serial PRIMARY KEY,
    period      date NOT NULL,                 -- tanggal 1 bulan tagihan
    file_name   text,
    rows        int NOT NULL DEFAULT 0,
    matched     int NOT NULL DEFAULT 0,
    unmatched   int NOT NULL DEFAULT 0,
    errors      int NOT NULL DEFAULT 0,
    total_kwh   double precision NOT NULL DEFAULT 0,
    replaced    boolean NOT NULL DEFAULT false,
    imported_by text,
    imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_kwh (
    period    date NOT NULL,
    idpel     text NOT NULL,
    node_id   bigint,                          -- pelanggan GIS (NULL = IDPEL tidak ditemukan)
    kwh       double precision NOT NULL,
    name      text,
    tarif     text,
    daya_va   double precision,
    import_id int REFERENCES customer_kwh_imports(id) ON DELETE SET NULL,
    PRIMARY KEY (period, idpel)
);
CREATE INDEX IF NOT EXISTS customer_kwh_node_idx ON customer_kwh (node_id, period) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_kwh_import_idx ON customer_kwh (import_id);

-- pencarian pelanggan GIS menurut IDPEL
CREATE INDEX IF NOT EXISTS gis_nodes_idpel_idx ON gis_nodes ((properties->>'idpel')) WHERE properties ? 'idpel';

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('load.lv_losses_high_pct',   '10', 'float', 'load', 'Batas susut gardu → pelanggan (JTR + SR + non-teknis) yang dianggap tinggi (%)'),
 ('load.lv_min_billed_pct',    '90', 'float', 'load', 'Cakupan minimum pelanggan GIS bertagihan agar susut gardu dihitung (%)'),
 ('load.lv_min_energy_days_pct','80', 'float', 'load', 'Cakupan minimum hari data AMR gardu dalam sebulan agar susut dihitung (%)'),
 ('load.lv_low_hours',         '40', 'float', 'load', 'Jam nyala bulanan pelanggan (kWh ÷ kVA kontrak) di bawah nilai ini ditandai rendah (indikasi P2TL)')
ON CONFLICT (key) DO NOTHING;
