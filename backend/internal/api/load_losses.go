package api

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/load"
)

// ---------------------------------------------------------------- topologi neraca energi

// lossTopo: neraca per penyulang (penyulang → gardu) dan per trafo GI (trafo → penyulang).
type lossTopo struct {
	feeders map[int]load.Balance // kunci: id titik penyulang
	trafos  map[int]load.Balance // kunci: id titik trafo GI
	pts     map[int]load.Point
	nFeeder int // penyulang aktif
}

// gdKVA: kapasitas trafo tiap gardu (kVA) dari atribut GIS — Σ daya trafo distribusi di dalam gardu,
// atau atribut daya pada gardu itu sendiri. Disimpan 15 menit.
func (s *Server) gdKVA(ctx context.Context) map[int64]float64 {
	ls := s.d.Load
	ls.mu.Lock()
	if ls.gdKVA != nil && time.Since(ls.gdKVAAt) < 15*time.Minute {
		m := ls.gdKVA
		ls.mu.Unlock()
		return m
	}
	ls.mu.Unlock()
	out := map[int64]float64{}
	rows, err := s.d.Pool.Query(ctx, `SELECT id, type_code, NULLIF(COALESCE(properties->>'daya_kva', properties->>'kapasitas_kva'), '')::float
		FROM gis_nodes WHERE type_code IN ('trafo_distribusi', 'gd') AND (properties ? 'daya_kva' OR properties ? 'kapasitas_kva')`)
	if err == nil {
		for rows.Next() {
			var id int64
			var tc string
			var v *float64
			if rows.Scan(&id, &tc, &v) != nil || v == nil || *v <= 0 {
				continue
			}
			gd := id
			if tc == "trafo_distribusi" {
				gd = s.d.Graph.NodeInfo(id).GD
			}
			if gd != 0 {
				out[gd] += *v
			}
		}
		rows.Close()
	}
	ls.mu.Lock()
	ls.gdKVA, ls.gdKVAAt = out, time.Now()
	ls.mu.Unlock()
	return out
}

