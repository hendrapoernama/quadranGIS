-- =====================================================================
-- 013: SOE (Sequence of Events) realtime: log kronologis kejadian jaringan
--      (buka/tutup switch, pemutusan, padam mulai/selesai, perubahan
--      energisasi akibat edit) dengan cap waktu presisi milidetik.
-- =====================================================================
CREATE TABLE IF NOT EXISTS soe_events (
    id           bigserial PRIMARY KEY,
    ts           timestamptz NOT NULL DEFAULT clock_timestamp(),
    category     text NOT NULL,                 -- switch | cut | outage | topology
    event        text NOT NULL,                 -- OPEN | CLOSE | OUTAGE_START | OUTAGE_END | DEENERGIZED | ENERGIZED
    severity     text NOT NULL DEFAULT 'info',  -- good | info | warning | serious | critical
    target_kind  text NOT NULL DEFAULT '',      -- node | edge
    target_id    bigint,
    target_code  text NOT NULL DEFAULT '',
    target_type  text NOT NULL DEFAULT '',
    way_edge_id  bigint,
    kind         text NOT NULL DEFAULT '',      -- GANGGUAN | PEMELIHARAAN | MLS
    level        text NOT NULL DEFAULT '',
    feeder_code  text NOT NULL DEFAULT '',
    customers    integer NOT NULL DEFAULT 0,
    load_va      double precision NOT NULL DEFAULT 0,
    nodes        integer NOT NULL DEFAULT 0,
    duration_sec double precision,
    maneuver_id  bigint,
    outage_id    bigint,
    username     text NOT NULL DEFAULT '',
    note         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS soe_ts_idx ON soe_events (ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS soe_target_idx ON soe_events (target_kind, target_id, ts DESC);

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('monitoring.soe_retention_days', '365', 'int', 'monitoring', 'Lama penyimpanan SOE (hari); event lebih lama dihapus otomatis')
ON CONFLICT (key) DO NOTHING;

-- isi awal dari riwayat manuver & kejadian padam yang sudah ada
INSERT INTO soe_events (ts, category, event, severity, target_kind, target_id, target_code, target_type, way_edge_id,
                        kind, customers, load_va, nodes, maneuver_id, outage_id, username, note)
SELECT m.created_at,
       CASE WHEN ct.is_switch THEN 'switch' ELSE 'cut' END,
       upper(m.action),
       CASE WHEN m.action = 'close' THEN 'good' WHEN m.kind = 'GANGGUAN' THEN 'serious' ELSE 'warning' END,
       m.target_kind, m.node_id, m.node_code, m.node_type, m.way_edge_id, m.kind,
       COALESCE((m.affected->>'pelanggan')::int, 0), COALESCE((m.affected->>'beban_va')::float8, 0),
       COALESCE((m.affected->>'nodes')::int, 0), m.id, m.outage_id, m.username, m.note
FROM maneuvers m LEFT JOIN component_types ct ON ct.code = m.node_type
WHERE NOT EXISTS (SELECT 1 FROM soe_events);

INSERT INTO soe_events (ts, category, event, severity, target_kind, target_id, target_code, target_type, way_edge_id,
                        kind, level, customers, load_va, nodes, outage_id, maneuver_id)
SELECT o.started_at + interval '1 millisecond', 'outage', 'OUTAGE_START',
       CASE WHEN o.level IN ('gi','trafo_gi','penyulang') THEN 'critical' WHEN o.level IN ('zona','gardu_distribusi') THEN 'serious' ELSE 'warning' END,
       o.cause_kind, o.cause_node_id, o.cause_node_code, o.cause_node_type, o.way_edge_id, o.kind, o.level,
       COALESCE((o.summary->>'pelanggan')::int, 0), COALESCE((o.summary->>'beban_va')::float8, 0),
       cardinality(o.affected_nodes), o.id, o.open_maneuver_id
FROM outages o
WHERE NOT EXISTS (SELECT 1 FROM soe_events WHERE category = 'outage');

INSERT INTO soe_events (ts, category, event, severity, target_kind, target_id, target_code, target_type, way_edge_id,
                        kind, level, customers, load_va, nodes, duration_sec, outage_id, maneuver_id)
SELECT o.ended_at + interval '1 millisecond', 'outage', 'OUTAGE_END', 'good',
       o.cause_kind, o.cause_node_id, o.cause_node_code, o.cause_node_type, o.way_edge_id, o.kind, o.level,
       COALESCE((o.summary->>'pelanggan')::int, 0), COALESCE((o.summary->>'beban_va')::float8, 0),
       cardinality(o.affected_nodes), EXTRACT(EPOCH FROM o.ended_at - o.started_at), o.id, o.close_maneuver_id
FROM outages o
WHERE o.ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM soe_events WHERE event = 'OUTAGE_END');
