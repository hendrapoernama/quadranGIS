package gis

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Exec adalah persistensi dasbor eksekutif: snapshot laporan berkala & statistik operasi per periode.
type Exec struct {
	pool *pgxpool.Pool
}

// NewExec membuat repositori eksekutif.
func NewExec(pool *pgxpool.Pool) *Exec { return &Exec{pool: pool} }

// ReportKinds adalah jenis laporan berkala.
var ReportKinds = []string{"daily", "weekly", "monthly"}

// PeriodicReport adalah satu snapshot laporan berkala.
type PeriodicReport struct {
	ID          int64           `json:"id"`
	Category    string          `json:"category"` // reliability | load
	Kind        string          `json:"kind"`
	PeriodStart time.Time       `json:"period_start"`
	PeriodEnd   time.Time       `json:"period_end"`
	Title       string          `json:"title"`
	Data        json.RawMessage `json:"data,omitempty"`
	Narrative   string          `json:"narrative"`
	NarrativeBy string          `json:"narrative_by"`
	GeneratedBy string          `json:"generated_by"`
	GeneratedAt time.Time       `json:"generated_at"`
}

const periodicCols = `id, category, kind, period_start, period_end, title, narrative, narrative_by, generated_by, generated_at`

func scanPeriodic(row pgx.Row, withData bool) (PeriodicReport, error) {
	var r PeriodicReport
	dest := []any{&r.ID, &r.Category, &r.Kind, &r.PeriodStart, &r.PeriodEnd, &r.Title, &r.Narrative, &r.NarrativeBy, &r.GeneratedBy, &r.GeneratedAt}
	var data []byte
	if withData {
		dest = append(dest, &data)
	}
	if err := row.Scan(dest...); err != nil {
		if err == pgx.ErrNoRows {
			return r, ErrNotFound
		}
		return r, err
	}
	if withData {
		r.Data = json.RawMessage(data)
	}
	return r, nil
}

