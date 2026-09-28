package api

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/load"
)

// ---------------------------------------------------------------- susut gardu distribusi → kWh pelanggan (bulanan)

const billMaxBytes = 200 << 20

type lvRow struct {
	GD             int64   `json:"gd_id"`
	Code           string  `json:"code"`
	Name           string  `json:"name"`
	Feeder         int64   `json:"feeder_id,omitempty"`
	FeederCode     string  `json:"feeder_code,omitempty"`
	UP3            string  `json:"up3,omitempty"`
	ULP            string  `json:"ulp,omitempty"`
	PointID        int     `json:"point_id,omitempty"`
	EnergyKWh      float64 `json:"energy_kwh"`
	EnergyMeasured float64 `json:"energy_measured_kwh"`
	Days           int     `json:"days"`
	ValidDays      int     `json:"valid_days"`
	SoldKWh        float64 `json:"sold_kwh"`
	Billed         int     `json:"billed"`
	Customers      int     `json:"customers"`
	BilledPct      float64 `json:"billed_pct"`
	ZeroKWh        int     `json:"zero_kwh"`
	LossKWh        float64 `json:"loss_kwh"`
	Pct            float64 `json:"pct"`
	Status         string  `json:"status"` // ok | estimasi | tagihan_kurang | energi_kurang | tanpa_meter
	Flag           string  `json:"flag,omitempty"`
}

func (r lvRow) valid() bool { return r.Status == "ok" || r.Status == "estimasi" }

type lvResult struct {
	energyMonth  time.Time // bulan energi gardu (periode tagihan - pergeseran)
	lag          int
	period       time.Time
	partial      bool // bulan belum selesai
	rows         []lvRow
	unmatched    int
	unmatchedKWh float64
	noGD         int
	noGDKWh      float64
	at           time.Time
}

var lvCache = struct {
	sync.Mutex
	m map[string]*lvResult
}{m: map[string]*lvResult{}}

func invalidateLV() {
	lvCache.Lock()
	lvCache.m = map[string]*lvResult{}
	lvCache.Unlock()
}

type lvSettings struct{ high, minBilled, minDays, lowHours float64 }

func (s *Server) lvSettings() lvSettings {
	c := s.d.Configs
	return lvSettings{c.Float("load.lv_losses_high_pct", 10), c.Float("load.lv_min_billed_pct", 90), c.Float("load.lv_min_energy_days_pct", 80), c.Float("load.lv_low_hours", 40)}
}

// lvLag: pergeseran bulan tagihan terhadap bulan energi gardu (query lag=0..3, bawaan konfigurasi).
func (s *Server) lvLag(c *gin.Context) int {
	if v, err := strconv.Atoi(c.Query("lag")); err == nil && v >= 0 && v <= 3 {
		return v
	}
	v := s.d.Configs.Int("load.lv_billing_lag_months", 0)
	if v < 0 || v > 3 {
		v = 0
	}
	return v
}

func monthOf(c *gin.Context) (time.Time, bool) {
	p, ok := load.ParsePeriod(c.Query("period"))
	return p, ok
}

// gdMonthEnergy menjumlahkan energi harian sah (≥ 40 slot) satu bulan; hasil diskalakan ke seluruh hari bulan.
func gdMonthEnergy(days map[string]load.DayEnergy, from, to time.Time, fullDays int) (est, measured float64, valid int) {
	for d := from; d.Before(to); d = d.AddDate(0, 0, 1) {
		if e, ok := days[d.Format("2006-01-02")]; ok && e.Samples >= load.MinDaySamples {
			measured += e.E * 1000
			valid++
		}
	}
	if valid > 0 {
		est = measured * float64(fullDays) / float64(valid)
	}
	return est, measured, valid
}

