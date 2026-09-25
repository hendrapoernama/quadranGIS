package repo

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/models"
)

// Audit mencatat aktivitas pengguna ke hypertable audit_logs.
type Audit struct{ pool *pgxpool.Pool }

// NewAudit membuat repository audit.
func NewAudit(pool *pgxpool.Pool) *Audit { return &Audit{pool: pool} }

// Log menulis catatan audit secara asinkron agar tidak memperlambat permintaan.
func (a *Audit) Log(userID *string, username, action, entity, entityID string, detail any, ip string) {
	go func() {
		b, err := json.Marshal(detail)
		if err != nil || detail == nil {
			b = []byte("{}")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := a.pool.Exec(ctx, `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			userID, username, action, entity, entityID, b, ip); err != nil {
			log.Printf("[audit] gagal mencatat: %v", err)
		}
	}()
}

// List mengembalikan catatan audit terbaru.
func (a *Audit) List(ctx context.Context, limit int) ([]models.AuditLog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := a.pool.Query(ctx, `SELECT time, user_id::text, username, action, entity, entity_id, detail, ip FROM audit_logs ORDER BY time DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.AuditLog{}
	for rows.Next() {
		var m models.AuditLog
		var detail []byte
		if err := rows.Scan(&m.Time, &m.UserID, &m.Username, &m.Action, &m.Entity, &m.EntityID, &detail, &m.IP); err != nil {
			return nil, err
		}
		m.Detail = json.RawMessage(detail)
		out = append(out, m)
	}
	return out, rows.Err()
}
