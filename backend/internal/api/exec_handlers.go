package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/stream"
)

// ---------------------------------------------------------------- perhitungan dasar

func jakartaLoc() *time.Location {
	if tz, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		return tz
	}
	return time.FixedZone("WIB", 7*3600)
}

// outageSum adalah bagian ringkasan kejadian (kolom summary) yang dipakai dasbor.
type outageSum struct {
	Customers int     `json:"pelanggan"`
	LoadVA    float64 `json:"beban_va"`
	GD        int     `json:"gd"`
	Feeders   []struct {
		ID   int64  `json:"id"`
		Code string `json:"code"`
		Name string `json:"name"`
	} `json:"penyulang"`
	GI []struct {
		ID   int64  `json:"id"`
		Code string `json:"code"`
	} `json:"parent_gi"`
}

// relCalc menyimpan kejadian padam pada satu periode yang sudah dihitung indeksnya.
type relCalc struct {
	from, to time.Time
	rp       gis.ReliabilityParams
	served   int
	outages  []gis.OutageRecord
	sums     []outageSum
}

func (s *Server) loadRel(ctx context.Context, from, to time.Time) (*relCalc, error) {
	items, err := s.d.Power.ListOutagesBetween(ctx, from, to, 50000)
	if err != nil {
		return nil, err
	}
	sum, _ := s.d.Graph.PowerSummary()
	rc := &relCalc{from: from, to: to, rp: s.reliabilityParams(), served: sum.Customers.Total, outages: items, sums: make([]outageSum, len(items))}
	for i := range items {
		gis.ApplyReliability(&rc.outages[i], from, to, rc.rp)
		_ = json.Unmarshal(items[i].Summary, &rc.sums[i])
	}
	return rc, nil
}

func (rc *relCalc) total() gis.ReliabilityGroup {
	g := gis.ReliabilityGroup{}
	for _, o := range rc.outages {
		g.Add(o)
	}
	g.Finish(rc.served)
	return g
}

func (rc *relCalc) groupBy(key func(o gis.OutageRecord) string) map[string]*gis.ReliabilityGroup {
	out := map[string]*gis.ReliabilityGroup{}
	for _, o := range rc.outages {
		k := key(o)
		g := out[k]
		if g == nil {
			g = &gis.ReliabilityGroup{}
			out[k] = g
		}
		g.Add(o)
	}
	for _, g := range out {
		g.Finish(rc.served)
	}
	return out
}