func (s *Server) lossTopology(ctx context.Context) (*lossTopo, error) {
	ls := s.d.Load
	ls.mu.Lock()
	if ls.topo != nil && time.Since(ls.topoAt) < 10*time.Minute {
		t := ls.topo
		ls.mu.Unlock()
		return t, nil
	}
	ls.mu.Unlock()
	pts, err := ls.Repo.Points(ctx)
	if err != nil {
		return nil, err
	}
	st := s.loadSettings()
	kva := s.gdKVA(ctx)
	defKVA := s.d.Configs.Float("load.default_gd_kva", 200)
	defFeederMW := math.Sqrt(3) * s.d.Configs.Float("ops.feeder_kv", 20) * s.d.Configs.Float("ops.feeder_capacity_a", 400) / 1000 * st.CapPF
	t := &lossTopo{feeders: map[int]load.Balance{}, trafos: map[int]load.Balance{}, pts: map[int]load.Point{}}
	feederByHead := map[int64]load.Point{}
	gdByNode := map[int64]load.Point{}
	for _, p := range pts {
		t.pts[p.ID] = p
		if !p.Active || p.NodeID == nil {
			continue
		}
		switch p.Kind {
		case "feeder":
			feederByHead[*p.NodeID] = p
			t.nFeeder++
		case "gd":
			gdByNode[*p.NodeID] = p
		}
	}
	// penyulang → gardu (bobot kVA; total = seluruh gardu penyulang menurut graf)
	type fb struct {
		outs      map[int]float64
		total     float64
		n         int
		seenNodes map[int64]bool
	}
	fbs := map[int64]*fb{}
	get := func(head int64) *fb {
		x := fbs[head]
		if x == nil {
			x = &fb{outs: map[int]float64{}, seenNodes: map[int64]bool{}}
			fbs[head] = x
		}
		return x
	}
	w := func(node int64, p *load.Point) float64 {
		if p != nil && p.CapMVA() > 0 {
			return p.CapMVA() * 1000
		}
		if v := kva[node]; v > 0 {
			return v
		}
		return defKVA
	}
	for _, g := range s.d.Graph.GDStatuses() {
		if _, ok := feederByHead[g.Feeder]; !ok {
			continue
		}
		x := get(g.Feeder)
		var gp *load.Point
		if q, ok := gdByNode[g.ID]; ok {
			gp = &q
			x.outs[q.ID] = w(g.ID, gp)
		}
		x.total += w(g.ID, gp)
		x.n++
		x.seenNodes[g.ID] = true
	}
	// gardu bermeter yang pemasoknya (hierarki) belum tercatat di graf
	for node, q := range gdByNode {
		if q.FeederID == nil {
			continue
		}
		if _, ok := feederByHead[*q.FeederID]; !ok {
			continue
		}
		x := get(*q.FeederID)
		if !x.seenNodes[node] {
			qq := q
			x.outs[q.ID] = w(node, &qq)
			x.total += x.outs[q.ID]
			x.n++
		}
	}
	for head, x := range fbs {
		f := feederByHead[head]
		if len(x.outs) == 0 {
			continue
		}
		t.feeders[f.ID] = load.Balance{Kind: "feeder", In: f.ID, Outs: x.outs, Total: x.total, NOut: x.n}
	}
	// trafo GI → penyulang (bobot daya mampu; total = seluruh penyulang trafo menurut graf)
	_, feeders := s.d.Graph.PowerSummary()
	trafoFeeders := map[int64][]int64{}
	for _, f := range feeders {
		if f.TrafoGI != 0 {
			trafoFeeders[f.TrafoGI] = append(trafoFeeders[f.TrafoGI], f.Head)
		}
	}
	for _, p := range pts {
		if p.Kind != "trafo_gi" || !p.Active || p.NodeID == nil {
			continue
		}
		b := load.Balance{Kind: "trafo_gi", In: p.ID, Outs: map[int]float64{}}
		for _, head := range trafoFeeders[*p.NodeID] {
			wt := defFeederMW
			if f, ok := feederByHead[head]; ok {
				if c := f.CapMW(st.CapPF); c > 0 {
					wt = c
				}
				b.Outs[f.ID] = wt
			}
			b.Total += wt
			b.NOut++
		}
		if len(b.Outs) > 0 {
			t.trafos[p.ID] = b
		}
	}
	ls.mu.Lock()
	ls.topo, ls.topoAt = t, time.Now()
	ls.mu.Unlock()
	return t, nil
}

// lossRow adalah neraca satu penyulang / trafo GI.
type lossRow struct {
	PointID int    `json:"point_id"`
	Code    string `json:"code"`
	Kind    string `json:"kind"`
	UP3     string `json:"up3"`
	ULP     string `json:"ulp"`
	load.BalanceResult
}

// lossMatch: titik termasuk cakupan entitas analisa susut.
func lossMatch(level, id string, p load.Point) bool {
	switch level {
	case "", "system":
		return true
	case "uid":
		return p.UID == id
	case "up3":
		return p.UP3 == id || (id == "-" && p.UP3 == "")
	case "gi":
		return p.GIID != nil && strconv.FormatInt(*p.GIID, 10) == id
	case "trafo_gi":
		return p.TrafoGIID != nil && strconv.FormatInt(*p.TrafoGIID, 10) == id
	case "feeder", "point":
		return strconv.Itoa(p.ID) == id
	}
	return false
}

// scope memilih neraca penyulang & trafo sesuai entitas.
func (t *lossTopo) scope(level, id string) (feeders, trafos []int) {
	for pid := range t.feeders {
		if lossMatch(level, id, t.pts[pid]) {
			feeders = append(feeders, pid)
		}
	}
	for pid := range t.trafos {
		p := t.pts[pid]
		if level == "trafo_gi" {
			if p.NodeID != nil && strconv.FormatInt(*p.NodeID, 10) == id {
				trafos = append(trafos, pid)
			}
		} else if level != "feeder" && level != "point" && lossMatch(level, id, p) {
			trafos = append(trafos, pid)
		}
	}
	sort.Ints(feeders)
	sort.Ints(trafos)
	return
}

