// Package load mengelola pembebanan (load profile) trafo GI, penyulang, dan gardu distribusi dari data
// SCADA/AMR 30 menit: penyimpanan, rekap harian, profil dasar, deteksi anomali, susut energi, simulator,
// dan analisa lanjutan. Besaran beban utama adalah daya aktif (MW); pembebanan % = MW ÷ daya mampu MW.
package load

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound: data tidak ada.
var ErrNotFound = errors.New("not found")

// Loc adalah zona waktu laporan (WIB).
var Loc = func() *time.Location {
	if tz, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		return tz
	}
	return time.FixedZone("WIB", 7*3600)
}()

// SlotOf mengembalikan nomor slot 30 menit (0..47) waktu WIB.
func SlotOf(t time.Time) int {
	l := t.In(Loc)
	return l.Hour()*2 + l.Minute()/30
}

// Kinds adalah jenis titik ukur.
var Kinds = []string{"feeder", "trafo_gi", "gd"}

// Point adalah titik ukur SCADA/AMR yang dipetakan ke objek GIS.
type Point struct {
	ID        int        `json:"id"`
	Code      string     `json:"code"`
	Kind      string     `json:"kind"` // feeder | trafo_gi | gd
	NodeID    *int64     `json:"node_id"`
	Name      string     `json:"name"`
	RatingA   *float64   `json:"rating_a"`
	RatingMVA *float64   `json:"rating_mva"` // trafo GI: MVA, gardu: kVA/1000
	KV        float64    `json:"kv"`
	Active    bool       `json:"active"`
	GIID      *int64     `json:"gi_id"`
	TrafoGIID *int64     `json:"trafo_gi_id"`
	FeederID  *int64     `json:"feeder_id"` // kubikel penyulang (penyulang: dirinya, gardu: pemasok)
	UP3       string     `json:"up3"`
	ULP       string     `json:"ulp"`
	UID       string     `json:"uid"`
	LastTS    *time.Time `json:"last_ts"`
	// diisi handler
	GICode      string `json:"gi_code,omitempty"`
	TrafoGICode string `json:"trafo_gi_code,omitempty"`
	FeederCode  string `json:"feeder_code,omitempty"`
}

// CapMVA: kapasitas nominal (MVA); penyulang dengan rating arus: √3·kV·A.
func (p Point) CapMVA() float64 {
	if p.Kind != "feeder" && p.RatingMVA != nil && *p.RatingMVA > 0 {
		return *p.RatingMVA
	}
	if p.RatingA != nil && *p.RatingA > 0 {
		return math.Sqrt(3) * p.KV * *p.RatingA / 1000
	}
	if p.RatingMVA != nil {
		return *p.RatingMVA
	}
	return 0
}

// CapMW: daya mampu (MW) = kapasitas MVA × faktor daya kapasitas.
func (p Point) CapMW(capPF float64) float64 {
	if capPF <= 0 || capPF > 1 {
		capPF = 0.85
	}
	return p.CapMVA() * capPF
}

// Reading adalah satu data 30 menit.
type Reading struct {
	PointID  int       `json:"point_id"`
	TS       time.Time `json:"ts"`
	IR       *float64  `json:"i_r"`
	IS       *float64  `json:"i_s"`
	IT       *float64  `json:"i_t"`
	IAvg     *float64  `json:"i_avg"`
	VR       *float64  `json:"v_r"`
	VS       *float64  `json:"v_s"`
	VT       *float64  `json:"v_t"`
	V        *float64  `json:"v_kv"` // tegangan antarfasa (kV)
	P        *float64  `json:"p_mw"`
	Q        *float64  `json:"q_mvar"`
	S        *float64  `json:"s_mva"`
	PF       *float64  `json:"pf"`
	F        *float64  `json:"f_hz"`
	KWhImp   *float64  `json:"kwh_imp"`
	KWhExp   *float64  `json:"kwh_exp"`
	KVarhImp *float64  `json:"kvarh_imp"`
	KVarhExp *float64  `json:"kvarh_exp"`
	Util     *float64  `json:"util"`
	Quality  int       `json:"quality"`
}

// kolom float (urutan sama dengan fields())
const readingCols = `i_r, i_s, i_t, i_avg, v_r, v_s, v_t, v_kv, p_mw, q_mvar, s_mva, pf, f_hz, kwh_imp, kwh_exp, kvarh_imp, kvarh_exp, util`

