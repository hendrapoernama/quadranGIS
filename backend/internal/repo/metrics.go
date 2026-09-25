package repo

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/models"
)

// Metrics menyimpan dan membaca metrik sistem dari hypertable.
type Metrics struct{ pool *pgxpool.Pool }

// NewMetrics membuat repository metrik.
func NewMetrics(pool *pgxpool.Pool) *Metrics { return &Metrics{pool: pool} }

// Insert menyimpan satu sampel.
func (m *Metrics) Insert(ctx context.Context, s models.MetricSample) error {
	_, err := m.pool.Exec(ctx, `INSERT INTO system_metrics
		(time, cpu_percent, mem_used_mb, mem_total_mb, heap_mb, goroutines, db_conns_total, db_conns_idle, db_ok,
		 redis_latency_ms, redis_ok, kafka_ok, http_requests, http_avg_ms, http_errors, ws_clients)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		s.Time, s.CPUPercent, s.MemUsedMB, s.MemTotalMB, s.HeapMB, s.Goroutines, s.DBConnsTotal, s.DBConnsIdle, s.DBOK,
		s.RedisLatencyMS, s.RedisOK, s.KafkaOK, s.HTTPRequests, s.HTTPAvgMS, s.HTTPErrors, s.WSClients)
	return err
}

// Series mengembalikan sampel dalam rentang menit terakhir (di-bucket agar ringan).
func (m *Metrics) Series(ctx context.Context, minutes int) ([]models.MetricSample, error) {
	if minutes <= 0 {
		minutes = 60
	}
	if minutes > 7*24*60 {
		minutes = 7 * 24 * 60
	}
	// bucket adaptif: maksimal ~240 titik
	bucketSec := minutes * 60 / 240
	if bucketSec < 15 {
		bucketSec = 15
	}
	rows, err := m.pool.Query(ctx, `SELECT time_bucket(make_interval(secs => $2), time) AS b,
			avg(cpu_percent), avg(mem_used_mb), max(mem_total_mb), avg(heap_mb), avg(goroutines)::int,
			avg(db_conns_total)::int, avg(db_conns_idle)::int, bool_and(db_ok), avg(redis_latency_ms), bool_and(redis_ok), bool_and(kafka_ok),
			sum(http_requests)::bigint, avg(http_avg_ms), sum(http_errors)::bigint, max(ws_clients)::int
		FROM system_metrics WHERE time > now() - make_interval(mins => $1)
		GROUP BY b ORDER BY b`, minutes, bucketSec)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.MetricSample{}
	for rows.Next() {
		var s models.MetricSample
		if err := rows.Scan(&s.Time, &s.CPUPercent, &s.MemUsedMB, &s.MemTotalMB, &s.HeapMB, &s.Goroutines,
			&s.DBConnsTotal, &s.DBConnsIdle, &s.DBOK, &s.RedisLatencyMS, &s.RedisOK, &s.KafkaOK,
			&s.HTTPRequests, &s.HTTPAvgMS, &s.HTTPErrors, &s.WSClients); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DBStats mengembalikan statistik database (ukuran, jumlah baris tabel utama).
func (m *Metrics) DBStats(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	var dbSize string
	if err := m.pool.QueryRow(ctx, `SELECT pg_size_pretty(pg_database_size(current_database()))`).Scan(&dbSize); err != nil {
		return nil, err
	}
	out["database_size"] = dbSize
	rows, err := m.pool.Query(ctx, `SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
		FROM pg_stat_user_tables WHERE relname IN ('gis_nodes','gis_edges','users','audit_logs','feature_history','stream_events','system_metrics')
		ORDER BY relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tables := []map[string]any{}
	for rows.Next() {
		var name, size string
		var live int64
		if err := rows.Scan(&name, &live, &size); err != nil {
			return nil, err
		}
		tables = append(tables, map[string]any{"table": name, "rows": live, "size": size})
	}
	out["tables"] = tables
	var version string
	_ = m.pool.QueryRow(ctx, `SELECT version()`).Scan(&version)
	out["version"] = version
	var ext []byte
	_ = m.pool.QueryRow(ctx, `SELECT json_object_agg(extname, extversion) FROM pg_extension WHERE extname IN ('postgis','timescaledb')`).Scan(&ext)
	out["extensions"] = json.RawMessage(ext)
	var active int
	_ = m.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE state='active'`).Scan(&active)
	out["active_queries"] = active
	out["checked_at"] = time.Now()
	return out, nil
}

// StreamEvents mengembalikan event Kafka terakhir yang tersimpan.
func (m *Metrics) StreamEvents(ctx context.Context, limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := m.pool.Query(ctx, `SELECT time, topic, partition, "offset", key, payload FROM stream_events ORDER BY time DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var t time.Time
		var topic, key string
		var part int
		var off int64
		var payload []byte
		if err := rows.Scan(&t, &topic, &part, &off, &key, &payload); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"time": t, "topic": topic, "partition": part, "offset": off, "key": key, "payload": json.RawMessage(payload)})
	}
	return out, rows.Err()
}

// InsertStreamEvent menyimpan event yang dikonsumsi dari Kafka.
func (m *Metrics) InsertStreamEvent(ctx context.Context, t time.Time, topic string, partition int, offset int64, key string, payload []byte) error {
	if !json.Valid(payload) {
		payload, _ = json.Marshal(map[string]string{"raw": string(payload)})
	}
	_, err := m.pool.Exec(ctx, `INSERT INTO stream_events (time, topic, partition, "offset", key, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
		t, topic, partition, offset, key, payload)
	return err
}