// ListReports mengembalikan laporan berkala terbaru (tanpa data), opsional per jenis.
func (e *Exec) ListReports(ctx context.Context, category, kind string, limit int) ([]PeriodicReport, error) {
	if category == "" {
		category = "reliability"
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := e.pool.Query(ctx, `SELECT `+periodicCols+` FROM periodic_reports
		WHERE category = $3 AND ($1 = '' OR kind = $1) ORDER BY period_start DESC, kind LIMIT $2`, kind, limit, category)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PeriodicReport{}
	for rows.Next() {
		r, err := scanPeriodic(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetReport mengembalikan satu laporan lengkap dengan datanya.
func (e *Exec) GetReport(ctx context.Context, id int64) (PeriodicReport, error) {
	return scanPeriodic(e.pool.QueryRow(ctx, `SELECT `+periodicCols+`, data FROM periodic_reports WHERE id = $1`, id), true)
}

// ReportExists memeriksa apakah laporan untuk jenis & awal periode sudah ada.
func (e *Exec) ReportExists(ctx context.Context, category, kind string, start time.Time) bool {
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM periodic_reports WHERE category = $3 AND kind = $1 AND period_start = $2`, kind, start, category).Scan(&n)
	return n > 0
}

// SaveReport menyimpan laporan (menimpa data laporan dengan jenis & periode yang sama; ringkasan dipertahankan).
func (e *Exec) SaveReport(ctx context.Context, r PeriodicReport) (int64, error) {
	var id int64
	if r.Category == "" {
		r.Category = "reliability"
	}
	err := e.pool.QueryRow(ctx, `INSERT INTO periodic_reports (kind, period_start, period_end, title, data, generated_by, category)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (category, kind, period_start) DO UPDATE SET period_end = EXCLUDED.period_end, title = EXCLUDED.title,
			data = EXCLUDED.data, generated_by = EXCLUDED.generated_by, generated_at = now()
		RETURNING id`, r.Kind, r.PeriodStart, r.PeriodEnd, r.Title, []byte(r.Data), r.GeneratedBy, r.Category).Scan(&id)
	return id, err
}

// SetNarrative menyimpan ringkasan eksekutif laporan.
func (e *Exec) SetNarrative(ctx context.Context, id int64, text, by string) error {
	tag, err := e.pool.Exec(ctx, `UPDATE periodic_reports SET narrative = $2, narrative_by = $3 WHERE id = $1`, id, text, by)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// DeleteReport menghapus laporan.
func (e *Exec) DeleteReport(ctx context.Context, id int64) error {
	tag, err := e.pool.Exec(ctx, `DELETE FROM periodic_reports WHERE id = $1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// OpsStats adalah statistik operasi pada satu periode.
type OpsStats struct {
	Maneuvers      int            `json:"maneuvers"`
	ManeuversOpen  int            `json:"maneuvers_open"`
	ManeuversClose int            `json:"maneuvers_close"`
	ManeuverKinds  map[string]int `json:"maneuver_kinds"`
	PlansCreated   int            `json:"plans_created"`
	PlansDone      int            `json:"plans_done"`
	PlansFlisr     int            `json:"plans_flisr"`
	SOESerious     int            `json:"soe_serious"`
	// laporan gangguan pelanggan
	Reports           int            `json:"reports"`
	ReportsResolved   int            `json:"reports_resolved"`
	ReportsOpen       int            `json:"reports_open"`
	ReportsOverdue    int            `json:"reports_overdue"` // selesai melewati SLA / masih terbuka melewati SLA
	ReportsLinked     int            `json:"reports_linked"`  // tertaut kejadian padam
	ReportAvgResolveM float64        `json:"report_avg_resolve_min"`
	ReportCategories  map[string]int `json:"report_categories"`
	ReportChannels    map[string]int `json:"report_channels"`
}

// OpsStatsBetween menghitung statistik operasi pada periode [from, to).
func (e *Exec) OpsStatsBetween(ctx context.Context, from, to time.Time, slaMinutes float64) (OpsStats, error) {
	st := OpsStats{ManeuverKinds: map[string]int{}, ReportCategories: map[string]int{}, ReportChannels: map[string]int{}}
	rows, err := e.pool.Query(ctx, `SELECT action, kind, count(*) FROM maneuvers WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2`, from, to)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var action, kind string
		var n int
		if rows.Scan(&action, &kind, &n) == nil {
			st.Maneuvers += n
			if action == "open" {
				st.ManeuversOpen += n
				st.ManeuverKinds[kind] += n
			} else {
				st.ManeuversClose += n
			}
		}
	}
	rows.Close()
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE created_at >= $1 AND created_at < $2),
		count(*) FILTER (WHERE status = 'done' AND finished_at >= $1 AND finished_at < $2),
		count(*) FILTER (WHERE source = 'flisr' AND created_at >= $1 AND created_at < $2)
		FROM switching_plans`, from, to).Scan(&st.PlansCreated, &st.PlansDone, &st.PlansFlisr)
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM soe_events WHERE ts >= $1 AND ts < $2 AND severity IN ('serious','critical')`, from, to).Scan(&st.SOESerious)
	var avg *float64
	_ = e.pool.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER (WHERE status = 'SELESAI'),
		count(*) FILTER (WHERE status IN ('BARU','DIVERIFIKASI','DIKERJAKAN')),
		count(*) FILTER (WHERE (resolved_at IS NOT NULL AND resolved_at > received_at + make_interval(mins => $3::int))
		                    OR (resolved_at IS NULL AND status IN ('BARU','DIVERIFIKASI','DIKERJAKAN') AND LEAST(now(), $2) > received_at + make_interval(mins => $3::int))),
		count(*) FILTER (WHERE outage_id IS NOT NULL),
		avg(EXTRACT(EPOCH FROM resolved_at - received_at) / 60) FILTER (WHERE resolved_at IS NOT NULL)
		FROM customer_reports WHERE received_at >= $1 AND received_at < $2`, from, to, int(slaMinutes)).
		Scan(&st.Reports, &st.ReportsResolved, &st.ReportsOpen, &st.ReportsOverdue, &st.ReportsLinked, &avg)
	if avg != nil {
		st.ReportAvgResolveM = *avg
	}
	rows, err = e.pool.Query(ctx, `SELECT 'c', category, count(*) FROM customer_reports WHERE received_at >= $1 AND received_at < $2 GROUP BY 2
		UNION ALL SELECT 'h', channel, count(*) FROM customer_reports WHERE received_at >= $1 AND received_at < $2 GROUP BY 2`, from, to)
	if err == nil {
		for rows.Next() {
			var t, k string
			var n int
			if rows.Scan(&t, &k, &n) == nil {
				if t == "c" {
					st.ReportCategories[k] = n
				} else {
					st.ReportChannels[k] = n
				}
			}
		}
		rows.Close()
	}
	return st, nil
}

// PendingPlans mengembalikan rencana yang disetujui tetapi belum selesai lebih dari `age`.
func (e *Exec) PendingPlans(ctx context.Context, age time.Duration) ([]Plan, error) {
	rows, err := e.pool.Query(ctx, `SELECT id, title, status, approved_at FROM switching_plans
		WHERE status IN ('approved','executing') AND COALESCE(approved_at, updated_at) < now() - make_interval(secs => $1)
		ORDER BY approved_at LIMIT 20`, age.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		var p Plan
		if rows.Scan(&p.ID, &p.Title, &p.Status, &p.ApprovedAt) == nil {
			out = append(out, p)
		}
	}
	return out, rows.Err()
}

// OverdueReports mengembalikan laporan pelanggan terbuka yang melewati SLA.
func (e *Exec) OverdueReports(ctx context.Context, slaMinutes float64, limit int) ([]Report, error) {
	rows, err := e.pool.Query(ctx, `SELECT id, ticket, category, priority, status, received_at FROM customer_reports
		WHERE status IN ('BARU','DIVERIFIKASI','DIKERJAKAN') AND received_at < now() - make_interval(mins => $1::int)
		ORDER BY received_at LIMIT $2`, int(slaMinutes), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		var r Report
		if rows.Scan(&r.ID, &r.Ticket, &r.Category, &r.Priority, &r.Status, &r.ReceivedAt) == nil {
			out = append(out, r)
		}
	}
	return out, rows.Err()
}

// Ready: graf topologi sudah dimuat & dikelompokkan (rekap pelanggan valid).
func (g *Graph) Ready() bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return !g.loading && len(g.nodes) > 0 && !g.groupsAt.IsZero()
}

// FeederTie adalah switch terbuka yang menghubungkan dua penyulang (titik manuver pelimpahan beban).
type FeederTie struct {
	Switch int64 `json:"switch_id"`
	A      int64 `json:"a"` // kepala penyulang
	B      int64 `json:"b"`
}

// FeederTies mengembalikan pasangan penyulang yang terhubung lewat switch terbuka (kondisi saat ini).
func (g *Graph) FeederTies() []FeederTie {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := []FeederTie{}
	seen := map[[3]int64]bool{}
	for id, n := range g.nodes {
		if !n.isSwitch() || (!n.open() && len(g.openWays[id]) == 0) {
			continue
		}
		fs := map[int64]bool{}
		for _, eid := range g.adj[id] {
			nb := g.nodes[g.edges[eid].other(id)]
			if nb.feeder != 0 {
				fs[nb.feeder] = true
			}
		}
		if n.feeder != 0 {
			fs[n.feeder] = true
		}
		list := make([]int64, 0, len(fs))
		for f := range fs {
			list = append(list, f)
		}
		sort.Slice(list, func(i, j int) bool { return list[i] < list[j] })
		for i := 0; i < len(list); i++ {
			for j := i + 1; j < len(list); j++ {
				k := [3]int64{id, list[i], list[j]}
				if !seen[k] {
					seen[k] = true
					out = append(out, FeederTie{Switch: id, A: list[i], B: list[j]})
				}
			}
		}
	}
	return out
}
