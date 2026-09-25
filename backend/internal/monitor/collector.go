// Package monitor mengumpulkan metrik sistem secara berkala dan menyimpannya
// ke hypertable TimescaleDB untuk halaman Monitoring Sistem.
package monitor

import (
	"context"
	"log"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"

	"quadrangis/internal/cache"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
	"quadrangis/internal/realtime"
	"quadrangis/internal/repo"
	"quadrangis/internal/stream"
)

// Collector mengambil sampel metrik.
type Collector struct {
	pool     *pgxpool.Pool
	cache    *cache.Cache
	producer *stream.Producer
	hub      *realtime.Hub
	http     *middleware.Metrics
	repo     *repo.Metrics
	cfg      *repo.Configs

	lastReq, lastErr, lastNs int64
	latest                   atomic.Pointer[models.MetricSample]
	startedAt                time.Time
}

// New membuat collector.
func New(pool *pgxpool.Pool, c *cache.Cache, p *stream.Producer, h *realtime.Hub, hm *middleware.Metrics, r *repo.Metrics, cfg *repo.Configs) *Collector {
	return &Collector{pool: pool, cache: c, producer: p, hub: h, http: hm, repo: r, cfg: cfg, startedAt: time.Now()}
}

// Start menjalankan pengambilan metrik berkala sampai ctx selesai.
func (c *Collector) Start(ctx context.Context) {
	go func() {
		_, _ = cpu.Percent(0, false) // inisialisasi pengukuran CPU
		for {
			interval := time.Duration(c.cfg.Int("monitoring.interval_seconds", 15)) * time.Second
			if interval < 5*time.Second {
				interval = 5 * time.Second
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(interval):
				s := c.Collect(ctx)
				if err := c.repo.Insert(ctx, s); err != nil {
					log.Printf("[monitor] simpan metrik gagal: %v", err)
				}
			}
		}
	}()
}

// Collect mengambil satu sampel metrik saat ini.
func (c *Collector) Collect(ctx context.Context) models.MetricSample {
	s := models.MetricSample{Time: time.Now()}
	if pct, err := cpu.Percent(0, false); err == nil && len(pct) > 0 {
		s.CPUPercent = pct[0]
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		s.MemUsedMB = float64(vm.Used) / 1024 / 1024
		s.MemTotalMB = float64(vm.Total) / 1024 / 1024
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	s.HeapMB = float64(ms.HeapAlloc) / 1024 / 1024
	s.Goroutines = runtime.NumGoroutine()

	st := c.pool.Stat()
	s.DBConnsTotal = int(st.TotalConns())
	s.DBConnsIdle = int(st.IdleConns())
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	s.DBOK = c.pool.Ping(pingCtx) == nil
	cancel()

	if c.cache != nil {
		lat, ok := c.cache.Ping(ctx)
		s.RedisLatencyMS = float64(lat.Microseconds()) / 1000
		s.RedisOK = ok
	}
	s.KafkaOK = c.producer != nil && c.producer.Healthy()
	if c.hub != nil {
		s.WSClients = c.hub.ClientCount()
	}

	req, errs, ns := c.http.Snapshot()
	dReq, dErr, dNs := req-c.lastReq, errs-c.lastErr, ns-c.lastNs
	c.lastReq, c.lastErr, c.lastNs = req, errs, ns
	s.HTTPRequests = dReq
	s.HTTPErrors = dErr
	if dReq > 0 {
		s.HTTPAvgMS = float64(dNs) / float64(dReq) / 1e6
	}
	c.latest.Store(&s)
	return s
}

// Latest mengembalikan sampel terakhir.
func (c *Collector) Latest() models.MetricSample {
	if p := c.latest.Load(); p != nil {
		return *p
	}
	return models.MetricSample{}
}

// Summary mengembalikan ringkasan status untuk dashboard.
func (c *Collector) Summary(ctx context.Context) map[string]any {
	s := c.Collect(ctx)
	out := map[string]any{
		"sample":        s,
		"uptime_sec":    int(time.Since(c.startedAt).Seconds()),
		"started_at":    c.startedAt,
		"go_version":    runtime.Version(),
		"num_cpu":       runtime.NumCPU(),
		"kafka_enabled": c.producer != nil && c.producer.Enabled(),
	}
	if du, err := disk.Usage("/"); err == nil {
		out["disk"] = map[string]any{"total_gb": float64(du.Total) / 1e9, "used_gb": float64(du.Used) / 1e9, "percent": du.UsedPercent}
	}
	return out
}
