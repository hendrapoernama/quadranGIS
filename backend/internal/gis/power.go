package gis

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Power adalah lapisan persistensi monitoring kelistrikan: status energisasi,
// posisi switch, catatan manuver, dan kejadian padam.
type Power struct {
	pool *pgxpool.Pool
}

// NewPower membuat layanan persistensi kelistrikan.
func NewPower(pool *pgxpool.Pool) *Power { return &Power{pool: pool} }

// Jenis manuver yang dikenal.
var ManeuverKinds = []string{"GANGGUAN", "PEMELIHARAAN", "MLS", "MANUVER", "BENCANA ALAM"}

// ManeuverRecord adalah satu catatan manuver.
type ManeuverRecord struct {
	ID         int64           `json:"id"`
	TargetKind string          `json:"target_kind"` // node | edge
	NodeID     int64           `json:"node_id"`     // id node, atau id saluran bila target_kind=edge
	NodeCode   string          `json:"node_code"`
	NodeType   string          `json:"node_type"`
	Action     string          `json:"action"`
	WayEdgeID  *int64          `json:"way_edge_id"`
	Kind       string          `json:"kind"`
	Note       string          `json:"note"`
	UserID     *string         `json:"user_id"`
	Username   string          `json:"username"`
	Affected   json.RawMessage `json:"affected"`
	OutageID   *int64          `json:"outage_id"`
	CreatedAt  time.Time       `json:"created_at"`
}

// OutageRecord adalah satu kejadian padam (dari manuver open sampai close).
type OutageRecord struct {
	ID              int64           `json:"id"`
	Kind            string          `json:"kind"`
	Level           string          `json:"level"`
	CauseKind       string          `json:"cause_kind"` // node | edge
	GroupCode       string          `json:"group_code"`
	CauseNodeID     int64           `json:"cause_node_id"`
	CauseNodeCode   string          `json:"cause_node_code"`
	CauseNodeType   string          `json:"cause_node_type"`
	WayEdgeID       *int64          `json:"way_edge_id"`
	OpenManeuverID  *int64          `json:"open_maneuver_id"`
	CloseManeuverID *int64          `json:"close_maneuver_id"`
	StartedAt       time.Time       `json:"started_at"`
	EndedAt         *time.Time      `json:"ended_at"`
	Summary         json.RawMessage `json:"summary"`
	Restored        json.RawMessage `json:"restored"`
	AffectedCount   int             `json:"affected_count"`
	DurationSec     float64         `json:"duration_sec"`
	// indeks keandalan per kejadian (diisi handler)
	Customers       int     `json:"customers"`
	CustomerMinutes float64 `json:"customer_minutes"`
	ENSkWh          float64 `json:"ens_kwh"`
	ENSRp           float64 `json:"ens_rp"`
	Momentary       bool    `json:"momentary"`
}

func chunks(ids []int64, size int) [][]int64 {
	var out [][]int64
	for len(ids) > size {
		out = append(out, ids[:size])
		ids = ids[size:]
	}
	if len(ids) > 0 {
		out = append(out, ids)
	}
	return out
}

// ApplyEnergized menyimpan perubahan status energisasi ke DB (bertahap agar transaksi ringan).
func (p *Power) ApplyEnergized(ctx context.Context, d EnergyDiff) error {
	apply := func(table string, ids []int64, on bool) error {
		for _, c := range chunks(ids, 50000) {
			if _, err := p.pool.Exec(ctx, `UPDATE `+table+` SET energized=$2 WHERE id = ANY($1::bigint[]) AND energized <> $2`, c, on); err != nil {
				return err
			}
		}
		return nil
	}
	if err := apply("gis_nodes", d.NodesOn, true); err != nil {
		return err
	}
	if err := apply("gis_nodes", d.NodesOff, false); err != nil {
		return err
	}
	if err := apply("gis_edges", d.EdgesOn, true); err != nil {
		return err
	}
	return apply("gis_edges", d.EdgesOff, false)
}

// SetSwitchState menyimpan posisi switch (status & arah terbuka) setelah manuver.
func (p *Power) SetSwitchState(ctx context.Context, nodeID int64, open bool, openWays []int64, userID *string) error {
	status := "closed"
	if open {
		status = "open"
	}
	if openWays == nil {
		openWays = []int64{}
	}
	_, err := p.pool.Exec(ctx, `UPDATE gis_nodes SET status=$2, open_ways=$3, updated_by=COALESCE($4, updated_by), updated_at=now() WHERE id=$1`,
		nodeID, status, openWays, userID)
	return err
}