// evalLV menghitung susut tiap gardu satu bulan: energi gardu (AMR) − Σ kWh pelanggan di bawahnya.
func (s *Server) evalLV(ctx context.Context, period time.Time, lag int) (*lvResult, error) {
	key := period.Format("2006-01") + "|" + strconv.Itoa(lag)
	lvCache.Lock()
	if r, ok := lvCache.m[key]; ok && time.Since(r.at) < 10*time.Minute {
		lvCache.Unlock()
		return r, nil
	}
	lvCache.Unlock()
	st := s.lvSettings()
	em := period.AddDate(0, -lag, 0)
	res := &lvResult{period: period, energyMonth: em, lag: lag, at: time.Now()}
	from, to := em, em.AddDate(0, 1, 0)
	fullDays := int(to.Sub(from).Hours()/24 + 0.5)
	l := time.Now().In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	if to.After(today) {
		to, res.partial = today, true
	}

	// kWh pelanggan → gardu
	byNode, un, unK, err := s.d.Load.Repo.BillByNode(ctx, period)
	if err != nil {
		return nil, err
	}
	res.unmatched, res.unmatchedKWh = un, unK
	nodes := make([]int64, 0, len(byNode))
	for id := range byNode {
		nodes = append(nodes, id)
	}
	gds, feeders := s.d.Graph.SinkGroups(nodes)
	cnts := s.d.Graph.SinkCounts(nodes) // pelanggan kolektif mewakili banyak pelanggan
	rows := map[int64]*lvRow{}
	get := func(gd int64) *lvRow {
		r := rows[gd]
		if r == nil {
			r = &lvRow{GD: gd, Days: fullDays}
			rows[gd] = r
		}
		return r
	}
	for i, id := range nodes {
		if gds[i] == 0 {
			res.noGD++
			res.noGDKWh += byNode[id]
			continue
		}
		r := get(gds[i])
		r.SoldKWh += byNode[id]
		c := cnts[i]
		if c < 1 {
			c = 1
		}
		r.Billed += c
		if byNode[id] <= 0 {
			r.ZeroKWh += c
		}
		if r.Feeder == 0 {
			r.Feeder = feeders[i]
		}
	}

	// energi gardu dari titik AMR
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		return nil, err
	}
	feederPt := map[int64]load.Point{}
	gdPts := map[int64]load.Point{}
	ids := []int32{}
	for _, p := range pts {
		if p.NodeID == nil || !p.Active {
			continue
		}
		switch p.Kind {
		case "gd":
			gdPts[*p.NodeID] = p
			ids = append(ids, int32(p.ID))
		case "feeder":
			feederPt[*p.NodeID] = p
		}
	}
	energy := map[int]map[string]load.DayEnergy{}
	if to.After(from) && len(ids) > 0 {
		if energy, err = s.d.Load.Repo.DailyEnergy(ctx, ids, from, to); err != nil {
			return nil, err
		}
	}
	for gd, p := range gdPts {
		r := get(gd)
		r.PointID, r.UP3, r.ULP = p.ID, p.UP3, p.ULP
		if r.Feeder == 0 && p.FeederID != nil {
			r.Feeder = *p.FeederID
		}
		r.EnergyKWh, r.EnergyMeasured, r.ValidDays = gdMonthEnergy(energy[p.ID], from, to, fullDays)
	}

	// jumlah pelanggan GIS tiap gardu, kode & nama
	refs := make([]gis.AssetRef, 0, len(rows))
	codeIDs := []int64{}
	for gd, r := range rows {
		refs = append(refs, gis.AssetRef{Kind: gis.AssetGD, ID: gd})
		codeIDs = append(codeIDs, gd)
		if r.Feeder != 0 {
			codeIDs = append(codeIDs, r.Feeder)
		}
	}
	for _, it := range s.d.Graph.AssetItems(refs) {
		if r := rows[it.ID]; r != nil {
			r.Customers = it.Pelanggan
			if r.Feeder == 0 {
				r.Feeder = it.Feeder
				if it.Feeder != 0 {
					codeIDs = append(codeIDs, it.Feeder)
				}
			}
		}
	}
	codes, err := s.d.Power.NodeCodes(ctx, codeIDs)
	if err != nil {
		return nil, err
	}
	out := make([]lvRow, 0, len(rows))
	for _, r := range rows {
		r.Code, r.Name = codes[r.GD].Code, codes[r.GD].Name
		r.FeederCode = codes[r.Feeder].Code
		if r.UP3 == "" {
			if fp, ok := feederPt[r.Feeder]; ok {
				r.UP3, r.ULP = fp.UP3, fp.ULP
			}
		}
		if r.Customers > 0 {
			r.BilledPct = float64(r.Billed) / float64(r.Customers) * 100
		} else if r.Billed > 0 {
			r.BilledPct = 100
		}
		switch {
		case r.PointID == 0:
			r.Status = "tanpa_meter"
		case float64(r.ValidDays) < float64(fullDays)*st.minDays/100:
			r.Status = "energi_kurang"
		case r.BilledPct < st.minBilled:
			r.Status = "tagihan_kurang"
		case r.ValidDays < fullDays:
			r.Status = "estimasi"
		default:
			r.Status = "ok"
		}
		if r.PointID != 0 && r.EnergyKWh > 0 {
			r.LossKWh = r.EnergyKWh - r.SoldKWh
			r.Pct = r.LossKWh / r.EnergyKWh * 100
		}
		if r.valid() {
			switch {
			case r.LossKWh < 0:
				r.Flag = "negatif"
			case r.Pct >= st.high:
				r.Flag = "tinggi"
			}
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return naturalLess(out[i].Code, out[j].Code) })
	res.rows = out
	lvCache.Lock()
	lvCache.m[key] = res
	lvCache.Unlock()
	return res, nil
}

