package load

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"
)

// Anomaly adalah satu anomali data / kondisi beban (rentang slot berurutan).
type Anomaly struct {
	ID          int64          `json:"id"`
	PointID     int            `json:"point_id"`
	Kind        string         `json:"kind"`
	Severity    string         `json:"severity"`
	Start       time.Time      `json:"start_ts"`
	End         time.Time      `json:"end_ts"`
	Slots       int            `json:"slots"`
	Value       *float64       `json:"value"`
	Expected    *float64       `json:"expected"`
	Detail      map[string]any `json:"detail"`
	Explanation string         `json:"explanation"`
	Status      string         `json:"status"`
	Note        string         `json:"note"`
	HandledBy   string         `json:"handled_by"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	// diisi handler
	PointCode string `json:"point_code,omitempty"`
	PointKind string `json:"point_kind,omitempty"`
}

// AnomalyKinds adalah jenis anomali: telemetri (data) & kondisi jaringan.
var AnomalyKinds = []string{"missing", "stale", "out_of_range", "zero_load", "spike", "drop", "energy", "mismatch", "level_shift", "imbalance", "low_pf", "voltage", "frequency", "overload", "losses"}

// minimum slot berurutan agar kondisi dicatat (menyaring kedip sesaat)
var minSlots = map[string]int{"overload": 2, "imbalance": 4, "low_pf": 4, "voltage": 2, "frequency": 1, "energy": 4, "stale": 1, "missing": 2, "zero_load": 1, "spike": 1, "drop": 1, "out_of_range": 1}

var sevRank = map[string]int{"info": 0, "warning": 1, "serious": 2, "critical": 3}

// OutageWindow adalah kejadian padam yang mengenai sebuah penyulang / trafo GI.
type OutageWindow struct {
	ID         int64
	From, To   time.Time
	Heads      map[int64]bool // penyulang (kubikel) terdampak
	Trafos     map[int64]bool
	Kind, Code string
}

// Detector mendeteksi anomali dari data 30 menit.
type Detector struct {
	repo     *Repo
	settings func() Settings
	// OnNew dipanggil untuk anomali baru bertingkat serius (notifikasi)
	OnNew func(ctx context.Context, a []Anomaly)
}

// NewDetector membuat detektor.
func NewDetector(repo *Repo, settings func() Settings) *Detector {
	return &Detector{repo: repo, settings: settings}
}

type hit struct {
	ts       time.Time
	sev      string
	value    float64
	expected float64
	detail   map[string]any
}

// Outages memuat kejadian padam yang beririsan dengan rentang waktu.
func (d *Detector) Outages(ctx context.Context, from, to time.Time) ([]OutageWindow, error) {
	rows, err := d.repo.pool.Query(ctx, `SELECT id, started_at, COALESCE(ended_at, now()), kind, cause_node_code,
		COALESCE(summary->'penyulang_ids', '[]'::jsonb), COALESCE(summary->'trafo_gi_ids', '[]'::jsonb)
		FROM outages WHERE started_at < $2 AND (ended_at IS NULL OR ended_at > $1)`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OutageWindow{}
	for rows.Next() {
		var w OutageWindow
		var hj, tj []byte
		if err := rows.Scan(&w.ID, &w.From, &w.To, &w.Kind, &w.Code, &hj, &tj); err != nil {
			return nil, err
		}
		var hs, ts []int64
		_ = json.Unmarshal(hj, &hs)
		_ = json.Unmarshal(tj, &ts)
		w.Heads, w.Trafos = map[int64]bool{}, map[int64]bool{}
		for _, h := range hs {
			w.Heads[h] = true
		}
		for _, t := range ts {
			w.Trafos[t] = true
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func outageAt(ws []OutageWindow, p Point, t time.Time) *OutageWindow {
	if p.NodeID == nil {
		return nil
	}
	for i := range ws {
		w := &ws[i]
		if t.Before(w.From.Add(-30*time.Minute)) || !t.Before(w.To) {
			continue
		}
		if (p.Kind == "feeder" && w.Heads[*p.NodeID]) || (p.Kind == "trafo_gi" && w.Trafos[*p.NodeID]) ||
			(p.Kind == "gd" && p.FeederID != nil && w.Heads[*p.FeederID]) {
			return w
		}
	}
	return nil
}

// Detect memeriksa data titik-titik pada [from, to) (plus konteks 3 jam sebelumnya) lalu menyimpan anomali.
func (d *Detector) Detect(ctx context.Context, points []Point, from, to time.Time) (int, error) {
	if len(points) == 0 {
		return 0, nil
	}
	st := d.settings()
	ids := make([]int32, 0, len(points))
	byID := map[int]Point{}
	for _, p := range points {
		ids = append(ids, int32(p.ID))
		byID[p.ID] = p
	}
	ctxFrom := from.Add(-3 * time.Hour)
	rs, err := d.repo.Readings(ctx, ids, ctxFrom, to)
	if err != nil {
		return 0, err
	}
	bases, err := d.repo.Baselines(ctx, ids)
	if err != nil {
		return 0, err
	}
	outs, _ := d.Outages(ctx, ctxFrom, to)
	hits := map[int]map[string][]hit{}
	add := func(pid int, kind string, h hit) {
		m := hits[pid]
		if m == nil {
			m = map[string][]hit{}
			hits[pid] = m
		}
		m[kind] = append(m[kind], h)
	}
	// per titik, data urut waktu
	i := 0
	for i < len(rs) {
		j := i
		for j < len(rs) && rs[j].PointID == rs[i].PointID {
			j++
		}
		p := byID[rs[i].PointID]
		d.checkPoint(p, rs[i:j], bases[p.ID], outs, st, ctxFrom, to, add)
		i = j
	}
	// titik tanpa data sama sekali di rentang → hilang
	has := map[int]bool{}
	for _, r := range rs {
		has[r.PointID] = true
	}
	for _, p := range points {
		if has[p.ID] || !p.Active {
			continue
		}
		end := to
		if end.After(time.Now()) {
			end = time.Now().Truncate(30 * time.Minute)
		}
		for t := from; t.Before(end); t = t.Add(30 * time.Minute) {
			add(p.ID, "missing", hit{ts: t, sev: "warning", detail: map[string]any{}})
		}
	}
	return d.save(ctx, hits, byID, ctxFrom, to)
}

func (d *Detector) checkPoint(p Point, rs []Reading, base map[int]Baseline, outs []OutageWindow, st Settings, from, to time.Time, add func(int, string, hit)) {
	capMW := p.CapMW(st.CapPF)
	kv := p.KV
	if kv <= 0 {
		kv = 20
	}
	f := func(v *float64) float64 {
		if v == nil {
			return math.NaN()
		}
		return *v
	}
	// slot hilang di antara data (awal riwayat sebuah titik bukan "hilang")
	expect := from
	if len(rs) > 0 && rs[0].TS.After(from) {
		expect = rs[0].TS
	}
	now := time.Now().Truncate(30 * time.Minute)
	for idx, r := range rs {
		for t := expect; t.Before(r.TS); t = t.Add(30 * time.Minute) {
			if !t.Before(from.Add(3 * time.Hour)) {
				add(p.ID, "missing", hit{ts: t, sev: "warning", detail: map[string]any{}})
			}
		}
		if r.TS.Add(30 * time.Minute).After(expect) {
			expect = r.TS.Add(30 * time.Minute)
		}
		s, util := f(r.P), f(r.Util) // beban MW
		ia := f(r.IAvg)
		// nilai di luar batas fisik
		neg := false
		for _, v := range []*float64{r.IR, r.IS, r.IT, r.IAvg, r.S, r.P} {
			if v != nil && *v < 0 {
				neg = true
			}
		}
		vv, fz := f(r.V), f(r.F)
		for _, v := range []*float64{r.KWhImp, r.KWhExp, r.KVarhImp, r.KVarhExp} {
			if v != nil && *v < 0 {
				neg = true
			}
		}
		if neg || util > 250 || (!math.IsNaN(vv) && (vv < kv*0.5 || vv > kv*1.5)) || (!math.IsNaN(fz) && (fz < st.FNominal*0.9 || fz > st.FNominal*1.1)) {
			add(p.ID, "out_of_range", hit{ts: r.TS, sev: "serious", value: s, detail: map[string]any{"util": util, "v": vv, "f": fz}})
			continue
		}
		// frekuensi di luar batas: besaran sistem, dicatat di trafo GI saja (satu kejadian tidak
		// menjadi ribuan anomali di penyulang & gardu)
		if p.Kind == "trafo_gi" && !math.IsNaN(fz) && math.Abs(fz-st.FNominal) > st.FDev {
			sev := "warning"
			if math.Abs(fz-st.FNominal) > st.FDev*2 {
				sev = "serious"
			}
			add(p.ID, "frequency", hit{ts: r.TS, sev: sev, value: fz, expected: st.FNominal, detail: map[string]any{}})
		}
		// beban nol: padam nyata (dicocokkan kejadian padam) atau telemetri
		if !math.IsNaN(s) && (s <= 0.0005 || (capMW > 0 && s < capMW*0.005)) {
			if w := outageAt(outs, p, r.TS); w == nil {
				add(p.ID, "zero_load", hit{ts: r.TS, sev: "serious", value: s, detail: map[string]any{}})
			}
			continue
		}
		// nilai macet: sama persis dengan 5 data sebelumnya
		if idx >= 5 && !math.IsNaN(ia) && ia > 0 {
			same := true
			for k := idx - 5; k < idx; k++ {
				if rs[k].IAvg == nil || *rs[k].IAvg != ia || !rs[k].TS.Equal(r.TS.Add(time.Duration(k-idx)*30*time.Minute)) {
					same = false
					break
				}
			}
			if same {
				add(p.ID, "stale", hit{ts: r.TS, sev: "warning", value: ia, detail: map[string]any{"slots": 6}})
			}
		}
		// beban lebih
		if !math.IsNaN(util) && util >= st.Warn {
			sev := "warning"
			if util >= st.Over {
				sev = "serious"
			}
			if util >= st.Over*1.2 {
				sev = "critical"
			}
			add(p.ID, "overload", hit{ts: r.TS, sev: sev, value: util, expected: st.Warn, detail: map[string]any{"p_mw": s}})
		}
		// ketidakseimbangan fasa
		if r.IR != nil && r.IS != nil && r.IT != nil && ia > 5 {
			mx := math.Max(*r.IR, math.Max(*r.IS, *r.IT))
			mn := math.Min(*r.IR, math.Min(*r.IS, *r.IT))
			if imb := (mx - mn) / ia * 100; imb > st.Imbalance {
				add(p.ID, "imbalance", hit{ts: r.TS, sev: "warning", value: imb, expected: st.Imbalance, detail: map[string]any{"i_r": *r.IR, "i_s": *r.IS, "i_t": *r.IT}})
			}
		}
		// faktor daya rendah (abaikan beban sangat kecil)
		if pf := f(r.PF); !math.IsNaN(pf) && pf < st.MinPF && (capMW <= 0 || s > capMW*0.1) {
			add(p.ID, "low_pf", hit{ts: r.TS, sev: "info", value: pf, expected: st.MinPF, detail: map[string]any{}})
		}
		// tegangan di luar batas
		if !math.IsNaN(vv) && (vv > kv*(1+st.VHigh/100) || vv < kv*(1-st.VLow/100)) {
			add(p.ID, "voltage", hit{ts: r.TS, sev: "warning", value: vv, expected: kv, detail: map[string]any{}})
		}
		// energi meter vs integrasi daya: kWh periode ≈ MW × 0,5 jam × 1000 (pengukuran energi / daya tidak konsisten)
		if r.KWhImp != nil && !math.IsNaN(s) && s > 0 && (capMW <= 0 || s > capMW*0.05) {
			e := s * 500
			if dev := (*r.KWhImp - e) / e * 100; math.Abs(dev) > st.EnergyDev {
				add(p.ID, "energy", hit{ts: r.TS, sev: "warning", value: *r.KWhImp, expected: e, detail: map[string]any{"pct": math.Round(dev)}})
			}
		}
		// lonjakan / penurunan terhadap profil dasar (median & MAD slot yang sama, jenis hari sama)
		if b, ok := base[DayType(r.TS, st.Holidays)*48+SlotOf(r.TS)]; ok && b.N >= 3 && b.Median > 0 && (capMW <= 0 || b.Median > capMW*0.05) {
			dev := s - b.Median
			rel := dev / b.Median * 100
			z := dev / (1.4826*b.MAD + b.Median*0.02)
			if rel > st.Spike && z > 4 {
				add(p.ID, "spike", hit{ts: r.TS, sev: "warning", value: s, expected: b.Median, detail: map[string]any{"pct": math.Round(rel), "z": math.Round(z*10) / 10}})
			} else if rel < -st.Spike && z < -4 && outageAt(outs, p, r.TS) == nil {
				add(p.ID, "drop", hit{ts: r.TS, sev: "warning", value: s, expected: b.Median, detail: map[string]any{"pct": math.Round(rel), "z": math.Round(z*10) / 10}})
			}
		}
	}
	// slot hilang di ujung rentang (data belum datang)
	end := to
	if end.After(now) {
		end = now
	}
	for t := expect; t.Before(end); t = t.Add(30 * time.Minute) {
		add(p.ID, "missing", hit{ts: t, sev: "warning", detail: map[string]any{}})
	}
}

type interval struct {
	start, end time.Time
	slots      int
	sev        string
	value      float64
	expected   float64
	detail     map[string]any
}

// intervals menggabungkan slot berurutan menjadi rentang.
func intervals(hs []hit, kind string) []interval {
	sort.Slice(hs, func(i, j int) bool { return hs[i].ts.Before(hs[j].ts) })
	out := []interval{}
	for _, h := range hs {
		n := len(out)
		if n > 0 && !h.ts.After(out[n-1].end.Add(30*time.Minute)) {
			iv := &out[n-1]
			if h.ts.After(iv.end) {
				iv.end = h.ts
				iv.slots++
			}
			if sevRank[h.sev] > sevRank[iv.sev] {
				iv.sev = h.sev
			}
			worse := math.Abs(h.value-h.expected) > math.Abs(iv.value-iv.expected)
			if kind == "low_pf" {
				worse = h.value < iv.value
			}
			if worse {
				iv.value, iv.expected, iv.detail = h.value, h.expected, h.detail
			}
			continue
		}
		out = append(out, interval{start: h.ts, end: h.ts, slots: 1, sev: h.sev, value: h.value, expected: h.expected, detail: h.detail})
	}
	return out
}

// save menggabungkan rentang dengan anomali yang sudah ada (bersebelahan) atau menyimpan baru.
func (d *Detector) save(ctx context.Context, hits map[int]map[string][]hit, byID map[int]Point, from, to time.Time) (int, error) {
	if len(hits) == 0 {
		return 0, nil
	}
	ids := []int32{}
	for pid := range hits {
		ids = append(ids, int32(pid))
	}
	type key struct {
		pid  int
		kind string
	}
	existing := map[key][]Anomaly{}
	rows, err := d.repo.pool.Query(ctx, `SELECT id, point_id, kind, severity, start_ts, end_ts, slots FROM load_anomalies
		WHERE point_id = ANY($1) AND end_ts >= $2 AND start_ts <= $3`, ids, from.Add(-30*time.Minute), to.Add(30*time.Minute))
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var a Anomaly
		if rows.Scan(&a.ID, &a.PointID, &a.Kind, &a.Severity, &a.Start, &a.End, &a.Slots) == nil {
			existing[key{a.PointID, a.Kind}] = append(existing[key{a.PointID, a.Kind}], a)
		}
	}
	rows.Close()
	created := 0
	fresh := []Anomaly{}
	for pid, kinds := range hits {
		for kind, hs := range kinds {
			for _, iv := range intervals(hs, kind) {
				var match *Anomaly
				for i := range existing[key{pid, kind}] {
					a := &existing[key{pid, kind}][i]
					if !iv.start.After(a.End.Add(30*time.Minute)) && !iv.end.Before(a.Start.Add(-30*time.Minute)) {
						match = a
						break
					}
				}
				det, _ := json.Marshal(iv.detail)
				if match != nil {
					start, end := match.Start, match.End
					if iv.start.Before(start) {
						start = iv.start
					}
					if iv.end.After(end) {
						end = iv.end
					}
					slots := int(end.Sub(start)/(30*time.Minute)) + 1
					sev := match.Severity
					if sevRank[iv.sev] > sevRank[sev] {
						sev = iv.sev
					}
					_, err := d.repo.pool.Exec(ctx, `UPDATE load_anomalies SET start_ts = $2, end_ts = $3, slots = $4, severity = $5,
						value = CASE WHEN $8 THEN $6 ELSE value END, expected = CASE WHEN $8 THEN $7 ELSE expected END,
						detail = CASE WHEN $8 THEN $9::jsonb ELSE detail END, updated_at = now(),
						status = CASE WHEN status = 'closed' THEN 'open' ELSE status END WHERE id = $1`,
						match.ID, start, end, slots, sev, iv.value, iv.expected, sevRank[iv.sev] >= sevRank[match.Severity], det)
					if err != nil {
						return created, err
					}
					match.Start, match.End, match.Severity = start, end, sev
					continue
				}
				if iv.slots < minSlots[kind] {
					continue
				}
				var id int64
				// anomali riwayat (berakhir > 7 hari lalu, mis. hasil pengisian riwayat) langsung ditutup
				status, note := "open", ""
				if iv.end.Before(time.Now().AddDate(0, 0, -7)) {
					status, note = "closed", "riwayat"
				}
				err := d.repo.pool.QueryRow(ctx, `INSERT INTO load_anomalies (point_id, kind, severity, start_ts, end_ts, slots, value, expected, detail, status, note)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
					ON CONFLICT (point_id, kind, start_ts) DO UPDATE SET end_ts = GREATEST(load_anomalies.end_ts, EXCLUDED.end_ts),
						slots = EXCLUDED.slots, updated_at = now() RETURNING id`,
					pid, kind, iv.sev, iv.start, iv.end, iv.slots, iv.value, iv.expected, det, status, note).Scan(&id)
				if err != nil {
					return created, err
				}
				created++
				a := Anomaly{ID: id, PointID: pid, Kind: kind, Severity: iv.sev, Start: iv.start, End: iv.end, Slots: iv.slots, PointCode: byID[pid].Code, PointKind: byID[pid].Kind}
				v := iv.value
				a.Value = &v
				existing[key{pid, kind}] = append(existing[key{pid, kind}], a)
				if sevRank[iv.sev] >= sevRank["serious"] && iv.end.After(time.Now().Add(-6*time.Hour)) {
					fresh = append(fresh, a)
				}
			}
		}
	}
	if len(fresh) > 0 && d.OnNew != nil {
		d.OnNew(ctx, fresh)
	}
	return created, nil
}

// ManeuverRef adalah manuver / kejadian yang dapat menjelaskan perubahan level beban.
type ManeuverRef struct {
	ID     int64
	At     time.Time
	Action string
	Kind   string
	Code   string
	Head   int64 // penyulang terkait
}

// DetectDaily memeriksa rekap harian [from, to): pergeseran level (dikaitkan dengan manuver) dan
// selisih incoming trafo GI vs jumlah penyulang di bawahnya.
func (d *Detector) DetectDaily(ctx context.Context, points []Point, from, to time.Time, maneuvers []ManeuverRef) (int, error) {
	st := d.settings()
	byID := map[int]Point{}
	for _, p := range points {
		byID[p.ID] = p
	}
	hits := map[int]map[string][]hit{}
	add := func(pid int, kind string, h hit) {
		m := hits[pid]
		if m == nil {
			m = map[string][]hit{}
			hits[pid] = m
		}
		m[kind] = append(m[kind], h)
	}
	explain := map[string]string{}
	// 1. pergeseran level: rata-rata harian vs median 7 hari sebelumnya
	rows, err := d.repo.pool.Query(ctx, `SELECT a.point_id, a.day, a.avg_mw, a.zero_slots,
		(SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.avg_mw) FROM load_daily b
		  WHERE b.point_id = a.point_id AND b.day >= a.day - 28 AND b.day < a.day AND b.samples >= 40
		    AND (CASE WHEN EXTRACT(isodow FROM b.day) >= 6 THEN EXTRACT(isodow FROM b.day) ELSE 0 END)
		      = (CASE WHEN EXTRACT(isodow FROM a.day) >= 6 THEN EXTRACT(isodow FROM a.day) ELSE 0 END))
		FROM load_daily a WHERE a.day >= ($1 AT TIME ZONE 'Asia/Jakarta')::date AND a.day < ($2 AT TIME ZONE 'Asia/Jakarta')::date AND a.samples >= 40`, from, to)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var pid, zero int
		var day time.Time
		var avg float64
		var prev *float64
		if rows.Scan(&pid, &day, &avg, &zero, &prev) != nil || prev == nil || *prev <= 0 || zero > 8 {
			continue
		}
		p, ok := byID[pid]
		if !ok {
			continue
		}
		rel := (avg - *prev) / *prev * 100
		if math.Abs(rel) < 30 {
			continue
		}
		dayStart := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, Loc)
		h := hit{ts: dayStart, sev: "info", value: avg, expected: *prev, detail: map[string]any{"pct": math.Round(rel)}}
		// kaitkan dengan manuver pada penyulang ini (±1 hari)
		if p.NodeID != nil {
			for _, m := range maneuvers {
				if m.Head == *p.NodeID && m.At.After(dayStart.Add(-24*time.Hour)) && m.At.Before(dayStart.Add(24*time.Hour)) {
					h.detail["maneuver_id"] = m.ID
					explain[fmt.Sprintf("%d|%s", pid, dayStart.Format(time.RFC3339))] = fmt.Sprintf("manuver #%d %s %s %s pada %s", m.ID, m.Action, m.Kind, m.Code, m.At.In(Loc).Format("02/01 15:04"))
					break
				}
			}
		}
		if _, ok := h.detail["maneuver_id"]; !ok {
			h.sev = "warning"
		}
		add(pid, "level_shift", h)
	}
	rows.Close()
	// 2. selisih incoming trafo GI vs Σ penyulang (per slot, dicatat per hari)
	for _, t := range points {
		if t.Kind != "trafo_gi" || t.NodeID == nil {
			continue
		}
		feeders := []int32{}
		for _, p := range points {
			if p.Kind == "feeder" && p.TrafoGIID != nil && *p.TrafoGIID == *t.NodeID && p.Active {
				feeders = append(feeders, int32(p.ID))
			}
		}
		if len(feeders) == 0 {
			continue
		}
		mrows, err := d.repo.pool.Query(ctx, `SELECT t.ts, t.p_mw, f.p, f.n FROM load_30m t
			JOIN (SELECT ts, sum(p_mw) p, count(*) n FROM load_30m WHERE point_id = ANY($2) AND ts >= $3 AND ts < $4 GROUP BY ts) f ON f.ts = t.ts
			WHERE t.point_id = $1 AND t.ts >= $3 AND t.ts < $4 AND t.p_mw > 0`, t.ID, feeders, from, to)
		if err != nil {
			return 0, err
		}
		for mrows.Next() {
			var ts time.Time
			var ts1, fs float64
			var n int
			if mrows.Scan(&ts, &ts1, &fs, &n) != nil || n < len(feeders) {
				continue
			}
			if diff := (ts1 - fs) / ts1 * 100; math.Abs(diff) > st.Mismatch {
				add(t.ID, "mismatch", hit{ts: ts, sev: "warning", value: ts1, expected: fs, detail: map[string]any{"pct": math.Round(diff), "feeders": len(feeders)}})
			}
		}
		mrows.Close()
	}
	// selisih: minimal 4 slot
	for pid, kinds := range hits {
		if hs, ok := kinds["mismatch"]; ok {
			keep := []hit{}
			for _, iv := range intervals(hs, "mismatch") {
				if iv.slots >= 4 {
					for _, h := range hs {
						if !h.ts.Before(iv.start) && !h.ts.After(iv.end) {
							keep = append(keep, h)
						}
					}
				}
			}
			if len(keep) == 0 {
				delete(kinds, "mismatch")
			} else {
				kinds["mismatch"] = keep
			}
			if len(kinds) == 0 {
				delete(hits, pid)
			}
		}
	}
	// level_shift adalah rekap harian: satu entri per hari (jangan digabung antarhari)
	n, err := d.save(ctx, hits, byID, from, to)
	for k, e := range explain {
		var pid int
		var ts string
		fmt.Sscanf(k, "%d|%s", &pid, &ts)
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			_, _ = d.repo.pool.Exec(ctx, `UPDATE load_anomalies SET explanation = $3 WHERE point_id = $1 AND kind = 'level_shift' AND start_ts <= $2 AND end_ts >= $2`, pid, t, e)
		}
	}
	return n, err
}

// DayHit adalah temuan harian (mis. susut tinggi) untuk sebuah titik.
type DayHit struct {
	PointID         int
	Kind, Severity  string
	Day             time.Time // awal hari WIB
	Value, Expected float64
	Detail          map[string]any
	Explanation     string
}

// SaveDayHits menyimpan temuan harian sebagai anomali satu slot di awal hari.
func (d *Detector) SaveDayHits(ctx context.Context, points []Point, hs []DayHit, from, to time.Time) (int, error) {
	byID := map[int]Point{}
	for _, p := range points {
		byID[p.ID] = p
	}
	hits := map[int]map[string][]hit{}
	for _, h := range hs {
		m := hits[h.PointID]
		if m == nil {
			m = map[string][]hit{}
			hits[h.PointID] = m
		}
		m[h.Kind] = append(m[h.Kind], hit{ts: h.Day, sev: h.Severity, value: h.Value, expected: h.Expected, detail: h.Detail})
	}
	n, err := d.save(ctx, hits, byID, from, to)
	for _, h := range hs {
		if h.Explanation != "" {
			_, _ = d.repo.pool.Exec(ctx, `UPDATE load_anomalies SET explanation = $4 WHERE point_id = $1 AND kind = $2 AND start_ts = $3`, h.PointID, h.Kind, h.Day, h.Explanation)
		}
	}
	return n, err
}

// DetectMissingLive mencatat titik aktif yang datanya berhenti (> 1 jam tidak ada data baru).
func (d *Detector) DetectMissingLive(ctx context.Context, points []Point) (int, error) {
	now := time.Now().Truncate(30 * time.Minute)
	hits := map[int]map[string][]hit{}
	byID := map[int]Point{}
	for _, p := range points {
		byID[p.ID] = p
		if !p.Active || p.LastTS == nil || p.LastTS.After(now.Add(-time.Hour)) {
			continue
		}
		start := p.LastTS.Add(30 * time.Minute)
		if start.Before(now.Add(-48 * time.Hour)) {
			start = now.Add(-48 * time.Hour)
		}
		for t := start; t.Before(now); t = t.Add(30 * time.Minute) {
			if hits[p.ID] == nil {
				hits[p.ID] = map[string][]hit{}
			}
			sev := "warning"
			if now.Sub(start) > 3*time.Hour {
				sev = "serious"
			}
			hits[p.ID]["missing"] = append(hits[p.ID]["missing"], hit{ts: t, sev: sev, detail: map[string]any{"last_ts": p.LastTS}})
		}
	}
	return d.save(ctx, hits, byID, now.Add(-48*time.Hour), now)
}

// ListAnomalies mengembalikan anomali (terbaru dulu) dengan filter.
func (r *Repo) ListAnomalies(ctx context.Context, kind, severity, status string, pointID int, from, to time.Time, limit int) ([]Anomaly, error) {
	if limit <= 0 || limit > 2000 {
		limit = 300
	}
	rows, err := r.pool.Query(ctx, `SELECT id, point_id, kind, severity, start_ts, end_ts, slots, value, expected, detail, explanation, status, note, handled_by, created_at, updated_at
		FROM load_anomalies WHERE ($1 = '' OR kind = $1) AND ($2 = '' OR severity = $2)
		AND ($3 = '' OR ($3 = 'active' AND status <> 'closed') OR status = $3) AND ($4 = 0 OR point_id = $4)
		AND end_ts >= $5 AND start_ts < $6 ORDER BY start_ts DESC LIMIT $7`, kind, severity, status, pointID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Anomaly{}
	for rows.Next() {
		var a Anomaly
		var det []byte
		var v, e *float32
		if err := rows.Scan(&a.ID, &a.PointID, &a.Kind, &a.Severity, &a.Start, &a.End, &a.Slots, &v, &e, &det, &a.Explanation, &a.Status, &a.Note, &a.HandledBy, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		if v != nil {
			x := float64(*v)
			a.Value = &x
		}
		if e != nil {
			x := float64(*e)
			a.Expected = &x
		}
		_ = json.Unmarshal(det, &a.Detail)
		out = append(out, a)
	}
	return out, rows.Err()
}

// AnomalyCounts menghitung anomali aktif per jenis & tingkat.
func (r *Repo) AnomalyCounts(ctx context.Context, from, to time.Time) (map[string]map[string]int, int, error) {
	rows, err := r.pool.Query(ctx, `SELECT kind, severity, count(*) FROM load_anomalies WHERE end_ts >= $1 AND start_ts < $2 GROUP BY 1, 2`, from, to)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := map[string]map[string]int{}
	total := 0
	for rows.Next() {
		var k, s string
		var n int
		if rows.Scan(&k, &s, &n) == nil {
			if out[k] == nil {
				out[k] = map[string]int{}
			}
			out[k][s] = n
			total += n
		}
	}
	var open int
	_ = r.pool.QueryRow(ctx, `SELECT count(*) FROM load_anomalies WHERE status = 'open'`).Scan(&open)
	return out, open, rows.Err()
}

// UpdateAnomaly mengubah status / catatan anomali.
func (r *Repo) UpdateAnomaly(ctx context.Context, id int64, status, note, by string) error {
	tag, err := r.pool.Exec(ctx, `UPDATE load_anomalies SET status = COALESCE(NULLIF($2, ''), status), note = CASE WHEN $3 <> '' THEN $3 ELSE note END,
		handled_by = $4, updated_at = now() WHERE id = $1`, id, status, note, by)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}
