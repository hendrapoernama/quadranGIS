package gis

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Ops menyimpan rencana manuver dan laporan gangguan pelanggan.
type Ops struct {
	pool *pgxpool.Pool
}

// NewOps membuat repositori operasi jaringan (rencana manuver // NewOps membuat repositori Pusat Operasi. laporan gangguan).
func NewOps(pool *pgxpool.Pool) *Ops { return &Ops{pool: pool} }

// ---------------------------------------------------------------- rencana manuver

// PlanStep adalah satu langkah rencana manuver.
type PlanStep struct {
	ID         int64      `json:"id"`
	Seq        int        `json:"seq"`
	TargetKind string     `json:"target_kind"`
	TargetID   int64      `json:"target_id"`
	TargetCode string     `json:"target_code"`
	TargetType string     `json:"target_type"`
	Action     string     `json:"action"`
	WayEdgeID  *int64     `json:"way_edge_id"`
	Note       string     `json:"note"`
	Status     string     `json:"status"`
	ExecutedAt *time.Time `json:"executed_at"`
	ExecutedBy string     `json:"executed_by"`
	ManeuverID *int64     `json:"maneuver_id"`
	Error      string     `json:"error"`
}

// Plan adalah rencana manuver.
type Plan struct {
	ID             int64           `json:"id"`
	Title          string          `json:"title"`
	Kind           string          `json:"kind"`
	Status         string          `json:"status"`
	Source         string          `json:"source"`
	OutageID       *int64          `json:"outage_id"`
	Fault          json.RawMessage `json:"fault"`
	Note           string          `json:"note"`
	CreatedByName  string          `json:"created_by_name"`
	ApprovedByName string          `json:"approved_by_name"`
	ApprovedAt     *time.Time      `json:"approved_at"`
	StartedAt      *time.Time      `json:"started_at"`
	FinishedAt     *time.Time      `json:"finished_at"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
	StepsTotal     int             `json:"steps_total"`
	StepsDone      int             `json:"steps_done"`
	Steps          []PlanStep      `json:"steps,omitempty"`
}

const planCols = `p.id, p.title, p.kind, p.status, p.source, p.outage_id, p.fault, p.note, p.created_by_name, p.approved_by_name,
	p.approved_at, p.started_at, p.finished_at, p.created_at, p.updated_at,
	(SELECT count(*) FROM switching_plan_steps s WHERE s.plan_id = p.id),
	(SELECT count(*) FROM switching_plan_steps s WHERE s.plan_id = p.id AND s.status IN ('done','skipped'))`

func scanPlan(row pgx.Row) (Plan, error) {
	var p Plan
	var fault []byte
	err := row.Scan(&p.ID, &p.Title, &p.Kind, &p.Status, &p.Source, &p.OutageID, &fault, &p.Note, &p.CreatedByName, &p.ApprovedByName,
		&p.ApprovedAt, &p.StartedAt, &p.FinishedAt, &p.CreatedAt, &p.UpdatedAt, &p.StepsTotal, &p.StepsDone)
	if len(fault) > 0 {
		p.Fault = fault
	}
	return p, err
}

// ListPlans mengembalikan rencana terbaru (status "" = semua, "active" = draft/approved/executing).
func (o *Ops) ListPlans(ctx context.Context, status string, limit int) ([]Plan, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	where := "true"
	args := []any{limit}
	switch status {
	case "":
	case "active":
		where = "p.status IN ('draft','approved','executing')"
	default:
		where = "p.status = $2"
		args = append(args, status)
	}
	rows, err := o.pool.Query(ctx, `SELECT `+planCols+` FROM switching_plans p WHERE `+where+` ORDER BY p.created_at DESC LIMIT $1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetPlan mengembalikan rencana beserta langkahnya.
func (o *Ops) GetPlan(ctx context.Context, id int64) (Plan, error) {
	p, err := scanPlan(o.pool.QueryRow(ctx, `SELECT `+planCols+` FROM switching_plans p WHERE p.id = $1`, id))
	if err != nil {
		if err == pgx.ErrNoRows {
			return p, ErrNotFound
		}
		return p, err
	}
	rows, err := o.pool.Query(ctx, `SELECT id, seq, target_kind, target_id, target_code, target_type, action, way_edge_id, note, status,
		executed_at, executed_by, maneuver_id, error FROM switching_plan_steps WHERE plan_id = $1 ORDER BY seq`, id)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.Steps = []PlanStep{}
	for rows.Next() {
		var s PlanStep
		if err := rows.Scan(&s.ID, &s.Seq, &s.TargetKind, &s.TargetID, &s.TargetCode, &s.TargetType, &s.Action, &s.WayEdgeID, &s.Note, &s.Status,
			&s.ExecutedAt, &s.ExecutedBy, &s.ManeuverID, &s.Error); err != nil {
			return p, err
		}
		p.Steps = append(p.Steps, s)
	}
	return p, rows.Err()
}

// SavePlan membuat (id = 0) atau mengganti rencana draft beserta seluruh langkahnya.
func (o *Ops) SavePlan(ctx context.Context, p Plan, userID *string, username string) (int64, error) {
	tx, err := o.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var fault any
	if len(p.Fault) > 0 {
		fault = []byte(p.Fault)
	}
	if p.ID == 0 {
		err = tx.QueryRow(ctx, `INSERT INTO switching_plans (title, kind, source, outage_id, fault, note, created_by, created_by_name)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, p.Title, p.Kind, p.Source, p.OutageID, fault, p.Note, userID, username).Scan(&p.ID)
		if err != nil {
			return 0, err
		}
	} else {
		tag, err := tx.Exec(ctx, `UPDATE switching_plans SET title=$2, kind=$3, note=$4, updated_at=now() WHERE id=$1 AND status='draft'`,
			p.ID, p.Title, p.Kind, p.Note)
		if err != nil {
			return 0, err
		}
		if tag.RowsAffected() == 0 {
			return 0, ErrBadRequest
		}
		if _, err := tx.Exec(ctx, `DELETE FROM switching_plan_steps WHERE plan_id=$1`, p.ID); err != nil {
			return 0, err
		}
	}
	for i, s := range p.Steps {
		if _, err := tx.Exec(ctx, `INSERT INTO switching_plan_steps (plan_id, seq, target_kind, target_id, target_code, target_type, action, way_edge_id, note)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, p.ID, i+1, s.TargetKind, s.TargetID, s.TargetCode, s.TargetType, s.Action, s.WayEdgeID, s.Note); err != nil {
			return 0, err
		}
	}
	return p.ID, tx.Commit(ctx)
}

// SetPlanStatus mengubah status rencana (dengan status asal yang diizinkan).
func (o *Ops) SetPlanStatus(ctx context.Context, id int64, to string, from []string, username string) error {
	extra := ""
	switch to {
	case "approved":
		extra = ", approved_by_name=$4, approved_at=now()"
	case "executing":
		extra = ", started_at=COALESCE(started_at, now())"
	case "done", "cancelled":
		extra = ", finished_at=now()"
	}
	args := []any{id, to, from}
	if to == "approved" {
		args = append(args, username)
	}
	tag, err := o.pool.Exec(ctx, `UPDATE switching_plans SET status=$2, updated_at=now()`+extra+` WHERE id=$1 AND status = ANY($3)`, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrBadRequest
	}
	return nil
}

// DeletePlan menghapus rencana draft / batal.
func (o *Ops) DeletePlan(ctx context.Context, id int64) error {
	tag, err := o.pool.Exec(ctx, `DELETE FROM switching_plans WHERE id=$1 AND status IN ('draft','cancelled')`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrBadRequest
	}
	return nil
}

// MarkStep mencatat hasil eksekusi satu langkah, lalu menutup rencana bila semua langkah selesai.
func (o *Ops) MarkStep(ctx context.Context, planID int64, seq int, status, username string, maneuverID *int64, errMsg string) (bool, error) {
	if _, err := o.pool.Exec(ctx, `UPDATE switching_plan_steps SET status=$3, executed_at=now(), executed_by=$4, maneuver_id=$5, error=$6
		WHERE plan_id=$1 AND seq=$2`, planID, seq, status, username, maneuverID, errMsg); err != nil {
		return false, err
	}
	var left int
	if err := o.pool.QueryRow(ctx, `SELECT count(*) FROM switching_plan_steps WHERE plan_id=$1 AND status NOT IN ('done','skipped')`, planID).Scan(&left); err != nil {
		return false, err
	}
	if left == 0 {
		_, err := o.pool.Exec(ctx, `UPDATE switching_plans SET status='done', finished_at=now(), updated_at=now() WHERE id=$1`, planID)
		return true, err
	}
	_, err := o.pool.Exec(ctx, `UPDATE switching_plans SET status='executing', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1 AND status='approved'`, planID)
	return false, err
}

// ---------------------------------------------------------------- laporan gangguan pelanggan

// ReportCategories, ReportChannels, ReportStatuses adalah nilai yang dikenal.
var (
	ReportCategories = []string{"PADAM", "PADAM_SEBAGIAN", "TEGANGAN", "KABEL_PUTUS", "TIANG", "BAHAYA", "LAINNYA"}
	ReportChannels   = []string{"TELEPON", "WA", "APLIKASI", "CALL_CENTER", "LANGSUNG", "MEDSOS", "LAPANGAN"}
	ReportStatuses   = []string{"BARU", "DIVERIFIKASI", "DIKERJAKAN", "SELESAI", "BATAL"}
	ReportPriorities = []string{"NORMAL", "TINGGI", "DARURAT"}
)

// Report adalah laporan gangguan pelanggan.
type Report struct {
	ID            int64           `json:"id"`
	Ticket        string          `json:"ticket"`
	ReceivedAt    time.Time       `json:"received_at"`
	Channel       string          `json:"channel"`
	ReporterName  string          `json:"reporter_name"`
	ReporterPhone string          `json:"reporter_phone"`
	CustomerID    *int64          `json:"customer_id"`
	CustomerCode  string          `json:"customer_code"`
	Address       string          `json:"address"`
	Lng           *float64        `json:"lng"`
	Lat           *float64        `json:"lat"`
	Category      string          `json:"category"`
	Description   string          `json:"description"`
	Priority      string          `json:"priority"`
	Status        string          `json:"status"`
	Energized     *bool           `json:"energized"`
	OutageID      *int64          `json:"outage_id"`
	GDID          *int64          `json:"gd_id"`
	FeederID      *int64          `json:"feeder_id"`
	RouteID       *int64          `json:"route_id"`
	AssignedTo    string          `json:"assigned_to"`
	Note          string          `json:"note"`
	History       json.RawMessage `json:"history"`
	CreatedByName string          `json:"created_by_name"`
	ResolvedAt    *time.Time      `json:"resolved_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	AgeMinutes    float64         `json:"age_minutes"`
	// diisi handler
	GDCode     string `json:"gd_code,omitempty"`
	FeederCode string `json:"feeder_code,omitempty"`
	RouteCode  string `json:"route_code,omitempty"`
	// laporan dari antrean offline: kunci idempoten & waktu dibuat di perangkat
	ClientID  *string    `json:"client_id,omitempty"`
	OfflineAt *time.Time `json:"-"`
}

const reportCols = `id, ticket, received_at, channel, reporter_name, reporter_phone, customer_id, customer_code, address,
	COALESCE(lng, (SELECT ST_X(n.geom) FROM gis_nodes n WHERE n.id = customer_id)),
	COALESCE(lat, (SELECT ST_Y(n.geom) FROM gis_nodes n WHERE n.id = customer_id)),
	category, description, priority, status, energized, outage_id, gd_id, feeder_id, route_id, assigned_to, note, history,
	created_by_name, resolved_at, updated_at, EXTRACT(EPOCH FROM COALESCE(resolved_at, now()) - received_at) / 60`

func scanReport(row pgx.Row) (Report, error) {
	var r Report
	var hist []byte
	err := row.Scan(&r.ID, &r.Ticket, &r.ReceivedAt, &r.Channel, &r.ReporterName, &r.ReporterPhone, &r.CustomerID, &r.CustomerCode, &r.Address,
		&r.Lng, &r.Lat, &r.Category, &r.Description, &r.Priority, &r.Status, &r.Energized, &r.OutageID, &r.GDID, &r.FeederID, &r.RouteID,
		&r.AssignedTo, &r.Note, &hist, &r.CreatedByName, &r.ResolvedAt, &r.UpdatedAt, &r.AgeMinutes)
	r.History = hist
	return r, err
}

// ReportFilter menyaring daftar laporan.
type ReportFilter struct {
	Status   string // "" | open | BARU | ...
	Category string
	Q        string
	Limit    int
}

// ListReports mengembalikan laporan terbaru.
func (o *Ops) ListReports(ctx context.Context, f ReportFilter) ([]Report, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 300
	}
	where, args := []string{"true"}, []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	switch f.Status {
	case "":
	case "open":
		where = append(where, "status IN ('BARU','DIVERIFIKASI','DIKERJAKAN')")
	default:
		add("status = $%d", f.Status)
	}
	if f.Category != "" {
		add("category = $%d", f.Category)
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		add("(ticket ILIKE $%[1]d OR customer_code ILIKE $%[1]d OR reporter_name ILIKE $%[1]d OR reporter_phone ILIKE $%[1]d OR address ILIKE $%[1]d)", "%"+q+"%")
	}
	args = append(args, f.Limit)
	rows, err := o.pool.Query(ctx, `SELECT `+reportCols+` FROM customer_reports WHERE `+strings.Join(where, " AND ")+
		fmt.Sprintf(` ORDER BY CASE status WHEN 'BARU' THEN 0 WHEN 'DIVERIFIKASI' THEN 1 WHEN 'DIKERJAKAN' THEN 2 ELSE 3 END,
		CASE priority WHEN 'DARURAT' THEN 0 WHEN 'TINGGI' THEN 1 ELSE 2 END, received_at DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		r, err := scanReport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetReport mengembalikan satu laporan.
func (o *Ops) GetReport(ctx context.Context, id int64) (Report, error) {
	r, err := scanReport(o.pool.QueryRow(ctx, `SELECT `+reportCols+` FROM customer_reports WHERE id=$1`, id))
	if err == pgx.ErrNoRows {
		return r, ErrNotFound
	}
	return r, err
}

// CreateReport menyimpan laporan baru dan mengembalikan id & nomor tiket.
func (o *Ops) CreateReport(ctx context.Context, r Report, userID *string, username string) (int64, string, error) {
	var id int64
	var ticket string
	// laporan offline yang dikirim ulang (client_id sama) tidak dibuat dua kali
	if r.ClientID != nil && *r.ClientID != "" {
		if err := o.pool.QueryRow(ctx, `SELECT id, ticket FROM customer_reports WHERE client_id = $1`, *r.ClientID).Scan(&id, &ticket); err == nil {
			return id, ticket, ErrConflict
		}
	}
	hist, _ := json.Marshal([]map[string]any{{"at": time.Now(), "by": username, "status": "BARU", "note": "laporan diterima"}})
	err := o.pool.QueryRow(ctx, `WITH n AS (SELECT nextval('customer_reports_id_seq') AS id)
		INSERT INTO customer_reports (id, ticket, channel, reporter_name, reporter_phone, customer_id, customer_code, address, lng, lat,
		category, description, priority, energized, outage_id, gd_id, feeder_id, route_id, history, created_by, created_by_name, client_id, received_at)
		SELECT n.id, 'LG-' || to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYYYMMDD') || '-' || lpad(n.id::text, 5, '0'),
		$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, COALESCE($21, now()) FROM n
		RETURNING id, ticket`,
		r.Channel, r.ReporterName, r.ReporterPhone, r.CustomerID, r.CustomerCode, r.Address, r.Lng, r.Lat,
		r.Category, r.Description, r.Priority, r.Energized, r.OutageID, r.GDID, r.FeederID, r.RouteID, hist, userID, username, r.ClientID, r.OfflineAt).Scan(&id, &ticket)
	return id, ticket, err
}

// UpdateReport mengubah status / penugasan / catatan dan menambah riwayat.
func (o *Ops) UpdateReport(ctx context.Context, id int64, status, priority, assigned, note, username string) error {
	entry, _ := json.Marshal([]map[string]any{{"at": time.Now(), "by": username, "status": status, "note": note, "assigned_to": assigned}})
	tag, err := o.pool.Exec(ctx, `UPDATE customer_reports SET
		status = COALESCE(NULLIF($2,''), status),
		priority = COALESCE(NULLIF($3,''), priority),
		assigned_to = CASE WHEN $4 = '-' THEN '' WHEN $4 <> '' THEN $4 ELSE assigned_to END,
		note = CASE WHEN $5 <> '' THEN $5 ELSE note END,
		resolved_at = CASE WHEN COALESCE(NULLIF($2,''), status) IN ('SELESAI','BATAL') THEN COALESCE(resolved_at, now()) ELSE NULL END,
		history = history || $6::jsonb, updated_at = now()
		WHERE id = $1`, id, status, priority, assigned, note, entry)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// LinkReportsToOutage menautkan laporan terbuka (belum tertaut) ke kejadian padam yang mencakup pelanggannya.
func (o *Ops) LinkReportsToOutage(ctx context.Context, outageID int64, affected []int64) (int64, error) {
	tag, err := o.pool.Exec(ctx, `UPDATE customer_reports SET outage_id=$1, energized=false, updated_at=now(),
		history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', 'sistem', 'status', status, 'note', 'tertaut ke kejadian padam #' || $1))
		WHERE outage_id IS NULL AND status IN ('BARU','DIVERIFIKASI','DIKERJAKAN') AND customer_id = ANY($2)`, outageID, affected)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ResolveReportsForOutages menyelesaikan laporan yang tertaut ke kejadian padam yang sudah pulih.
func (o *Ops) ResolveReportsForOutages(ctx context.Context, outageIDs []int64) ([]int64, error) {
	rows, err := o.pool.Query(ctx, `UPDATE customer_reports SET status='SELESAI', resolved_at=now(), energized=true, updated_at=now(),
		history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', 'sistem', 'status', 'SELESAI', 'note', 'pasokan pulih (kejadian padam #' || outage_id || ' ditutup)'))
		WHERE outage_id = ANY($1) AND status IN ('BARU','DIVERIFIKASI','DIKERJAKAN') RETURNING id`, outageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

// NearestCustomer mencari pelanggan terdekat dari koordinat (radius meter).
func (o *Ops) NearestCustomer(ctx context.Context, lng, lat, radiusM float64) (int64, string, error) {
	var id int64
	var code string
	err := o.pool.QueryRow(ctx, `SELECT n.id, n.code FROM gis_nodes n
		WHERE n.type_code IN ('pelanggan_tr','pelanggan_tm','pelanggan_tt')
		  AND ST_DWithin(n.geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
		ORDER BY n.geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`, lng, lat, radiusM).Scan(&id, &code)
	if err == pgx.ErrNoRows {
		return 0, "", ErrNotFound
	}
	return id, code, err
}

// FindCustomer mencari pelanggan dari kode / kode SSOT / idpel.
func (o *Ops) FindCustomer(ctx context.Context, code string) (int64, string, error) {
	var id int64
	var c string
	err := o.pool.QueryRow(ctx, `SELECT id, code FROM gis_nodes
		WHERE type_code IN ('pelanggan_tr','pelanggan_tm','pelanggan_tt')
		  AND (code = $1 OR properties->>'kode_ssot' = $1 OR properties->>'idpel' = $1) LIMIT 1`, strings.TrimSpace(code)).Scan(&id, &c)
	if err == pgx.ErrNoRows {
		return 0, "", ErrNotFound
	}
	return id, c, err
}

// ReportStats merangkum laporan terbuka.
func (o *Ops) ReportStats(ctx context.Context, slaMinutes float64) (map[string]int, error) {
	out := map[string]int{}
	rows, err := o.pool.Query(ctx, `SELECT status, count(*) FROM customer_reports
		WHERE status IN ('BARU','DIVERIFIKASI','DIKERJAKAN') OR received_at > now() - interval '1 day' GROUP BY status`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s string
		var n int
		if rows.Scan(&s, &n) == nil {
			out[s] = n
		}
	}
	rows.Close()
	var overdue int
	_ = o.pool.QueryRow(ctx, `SELECT count(*) FROM customer_reports WHERE status IN ('BARU','DIVERIFIKASI','DIKERJAKAN')
		AND received_at < now() - make_interval(mins => $1::int)`, int(slaMinutes)).Scan(&overdue)
	out["overdue"] = overdue
	return out, nil
}
