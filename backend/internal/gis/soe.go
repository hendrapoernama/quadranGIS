package gis

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// SOEEvent adalah satu baris Sequence of Events (log kronologis kejadian jaringan).
type SOEEvent struct {
	ID          int64     `json:"id"`
	TS          time.Time `json:"ts"`
	Category    string    `json:"category"` // switch | cut | outage | topology
	Event       string    `json:"event"`    // OPEN | CLOSE | OUTAGE_START | OUTAGE_END | DEENERGIZED | ENERGIZED
	Severity    string    `json:"severity"` // good | info | warning | serious | critical
	TargetKind  string    `json:"target_kind"`
	TargetID    *int64    `json:"target_id"`
	TargetCode  string    `json:"target_code"`
	TargetType  string    `json:"target_type"`
	WayEdgeID   *int64    `json:"way_edge_id"`
	Kind        string    `json:"kind"`
	Level       string    `json:"level"`
	FeederCode  string    `json:"feeder_code"`
	Customers   int       `json:"customers"`
	LoadVA      float64   `json:"load_va"`
	Nodes       int       `json:"nodes"`
	DurationSec *float64  `json:"duration_sec"`
	ManeuverID  *int64    `json:"maneuver_id"`
	OutageID    *int64    `json:"outage_id"`
	Username    string    `json:"username"`
	Note        string    `json:"note"`
}

const soeCols = `id, ts, category, event, severity, target_kind, target_id, target_code, target_type, way_edge_id, kind, level,
	feeder_code, customers, load_va, nodes, duration_sec, maneuver_id, outage_id, username, note`

// InsertSOE menyimpan event; ID dan cap waktu (clock_timestamp, presisi mikrodetik) diisi ke e.
func (p *Power) InsertSOE(ctx context.Context, e *SOEEvent) error {
	if e.Severity == "" {
		e.Severity = "info"
	}
	return p.pool.QueryRow(ctx, `INSERT INTO soe_events (category, event, severity, target_kind, target_id, target_code, target_type,
		way_edge_id, kind, level, feeder_code, customers, load_va, nodes, duration_sec, maneuver_id, outage_id, username, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, ts`,
		e.Category, e.Event, e.Severity, e.TargetKind, e.TargetID, e.TargetCode, e.TargetType, e.WayEdgeID, e.Kind, e.Level,
		e.FeederCode, e.Customers, e.LoadVA, e.Nodes, e.DurationSec, e.ManeuverID, e.OutageID, e.Username, e.Note).Scan(&e.ID, &e.TS)
}

// SOEFilter menyaring daftar SOE.
type SOEFilter struct {
	BeforeID   int64 // halaman berikutnya (lebih lama)
	AfterID    int64 // hanya event lebih baru (sinkronisasi setelah koneksi putus)
	Category   string
	Severity   string // minimal: warning => warning, serious, critical
	Kind       string
	Q          string
	From, To   time.Time
	TargetKind string
	TargetID   int64
	Limit      int
}

// SeverityRank mengurutkan tingkat keparahan.
var SeverityRank = map[string]int{"good": 0, "info": 1, "warning": 2, "serious": 3, "critical": 4}

// ListSOE mengembalikan event terbaru dulu.
func (p *Power) ListSOE(ctx context.Context, f SOEFilter) ([]SOEEvent, error) {
	if f.Limit <= 0 || f.Limit > 2000 {
		f.Limit = 300
	}
	where, args := []string{"true"}, []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if f.BeforeID > 0 {
		add("id < $%d", f.BeforeID)
	}
	if f.AfterID > 0 {
		add("id > $%d", f.AfterID)
	}
	if f.Category != "" {
		add("category = $%d", f.Category)
	}
	if r, ok := SeverityRank[f.Severity]; ok && r > 0 {
		sev := []string{}
		for k, v := range SeverityRank {
			if v >= r {
				sev = append(sev, k)
			}
		}
		add("severity = ANY($%d)", sev)
	}
	if f.Kind != "" {
		add("kind = $%d", f.Kind)
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		add("(target_code ILIKE $%[1]d OR feeder_code ILIKE $%[1]d OR username ILIKE $%[1]d OR note ILIKE $%[1]d)", "%"+q+"%")
	}
	if !f.From.IsZero() {
		add("ts >= $%d", f.From)
	}
	if !f.To.IsZero() {
		add("ts < $%d", f.To)
	}
	if f.TargetID > 0 {
		add("target_id = $%d", f.TargetID)
		if f.TargetKind != "" {
			add("target_kind = $%d", f.TargetKind)
		}
	}
	args = append(args, f.Limit)
	rows, err := p.pool.Query(ctx, `SELECT `+soeCols+` FROM soe_events WHERE `+strings.Join(where, " AND ")+
		fmt.Sprintf(` ORDER BY ts DESC, id DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SOEEvent{}
	for rows.Next() {
		var e SOEEvent
		if err := rows.Scan(&e.ID, &e.TS, &e.Category, &e.Event, &e.Severity, &e.TargetKind, &e.TargetID, &e.TargetCode, &e.TargetType,
			&e.WayEdgeID, &e.Kind, &e.Level, &e.FeederCode, &e.Customers, &e.LoadVA, &e.Nodes, &e.DurationSec, &e.ManeuverID,
			&e.OutageID, &e.Username, &e.Note); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneSOE menghapus event yang lebih lama dari retensi.
func (p *Power) PruneSOE(ctx context.Context, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	tag, err := p.pool.Exec(ctx, `DELETE FROM soe_events WHERE ts < now() - make_interval(days => $1)`, days)
	return tag.RowsAffected(), err
}

// OutageSeverity memetakan level kejadian padam ke tingkat keparahan SOE.
func OutageSeverity(level string) string {
	switch level {
	case "gi", "trafo_gi", "penyulang":
		return "critical"
	case "zona", "gardu_distribusi":
		return "serious"
	}
	return "warning"
}
