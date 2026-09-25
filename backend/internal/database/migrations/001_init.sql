-- =====================================================================
-- QuadranGIS - skema awal
-- PostgreSQL 16 + PostGIS + TimescaleDB
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Administrasi: roles, users, menus, konfigurasi
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text UNIQUE NOT NULL,
    description text NOT NULL DEFAULT '',
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_system   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text UNIQUE NOT NULL,
    email         text NOT NULL DEFAULT '',
    full_name     text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    role_id       uuid REFERENCES roles(id) ON DELETE SET NULL,
    is_active     boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role_id);

CREATE TABLE IF NOT EXISTS menus (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  uuid REFERENCES menus(id) ON DELETE CASCADE,
    title      text NOT NULL,
    path       text NOT NULL DEFAULT '',
    icon       text NOT NULL DEFAULT '',
    sort_order int  NOT NULL DEFAULT 0,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_menus (
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    menu_id uuid NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS app_configs (
    key         text PRIMARY KEY,
    value       text NOT NULL DEFAULT '',
    value_type  text NOT NULL DEFAULT 'string',   -- string|int|float|bool|json
    "group"     text NOT NULL DEFAULT 'general',
    description text NOT NULL DEFAULT '',
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Audit & monitoring (hypertable TimescaleDB)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    time      timestamptz NOT NULL DEFAULT now(),
    user_id   uuid,
    username  text NOT NULL DEFAULT '',
    action    text NOT NULL,
    entity    text NOT NULL DEFAULT '',
    entity_id text NOT NULL DEFAULT '',
    detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip        text NOT NULL DEFAULT ''
);
SELECT create_hypertable('audit_logs', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs(user_id, time DESC);

CREATE TABLE IF NOT EXISTS system_metrics (
    time             timestamptz NOT NULL DEFAULT now(),
    cpu_percent      double precision NOT NULL DEFAULT 0,
    mem_used_mb      double precision NOT NULL DEFAULT 0,
    mem_total_mb     double precision NOT NULL DEFAULT 0,
    heap_mb          double precision NOT NULL DEFAULT 0,
    goroutines       int NOT NULL DEFAULT 0,
    db_conns_total   int NOT NULL DEFAULT 0,
    db_conns_idle    int NOT NULL DEFAULT 0,
    db_ok            boolean NOT NULL DEFAULT false,
    redis_latency_ms double precision NOT NULL DEFAULT 0,
    redis_ok         boolean NOT NULL DEFAULT false,
    kafka_ok         boolean NOT NULL DEFAULT false,
    http_requests    bigint NOT NULL DEFAULT 0,
    http_avg_ms      double precision NOT NULL DEFAULT 0,
    http_errors      bigint NOT NULL DEFAULT 0,
    ws_clients       int NOT NULL DEFAULT 0
);
SELECT create_hypertable('system_metrics', 'time', if_not_exists => TRUE);

-- retensi otomatis: metrik 30 hari, audit 1 tahun
SELECT add_retention_policy('system_metrics', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('audit_logs', INTERVAL '365 days', if_not_exists => TRUE);

-- event dari Kafka (sink) untuk penelusuran stream
CREATE TABLE IF NOT EXISTS stream_events (
    time      timestamptz NOT NULL DEFAULT now(),
    topic     text NOT NULL,
    partition int NOT NULL DEFAULT 0,
    "offset"  bigint NOT NULL DEFAULT 0,
    key       text NOT NULL DEFAULT '',
    payload   jsonb NOT NULL DEFAULT '{}'::jsonb
);
SELECT create_hypertable('stream_events', 'time', if_not_exists => TRUE);
SELECT add_retention_policy('stream_events', INTERVAL '90 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------
-- GIS kelistrikan
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS component_types (
    code        text PRIMARY KEY,
    name        text NOT NULL,
    geom_kind   text NOT NULL CHECK (geom_kind IN ('point','line')),
    category    text NOT NULL DEFAULT 'jaringan',
    is_source   boolean NOT NULL DEFAULT false,  -- sumber daya (awal trace)
    is_switch   boolean NOT NULL DEFAULT false,  -- punya status open/closed
    is_sink     boolean NOT NULL DEFAULT false,  -- pelanggan (akhir trace)
    voltage_kv  double precision NOT NULL DEFAULT 0,
    color       text NOT NULL DEFAULT '#3b82f6',
    icon        text NOT NULL DEFAULT 'circle',
    min_zoom    int  NOT NULL DEFAULT 0,          -- zoom minimum layer tampil (loading ringan)
    label_zoom  int  NOT NULL DEFAULT 16,         -- zoom minimum label tampil
    size        double precision NOT NULL DEFAULT 5,
    sort_order  int  NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true
);

-- Titik (node topologi): GI, GH, GD, trafo, kubikel, pelanggan, junction, dll
CREATE TABLE IF NOT EXISTS gis_nodes (
    id          bigserial PRIMARY KEY,
    type_code   text NOT NULL REFERENCES component_types(code),
    code        text NOT NULL DEFAULT '',
    name        text NOT NULL DEFAULT '',
    geom        geometry(Point, 4326) NOT NULL,
    status      text NOT NULL DEFAULT 'closed',   -- closed|open (untuk switch / kubikel)
    properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by  uuid,
    updated_by  uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_nodes_geom_idx ON gis_nodes USING GIST (geom);
CREATE INDEX IF NOT EXISTS gis_nodes_type_idx ON gis_nodes (type_code);
CREATE INDEX IF NOT EXISTS gis_nodes_code_idx ON gis_nodes (code);
CREATE INDEX IF NOT EXISTS gis_nodes_name_idx ON gis_nodes (lower(name) text_pattern_ops);

-- Garis (edge topologi): busbar, SKTM, SUTM, SKUTR, SKTR, SR
CREATE TABLE IF NOT EXISTS gis_edges (
    id           bigserial PRIMARY KEY,
    type_code    text NOT NULL REFERENCES component_types(code),
    code         text NOT NULL DEFAULT '',
    name         text NOT NULL DEFAULT '',
    geom         geometry(LineString, 4326) NOT NULL,
    from_node_id bigint NOT NULL REFERENCES gis_nodes(id) ON DELETE CASCADE,
    to_node_id   bigint NOT NULL REFERENCES gis_nodes(id) ON DELETE CASCADE,
    length_m     double precision NOT NULL DEFAULT 0,
    status       text NOT NULL DEFAULT 'closed',
    properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by   uuid,
    updated_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_edges_geom_idx ON gis_edges USING GIST (geom);
CREATE INDEX IF NOT EXISTS gis_edges_type_idx ON gis_edges (type_code);
CREATE INDEX IF NOT EXISTS gis_edges_from_idx ON gis_edges (from_node_id);
CREATE INDEX IF NOT EXISTS gis_edges_to_idx   ON gis_edges (to_node_id);
CREATE INDEX IF NOT EXISTS gis_edges_code_idx ON gis_edges (code);

-- Riwayat perubahan fitur (hypertable)
CREATE TABLE IF NOT EXISTS feature_history (
    time       timestamptz NOT NULL DEFAULT now(),
    kind       text NOT NULL,          -- node|edge
    feature_id bigint NOT NULL,
    action     text NOT NULL,          -- create|update|delete|split|merge
    user_id    uuid,
    username   text NOT NULL DEFAULT '',
    data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
SELECT create_hypertable('feature_history', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS feature_history_feat_idx ON feature_history(kind, feature_id, time DESC);

-- Ringkasan kepadatan titik untuk zoom rendah (di-refresh berkala oleh backend)
CREATE MATERIALIZED VIEW IF NOT EXISTS gis_nodes_density AS
SELECT row_number() OVER () AS id,
       type_code,
       count(*)::int AS cnt,
       ST_Centroid(ST_Collect(geom))::geometry(Point,4326) AS geom
FROM gis_nodes
GROUP BY type_code, ST_SnapToGrid(geom, 0.02);
CREATE UNIQUE INDEX IF NOT EXISTS gis_nodes_density_id_idx ON gis_nodes_density(id);
CREATE INDEX IF NOT EXISTS gis_nodes_density_geom_idx ON gis_nodes_density USING GIST(geom);

-- fungsi bantu: panjang garis dalam meter
CREATE OR REPLACE FUNCTION qgis_length_m(g geometry) RETURNS double precision AS $$
    SELECT ST_Length(g::geography);
$$ LANGUAGE sql IMMUTABLE;