// mttr: rata-rata durasi (menit) kejadian utama yang sudah selesai & bukan momentary.
func (rc *relCalc) mttr() float64 {
	n, sum := 0, 0.0
	for _, o := range rc.outages {
		if o.EndedAt != nil && o.ParentID == nil && !o.Momentary && o.StartedAt.After(rc.from) {
			n++
			sum += o.DurationSec / 60
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

type feederAgg struct {
	ID              int64     `json:"id"`
	Code            string    `json:"code"`
	Name            string    `json:"name"`
	Outages         int       `json:"outages"`
	Faults          int       `json:"faults"` // GANGGUAN + BENCANA ALAM
	Momentary       int       `json:"momentary"`
	CustomersOut    float64   `json:"customers_out"`
	CustomerMinutes float64   `json:"customer_minutes"`
	ENSkWh          float64   `json:"ens_kwh"`
	ENSRp           float64   `json:"ens_rp"`
	LastAt          time.Time `json:"last_at"`
}

// feeders: agregat per penyulang. Kejadian yang mengenai beberapa penyulang dibagi rata
// (pelanggan·menit, ENS), sedangkan frekuensinya dihitung di tiap penyulang.
func (rc *relCalc) feeders(filter func(i int) bool) []*feederAgg {
	m := map[int64]*feederAgg{}
	for i, o := range rc.outages {
		if filter != nil && !filter(i) {
			continue
		}
		fs := rc.sums[i].Feeders
		if len(fs) == 0 {
			continue
		}
		share := 1 / float64(len(fs))
		for _, f := range fs {
			a := m[f.ID]
			if a == nil {
				a = &feederAgg{ID: f.ID, Code: f.Code, Name: f.Name}
				m[f.ID] = a
			}
			if o.ParentID == nil {
				a.Outages++
				if o.Kind == "GANGGUAN" || o.Kind == "BENCANA ALAM" {
					a.Faults++
				}
				if o.Momentary {
					a.Momentary++
				} else {
					a.CustomersOut += float64(o.Customers) * share
				}
			}
			if o.ParentID != nil || !o.Momentary { // sama dengan aturan SAIDI (ReliabilityGroup.Add)
				a.CustomerMinutes += o.CustomerMinutes * share
			}
			a.ENSkWh += o.ENSkWh * share
			a.ENSRp += o.ENSRp * share
			if o.StartedAt.After(a.LastAt) {
				a.LastAt = o.StartedAt
			}
		}
	}
	out := make([]*feederAgg, 0, len(m))
	for _, a := range m {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CustomerMinutes != out[j].CustomerMinutes {
			return out[i].CustomerMinutes > out[j].CustomerMinutes
		}
		return out[i].Outages > out[j].Outages
	})
	return out
}

type outageBrief struct {
	ID              int64      `json:"id"`
	Kind            string     `json:"kind"`
	Level           string     `json:"level"`
	CauseCode       string     `json:"cause_code"`
	CauseType       string     `json:"cause_type"`
	Feeder          string     `json:"feeder"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         *time.Time `json:"ended_at"`
	DurationMin     float64    `json:"duration_min"`
	Customers       int        `json:"customers"`
	CustomerMinutes float64    `json:"customer_minutes"`
	ENSkWh          float64    `json:"ens_kwh"`
	ENSRp           float64    `json:"ens_rp"`
	Momentary       bool       `json:"momentary"`
	Continuation    bool       `json:"continuation"`
}

func briefOf(o gis.OutageRecord, sm outageSum) outageBrief {
	b := outageBrief{ID: o.ID, Kind: o.Kind, Level: o.Level, CauseCode: o.CauseNodeCode, CauseType: o.CauseNodeType,
		StartedAt: o.StartedAt, EndedAt: o.EndedAt, DurationMin: o.DurationSec / 60, Customers: o.Customers,
		CustomerMinutes: o.CustomerMinutes, ENSkWh: o.ENSkWh, ENSRp: o.ENSRp, Momentary: o.Momentary, Continuation: o.ParentID != nil}
	if len(sm.Feeders) > 0 {
		b.Feeder = sm.Feeders[0].Code
		if len(sm.Feeders) > 1 {
			b.Feeder += fmt.Sprintf(" +%d", len(sm.Feeders)-1)
		}
	}
	return b
}

func (rc *relCalc) topOutages(n int, filter func(i int) bool) []outageBrief {
	idx := []int{}
	for i := range rc.outages {
		if filter == nil || filter(i) {
			idx = append(idx, i)
		}
	}
	sort.Slice(idx, func(a, b int) bool { return rc.outages[idx[a]].CustomerMinutes > rc.outages[idx[b]].CustomerMinutes })
	if len(idx) > n {
		idx = idx[:n]
	}
	out := make([]outageBrief, 0, len(idx))
	for _, i := range idx {
		out = append(out, briefOf(rc.outages[i], rc.sums[i]))
	}
	return out
}

// dayPoint adalah satu titik deret harian.
type dayPoint struct {
	Date            string  `json:"date"`
	Outages         int     `json:"outages"`
	Faults          int     `json:"faults"`
	CustomersOut    int     `json:"customers_out"`
	CustomerMinutes float64 `json:"customer_minutes"`
	ENSRp           float64 `json:"ens_rp"`
}

// daily: deret harian dalam periode (maks. 92 hari). Frekuensi menurut hari mulai, durasi dipotong per hari.
func (rc *relCalc) daily() []dayPoint {
	loc := jakartaLoc()
	start := rc.from.In(loc)
	start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	out := []dayPoint{}
	for d := start; d.Before(rc.to) && len(out) < 92; d = d.AddDate(0, 0, 1) {
		e := d.AddDate(0, 0, 1)
		p := dayPoint{Date: d.Format("2006-01-02")}
		for _, o := range rc.outages {
			if !o.StartedAt.Before(e) || (o.EndedAt != nil && !o.EndedAt.After(d)) {
				continue
			}
			x := o
			gis.ApplyReliability(&x, d, e, rc.rp)
			if !x.StartedAt.Before(d) && x.ParentID == nil {
				p.Outages++
				if x.Kind == "GANGGUAN" || x.Kind == "BENCANA ALAM" {
					p.Faults++
				}
				if !x.Momentary {
					p.CustomersOut += x.Customers
				}
			}
			if x.ParentID != nil || !x.Momentary {
				p.CustomerMinutes += x.CustomerMinutes
			}
			p.ENSRp += x.ENSRp
		}
		out = append(out, p)
	}
	return out
}

// ---------------------------------------------------------------- wilayah

type regionOut struct {
	gis.Region
	Rel    gis.ReliabilityGroup `json:"rel"`
	Active int                  `json:"active"` // kejadian padam aktif yang mengenai wilayah
}

// regionReliability menghitung indeks per ULP, per UP3 (gabungan ULP-nya), dan di luar wilayah.
// filter opsional membatasi kejadian yang dihitung.
func (s *Server) regionReliability(ctx context.Context, rc *relCalc) ([]regionOut, error) {
	regs, err := s.d.Boundaries.Regions(ctx, rc.served)
	if err != nil {
		return nil, err
	}
	byID := map[int64]*regionOut{}
	out := make([]regionOut, len(regs))
	for i, r := range regs {
		out[i] = regionOut{Region: r}
	}
	for i := range out {
		byID[out[i].ID] = &out[i]
	}
	for _, o := range rc.outages {
		up3 := map[int64]gis.OutageRecord{}
		for _, id := range gis.RegionIDs(o) {
			part, okp := gis.RegionPart(o, id)
			r := byID[id]
			if !okp || r == nil {
				continue
			}
			r.Rel.Add(part)
			if o.EndedAt == nil {
				r.Active++
			}
			if r.ParentID != 0 {
				if u, seen := up3[r.ParentID]; seen {
					u.Customers += part.Customers
					u.CustomerMinutes += part.CustomerMinutes
					u.ENSkWh += part.ENSkWh
					u.ENSRp += part.ENSRp
					up3[r.ParentID] = u
				} else {
					up3[r.ParentID] = part
				}
			}
		}
		for id, part := range up3 {
			if r := byID[id]; r != nil {
				r.Rel.Add(part)
				if o.EndedAt == nil {
					r.Active++
				}
			}
		}
	}
	for i := range out {
		out[i].Rel.Finish(out[i].Customers)
	}
	return out, nil
}

// regionMembers: id ULP untuk sebuah wilayah (UP3 → ULP-nya, ULP → dirinya, 0 → di luar wilayah).
func regionMembers(regs []regionOut, id int64) (map[int64]bool, *regionOut) {
	set := map[int64]bool{}
	var self *regionOut
	for i := range regs {
		r := &regs[i]
		if r.ID == id {
			self = r
			if r.Level != "up3" {
				set[r.ID] = true
			}
		}
		if r.ParentID == id && id != 0 {
			set[r.ID] = true
		}
	}
	return set, self
}

// ---------------------------------------------------------------- target

type targets struct {
	SAIDIYear   float64 `json:"saidi_year"`
	SAIFIYear   float64 `json:"saifi_year"`
	SAIDIPeriod float64 `json:"saidi_period"` // target dipro-rata ke panjang periode
	SAIFIPeriod float64 `json:"saifi_period"`
}

func (s *Server) targetsFor(from, to time.Time) targets {
	t := targets{SAIDIYear: s.d.Configs.Float("reliability.target_saidi_year", 120), SAIFIYear: s.d.Configs.Float("reliability.target_saifi_year", 2)}
	frac := to.Sub(from).Hours() / (365 * 24)
	t.SAIDIPeriod, t.SAIFIPeriod = t.SAIDIYear*frac, t.SAIFIYear*frac
	return t
}

// ---------------------------------------------------------------- laporan periode

// buildPeriodReport menyusun data laporan untuk periode [from, to) (dipakai dasbor & laporan berkala).
func (s *Server) buildPeriodReport(ctx context.Context, kind string, from, to time.Time) (gin.H, error) {
	rc, err := s.loadRel(ctx, from, to)
	if err != nil {
		return nil, err
	}
	sla := s.d.Configs.Float("ops.report_sla_minutes", 120)
	ops, err := s.d.Exec.OpsStatsBetween(ctx, from, to, sla)
	if err != nil {
		return nil, err
	}
	regs, err := s.regionReliability(ctx, rc)
	if err != nil {
		return nil, err
	}
	// periode pembanding: bulan/tahun sebelumnya pada rentang yang sama, selain itu geser sepanjang periode
	var pFrom, pTo time.Time
	switch kind {
	case "month", "monthly":
		pFrom, pTo = from.AddDate(0, -1, 0), to.AddDate(0, -1, 0)
	case "year":
		pFrom, pTo = from.AddDate(-1, 0, 0), to.AddDate(-1, 0, 0)
	default:
		pFrom, pTo = from.Add(-to.Sub(from)), from
	}
	prev := gin.H{}
	if prc, err := s.loadRel(ctx, pFrom, pTo); err == nil {
		pops, _ := s.d.Exec.OpsStatsBetween(ctx, pFrom, pTo, sla)
		prev = gin.H{"from": pFrom, "to": pTo, "total": prc.total(), "mttr_min": prc.mttr(), "reports": pops.Reports, "maneuvers": pops.Maneuvers}
	}
	fs := rc.feeders(nil)
	if len(fs) > 10 {
		fs = fs[:10]
	}
	byKind := rc.groupBy(func(o gis.OutageRecord) string { return o.Kind })
	byLevel := rc.groupBy(func(o gis.OutageRecord) string { return o.Level })
	data := gin.H{
		"kind": kind, "from": from, "to": to, "generated_at": time.Now(),
		"customers_served": rc.served, "params": rc.rp, "targets": s.targetsFor(from, to),
		"total": rc.total(), "mttr_min": rc.mttr(), "by_kind": byKind, "by_level": byLevel,
		"regions": regs, "top_feeders": fs, "top_outages": rc.topOutages(15, nil), "ops": ops, "previous": prev,
	}
	if to.Sub(from) <= 93*24*time.Hour {
		data["daily"] = rc.daily()
	}
	return data, nil
}

// periodOf mengembalikan periode laporan berkala yang memuat tanggal d.
func periodOf(kind string, d time.Time) (time.Time, time.Time) {
	loc := jakartaLoc()
	d = d.In(loc)
	day := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, loc)
	switch kind {
	case "weekly":
		wd := (int(day.Weekday()) + 6) % 7 // Senin = 0
		start := day.AddDate(0, 0, -wd)
		return start, start.AddDate(0, 0, 7)
	case "monthly":
		start := time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 1, 0)
	}
	return day, day.AddDate(0, 0, 1)
}

var monthsID = []string{"Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"}

func periodTitle(kind string, from, to time.Time) string {
	loc := jakartaLoc()
	f, t := from.In(loc), to.In(loc).AddDate(0, 0, -1)
	dmy := func(x time.Time) string { return fmt.Sprintf("%d %s %d", x.Day(), monthsID[x.Month()-1], x.Year()) }
	switch kind {
	case "weekly":
		return "Laporan Mingguan " + dmy(f) + " – " + dmy(t)
	case "monthly":
		return fmt.Sprintf("Laporan Bulanan %s %d", monthsID[f.Month()-1], f.Year())
	}
	return "Laporan Harian " + dmy(f)
}

// generatePeriodic menyusun & menyimpan laporan berkala.
func (s *Server) generatePeriodic(ctx context.Context, kind string, from, to time.Time, by string) (int64, error) {
	data, err := s.buildPeriodReport(ctx, kind, from, to)
	if err != nil {
		return 0, err
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return 0, err
	}
	id, err := s.d.Exec.SaveReport(ctx, gis.PeriodicReport{Kind: kind, PeriodStart: from, PeriodEnd: to, Title: periodTitle(kind, from, to), Data: raw, GeneratedBy: by})
	if err == nil {
		ev, _ := json.Marshal(gin.H{"kind": kind, "id": id})
		s.d.Hub.Publish(stream.Event{Type: "exec.report", ID: id, At: time.Now(), Data: ev})
	}
	return id, err
}

// StartExecScheduler membuat laporan berkala otomatis untuk periode lengkap terakhir
// (harian 00:15 WIB, mingguan Senin, bulanan tanggal 1) bila belum ada.
func StartExecScheduler(ctx context.Context, d *Deps) {
	s := &Server{d: d}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Minute):
			}
			if !d.Graph.Ready() {
				continue
			}
			now := time.Now().In(jakartaLoc())
			if now.Hour() == 0 && now.Minute() < 15 {
				continue // beri waktu kejadian lintas tengah malam tercatat
			}
			for _, kind := range gis.ReportKinds {
				if !d.Configs.Bool("report.auto_"+kind, true) {
					continue
				}
				cur, _ := periodOf(kind, now)
				from, to := periodOf(kind, cur.Add(-time.Hour))
				if d.Exec.ReportExists(ctx, kind, from) {
					continue
				}
				if id, err := s.generatePeriodic(ctx, kind, from, to, "system"); err != nil {
					log.Printf("[exec] laporan %s gagal: %v", kind, err)
				} else {
					log.Printf("[exec] laporan %s #%d dibuat (%s)", kind, id, from.Format("2006-01-02"))
				}
			}
		}
	}()
}

// ---------------------------------------------------------------- handler

// GET /api/exec/dashboard?period=today|month|year|30d|from&to
func (s *Server) execDashboard(c *gin.Context) {
	ctx := c.Request.Context()
	from, to, period := reliabilityPeriod(c)
	rep, err := s.buildPeriodReport(ctx, period, from, to)
	if err != nil {
		handleErr(c, err)
		return
	}
	loc := jakartaLoc()
	now := time.Now().In(loc)

	// tren 12 bulan
	m0 := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc).AddDate(0, -11, 0)
	yrc, err := s.loadRel(ctx, m0, now)
	if err != nil {
		handleErr(c, err)
		return
	}
	type monthPoint struct {
		Month string `json:"month"`
		gis.ReliabilityGroup
	}
	trend := []monthPoint{}
	for m := m0; m.Before(now); m = m.AddDate(0, 1, 0) {
		e := m.AddDate(0, 1, 0)
		if e.After(now) {
			e = now
		}
		g := gis.ReliabilityGroup{}
		for _, o := range yrc.outages {
			if !o.StartedAt.Before(e) || (o.EndedAt != nil && !o.EndedAt.After(m)) {
				continue
			}
			x := o
			gis.ApplyReliability(&x, m, e, yrc.rp)
			g.Add(x)
		}
		g.Finish(yrc.served)
		trend = append(trend, monthPoint{Month: m.Format("2006-01"), ReliabilityGroup: g})
	}

	// tahun berjalan vs target
	y0 := time.Date(now.Year(), 1, 1, 0, 0, 0, 0, loc)
	ytdG := gis.ReliabilityGroup{}
	for _, o := range yrc.outages {
		if o.EndedAt != nil && !o.EndedAt.After(y0) {
			continue
		}
		x := o
		gis.ApplyReliability(&x, y0, now, yrc.rp)
		ytdG.Add(x)
	}
	ytdG.Finish(yrc.served)
	elapsed := now.Sub(y0).Hours() / (float64(time.Date(now.Year()+1, 1, 1, 0, 0, 0, 0, loc).Sub(y0).Hours()))
	tg := s.targetsFor(y0, now)
	proj := func(v float64) float64 {
		if elapsed <= 0 {
			return 0
		}
		return v / elapsed
	}
	ytd := gin.H{"from": y0, "rel": ytdG, "elapsed": elapsed, "targets": tg,
		"saidi_projection": proj(ytdG.SAIDI), "saifi_projection": proj(ytdG.SAIFI)}

	// kondisi sekarang
	sum, feeders := s.d.Graph.PowerSummary()
	active, _ := s.d.Power.CountActiveOutages(ctx)
	rs, _ := s.d.Ops.ReportStats(ctx, s.d.Configs.Float("ops.report_sla_minutes", 120))
	plans, _ := s.d.Ops.ListPlans(ctx, "active", 200)
	sp := s.simParams()
	over := 0
	for _, f := range feeders {
		if sp.CapacityVA > 0 && (f.LoadVA-f.LoadOffVA)*sp.LoadFactor/sp.CapacityVA >= 0.8 {
			over++
		}
	}
	open := 0
	for _, st := range []string{"BARU", "DIVERIFIKASI", "DIKERJAKAN"} {
		open += rs[st]
	}
	nowH := gin.H{"at": sum.At, "customers": sum.Customers, "feeders": sum.Feeders, "gd": sum.GDState, "load_va": sum.LoadVA, "load_off_va": sum.LoadOffVA,
		"active_outages": active, "reports_open": open, "reports_overdue": rs["overdue"], "plans_active": len(plans), "feeders_high_load": over,
		"ready": s.d.Graph.Ready()}
	ok(c, gin.H{"period": period, "report": rep, "trend": trend, "ytd": ytd, "now": nowH})
}

// GET /api/exec/regions?period=
func (s *Server) execRegions(c *gin.Context) {
	ctx := c.Request.Context()
	from, to, period := reliabilityPeriod(c)
	rc, err := s.loadRel(ctx, from, to)
	if err != nil {
		handleErr(c, err)
		return
	}
	regs, err := s.regionReliability(ctx, rc)
	if err != nil {
		handleErr(c, err)
		return
	}
	pending := 0
	for _, o := range rc.outages {
		if o.Regions == nil {
			pending++
		}
	}
	ok(c, gin.H{"period": period, "from": from, "to": to, "items": regs, "total": rc.total(), "targets": s.targetsFor(from, to),
		"customers_served": rc.served, "pending": pending})
}

// GET /api/exec/regions/:id?period=  (id 0 = di luar batas wilayah)
func (s *Server) execRegion(c *gin.Context) {
	ctx := c.Request.Context()
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 0 {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	from, to, period := reliabilityPeriod(c)
	rc, err := s.loadRel(ctx, from, to)
	if err != nil {
		handleErr(c, err)
		return
	}
	regs, err := s.regionReliability(ctx, rc)
	if err != nil {
		handleErr(c, err)
		return
	}
	members, self := regionMembers(regs, id)
	if id == 0 {
		members[0] = true
	}
	if self == nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	// kejadian yang mengenai wilayah, dengan porsi wilayahnya
	sub := &relCalc{from: rc.from, to: rc.to, rp: rc.rp, served: self.Customers}
	for i, o := range rc.outages {
		var agg gis.OutageRecord
		hit := false
		for _, rid := range gis.RegionIDs(o) {
			if !members[rid] {
				continue
			}
			part, okp := gis.RegionPart(o, rid)
			if !okp {
				continue
			}
			if !hit {
				agg, hit = part, true
			} else {
				agg.Customers += part.Customers
				agg.CustomerMinutes += part.CustomerMinutes
				agg.ENSkWh += part.ENSkWh
				agg.ENSRp += part.ENSRp
			}
		}
		if hit {
			sub.outages = append(sub.outages, agg)
			sub.sums = append(sub.sums, rc.sums[i])
		}
	}
	children := []regionOut{}
	for _, r := range regs {
		if id != 0 && r.ParentID == id {
			children = append(children, r)
		}
	}
	fs := sub.feeders(nil)
	if len(fs) > 10 {
		fs = fs[:10]
	}
	byKind := sub.groupBy(func(o gis.OutageRecord) string { return o.Kind })
	ok(c, gin.H{"period": period, "from": from, "to": to, "region": self, "children": children, "targets": s.targetsFor(from, to),
		"by_kind": byKind, "top_feeders": fs, "outages": sub.topOutages(50, nil)})
}

// GET /api/exec/reports?kind=
func (s *Server) execListReports(c *gin.Context) {
	items, err := s.d.Exec.ListReports(c.Request.Context(), c.Query("kind"), queryInt(c, "limit", 100))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/exec/reports/:id
func (s *Server) execGetReport(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	r, err := s.d.Exec.GetReport(c.Request.Context(), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, r)
}

// POST /api/exec/reports {kind, date: YYYY-MM-DD}
func (s *Server) execGenerateReport(c *gin.Context) {
	var req struct {
		Kind string `json:"kind"`
		Date string `json:"date"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || !inList(req.Kind, gis.ReportKinds) {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	d := time.Now()
	if req.Date != "" {
		t, err := time.ParseInLocation("2006-01-02", req.Date, jakartaLoc())
		if err != nil {
			failT(c, http.StatusBadRequest, "common.bad_payload")
			return
		}
		d = t
	}
	from, to := periodOf(req.Kind, d)
	if from.After(time.Now()) {
		failT(c, http.StatusBadRequest, "exec.future_period")
		return
	}
	_, username := claimsUser(c)
	id, err := s.generatePeriodic(c.Request.Context(), req.Kind, from, to, username)
	if err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "exec.report", strconv.FormatInt(id, 10), gin.H{"kind": req.Kind, "from": from})
	ok(c, gin.H{"id": id})
}

// PUT /api/exec/reports/:id/narrative {text}
func (s *Server) execSetNarrative(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Text) > 60000 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	_, username := claimsUser(c)
	if err := s.d.Exec.SetNarrative(c.Request.Context(), id, req.Text, username); err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "exec.narrative", strconv.FormatInt(id, 10), gin.H{"chars": len(req.Text)})
	ok(c, gin.H{"ok": true})
}

// DELETE /api/exec/reports/:id
func (s *Server) execDeleteReport(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	if err := s.d.Exec.DeleteReport(c.Request.Context(), id); err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "exec.report_delete", strconv.FormatInt(id, 10), nil)
	ok(c, gin.H{"ok": true})
}

// POST /api/exec/regions/recompute: hitung ulang wilayah seluruh kejadian (sesudah batas wilayah berubah)
func (s *Server) execRecomputeRegions(c *gin.Context) {
	n, err := s.d.Power.RecomputeOutageRegions(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	s.d.Boundaries.InvalidateRegions()
	s.auditOps(c, "exec.regions_recompute", "", gin.H{"outages": n})
	ok(c, gin.H{"outages": n})
}