func (x *Reading) fields() []**float64 {
	return []**float64{&x.IR, &x.IS, &x.IT, &x.IAvg, &x.VR, &x.VS, &x.VT, &x.V, &x.P, &x.Q, &x.S, &x.PF, &x.F, &x.KWhImp, &x.KWhExp, &x.KVarhImp, &x.KVarhExp, &x.Util}
}

// Repo adalah akses database pembebanan.
type Repo struct {
	pool *pgxpool.Pool
}

// NewRepo membuat repositori pembebanan.
func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Pool mengembalikan koneksi (untuk kueri analitik di paket ini).
func (r *Repo) Pool() *pgxpool.Pool { return r.pool }

const pointCols = `id, code, kind, node_id, name, rating_a, rating_mva, kv, active, gi_id, trafo_gi_id, feeder_id, up3, ulp, uid, last_ts`

func scanPoint(row pgx.Row) (Point, error) {
	var p Point
	err := row.Scan(&p.ID, &p.Code, &p.Kind, &p.NodeID, &p.Name, &p.RatingA, &p.RatingMVA, &p.KV, &p.Active, &p.GIID, &p.TrafoGIID, &p.FeederID, &p.UP3, &p.ULP, &p.UID, &p.LastTS)
	if err == pgx.ErrNoRows {
		return p, ErrNotFound
	}
	return p, err
}