type lvFeeder struct {
	Feeder    int64   `json:"feeder_id"`
	Code      string  `json:"code"`
	UP3       string  `json:"up3,omitempty"`
	GDs       int     `json:"gds"`
	GDValid   int     `json:"gds_valid"`
	EnergyKWh float64 `json:"energy_kwh"`
	SoldKWh   float64 `json:"sold_kwh"`
	LossKWh   float64 `json:"loss_kwh"`
	Pct       float64 `json:"pct"`
	High      int     `json:"high"`
}

// GET /api/load/losses/customers?period=YYYY-MM&up3&ulp&feeder&q&status&sort&dir&offset&limit&format=csv
func (s *Server) loadLVLosses(c *gin.Context) {
	ctx := c.Request.Context()
	period, okP := monthOf(c)
	if !okP {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	res, err := s.evalLV(ctx, period, s.lvLag(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	st := s.lvSettings()
	up3, ulp, q, status := c.Query("up3"), c.Query("ulp"), strings.ToLower(strings.TrimSpace(c.Query("q"))), c.Query("status")
	feeder, _ := strconv.ParseInt(c.Query("feeder"), 10, 64)
	scope := []lvRow{}
	up3s, ulps := map[string]bool{}, map[string]bool{}
	for _, r := range res.rows {
		if r.UP3 != "" {
			up3s[r.UP3] = true
		}
		if up3 != "" && r.UP3 != up3 {
			continue
		}
		if r.ULP != "" {
			ulps[r.ULP] = true
		}
		if (ulp != "" && r.ULP != ulp) || (feeder != 0 && r.Feeder != feeder) {
			continue
		}
		scope = append(scope, r)
	}
	// ringkasan cakupan
	sum := gin.H{}
	var eK, sK, soldAll float64
	var nValid, nEst, nHigh, nNeg, nNoMeter, nLowBill, nLowE, billed, cust, zero int
	fd := map[int64]*lvFeeder{}
	for _, r := range scope {
		soldAll += r.SoldKWh
		switch r.Status {
		case "tanpa_meter":
			nNoMeter++
		case "tagihan_kurang":
			nLowBill++
		case "energi_kurang":
			nLowE++
		}
		f := fd[r.Feeder]
		if f == nil {
			f = &lvFeeder{Feeder: r.Feeder, Code: r.FeederCode, UP3: r.UP3}
			fd[r.Feeder] = f
		}
		f.GDs++
		if !r.valid() {
			continue
		}
		nValid++
		if r.Status == "estimasi" {
			nEst++
		}
		switch r.Flag {
		case "tinggi":
			nHigh++
			f.High++
		case "negatif":
			nNeg++
		}
		eK += r.EnergyKWh
		sK += r.SoldKWh
		billed += r.Billed
		cust += r.Customers
		zero += r.ZeroKWh
		f.GDValid++
		f.EnergyKWh += r.EnergyKWh
		f.SoldKWh += r.SoldKWh
	}
	sum["energy_kwh"], sum["sold_kwh"], sum["loss_kwh"] = eK, sK, eK-sK
	if eK > 0 {
		sum["pct"] = (eK - sK) / eK * 100
	} else {
		sum["pct"] = nil
	}
	sum["gds"], sum["gds_valid"], sum["gds_estimated"], sum["gds_high"], sum["gds_negative"] = len(scope), nValid, nEst, nHigh, nNeg
	sum["gds_no_meter"], sum["gds_low_billing"], sum["gds_low_energy"] = nNoMeter, nLowBill, nLowE
	sum["billed"], sum["customers"], sum["zero_kwh"], sum["sold_all_kwh"] = billed, cust, zero, soldAll
	feeders := make([]lvFeeder, 0, len(fd))
	for _, f := range fd {
		if f.GDValid == 0 {
			continue
		}
		f.LossKWh = f.EnergyKWh - f.SoldKWh
		if f.EnergyKWh > 0 {
			f.Pct = f.LossKWh / f.EnergyKWh * 100
		}
		feeders = append(feeders, *f)
	}
	sort.Slice(feeders, func(i, j int) bool { return feeders[i].Pct > feeders[j].Pct })

	// daftar gardu (filter + urut + halaman)
	list := []lvRow{}
	for _, r := range scope {
		if q != "" && !strings.Contains(strings.ToLower(r.Code+" "+r.Name+" "+r.FeederCode), q) {
			continue
		}
		switch status {
		case "", "all":
		case "valid":
			if !r.valid() {
				continue
			}
		case "tinggi", "negatif":
			if r.Flag != status {
				continue
			}
		default:
			if r.Status != status {
				continue
			}
		}
		list = append(list, r)
	}
	sortKey, desc := c.DefaultQuery("sort", "pct"), c.DefaultQuery("dir", "desc") == "desc"
	val := func(r lvRow) float64 {
		switch sortKey {
		case "loss":
			return r.LossKWh
		case "energy":
			return r.EnergyKWh
		case "sold":
			return r.SoldKWh
		case "billed":
			return r.BilledPct
		}
		if !r.valid() {
			return math.Inf(-1)
		}
		return r.Pct
	}
	if sortKey != "code" {
		sort.SliceStable(list, func(i, j int) bool {
			if desc {
				return val(list[i]) > val(list[j])
			}
			return val(list[i]) < val(list[j])
		})
	}
	if c.Query("format") == "csv" {
		s.lvCSV(c, period, res.energyMonth, list)
		return
	}
	limit, offset := queryInt(c, "limit", 100), queryInt(c, "offset", 0)
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	if offset < 0 || offset > len(list) {
		offset = 0
	}
	end := offset + limit
	if end > len(list) {
		end = len(list)
	}
	keys := func(m map[string]bool) []string {
		o := make([]string, 0, len(m))
		for k := range m {
			o = append(o, k)
		}
		sort.Strings(o)
		return o
	}
	ok(c, gin.H{"period": period.Format("2006-01"), "energy_period": res.energyMonth.Format("2006-01"), "lag": res.lag, "partial": res.partial, "summary": sum, "feeders": feeders,
		"items": list[offset:end], "total": len(list), "offset": offset, "limit": limit,
		"unmatched": res.unmatched, "unmatched_kwh": res.unmatchedKWh, "no_gd": res.noGD, "no_gd_kwh": res.noGDKWh,
		"up3s": keys(up3s), "ulps": keys(ulps),
		"settings": gin.H{"high": st.high, "min_billed": st.minBilled, "min_days": st.minDays, "low_hours": st.lowHours}})
}

func (s *Server) lvCSV(c *gin.Context, period, energyMonth time.Time, list []lvRow) {
	var b strings.Builder
	b.WriteString("\xEF\xBB\xBF")
	b.WriteString("periode;periode_energi;gardu;nama;penyulang;up3;ulp;status;tanda;energi_gardu_kwh;hari_data;hari_bulan;kwh_pelanggan;pelanggan_bertagihan;pelanggan_gis;cakupan_tagihan_pct;pelanggan_0_kwh;susut_kwh;susut_pct\n")
	f := func(v float64, d int) string { return strconv.FormatFloat(v, 'f', d, 64) }
	esc := func(s string) string { return strings.ReplaceAll(s, ";", ",") }
	for _, r := range list {
		pct := ""
		if r.PointID != 0 && r.EnergyKWh > 0 {
			pct = f(r.Pct, 2)
		}
		fmt.Fprintf(&b, "%s;%s;%s;%s;%s;%s;%s;%s;%s;%s;%d;%d;%s;%d;%d;%s;%d;%s;%s\n", period.Format("2006-01"), energyMonth.Format("2006-01"), esc(r.Code), esc(r.Name), esc(r.FeederCode), esc(r.UP3), esc(r.ULP),
			r.Status, r.Flag, f(r.EnergyKWh, 0), r.ValidDays, r.Days, f(r.SoldKWh, 0), r.Billed, r.Customers, f(r.BilledPct, 1), r.ZeroKWh, f(r.LossKWh, 0), pct)
	}
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="susut-gardu-pelanggan-%s.csv"`, period.Format("2006-01")))
	c.Data(http.StatusOK, "text/csv; charset=utf-8", []byte(b.String()))
}

type lvCustomer struct {
	ID       int64    `json:"id"`
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	IDPel    string   `json:"idpel"`
	Tarif    string   `json:"tarif"`
	DayaVA   float64  `json:"daya_va"`
	KWh      *float64 `json:"kwh"`
	Hours    *float64 `json:"hours"` // jam nyala = kWh ÷ kVA
	Flag     string   `json:"flag,omitempty"`
	TypeCode string   `json:"type_code"`
}

// GET /api/load/losses/customers/gd?period=YYYY-MM&gd=<node id> — rincian satu gardu: pelanggan & tren 12 bulan
func (s *Server) loadLVGardu(c *gin.Context) {
	ctx := c.Request.Context()
	period, okP := monthOf(c)
	gd, err := strconv.ParseInt(c.Query("gd"), 10, 64)
	if !okP || err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	res, err := s.evalLV(ctx, period, s.lvLag(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	var row *lvRow
	for i := range res.rows {
		if res.rows[i].GD == gd {
			row = &res.rows[i]
			break
		}
	}
	if row == nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	st := s.lvSettings()
	custIDs := s.d.Graph.AssetIDs(gis.AssetPelanggan, gis.AssetGD, gd)
	bills, err := s.d.Load.Repo.BillForNodes(ctx, period, custIDs)
	if err != nil {
		handleErr(c, err)
		return
	}
	custs := make([]lvCustomer, 0, len(custIDs))
	rs, err := s.d.Pool.Query(ctx, `SELECT id, code, COALESCE(name,''), type_code, COALESCE(properties->>'idpel',''), COALESCE(properties->>'tarif',''),
		COALESCE(NULLIF(properties->>'daya_va','')::float, NULLIF(properties->>'daya_kva','')::float * 1000, NULLIF(properties->>'daya_mva','')::float * 1e6, 0)
		FROM gis_nodes WHERE id = ANY($1)`, custIDs)
	if err != nil {
		handleErr(c, err)
		return
	}
	for rs.Next() {
		var x lvCustomer
		if rs.Scan(&x.ID, &x.Code, &x.Name, &x.TypeCode, &x.IDPel, &x.Tarif, &x.DayaVA) != nil {
			continue
		}
		if b, ok := bills[x.ID]; ok {
			k := b.KWh
			x.KWh = &k
			if x.IDPel == "" {
				x.IDPel = b.IDPel
			}
			if x.Tarif == "" {
				x.Tarif = b.Tarif
			}
			if x.DayaVA == 0 {
				x.DayaVA = b.DayaVA
			}
			if x.DayaVA > 0 {
				h := k / (x.DayaVA / 1000)
				x.Hours = &h
			}
			switch {
			case k <= 0:
				x.Flag = "nol"
			case x.Hours != nil && *x.Hours > float64(row.Days*24):
				x.Flag = "melebihi_daya" // kWh > daya kontrak × jam sebulan: data daya / kWh keliru
			case x.Hours != nil && *x.Hours < st.lowHours:
				x.Flag = "rendah"
			}
		} else {
			x.Flag = "tanpa_tagihan"
		}
		custs = append(custs, x)
	}
	rs.Close()
	sort.Slice(custs, func(i, j int) bool {
		// pelanggan bertanda (indikasi P2TL / data keliru) lebih dulu
		if (custs[i].Flag != "") != (custs[j].Flag != "") {
			return custs[i].Flag != ""
		}
		ki, kj := -1.0, -1.0
		if custs[i].KWh != nil {
			ki = *custs[i].KWh
		}
		if custs[j].KWh != nil {
			kj = *custs[j].KWh
		}
		return ki > kj
	})

	// tren 12 bulan: energi gardu vs kWh terjual
	trend := []gin.H{}
	start := period.AddDate(0, -11, 0)
	lag := res.lag
	sold, _ := s.d.Load.Repo.BillTrend(ctx, custIDs, start)
	var energy map[string]load.DayEnergy
	if row.PointID != 0 {
		l := time.Now().In(load.Loc)
		today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
		end := period.AddDate(0, 1-lag, 0)
		if end.After(today) {
			end = today
		}
		if m, err := s.d.Load.Repo.DailyEnergy(ctx, []int32{int32(row.PointID)}, start.AddDate(0, -lag, 0), end); err == nil {
			energy = m[row.PointID]
		}
	}
	for m := start; !m.After(period); m = m.AddDate(0, 1, 0) {
		key := m.Format("2006-01")
		e0 := m.AddDate(0, -lag, 0)
		next := e0.AddDate(0, 1, 0)
		full := int(next.Sub(e0).Hours()/24 + 0.5)
		e, _, valid := gdMonthEnergy(energy, e0, next, full)
		p := gin.H{"period": key, "energy_period": e0.Format("2006-01"), "energy_kwh": nil, "sold_kwh": nil, "pct": nil, "valid_days": valid, "days": full}
		if float64(valid) >= float64(full)*st.minDays/100 {
			p["energy_kwh"] = e
		}
		if v, ok := sold[key]; ok {
			p["sold_kwh"] = v
			if ev, ok := p["energy_kwh"].(float64); ok && ev > 0 {
				p["pct"] = (ev - v) / ev * 100
			}
		}
		trend = append(trend, p)
	}
	ok(c, gin.H{"period": period.Format("2006-01"), "energy_period": res.energyMonth.Format("2006-01"), "lag": lag, "gardu": row, "customers": custs, "trend": trend,
		"settings": gin.H{"high": st.high, "low_hours": st.lowHours}})
}

// ---------------------------------------------------------------- impor kWh pelanggan

// POST /api/load/customer-kwh/import?period=YYYY-MM&apply=0|1&replace=0|1&name= (badan: berkas CSV / XLSX)
func (s *Server) loadBillImport(c *gin.Context) {
	ctx := c.Request.Context()
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, billMaxBytes+1))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if len(raw) > billMaxBytes {
		fail(c, http.StatusRequestEntityTooLarge, pick(c, "Berkas lebih dari 200 MB; pecah per UP3 / ULP.", "The file exceeds 200 MB; split it per UP3 / ULP."))
		return
	}
	var def *time.Time
	if p, ok := load.ParsePeriod(c.Query("period")); ok {
		def = &p
	}
	parsed, err := load.ParseBilling(raw, def)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.d.Load.Repo.MatchCustomers(ctx, parsed.Rows); err != nil {
		handleErr(c, err)
		return
	}
	// ringkasan per periode
	type perSum struct {
		Period    string  `json:"period"`
		Rows      int     `json:"rows"`
		KWh       float64 `json:"kwh"`
		Matched   int     `json:"matched"`
		Unmatched int     `json:"unmatched"`
		Existing  int     `json:"existing"`
		GDs       int     `json:"gds"`
	}
	per := map[string]*perSum{}
	by := map[string]int{}
	periods := []time.Time{}
	unmatched := []load.BillRow{}
	matchedNodes := map[string][]int64{}
	var total float64
	for _, r := range parsed.Rows {
		k := r.Period.Format("2006-01")
		p := per[k]
		if p == nil {
			p = &perSum{Period: k}
			per[k] = p
			periods = append(periods, r.Period)
		}
		p.Rows++
		p.KWh += r.KWh
		total += r.KWh
		if r.NodeID != 0 {
			p.Matched++
			by[r.By]++
			matchedNodes[k] = append(matchedNodes[k], r.NodeID)
		} else {
			p.Unmatched++
			if len(unmatched) < 100 {
				unmatched = append(unmatched, r)
			}
		}
	}
	existing, _ := s.d.Load.Repo.ExistingBillRows(ctx, periods)
	list := []perSum{}
	for k, p := range per {
		p.Existing = existing[k]
		gds, _ := s.d.Graph.SinkGroups(matchedNodes[k])
		set := map[int64]bool{}
		for _, g := range gds {
			if g != 0 {
				set[g] = true
			}
		}
		p.GDs = len(set)
		list = append(list, *p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Period < list[j].Period })
	rep := gin.H{"format": parsed.Format, "columns": parsed.Columns, "lines": parsed.Lines, "rows": len(parsed.Rows), "merged": parsed.Merged,
		"n_errors": parsed.NErrors, "errors": parsed.Errors, "periods": list, "matched_by": by, "unmatched": unmatched, "total_kwh": total, "applied": false}
	if c.Query("apply") != "1" {
		ok(c, rep)
		return
	}
	if len(parsed.Rows) == 0 {
		fail(c, http.StatusBadRequest, pick(c, "Tidak ada baris sah untuk disimpan.", "No valid rows to save."))
		return
	}
	p := s.person(c)
	errsBy := map[string]int{}
	if len(list) == 1 {
		errsBy[list[0].Period] = parsed.NErrors
	}
	name := strings.TrimSpace(c.Query("name"))
	imps, err := s.d.Load.Repo.SaveBilling(ctx, parsed.Rows, name, p.FullNameOr(), c.Query("replace") == "1", errsBy)
	if err != nil {
		handleErr(c, err)
		return
	}
	invalidateLV()
	s.d.Audit.Log(&p.UserID, p.Username, "load.customer_kwh.import", "customer_kwh", name, gin.H{"rows": len(parsed.Rows), "periods": list, "replace": c.Query("replace") == "1"}, clientIP(c))
	rep["applied"], rep["imports"] = true, imps
	ok(c, rep)
}

// GET /api/load/customer-kwh — periode yang tersedia & riwayat impor
func (s *Server) loadBillList(c *gin.Context) {
	ctx := c.Request.Context()
	periods, err := s.d.Load.Repo.BillPeriods(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	imps, err := s.d.Load.Repo.BillImports(ctx, 50)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"periods": periods, "imports": imps})
}

// DELETE /api/load/customer-kwh/imports/:id
func (s *Server) loadBillDelete(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	n, err := s.d.Load.Repo.DeleteBillImport(c.Request.Context(), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	invalidateLV()
	p := s.person(c)
	s.d.Audit.Log(&p.UserID, p.Username, "load.customer_kwh.delete", "customer_kwh", strconv.Itoa(id), gin.H{"rows": n}, clientIP(c))
	ok(c, gin.H{"deleted": n})
}

// GET /api/load/customer-kwh/unmatched?period=YYYY-MM&format=csv — IDPEL yang tidak ditemukan di GIS
func (s *Server) loadBillUnmatched(c *gin.Context) {
	period, okP := monthOf(c)
	if !okP {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	limit := 500
	if c.Query("format") == "csv" {
		limit = 1000000
	}
	rows, err := s.d.Load.Repo.BillUnmatched(c.Request.Context(), period, limit)
	if err != nil {
		handleErr(c, err)
		return
	}
	if c.Query("format") == "csv" {
		var b strings.Builder
		b.WriteString("\xEF\xBB\xBFIDPEL;BLTH;KWH;NAMA;TARIF;DAYA\n")
		for _, r := range rows {
			fmt.Fprintf(&b, "%s;%s;%s;%s;%s;%s\n", r.IDPel, period.Format("200601"), strconv.FormatFloat(r.KWh, 'f', -1, 64),
				strings.ReplaceAll(r.Name, ";", ","), r.Tarif, strconv.FormatFloat(r.DayaVA, 'f', 0, 64))
		}
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="idpel-tidak-ditemukan-%s.csv"`, period.Format("2006-01")))
		c.Data(http.StatusOK, "text/csv; charset=utf-8", []byte(b.String()))
		return
	}
	ok(c, gin.H{"items": rows})
}

// GET /api/load/customer-kwh/template — contoh format berkas
func (s *Server) loadBillTemplate(c *gin.Context) {
	body := "\xEF\xBB\xBFIDPEL;BLTH;KWH;NAMA;TARIF;DAYA\n512345678901;202608;215;Contoh Pelanggan 1;R1;1300\n512345678902;202608;1.284,5;Contoh Pelanggan 2;B2;6600\n"
	c.Header("Content-Disposition", `attachment; filename="template-kwh-pelanggan.csv"`)
	c.Data(http.StatusOK, "text/csv; charset=utf-8", []byte(body))
}