// InsertManeuver mencatat manuver.
func (p *Power) InsertManeuver(ctx context.Context, m ManeuverRecord) (int64, error) {
	if len(m.Affected) == 0 {
		m.Affected = json.RawMessage("{}")
	}
	var id int64
	if m.TargetKind == "" {
		m.TargetKind = "node"
	}
	err := p.pool.QueryRow(ctx, `INSERT INTO maneuvers (node_id, node_code, node_type, action, way_edge_id, kind, note, user_id, username, affected, outage_id, target_kind)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
		m.NodeID, m.NodeCode, m.NodeType, m.Action, m.WayEdgeID, m.Kind, m.Note, m.UserID, m.Username, []byte(m.Affected), m.OutageID, m.TargetKind).Scan(&id)
	return id, err
}

// LinkManeuverOutage mengaitkan manuver dengan kejadian padam.
func (p *Power) LinkManeuverOutage(ctx context.Context, maneuverID, outageID int64) error {
	_, err := p.pool.Exec(ctx, `UPDATE maneuvers SET outage_id=$2 WHERE id=$1`, maneuverID, outageID)
	return err
}

// OpenOutage membuka kejadian padam baru.
func (p *Power) OpenOutage(ctx context.Context, o OutageRecord, affected []int64) (int64, error) {
	if len(o.Summary) == 0 {
		o.Summary = json.RawMessage("{}")
	}
	if affected == nil {
		affected = []int64{}
	}
	var id int64
	if o.CauseKind == "" {
		o.CauseKind = "node"
	}
	err := p.pool.QueryRow(ctx, `INSERT INTO outages (kind, level, group_code, cause_node_id, cause_node_code, cause_node_type, way_edge_id, open_maneuver_id, summary, affected_nodes, cause_kind)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
		o.Kind, o.Level, o.GroupCode, o.CauseNodeID, o.CauseNodeCode, o.CauseNodeType, o.WayEdgeID, o.OpenManeuverID, []byte(o.Summary), affected, o.CauseKind).Scan(&id)
	return id, err
}