type lossResult struct {
	Dist     load.BalanceResult `json:"dist"`
	GI       load.BalanceResult `json:"gi"`
	Combined float64            `json:"combined_pct"`
	Feeders  []lossRow          `json:"feeders"`
	Trafos   []lossRow          `json:"trafos"`
	Coverage gin.H              `json:"coverage"`
}

// evalLosses menghitung neraca penyulang & trafo GI pada [from, to) untuk cakupan entitas.
func (s *Server) evalLosses(ctx context.Context, level, id string, from, to time.Time) (*lossResult, error) {
	t, err := s.lossTopology(ctx)
	if err != nil {
		return nil, err
	}
	st := s.loadSettings()
	fs, ts := t.scope(level, id)
	ids := []int32{}
	for _, list := range [][]int{fs, ts} {
		for _, pid := range list {
			var b load.Balance
			if b = t.feeders[pid]; b.In == 0 {
				b = t.trafos[pid]
			}
			ids = append(ids, int32(b.In))
			for o := range b.Outs {
				ids = append(ids, int32(o))
			}
		}
	}
	en, err := s.d.Load.Repo.DailyEnergy(ctx, ids, from, to)
	if err != nil {
		return nil, err
	}
	days := load.Days(from, to)
	res := &lossResult{Feeders: []lossRow{}, Trafos: []lossRow{}}
	row := func(pid int, b load.Balance) lossRow {
		p := t.pts[pid]
		return lossRow{PointID: pid, Code: p.Code, Kind: p.Kind, UP3: p.UP3, ULP: p.ULP, BalanceResult: b.Evaluate(en, days, st.LossCoverage, true)}
	}
	dist, gi := []load.BalanceResult{}, []load.BalanceResult{}
	gdPts := 0
	for _, pid := range fs {
		r := row(pid, t.feeders[pid])
		gdPts += r.Metered
		dist = append(dist, r.BalanceResult)
		r.Daily = nil
		res.Feeders = append(res.Feeders, r)
	}
	for _, pid := range ts {
		r := row(pid, t.trafos[pid])
		gi = append(gi, r.BalanceResult)
		r.Daily = nil
		res.Trafos = append(res.Trafos, r)
	}
	res.Dist, res.GI = load.Sum(dist), load.Sum(gi)
	// susut gabungan trafo GI → gardu: 1 − (1 − susut GI)(1 − susut distribusi)
	g, d := 0.0, 0.0
	if res.GI.EIn > 0 {
		g = res.GI.Pct / 100
	}
	if res.Dist.EIn > 0 {
		d = res.Dist.Pct / 100
	}
	res.Combined = (1 - (1-g)*(1-d)) * 100
	nf := 0 // penyulang aktif dalam cakupan (bermeter gardu maupun tidak)
	for _, p := range t.pts {
		if p.Kind == "feeder" && p.Active && lossMatch(level, id, p) {
			nf++
		}
	}
	res.Coverage = gin.H{"feeders": nf, "feeders_metered": len(fs), "gd_points": gdPts, "trafos_metered": len(ts), "min_coverage": st.LossCoverage}
	sort.Slice(res.Feeders, func(i, j int) bool { return lossRank(res.Feeders[i]) > lossRank(res.Feeders[j]) })
	sort.Slice(res.Trafos, func(i, j int) bool { return math.Abs(res.Trafos[i].Pct) > math.Abs(res.Trafos[j].Pct) })
	return res, nil
}

func lossRank(r lossRow) float64 {
	if r.Valid == 0 {
		return -1e9
	}
	return r.Pct
}

// lossPeriod: rentang periode analisa susut (hari lengkap saja; hari ini belum dihitung).
func lossPeriod(period string, day time.Time) (time.Time, time.Time) {
	var from, to time.Time
	switch period {
	case "month":
		from = time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, load.Loc)
		to = from.AddDate(0, 1, 0)
	case "year":
		from = time.Date(day.Year(), 1, 1, 0, 0, 0, 0, load.Loc)
		to = from.AddDate(1, 0, 0)
	case "30d":
		from, to = day.AddDate(0, 0, -29), day.AddDate(0, 0, 1)
	default:
		from, to = day, day.AddDate(0, 0, 1)
	}
	l := time.Now().In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	if to.After(today) {
		to = today
	}
	return from, to
}

