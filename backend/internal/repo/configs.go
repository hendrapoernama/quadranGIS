package repo

import (
	"context"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/models"
)

// Configs adalah repository konfigurasi aplikasi dengan cache di memori
// sehingga pembacaan nilai (mis. toleransi snap) tidak membebani database.
type Configs struct {
	pool   *pgxpool.Pool
	mu     sync.RWMutex
	values map[string]string
}

// NewConfigs membuat repository dan memuat cache awal.
func NewConfigs(pool *pgxpool.Pool) *Configs {
	c := &Configs{pool: pool, values: map[string]string{}}
	return c
}

// Refresh memuat ulang cache dari database.
func (c *Configs) Refresh(ctx context.Context) error {
	rows, err := c.pool.Query(ctx, `SELECT key, value FROM app_configs`)
	if err != nil {
		return err
	}
	defer rows.Close()
	vals := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return err
		}
		vals[k] = v
	}
	c.mu.Lock()
	c.values = vals
	c.mu.Unlock()
	return rows.Err()
}

// StartAutoRefresh memuat ulang cache secara berkala.
func (c *Configs) StartAutoRefresh(ctx context.Context, every time.Duration) {
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := c.Refresh(ctx); err != nil {
					log.Printf("[config] refresh gagal: %v", err)
				}
			}
		}
	}()
}

// Str membaca nilai string.
func (c *Configs) Str(key, def string) string {
	c.mu.RLock()
	v, ok := c.values[key]
	c.mu.RUnlock()
	if !ok || v == "" {
		return def
	}
	return v
}

// Int membaca nilai integer.
func (c *Configs) Int(key string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(c.Str(key, ""))); err == nil {
		return v
	}
	return def
}

// Float membaca nilai desimal.
func (c *Configs) Float(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(strings.TrimSpace(c.Str(key, "")), 64); err == nil {
		return v
	}
	return def
}

// Bool membaca nilai boolean.
func (c *Configs) Bool(key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(c.Str(key, ""))) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	}
	return def
}

// List mengembalikan seluruh konfigurasi.
func (c *Configs) List(ctx context.Context) ([]models.Config, error) {
	rows, err := c.pool.Query(ctx, `SELECT key, value, value_type, "group", description, updated_at FROM app_configs ORDER BY "group", key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Config{}
	for rows.Next() {
		var m models.Config
		if err := rows.Scan(&m.Key, &m.Value, &m.ValueType, &m.Group, &m.Description, &m.UpdatedAt); err != nil {
			return nil, err
		}
		if m.ValueType == "secret" {
			// rahasia (mis. API key) tidak pernah dikirim ke klien
			// nilai kosong saat simpan = tidak diubah; satu spasi = dihapus
			m.HasValue = strings.TrimSpace(m.Value) != ""
			m.Value = ""
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Public mengembalikan konfigurasi yang aman dibagikan ke klien (grup general & loading).
func (c *Configs) Public() map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := map[string]string{}
	for k, v := range c.values {
		if strings.HasPrefix(k, "app.") || strings.HasPrefix(k, "loading.") || strings.HasPrefix(k, "topology.") || strings.HasPrefix(k, "trace.") ||
			strings.HasPrefix(k, "map.") || strings.HasPrefix(k, "monitoring.") {
			out[k] = v
		}
	}
	return out
}

// Upsert menyimpan satu konfigurasi lalu memuat ulang cache.
func (c *Configs) Upsert(ctx context.Context, m models.Config) error {
	// Kolom kosong (value_type, group, description) berarti "pertahankan nilai lama";
	// bawaan hanya dipakai saat baris baru dibuat. Tipe 'secret' bersifat tetap, dan nilai
	// kosong pada secret berarti tidak diubah (satu spasi untuk menghapus).
	_, err := c.pool.Exec(ctx, `INSERT INTO app_configs (key, value, value_type, "group", description, updated_at)
		VALUES ($1, $2, COALESCE(NULLIF($3,''),'string'), COALESCE(NULLIF($4,''),'general'), $5, now())
		ON CONFLICT (key) DO UPDATE SET
			value=CASE WHEN app_configs.value_type='secret' AND $2='' THEN app_configs.value ELSE $2 END,
			value_type=CASE WHEN app_configs.value_type='secret' OR $3='' THEN app_configs.value_type ELSE $3 END,
			"group"=CASE WHEN $4<>'' THEN $4 ELSE app_configs."group" END,
			description=CASE WHEN $5<>'' THEN $5 ELSE app_configs.description END,
			updated_at=now()`,
		strings.TrimSpace(m.Key), m.Value, m.ValueType, m.Group, m.Description)
	if err != nil {
		return err
	}
	return c.Refresh(ctx)
}

// UpsertMany menyimpan beberapa konfigurasi sekaligus.
func (c *Configs) UpsertMany(ctx context.Context, items []models.Config) error {
	for _, it := range items {
		if err := c.Upsert(ctx, it); err != nil {
			return err
		}
	}
	return nil
}

// Delete menghapus konfigurasi.
func (c *Configs) Delete(ctx context.Context, key string) error {
	if _, err := c.pool.Exec(ctx, `DELETE FROM app_configs WHERE key=$1`, key); err != nil {
		return err
	}
	return c.Refresh(ctx)
}