// CloseOutages menutup kejadian padam aktif yang disebabkan alat (dan arah) yang sama.
func (p *Power) CloseOutages(ctx context.Context, causeKind string, causeNodeID int64, wayEdge *int64, closeManeuverID int64, restored json.RawMessage) ([]int64, error) {
	if len(restored) == 0 {
		restored = json.RawMessage("{}")
	}
	rows, err := p.pool.Query(ctx, `UPDATE outages SET ended_at=now(), close_maneuver_id=$2, restored=$3
		WHERE cause_node_id=$1 AND cause_kind=$5 AND ended_at IS NULL AND way_edge_id IS NOT DISTINCT FROM $4 RETURNING id`, causeNodeID, closeManeuverID, []byte(restored), wayEdge, causeKind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectIDs(rows)
}

const outageCols = `id, kind, level, group_code, cause_node_id, cause_node_code, cause_node_type, way_edge_id, open_maneuver_id, close_maneuver_id,
	started_at, ended_at, summary, restored, cardinality(affected_nodes), EXTRACT(EPOCH FROM COALESCE(ended_at, now()) - started_at), cause_kind`

func scanOutage(rows pgx.Rows) (OutageRecord, error) {
	var o OutageRecord
	var summary, restored []byte
	err := rows.Scan(&o.ID, &o.Kind, &o.Level, &o.GroupCode, &o.CauseNodeID, &o.CauseNodeCode, &o.CauseNodeType, &o.WayEdgeID, &o.OpenManeuverID, &o.CloseManeuverID,
		&o.StartedAt, &o.EndedAt, &summary, &restored, &o.AffectedCount, &o.DurationSec, &o.CauseKind)
	if len(summary) > 0 {
		o.Summary = json.RawMessage(summary)
	} else {
		o.Summary = json.RawMessage("{}")
	}
	if len(restored) > 0 {
		o.Restored = json.RawMessage(restored)
	}
	return o, err
}

// ListOutages mengembalikan kejadian padam (aktif saja atau termasuk riwayat).
func (p *Power) ListOutages(ctx context.Context, activeOnly bool, limit int) ([]OutageRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + outageCols + ` FROM outages`
	if activeOnly {
		q += ` WHERE ended_at IS NULL`
	}
	q += ` ORDER BY started_at DESC LIMIT $1`
	rows, err := p.pool.Query(ctx, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OutageRecord{}
	for rows.Next() {
		o, err := scanOutage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// GetOutage mengambil satu kejadian padam beserta daftar node terdampak.
func (p *Power) GetOutage(ctx context.Context, id int64) (OutageRecord, []int64, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+outageCols+` FROM outages WHERE id=$1`, id)
	if err != nil {
		return OutageRecord{}, nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return OutageRecord{}, nil, ErrNotFound
	}
	o, err := scanOutage(rows)
	if err != nil {
		return OutageRecord{}, nil, err
	}
	rows.Close()
	var affected []int64
	if err := p.pool.QueryRow(ctx, `SELECT affected_nodes FROM outages WHERE id=$1`, id).Scan(&affected); err != nil {
		return o, nil, err
	}
	return o, affected, nil
}

// CountActiveOutages menghitung kejadian padam yang masih berlangsung.
func (p *Power) CountActiveOutages(ctx context.Context) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `SELECT count(*) FROM outages WHERE ended_at IS NULL`).Scan(&n)
	return n, err
}

// ListManeuvers mengembalikan riwayat manuver (opsional per alat).
func (p *Power) ListManeuvers(ctx context.Context, nodeID int64, limit int) ([]ManeuverRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT id, node_id, node_code, node_type, action, way_edge_id, kind, note, user_id, username, affected, outage_id, created_at, target_kind FROM maneuvers`
	args := []any{limit}
	if nodeID > 0 {
		q += ` WHERE node_id=$2`
		args = append(args, nodeID)
	}
	q += ` ORDER BY created_at DESC LIMIT $1`
	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManeuverRecord{}
	for rows.Next() {
		var m ManeuverRecord
		var affected []byte
		var uid *string
		if err := rows.Scan(&m.ID, &m.NodeID, &m.NodeCode, &m.NodeType, &m.Action, &m.WayEdgeID, &m.Kind, &m.Note, &uid, &m.Username, &affected, &m.OutageID, &m.CreatedAt, &m.TargetKind); err != nil {
			return nil, err
		}
		m.UserID = uid
		if len(affected) > 0 {
			m.Affected = json.RawMessage(affected)
		} else {
			m.Affected = json.RawMessage("{}")
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// CodeName adalah pasangan kode & nama fitur.
type CodeName struct {
	ID       int64  `json:"id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	TypeCode string `json:"type_code"`
}

// NodeCodes mengambil kode & nama untuk sekumpulan id node.
func (p *Power) NodeCodes(ctx context.Context, ids []int64) (map[int64]CodeName, error) {
	out := map[int64]CodeName{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := p.pool.Query(ctx, `SELECT id, code, name, type_code FROM gis_nodes WHERE id = ANY($1::bigint[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c CodeName
		if err := rows.Scan(&c.ID, &c.Code, &c.Name, &c.TypeCode); err != nil {
			return nil, err
		}
		out[c.ID] = c
	}
	return out, rows.Err()
}

// EdgeCodes mengambil kode & nama untuk sekumpulan id edge.
func (p *Power) EdgeCodes(ctx context.Context, ids []int64) (map[int64]CodeName, error) {
	out := map[int64]CodeName{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := p.pool.Query(ctx, `SELECT id, code, name, type_code FROM gis_edges WHERE id = ANY($1::bigint[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c CodeName
		if err := rows.Scan(&c.ID, &c.Code, &c.Name, &c.TypeCode); err != nil {
			return nil, err
		}
		out[c.ID] = c
	}
	return out, rows.Err()
}

// RouteTrafo mengembalikan trafo distribusi di ujung hulu sebuah saluran TR (jurusan), bila ada.
func (p *Power) RouteTrafo(ctx context.Context, routeEdge int64) (CodeName, bool) {
	var c CodeName
	// jurusan berawal di trafo langsung, atau di rak TR (trafo tersambung ke rak)
	err := p.pool.QueryRow(ctx, `WITH ends AS (
			SELECT unnest(ARRAY[e.from_node_id, e.to_node_id]) AS id FROM gis_edges e WHERE e.id=$1),
		cand AS (
			SELECT id FROM ends
			UNION
			SELECT CASE WHEN x.from_node_id = r.id THEN x.to_node_id ELSE x.from_node_id END
			FROM ends JOIN gis_nodes r ON r.id = ends.id AND r.type_code = 'rak_tr'
			JOIN gis_edges x ON r.id IN (x.from_node_id, x.to_node_id))
		SELECT n.id, n.code, n.name, n.type_code FROM gis_nodes n JOIN cand ON cand.id = n.id
		WHERE n.type_code='trafo_distribusi' LIMIT 1`, routeEdge).Scan(&c.ID, &c.Code, &c.Name, &c.TypeCode)
	return c, err == nil
}

// ActiveOutageKind mengembalikan jenis kejadian padam aktif untuk target (untuk penutupan tanpa jenis).
func (p *Power) ActiveOutageKind(ctx context.Context, causeKind string, causeID int64, wayEdge *int64) string {
	var k string
	_ = p.pool.QueryRow(ctx, `SELECT kind FROM outages WHERE cause_node_id=$1 AND cause_kind=$2 AND ended_at IS NULL
		AND way_edge_id IS NOT DISTINCT FROM $3 ORDER BY started_at DESC LIMIT 1`, causeID, causeKind, wayEdge).Scan(&k)
	return k
}

// SetEdgeState menyimpan status saluran (open = diputus) setelah manuver.
func (p *Power) SetEdgeState(ctx context.Context, edgeID int64, open bool, userID *string) error {
	status := "closed"
	if open {
		status = "open"
	}
	_, err := p.pool.Exec(ctx, `UPDATE gis_edges SET status=$2, updated_by=COALESCE($3, updated_by), updated_at=now() WHERE id=$1`, edgeID, status, userID)
	return err
}

// ListOutagesBetween mengembalikan kejadian padam yang beririsan dengan periode [from, to).
func (p *Power) ListOutagesBetween(ctx context.Context, from, to time.Time, limit int) ([]OutageRecord, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := p.pool.Query(ctx, `SELECT `+outageCols+` FROM outages
		WHERE started_at < $2 AND (ended_at IS NULL OR ended_at > $1) ORDER BY started_at DESC LIMIT $3`, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OutageRecord{}
	for rows.Next() {
		o, err := scanOutage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ReliabilityParams adalah parameter perhitungan indeks keandalan.
type ReliabilityParams struct {
	TariffRpPerKWh   float64 `json:"tariff_rp_per_kwh"`
	LoadFactor       float64 `json:"load_factor"`
	PowerFactor      float64 `json:"power_factor"`
	SustainedMinutes float64 `json:"sustained_minutes"`
}

// ReliabilityGroup adalah akumulasi indeks untuk satu kelompok (total / level / jenis).
type ReliabilityGroup struct {
	Outages         int     `json:"outages"`
	Momentary       int     `json:"momentary"`
	CustomersOut    int     `json:"customers_out"` // jumlah pelanggan-padam (kejadian sustained)
	CustomerMinutes float64 `json:"customer_minutes"`
	SAIDI           float64 `json:"saidi"` // menit / pelanggan
	SAIFI           float64 `json:"saifi"` // kali / pelanggan
	ENSkWh          float64 `json:"ens_kwh"`
	ENSRp           float64 `json:"ens_rp"`
}

// ApplyReliability mengisi indeks per kejadian, dengan durasi dipotong ke periode [from, to).
func ApplyReliability(o *OutageRecord, from, to time.Time, rp ReliabilityParams) {
	var sum struct {
		Customers int     `json:"pelanggan"`
		LoadVA    float64 `json:"beban_va"`
	}
	_ = json.Unmarshal(o.Summary, &sum)
	end := time.Now()
	if o.EndedAt != nil {
		end = *o.EndedAt
	}
	start := o.StartedAt
	if !from.IsZero() && start.Before(from) {
		start = from
	}
	if !to.IsZero() && end.After(to) {
		end = to
	}
	minutes := end.Sub(start).Minutes()
	if minutes < 0 {
		minutes = 0
	}
	o.Customers = sum.Customers
	o.Momentary = o.EndedAt != nil && o.DurationSec/60 < rp.SustainedMinutes
	o.CustomerMinutes = float64(sum.Customers) * minutes
	o.ENSkWh = sum.LoadVA / 1000 * rp.LoadFactor * rp.PowerFactor * minutes / 60
	o.ENSRp = o.ENSkWh * rp.TariffRpPerKWh
}

// Add menambahkan satu kejadian ke kelompok.
func (g *ReliabilityGroup) Add(o OutageRecord) {
	g.Outages++
	g.ENSkWh += o.ENSkWh
	g.ENSRp += o.ENSRp
	if o.Momentary {
		g.Momentary++
		return
	}
	g.CustomersOut += o.Customers
	g.CustomerMinutes += o.CustomerMinutes
}

// Finish menghitung SAIDI & SAIFI terhadap jumlah pelanggan yang dilayani.
func (g *ReliabilityGroup) Finish(totalCustomers int) {
	if totalCustomers > 0 {
		g.SAIDI = g.CustomerMinutes / float64(totalCustomers)
		g.SAIFI = float64(g.CustomersOut) / float64(totalCustomers)
	}
}