// GET /api/load/losses?level&id&period=day|month|year|30d&date=
func (s *Server) loadLosses(c *gin.Context) {
	ctx := c.Request.Context()
	level, id := c.DefaultQuery("level", "system"), c.Query("id")
	period := c.DefaultQuery("period", "month")
	day := loadDay(c)
	from, to := lossPeriod(period, day)
	if !to.After(from) {
		// hari ini dipilih: pakai kemarin
		from, to = lossPeriod("day", day.AddDate(0, 0, -1))
	}
	res, err := s.evalLosses(ctx, level, id, from, to)
	if err != nil {
		s.simErr(c, err)
		return
	}
	name := id
	if level == "system" || level == "" {
		name = "Sistem"
	} else if e, _, err := s.resolveEntity(ctx, level, id); err == nil {
		name = e.Name
	}
	st := s.loadSettings()
	ok(c, gin.H{"level": level, "id": id, "name": name, "period": period, "from": from, "to": to, "result": res,
		"settings": gin.H{"high": st.LossHigh, "gi": st.LossGI, "min_coverage": st.LossCoverage}})
}

// GET /api/load/losses/feeder?point&date&days=30 — susut satu penyulang: profil per slot, dekomposisi
// (tetap / sebanding beban / kuadrat beban), neraca harian, dan energi tiap gardu.
func (s *Server) loadFeederLosses(c *gin.Context) {
	ctx := c.Request.Context()
	t, err := s.lossTopology(ctx)
	if err != nil {
		s.simErr(c, err)
		return
	}
	pid := queryInt(c, "point", 0)
	b, okB := t.feeders[pid]
	if !okB {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	st := s.loadSettings()
	day := loadDay(c)
	days := queryInt(c, "days", 30)
	if days < 7 || days > 120 {
		days = 30
	}
	dayTo := day.AddDate(0, 0, 1)
	from := dayTo.AddDate(0, 0, -days)
	ids := []int32{int32(b.In)}
	for o := range b.Outs {
		ids = append(ids, int32(o))
	}
	rs, err := s.d.Load.Repo.Readings(ctx, ids, from, dayTo)
	if err != nil {
		handleErr(c, err)
		return
	}
	type slot struct {
		pf, pg, w float64
		hasF      bool
	}
	slots := map[time.Time]*slot{}
	gdE := map[int]float64{}
	gdPeak := map[int]float64{}
	gdN := map[int]int{}
	for _, r := range rs {
		if r.P == nil {
			continue
		}
		x := slots[r.TS]
		if x == nil {
			x = &slot{}
			slots[r.TS] = x
		}
		if r.PointID == b.In {
			x.pf, x.hasF = *r.P, true
			continue
		}
		x.pg += *r.P
		x.w += b.Outs[r.PointID]
		if !r.TS.Before(day) {
			e := *r.P * 0.5
			if r.KWhImp != nil {
				e = *r.KWhImp / 1000
			}
			gdE[r.PointID] += e
			gdPeak[r.PointID] = math.Max(gdPeak[r.PointID], *r.P)
			gdN[r.PointID]++
		}
	}
	type prof struct {
		TS       time.Time `json:"ts"`
		Feeder   float64   `json:"feeder"`
		GD       float64   `json:"gd"`       // Σ gardu diperkirakan (dikoreksi cakupan)
		Measured float64   `json:"measured"` // Σ gardu bermeter
		Loss     float64   `json:"loss"`
		Pct      float64   `json:"pct"`
		Coverage float64   `json:"coverage"`
	}
	profile := []prof{}
	ps, ls := []float64{}, []float64{}
	keys := make([]time.Time, 0, len(slots))
	for ts := range slots {
		keys = append(keys, ts)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Before(keys[j]) })
	for _, ts := range keys {
		x := slots[ts]
		cov := 0.0
		if b.Total > 0 {
			cov = math.Min(100, x.w/b.Total*100)
		}
		if !x.hasF || cov < st.LossCoverage || x.w == 0 {
			continue
		}
		est := x.pg / (cov / 100)
		loss := x.pf - est
		if x.pf > 0 {
			ps = append(ps, x.pf)
			ls = append(ls, loss)
		}
		if !ts.Before(day) {
			p := prof{TS: ts, Feeder: x.pf, GD: est, Measured: x.pg, Loss: loss, Coverage: cov}
			if x.pf > 0 {
				p.Pct = loss / x.pf * 100
			}
			profile = append(profile, p)
		}
	}
	fit := load.FitLosses(ps, ls)
	en, _ := s.d.Load.Repo.DailyEnergy(ctx, ids, from, dayTo)
	bal := b.Evaluate(en, load.Days(from, dayTo), st.LossCoverage, true)
	type gdRow struct {
		PointID  int     `json:"point_id"`
		Code     string  `json:"code"`
		KVA      float64 `json:"kva"`
		EnergyMW float64 `json:"energy_mwh"`
		PeakKW   float64 `json:"peak_kw"`
		Util     float64 `json:"util"`
		Samples  int     `json:"samples"`
	}
	gds := []gdRow{}
	for o, wkva := range b.Outs {
		p := t.pts[o]
		r := gdRow{PointID: o, Code: p.Code, KVA: wkva, EnergyMW: gdE[o], PeakKW: gdPeak[o] * 1000, Samples: gdN[o]}
		if wkva > 0 {
			r.Util = gdPeak[o] * 1000 / (wkva * st.CapPF) * 100
		}
		gds = append(gds, r)
	}
	sort.Slice(gds, func(i, j int) bool { return gds[i].Util > gds[j].Util })
	p := t.pts[b.In]
	ok(c, gin.H{"point": p, "date": day.Format("2006-01-02"), "days": days, "profile": profile, "fit": fit, "balance": bal,
		"gds": gds, "members": b.NOut, "metered": len(b.Outs), "total_kva": b.Total, "settings": gin.H{"high": st.LossHigh, "min_coverage": st.LossCoverage}})
}