// Points mengembalikan semua titik ukur.
func (r *Repo) Points(ctx context.Context) ([]Point, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+pointCols+` FROM scada_points ORDER BY kind DESC, code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Point{}
	for rows.Next() {
		p, err := scanPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Point mengembalikan satu titik.
func (r *Repo) Point(ctx context.Context, id int) (Point, error) {
	return scanPoint(r.pool.QueryRow(ctx, `SELECT `+pointCols+` FROM scada_points WHERE id = $1`, id))
}

// UpsertPoint menambah / memperbarui titik (kunci kode).
func (r *Repo) UpsertPoint(ctx context.Context, p Point) (int, error) {
	var id int
	err := r.pool.QueryRow(ctx, `INSERT INTO scada_points (code, kind, node_id, name, rating_a, rating_mva, kv, active, feeder_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, node_id = EXCLUDED.node_id, name = EXCLUDED.name,
			rating_a = EXCLUDED.rating_a, rating_mva = EXCLUDED.rating_mva, kv = EXCLUDED.kv, active = EXCLUDED.active,
			feeder_id = COALESCE(EXCLUDED.feeder_id, scada_points.feeder_id), updated_at = now()
		RETURNING id`, p.Code, p.Kind, p.NodeID, p.Name, p.RatingA, p.RatingMVA, p.KV, p.Active, p.FeederID).Scan(&id)
	if err == nil {
		_, _ = r.pool.Exec(ctx, `DELETE FROM scada_unmapped WHERE code = $1`, p.Code)
	}
	return id, err
}

// DeletePoint menghapus titik beserta datanya.
func (r *Repo) DeletePoint(ctx context.Context, id int) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, q := range []string{`DELETE FROM load_30m WHERE point_id = $1`, `DELETE FROM load_daily WHERE point_id = $1`,
		`DELETE FROM load_baseline WHERE point_id = $1`, `DELETE FROM load_anomalies WHERE point_id = $1`, `DELETE FROM scada_registers WHERE point_id = $1`} {
		if _, err := tx.Exec(ctx, q, id); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM scada_points WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Hierarchy adalah hasil sinkronisasi hierarki sebuah titik.
type Hierarchy struct {
	ID        int
	GIID      *int64
	TrafoGIID *int64
	FeederID  *int64
	UnitID    *int
	UP3, ULP  string
	UID       string
}

// SetHierarchy menyimpan hierarki titik (GI, trafo GI, penyulang, UP3, ULP, UID).
func (r *Repo) SetHierarchy(ctx context.Context, hs []Hierarchy) error {
	b := &pgx.Batch{}
	for _, h := range hs {
		b.Queue(`UPDATE scada_points SET gi_id = $2, trafo_gi_id = $3, feeder_id = $4, up3 = $5, ulp = $6, uid = $7, unit_id = $8
			WHERE id = $1 AND (gi_id IS DISTINCT FROM $2 OR trafo_gi_id IS DISTINCT FROM $3 OR feeder_id IS DISTINCT FROM $4
			  OR up3 <> $5 OR ulp <> $6 OR uid <> $7 OR unit_id IS DISTINCT FROM $8)`, h.ID, h.GIID, h.TrafoGIID, h.FeederID, h.UP3, h.ULP, h.UID, h.UnitID)
	}
	return r.pool.SendBatch(ctx, b).Close()
}

// NodeRegions: UP3/ULP/UID tempat titik node berada (dari poligon ULP).
func (r *Repo) NodeRegions(ctx context.Context, ids []int64, defUID string) (map[int64][3]string, error) {
	out := map[int64][3]string{}
	rows, err := r.pool.Query(ctx, `SELECT n.id, COALESCE(u.parent, ''), COALESCE(u.name, ''),
		COALESCE(up.properties->>'uid', '')
		FROM gis_nodes n
		LEFT JOIN gis_boundaries u ON u.level = 'ulp' AND ST_Intersects(u.geom, n.geom)
		LEFT JOIN gis_boundaries up ON up.level = 'up3' AND up.name = u.parent
		WHERE n.id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var up3, ulp, uid string
		if rows.Scan(&id, &up3, &ulp, &uid) == nil {
			if uid == "" {
				uid = defUID
			}
			out[id] = [3]string{up3, ulp, uid}
		}
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------ data 30 menit

// UpsertReadings menyimpan data (timpa bila titik & waktu sama) lalu memperbarui last_ts.
func (r *Repo) UpsertReadings(ctx context.Context, rs []Reading) error {
	if len(rs) == 0 {
		return nil
	}
	n := len(rs)
	pid := make([]int32, n)
	ts := make([]time.Time, n)
	const nf = 18
	cols := make([][]*float64, nf)
	for i := range cols {
		cols[i] = make([]*float64, n)
	}
	q := make([]int16, n)
	for i := range rs {
		x := &rs[i]
		pid[i], ts[i], q[i] = int32(x.PointID), x.TS, int16(x.Quality)
		for j, f := range x.fields() {
			cols[j][i] = *f
		}
	}
	args := []any{pid, ts}
	for _, c := range cols {
		args = append(args, c)
	}
	args = append(args, q)
	_, err := r.pool.Exec(ctx, `INSERT INTO load_30m (point_id, ts, `+readingCols+`, quality)
		SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[],
			$9::float8[], $10::float8[], $11::float8[], $12::float8[], $13::float8[], $14::float8[], $15::float8[], $16::float8[], $17::float8[],
			$18::float8[], $19::float8[], $20::float8[], $21::smallint[])
		ON CONFLICT (point_id, ts) DO UPDATE SET i_r = EXCLUDED.i_r, i_s = EXCLUDED.i_s, i_t = EXCLUDED.i_t, i_avg = EXCLUDED.i_avg,
			v_r = EXCLUDED.v_r, v_s = EXCLUDED.v_s, v_t = EXCLUDED.v_t, v_kv = EXCLUDED.v_kv, p_mw = EXCLUDED.p_mw, q_mvar = EXCLUDED.q_mvar,
			s_mva = EXCLUDED.s_mva, pf = EXCLUDED.pf, f_hz = EXCLUDED.f_hz, kwh_imp = EXCLUDED.kwh_imp, kwh_exp = EXCLUDED.kwh_exp,
			kvarh_imp = EXCLUDED.kvarh_imp, kvarh_exp = EXCLUDED.kvarh_exp, util = EXCLUDED.util, quality = EXCLUDED.quality, received_at = now()`,
		args...)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx, `UPDATE scada_points p SET last_ts = x.m FROM (
		SELECT u.pid, max(u.ts) m FROM unnest($1::int[], $2::timestamptz[]) u(pid, ts) GROUP BY u.pid) x
		WHERE p.id = x.pid AND (p.last_ts IS NULL OR p.last_ts < x.m)`, pid, ts)
	return err
}

// Register adalah nilai register meter energi (mode kumulatif).
type Register struct {
	TS                 time.Time
	KWhImp, KWhExp     *float64
	KVarhImp, KVarhExp *float64
}

// Registers memuat register terakhir semua titik.
func (r *Repo) Registers(ctx context.Context) (map[int]Register, error) {
	rows, err := r.pool.Query(ctx, `SELECT point_id, ts, kwh_imp, kwh_exp, kvarh_imp, kvarh_exp FROM scada_registers`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]Register{}
	for rows.Next() {
		var id int
		var g Register
		if rows.Scan(&id, &g.TS, &g.KWhImp, &g.KWhExp, &g.KVarhImp, &g.KVarhExp) == nil {
			out[id] = g
		}
	}
	return out, rows.Err()
}

// SaveRegisters menyimpan register terakhir.
func (r *Repo) SaveRegisters(ctx context.Context, regs map[int]Register) error {
	if len(regs) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	for id, g := range regs {
		b.Queue(`INSERT INTO scada_registers (point_id, ts, kwh_imp, kwh_exp, kvarh_imp, kvarh_exp) VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (point_id) DO UPDATE SET ts = EXCLUDED.ts, kwh_imp = EXCLUDED.kwh_imp, kwh_exp = EXCLUDED.kwh_exp,
			kvarh_imp = EXCLUDED.kvarh_imp, kvarh_exp = EXCLUDED.kvarh_exp WHERE scada_registers.ts <= EXCLUDED.ts`,
			id, g.TS, g.KWhImp, g.KWhExp, g.KVarhImp, g.KVarhExp)
	}
	return r.pool.SendBatch(ctx, b).Close()
}

// Unmapped mencatat kode titik yang belum dipetakan.
func (r *Repo) Unmapped(ctx context.Context, code, kind string, sample []byte) {
	_, _ = r.pool.Exec(ctx, `INSERT INTO scada_unmapped (code, kind, sample, messages) VALUES ($1, $2, $3, 1)
		ON CONFLICT (code) DO UPDATE SET last_seen = now(), messages = scada_unmapped.messages + 1, sample = EXCLUDED.sample, kind = EXCLUDED.kind`,
		code, kind, sample)
}

// UnmappedCode adalah kode tak dikenal dari SCADA.
type UnmappedCode struct {
	Code      string    `json:"code"`
	Kind      string    `json:"kind"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
	Messages  int64     `json:"messages"`
}

// UnmappedList mengembalikan kode belum dipetakan.
func (r *Repo) UnmappedList(ctx context.Context) ([]UnmappedCode, error) {
	rows, err := r.pool.Query(ctx, `SELECT code, kind, first_seen, last_seen, messages FROM scada_unmapped ORDER BY last_seen DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UnmappedCode{}
	for rows.Next() {
		var u UnmappedCode
		if rows.Scan(&u.Code, &u.Kind, &u.FirstSeen, &u.LastSeen, &u.Messages) == nil {
			out = append(out, u)
		}
	}
	return out, rows.Err()
}

// EnergySQL: energi impor satu slot (MWh) — dari meter kWh, atau integrasi MW × 0,5 jam bila meter kosong.
const EnergySQL = `COALESCE(kwh_imp / 1000.0, GREATEST(COALESCE(p_mw, 0), 0) * 0.5)`

// EnergyExpSQL: energi ekspor satu slot (MWh).
const EnergyExpSQL = `COALESCE(kwh_exp / 1000.0, GREATEST(-COALESCE(p_mw, 0), 0) * 0.5)`

// RefreshDaily menghitung ulang rekap harian (WIB) untuk titik & rentang waktu tertentu (nil = semua titik).
func (r *Repo) RefreshDaily(ctx context.Context, points []int32, from, to time.Time, warnPct, overPct float64) error {
	// batas hari WIB
	f := time.Date(from.In(Loc).Year(), from.In(Loc).Month(), from.In(Loc).Day(), 0, 0, 0, 0, Loc)
	t := time.Date(to.In(Loc).Year(), to.In(Loc).Month(), to.In(Loc).Day(), 0, 0, 0, 0, Loc).AddDate(0, 0, 1)
	_, err := r.pool.Exec(ctx, `INSERT INTO load_daily AS d (point_id, day, samples, zero_slots, metered_slots, peak_mw, peak_ts, peak_mva, peak_i, peak_util,
		wbp_peak_mw, wbp_peak_ts, lwbp_peak_mw, min_mw, avg_mw, energy_mwh, energy_exp_mwh, mvarh_imp, mvarh_exp, load_factor, max_imbalance,
		min_pf, avg_pf, min_v, max_v, min_f, max_f, hours_over80, hours_over100)
		SELECT point_id, day, count(*), count(*) FILTER (WHERE COALESCE(p_mw, 0) <= 0), count(kwh_imp),
			max(p_mw), (array_agg(ts ORDER BY p_mw DESC NULLS LAST))[1], max(s_mva), max(GREATEST(i_r, i_s, i_t, i_avg)), max(util),
			max(p_mw) FILTER (WHERE h >= 17 AND h < 22), (array_agg(ts ORDER BY p_mw DESC NULLS LAST) FILTER (WHERE h >= 17 AND h < 22))[1],
			max(p_mw) FILTER (WHERE h < 17 OR h >= 22),
			min(p_mw) FILTER (WHERE p_mw > 0), avg(p_mw), sum(`+EnergySQL+`), sum(`+EnergyExpSQL+`),
			sum(COALESCE(kvarh_imp / 1000.0, GREATEST(COALESCE(q_mvar, 0), 0) * 0.5)), sum(COALESCE(kvarh_exp / 1000.0, GREATEST(-COALESCE(q_mvar, 0), 0) * 0.5)),
			CASE WHEN max(p_mw) > 0 THEN avg(p_mw) / max(p_mw) END,
			max(CASE WHEN i_avg > 1 THEN (GREATEST(i_r, i_s, i_t) - LEAST(i_r, i_s, i_t)) / i_avg * 100 END),
			min(pf) FILTER (WHERE p_mw > 0), avg(pf) FILTER (WHERE p_mw > 0), min(v_kv) FILTER (WHERE v_kv > 0), max(v_kv),
			min(f_hz) FILTER (WHERE f_hz > 0), max(f_hz),
			count(*) FILTER (WHERE util >= $4) * 0.5, count(*) FILTER (WHERE util >= $5) * 0.5
		FROM (SELECT *, (ts AT TIME ZONE 'Asia/Jakarta')::date AS day, EXTRACT(hour FROM ts AT TIME ZONE 'Asia/Jakarta') AS h
		      FROM load_30m WHERE ts >= $2 AND ts < $3 AND ($1::int[] IS NULL OR point_id = ANY($1))) x
		GROUP BY point_id, day
		ON CONFLICT (point_id, day) DO UPDATE SET samples = EXCLUDED.samples, zero_slots = EXCLUDED.zero_slots, metered_slots = EXCLUDED.metered_slots,
			peak_mw = EXCLUDED.peak_mw, peak_ts = EXCLUDED.peak_ts, peak_mva = EXCLUDED.peak_mva, peak_i = EXCLUDED.peak_i, peak_util = EXCLUDED.peak_util,
			wbp_peak_mw = EXCLUDED.wbp_peak_mw, wbp_peak_ts = EXCLUDED.wbp_peak_ts, lwbp_peak_mw = EXCLUDED.lwbp_peak_mw, min_mw = EXCLUDED.min_mw,
			avg_mw = EXCLUDED.avg_mw, energy_mwh = EXCLUDED.energy_mwh, energy_exp_mwh = EXCLUDED.energy_exp_mwh, mvarh_imp = EXCLUDED.mvarh_imp,
			mvarh_exp = EXCLUDED.mvarh_exp, load_factor = EXCLUDED.load_factor, max_imbalance = EXCLUDED.max_imbalance,
			min_pf = EXCLUDED.min_pf, avg_pf = EXCLUDED.avg_pf, min_v = EXCLUDED.min_v, max_v = EXCLUDED.max_v, min_f = EXCLUDED.min_f, max_f = EXCLUDED.max_f,
			hours_over80 = EXCLUDED.hours_over80, hours_over100 = EXCLUDED.hours_over100`,
		nilIfEmpty(points), f, t, warnPct, overPct)
	return err
}

func nilIfEmpty(p []int32) []int32 {
	if len(p) == 0 {
		return nil
	}
	return p
}

// RefreshBaseline menghitung profil dasar (median & MAD MW per jenis hari & slot) dari 28 hari sebelum `until`.
func (r *Repo) RefreshBaseline(ctx context.Context, until time.Time, holidays []string) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO load_baseline (point_id, daytype, slot, median_mw, mad_mw, samples, updated_at)
		SELECT point_id, dt, slot, med, COALESCE(mad, 0), n, now() FROM (
			SELECT x.point_id, x.dt, x.slot, x.med, x.n,
			       percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(y.p_mw - x.med)) AS mad
			FROM (
				SELECT point_id, dt, slot, percentile_cont(0.5) WITHIN GROUP (ORDER BY p_mw) AS med, count(*) AS n
				FROM (SELECT point_id, p_mw, `+dayTypeSQL+` AS dt, `+slotSQL+` AS slot FROM load_30m
				      WHERE ts >= $1::timestamptz - interval '28 days' AND ts < $1::timestamptz AND p_mw > 0) a
				GROUP BY 1, 2, 3) x
			JOIN (SELECT point_id, p_mw, `+dayTypeSQL+` AS dt, `+slotSQL+` AS slot FROM load_30m
			      WHERE ts >= $1::timestamptz - interval '28 days' AND ts < $1::timestamptz AND p_mw > 0) y
			  ON y.point_id = x.point_id AND y.dt = x.dt AND y.slot = x.slot
			GROUP BY x.point_id, x.dt, x.slot, x.med, x.n) z
		ON CONFLICT (point_id, daytype, slot) DO UPDATE SET median_mw = EXCLUDED.median_mw, mad_mw = EXCLUDED.mad_mw,
			samples = EXCLUDED.samples, updated_at = now()`, until, holidays)
	return err
}

// jenis hari WIB: 0 kerja, 1 Sabtu, 2 Minggu / libur ($2 = daftar tanggal libur)
const dayTypeSQL = `(CASE WHEN to_char(ts AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') = ANY($2::text[]) THEN 2
	WHEN EXTRACT(isodow FROM ts AT TIME ZONE 'Asia/Jakarta') = 7 THEN 2
	WHEN EXTRACT(isodow FROM ts AT TIME ZONE 'Asia/Jakarta') = 6 THEN 1 ELSE 0 END)::smallint`
const slotSQL = `(EXTRACT(hour FROM ts AT TIME ZONE 'Asia/Jakarta') * 2 + floor(EXTRACT(minute FROM ts AT TIME ZONE 'Asia/Jakarta') / 30))::smallint`

// DayType menentukan jenis hari untuk tanggal WIB.
func DayType(t time.Time, holidays map[string]bool) int {
	l := t.In(Loc)
	if holidays[l.Format("2006-01-02")] || l.Weekday() == time.Sunday {
		return 2
	}
	if l.Weekday() == time.Saturday {
		return 1
	}
	return 0
}

// Baseline adalah profil dasar satu slot (MW).
type Baseline struct {
	Median, MAD float64
	N           int
}

// Baselines mengembalikan profil dasar untuk titik-titik tertentu: map[point][daytype*48+slot].
func (r *Repo) Baselines(ctx context.Context, points []int32) (map[int]map[int]Baseline, error) {
	rows, err := r.pool.Query(ctx, `SELECT point_id, daytype, slot, median_mw, mad_mw, samples FROM load_baseline WHERE ($1::int[] IS NULL OR point_id = ANY($1))`, nilIfEmpty(points))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]map[int]Baseline{}
	for rows.Next() {
		var pid, dt, slot, n int
		var med, mad float64
		if rows.Scan(&pid, &dt, &slot, &med, &mad, &n) == nil {
			m := out[pid]
			if m == nil {
				m = map[int]Baseline{}
				out[pid] = m
			}
			m[dt*48+slot] = Baseline{med, mad, n}
		}
	}
	return out, rows.Err()
}

// Readings mengembalikan data titik-titik pada rentang waktu (urut titik, waktu).
func (r *Repo) Readings(ctx context.Context, points []int32, from, to time.Time) ([]Reading, error) {
	rows, err := r.pool.Query(ctx, `SELECT point_id, ts, `+readingCols+`, quality
		FROM load_30m WHERE ts >= $2 AND ts < $3 AND ($1::int[] IS NULL OR point_id = ANY($1)) ORDER BY point_id, ts`, nilIfEmpty(points), from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Reading{}
	for rows.Next() {
		var x Reading
		var q int16
		var f [18]*float64
		dst := []any{&x.PointID, &x.TS}
		for i := range f {
			dst = append(dst, &f[i])
		}
		dst = append(dst, &q)
		if err := rows.Scan(dst...); err != nil {
			return nil, err
		}
		for i, p := range x.fields() {
			*p = f[i]
		}
		x.Quality = int(q)
		out = append(out, x)
	}
	return out, rows.Err()
}

// SeriesPoint adalah satu titik deret (gabungan beberapa titik ukur pada waktu yang sama).
type SeriesPoint struct {
	TS     time.Time `json:"ts"`
	P      float64   `json:"p"` // MW (besaran beban utama)
	Q      float64   `json:"q"`
	S      float64   `json:"s"`
	I      float64   `json:"i"`
	E      float64   `json:"e"` // energi impor slot (MWh)
	Util   float64   `json:"util"`
	Points int       `json:"n"`
}

// Series menjumlahkan beban titik-titik per slot (beban serentak / coincident). capMW untuk % pembebanan gabungan.
func (r *Repo) Series(ctx context.Context, points []int32, from, to time.Time, capMW float64) ([]SeriesPoint, error) {
	rows, err := r.pool.Query(ctx, `SELECT ts, sum(COALESCE(p_mw, 0)), sum(COALESCE(q_mvar, 0)), sum(COALESCE(s_mva, 0)), sum(COALESCE(i_avg, 0)),
		sum(`+EnergySQL+`), max(util), count(*)
		FROM load_30m WHERE point_id = ANY($1) AND ts >= $2 AND ts < $3 GROUP BY ts ORDER BY ts`, points, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SeriesPoint{}
	for rows.Next() {
		var s SeriesPoint
		var util *float64
		if err := rows.Scan(&s.TS, &s.P, &s.Q, &s.S, &s.I, &s.E, &util, &s.Points); err != nil {
			return nil, err
		}
		if len(points) > 1 || util == nil {
			if capMW > 0 {
				s.Util = s.P / capMW * 100
			}
		} else {
			s.Util = *util
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DayStat adalah rekap harian (gabungan titik), beban dalam MW.
type DayStat struct {
	Day        string     `json:"day"`
	PeakMW     float64    `json:"peak_mw"`
	PeakTS     *time.Time `json:"peak_ts"`
	WBPPeakMW  float64    `json:"wbp_peak_mw"`
	LWBPPeakMW float64    `json:"lwbp_peak_mw"`
	MinMW      float64    `json:"min_mw"`
	AvgMW      float64    `json:"avg_mw"`
	EnergyMWh  float64    `json:"energy_mwh"`
	EnergyExp  float64    `json:"energy_exp_mwh"`
	LoadFactor float64    `json:"load_factor"`
	PeakUtil   float64    `json:"peak_util"`
	Samples    int        `json:"samples"`
	Hours80    float64    `json:"hours_over80"`
	Hours100   float64    `json:"hours_over100"`
}

// DailyGroup menghitung rekap harian beban serentak untuk sekelompok titik.
func (r *Repo) DailyGroup(ctx context.Context, points []int32, from, to time.Time, capMW, warnPct, overPct float64) ([]DayStat, error) {
	if len(points) == 1 {
		// satu titik: pakai rekap harian yang sudah dihitung
		rows, err := r.pool.Query(ctx, `SELECT to_char(day, 'YYYY-MM-DD'), COALESCE(peak_mw,0), peak_ts, COALESCE(wbp_peak_mw,0), COALESCE(lwbp_peak_mw,0),
			COALESCE(min_mw,0), COALESCE(avg_mw,0), COALESCE(energy_mwh,0), COALESCE(energy_exp_mwh,0), COALESCE(load_factor,0), COALESCE(peak_util,0),
			samples, hours_over80, hours_over100
			FROM load_daily WHERE point_id = $1 AND day >= ($2 AT TIME ZONE 'Asia/Jakarta')::date AND day < ($3 AT TIME ZONE 'Asia/Jakarta')::date ORDER BY day`,
			points[0], from, to)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []DayStat{}
		for rows.Next() {
			var d DayStat
			if err := rows.Scan(&d.Day, &d.PeakMW, &d.PeakTS, &d.WBPPeakMW, &d.LWBPPeakMW, &d.MinMW, &d.AvgMW, &d.EnergyMWh, &d.EnergyExp, &d.LoadFactor, &d.PeakUtil,
				&d.Samples, &d.Hours80, &d.Hours100); err != nil {
				return nil, err
			}
			out = append(out, d)
		}
		return out, rows.Err()
	}
	rows, err := r.pool.Query(ctx, `SELECT to_char(day, 'YYYY-MM-DD'), max(p), (array_agg(ts ORDER BY p DESC))[1],
		COALESCE(max(p) FILTER (WHERE h >= 17 AND h < 22), 0), COALESCE(max(p) FILTER (WHERE h < 17 OR h >= 22), 0),
		COALESCE(min(p) FILTER (WHERE p > 0), 0), avg(p), sum(e), sum(ex), CASE WHEN max(p) > 0 THEN avg(p) / max(p) ELSE 0 END, count(*),
		count(*) FILTER (WHERE $4 > 0 AND p / $4 * 100 >= $5) * 0.5, count(*) FILTER (WHERE $4 > 0 AND p / $4 * 100 >= $6) * 0.5
		FROM (SELECT ts, (ts AT TIME ZONE 'Asia/Jakarta')::date AS day, EXTRACT(hour FROM ts AT TIME ZONE 'Asia/Jakarta') AS h,
		             sum(COALESCE(p_mw, 0)) AS p, sum(`+EnergySQL+`) AS e, sum(`+EnergyExpSQL+`) AS ex
		      FROM load_30m WHERE point_id = ANY($1) AND ts >= $2 AND ts < $3 GROUP BY ts) x
		GROUP BY day ORDER BY day`, points, from, to, capMW, warnPct, overPct)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DayStat{}
	for rows.Next() {
		var d DayStat
		if err := rows.Scan(&d.Day, &d.PeakMW, &d.PeakTS, &d.WBPPeakMW, &d.LWBPPeakMW, &d.MinMW, &d.AvgMW, &d.EnergyMWh, &d.EnergyExp, &d.LoadFactor, &d.Samples, &d.Hours80, &d.Hours100); err != nil {
			return nil, err
		}
		if capMW > 0 {
			d.PeakUtil = d.PeakMW / capMW * 100
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// PointDaily adalah rekap harian sebuah titik (untuk peringkat & laporan).
type PointDaily struct {
	PointID   int        `json:"point_id"`
	PeakMW    float64    `json:"peak_mw"`
	PeakTS    *time.Time `json:"peak_ts"`
	PeakMVA   float64    `json:"peak_mva"`
	PeakUtil  float64    `json:"peak_util"`
	PeakI     float64    `json:"peak_i"`
	AvgMW     float64    `json:"avg_mw"`
	EnergyMWh float64    `json:"energy_mwh"`
	EnergyExp float64    `json:"energy_exp_mwh"`
	MVArh     float64    `json:"mvarh_imp"`
	LF        float64    `json:"load_factor"`
	Hours80   float64    `json:"hours_over80"`
	Hours100  float64    `json:"hours_over100"`
	Imbalance float64    `json:"max_imbalance"`
	MinPF     float64    `json:"min_pf"`
	AvgPF     float64    `json:"avg_pf"`
	MinV      float64    `json:"min_v"`
	MaxV      float64    `json:"max_v"`
	Samples   int        `json:"samples"`
	Metered   int        `json:"metered_slots"`
	Days      int        `json:"days"`
}

// PointStats merangkum rekap harian tiap titik pada rentang hari [from, to) (kind kosong = semua jenis).
func (r *Repo) PointStats(ctx context.Context, from, to time.Time, kind string) (map[int]*PointDaily, error) {
	rows, err := r.pool.Query(ctx, `SELECT d.point_id, COALESCE(max(peak_mw),0), (array_agg(peak_ts ORDER BY peak_mw DESC NULLS LAST))[1], COALESCE(max(peak_mva),0),
		COALESCE(max(peak_util),0), COALESCE(max(peak_i),0), COALESCE(avg(avg_mw),0), COALESCE(sum(energy_mwh),0), COALESCE(sum(energy_exp_mwh),0),
		COALESCE(sum(mvarh_imp),0), COALESCE(avg(load_factor),0), sum(hours_over80), sum(hours_over100),
		COALESCE(max(max_imbalance),0), COALESCE(min(min_pf),0), COALESCE(avg(avg_pf),0), COALESCE(min(min_v),0), COALESCE(max(max_v),0),
		sum(samples), sum(metered_slots), count(*)
		FROM load_daily d JOIN scada_points p ON p.id = d.point_id
		WHERE day >= ($1 AT TIME ZONE 'Asia/Jakarta')::date AND day < ($2 AT TIME ZONE 'Asia/Jakarta')::date AND ($3 = '' OR p.kind = $3)
		GROUP BY d.point_id`, from, to, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]*PointDaily{}
	for rows.Next() {
		d := &PointDaily{}
		if err := rows.Scan(&d.PointID, &d.PeakMW, &d.PeakTS, &d.PeakMVA, &d.PeakUtil, &d.PeakI, &d.AvgMW, &d.EnergyMWh, &d.EnergyExp, &d.MVArh, &d.LF,
			&d.Hours80, &d.Hours100, &d.Imbalance, &d.MinPF, &d.AvgPF, &d.MinV, &d.MaxV, &d.Samples, &d.Metered, &d.Days); err != nil {
			return nil, err
		}
		out[d.PointID] = d
	}
	return out, rows.Err()
}

// DataRange mengembalikan waktu data paling awal & akhir.
func (r *Repo) DataRange(ctx context.Context) (first, last *time.Time, rows int64) {
	_ = r.pool.QueryRow(ctx, `SELECT min(day)::timestamptz, (max(day) + 1)::timestamptz, COALESCE(sum(samples), 0) FROM load_daily`).Scan(&first, &last, &rows)
	return
}