// lossSummary: susut sistem pada [from, to) tanpa rincian (ringkasan & AI).
func (s *Server) lossSummary(ctx context.Context, from, to time.Time) (gin.H, error) {
	r, err := s.evalLosses(ctx, "system", "", from, to)
	if err != nil {
		return nil, err
	}
	r.Dist.Daily, r.GI.Daily = nil, nil
	return gin.H{"dist": r.Dist, "gi": r.GI, "combined_pct": r.Combined, "coverage": r.Coverage}, nil
}

// lossReport: bagian susut pada laporan beban.
func (s *Server) lossReport(ctx context.Context, from, to time.Time) (gin.H, error) {
	r, err := s.evalLosses(ctx, "system", "", from, to)
	if err != nil {
		return nil, err
	}
	st := s.loadSettings()
	top, neg := []lossRow{}, []lossRow{}
	type up3Acc struct {
		UP3  string  `json:"up3"`
		EIn  float64 `json:"e_in"`
		EOut float64 `json:"e_out"`
		Pct  float64 `json:"pct"`
		N    int     `json:"feeders"`
	}
	by := map[string]*up3Acc{}
	for _, f := range r.Feeders {
		if f.Valid == 0 {
			continue
		}
		if f.Pct >= st.LossHigh && len(top) < 20 {
			top = append(top, f)
		}
		if f.Pct < -2 && len(neg) < 20 {
			neg = append(neg, f)
		}
		k := f.UP3
		if k == "" {
			k = "-"
		}
		a := by[k]
		if a == nil {
			a = &up3Acc{UP3: k}
			by[k] = a
		}
		a.EIn += f.EIn
		a.EOut += f.EOut
		a.N++
	}
	up3 := []up3Acc{}
	for _, a := range by {
		if a.EIn > 0 {
			a.Pct = (a.EIn - a.EOut) / a.EIn * 100
		}
		up3 = append(up3, *a)
	}
	sort.Slice(up3, func(i, j int) bool { return up3[i].Pct > up3[j].Pct })
	worst := r.Feeders
	if len(worst) > 15 {
		worst = worst[:15]
	}
	return gin.H{"dist": r.Dist, "gi": r.GI, "combined_pct": r.Combined, "coverage": r.Coverage, "worst_feeders": worst,
		"high": top, "negative": neg, "by_up3": up3, "trafos": r.Trafos, "settings": gin.H{"high": st.LossHigh, "gi": st.LossGI}}, nil
}

// detectLosses mencatat anomali susut harian pada [from, to): susut distribusi penyulang tinggi / negatif
// (indikasi pencurian, gardu tak terdaftar, atau kesalahan meter) dan selisih trafo GI vs Σ penyulang.
func (s *Server) detectLosses(ctx context.Context, from, to time.Time) {
	from = time.Date(from.In(load.Loc).Year(), from.In(load.Loc).Month(), from.In(load.Loc).Day(), 0, 0, 0, 0, load.Loc)
	l := time.Now().In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	if to.After(today) {
		to = today
	}
	if !to.After(from) {
		return
	}
	st := s.loadSettings()
	topo, err := s.lossTopology(ctx)
	if err != nil {
		return
	}
	hits := []load.DayHit{}
	for cur := from; cur.Before(to); cur = cur.AddDate(0, 0, 30) {
		end := cur.AddDate(0, 0, 30)
		if end.After(to) {
			end = to
		}
		en, err := s.d.Load.Repo.DailyEnergy(ctx, nil, cur, end)
		if err != nil {
			return
		}
		days := load.Days(cur, end)
		for pid, b := range topo.feeders {
			for _, d := range b.Evaluate(en, days, st.LossCoverage, true).Daily {
				if !d.Valid {
					continue
				}
				dayT, _ := time.ParseInLocation("2006-01-02", d.Day, load.Loc)
				expl := fmt.Sprintf("Energi penyulang %.1f MWh, gardu %.1f MWh (cakupan meter %.0f%%) → susut %.1f MWh = %.1f%%.", d.EIn, d.EOut, d.Coverage, d.Loss, d.Pct)
				switch {
				case d.Pct >= st.LossHigh:
					sev := "warning"
					if d.Pct >= st.LossHigh*1.5 {
						sev = "serious"
					}
					hits = append(hits, load.DayHit{PointID: pid, Kind: "losses", Severity: sev, Day: dayT, Value: d.Pct, Expected: st.LossHigh,
						Detail: map[string]any{"e_in": d.EIn, "e_out": d.EOut, "coverage": d.Coverage, "scope": "distribusi"}, Explanation: expl})
				case d.Pct < -2:
					hits = append(hits, load.DayHit{PointID: pid, Kind: "losses", Severity: "warning", Day: dayT, Value: d.Pct, Expected: 0,
						Detail:      map[string]any{"e_in": d.EIn, "e_out": d.EOut, "coverage": d.Coverage, "scope": "negatif"},
						Explanation: expl + " Susut negatif: periksa meter penyulang/gardu atau gardu yang tercatat pada penyulang lain."})
				}
			}
		}
		for pid, b := range topo.trafos {
			for _, d := range b.Evaluate(en, days, 99, true).Daily {
				if !d.Valid || math.Abs(d.Pct) < st.LossGI {
					continue
				}
				dayT, _ := time.ParseInLocation("2006-01-02", d.Day, load.Loc)
				hits = append(hits, load.DayHit{PointID: pid, Kind: "losses", Severity: "warning", Day: dayT, Value: d.Pct, Expected: st.LossGI,
					Detail:      map[string]any{"e_in": d.EIn, "e_out": d.EOut, "scope": "gi"},
					Explanation: fmt.Sprintf("Energi trafo GI %.1f MWh vs Σ penyulang %.1f MWh → selisih %.1f%%.", d.EIn, d.EOut, d.Pct)})
			}
		}
	}
	if len(hits) == 0 {
		return
	}
	pts, _ := s.d.Load.Repo.Points(ctx)
	if _, err := s.d.Load.Det.SaveDayHits(ctx, pts, hits, from, to); err != nil {
		log.Printf("[load] simpan anomali susut: %v", err)
	}
}
