package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/load"
)

// ---------------------------------------------------------------- entitas & hierarki

// loadEntity adalah objek analisa: sistem, UID, UP3, GI, trafo GI, penyulang, atau gardu distribusi.
type loadEntity struct {
	Level   string  `json:"level"` // system | uid | up3 | gi | trafo_gi | feeder | gd
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Parent  string  `json:"parent,omitempty"`
	CapMW   float64 `json:"cap_mw"` // daya mampu (MW)
	CapMVA  float64 `json:"cap_mva"`
	Members int     `json:"members"`
	PointID int     `json:"point_id,omitempty"`
	points  []int32
}

var errUnknownEntity = errors.New("unknown entity")

// basePoints: titik dasar penjumlahan — trafo GI yang terukur, ditambah penyulang yang trafonya tidak terukur
// (agar beban tidak terhitung dua kali). Gardu distribusi berada di hilir penyulang sehingga tidak ikut.
func basePoints(ps []load.Point) []load.Point {
	measured := map[int64]bool{}
	for _, p := range ps {
		if p.Kind == "trafo_gi" && p.Active && p.NodeID != nil {
			measured[*p.NodeID] = true
		}
	}
	out := []load.Point{}
	for _, p := range ps {
		if !p.Active || p.Kind == "gd" {
			continue
		}
		if p.Kind == "trafo_gi" || p.TrafoGIID == nil || !measured[*p.TrafoGIID] {
			out = append(out, p)
		}
	}
	return out
}

// feederCodes: kode penyulang per kubikel (untuk menampilkan pemasok gardu).
func feederCodes(ps []load.Point) map[int64]string {
	out := map[int64]string{}
	for _, p := range ps {
		if p.Kind == "feeder" && p.NodeID != nil {
			out[*p.NodeID] = p.Code
		}
	}
	return out
}

func (s *Server) resolveEntity(ctx context.Context, level, id string) (loadEntity, []load.Point, error) {
	all, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		return loadEntity{}, nil, err
	}
	e := loadEntity{Level: level, ID: id}
	sel := []load.Point{}
	switch level {
	case "", "system":
		e.Level, e.Name = "system", "Sistem"
		sel = basePoints(all)
	case "uid", "up3":
		for _, p := range basePoints(all) {
			v := p.UID
			if level == "up3" {
				v = p.UP3
			}
			if v == id || (id == "-" && v == "") {
				sel = append(sel, p)
			}
		}
		e.Name = id
	case "gi":
		gid, _ := strconv.ParseInt(id, 10, 64)
		for _, p := range basePoints(all) {
			if p.GIID != nil && *p.GIID == gid {
				sel = append(sel, p)
			}
		}
		if cn, err := s.d.Power.NodeCodes(ctx, []int64{gid}); err == nil {
			e.Name = cn[gid].Code
		}
	case "trafo_gi":
		tid, _ := strconv.ParseInt(id, 10, 64)
		for _, p := range all {
			if p.Active && p.Kind == "trafo_gi" && p.NodeID != nil && *p.NodeID == tid {
				sel = []load.Point{p}
				break
			}
		}
		if len(sel) == 0 {
			for _, p := range all {
				if p.Active && p.Kind == "feeder" && p.TrafoGIID != nil && *p.TrafoGIID == tid {
					sel = append(sel, p)
				}
			}
		}
		if cn, err := s.d.Power.NodeCodes(ctx, []int64{tid}); err == nil {
			e.Name = cn[tid].Code
		}
	case "feeder", "gd", "point":
		pid, _ := strconv.Atoi(id)
		for _, p := range all {
			if p.ID == pid {
				sel = []load.Point{p}
				e.Name, e.PointID, e.Level = p.Code, p.ID, p.Kind
				if p.Kind == "gd" && p.FeederID != nil {
					e.Parent = feederCodes(all)[*p.FeederID]
				}
			}
		}
	default:
		return e, nil, errUnknownEntity
	}
	if len(sel) == 0 {
		return e, nil, errUnknownEntity
	}
	capPF := s.loadSettings().CapPF
	for _, p := range sel {
		e.points = append(e.points, int32(p.ID))
		e.CapMW += p.CapMW(capPF)
		e.CapMVA += p.CapMVA()
	}
	e.Members = len(sel)
	return e, sel, nil
}

// GET /api/load/entities?level=
func (s *Server) loadEntities(c *gin.Context) {
	ctx := c.Request.Context()
	all, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	capPF := s.loadSettings().CapPF
	level := c.DefaultQuery("level", "feeder")
	type item struct {
		ID     string  `json:"id"`
		Name   string  `json:"name"`
		Parent string  `json:"parent,omitempty"`
		CapMW  float64 `json:"cap_mw"`
		Count  int     `json:"count"`
	}
	out := []item{}
	agg := map[string]*item{}
	ids := []int64{}
	add := func(key, name, parent string, cap float64) {
		it := agg[key]
		if it == nil {
			it = &item{ID: key, Name: name, Parent: parent}
			agg[key] = it
		}
		it.CapMW += cap
		it.Count++
	}
	switch level {
	case "feeder", "gd":
		fcode := feederCodes(all)
		for _, p := range all {
			if p.Kind != level {
				continue
			}
			parent := p.UP3
			if level == "gd" && p.FeederID != nil {
				parent = fcode[*p.FeederID]
			}
			out = append(out, item{ID: strconv.Itoa(p.ID), Name: p.Code, Parent: parent, CapMW: p.CapMW(capPF), Count: 1})
		}
	case "trafo_gi":
		for _, p := range all {
			if p.TrafoGIID != nil && p.Kind != "gd" {
				ids = append(ids, *p.TrafoGIID)
				if p.Kind == "trafo_gi" {
					add(strconv.FormatInt(*p.TrafoGIID, 10), "", p.UP3, p.CapMW(capPF))
				} else if agg[strconv.FormatInt(*p.TrafoGIID, 10)] == nil {
					add(strconv.FormatInt(*p.TrafoGIID, 10), "", p.UP3, 0)
				}
			}
		}
	case "gi":
		for _, p := range basePoints(all) {
			if p.GIID != nil {
				ids = append(ids, *p.GIID)
				add(strconv.FormatInt(*p.GIID, 10), "", p.UP3, p.CapMW(capPF))
			}
		}
	case "up3":
		for _, p := range basePoints(all) {
			k := p.UP3
			if k == "" {
				k = "-"
			}
			add(k, k, p.UID, p.CapMW(capPF))
		}
	case "uid":
		for _, p := range basePoints(all) {
			add(p.UID, p.UID, "", p.CapMW(capPF))
		}
	}
	if len(ids) > 0 {
		codes, _ := s.d.Power.NodeCodes(ctx, ids)
		for k, it := range agg {
			if id, err := strconv.ParseInt(k, 10, 64); err == nil {
				it.Name = codes[id].Code
			}
		}
	}
	for _, it := range agg {
		out = append(out, *it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	ok(c, gin.H{"items": out, "level": level})
}

func loadDay(c *gin.Context) time.Time {
	l := time.Now().In(load.Loc)
	d := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	if v := c.Query("date"); v != "" {
		if t, err := time.ParseInLocation("2006-01-02", v, load.Loc); err == nil {
			d = t
		}
	}
	return d
}

// ---------------------------------------------------------------- analisa

type monthStat struct {
	Month      string     `json:"month"`
	PeakMW     float64    `json:"peak_mw"`
	PeakTS     *time.Time `json:"peak_ts"`
	PeakUtil   float64    `json:"peak_util"`
	EnergyMWh  float64    `json:"energy_mwh"`
	EnergyExp  float64    `json:"energy_exp_mwh"`
	AvgLF      float64    `json:"load_factor"`
	Hours80    float64    `json:"hours_over80"`
	Hours100   float64    `json:"hours_over100"`
	Days       int        `json:"days"`
	WBPPeakMW  float64    `json:"wbp_peak_mw"`
	LWBPPeakMW float64    `json:"lwbp_peak_mw"`
	Completion float64    `json:"completeness"`
}

func monthly(days []load.DayStat, cap float64) []monthStat {
	m := map[string]*monthStat{}
	keys := []string{}
	for _, d := range days {
		k := d.Day[:7]
		ms := m[k]
		if ms == nil {
			ms = &monthStat{Month: k}
			m[k] = ms
			keys = append(keys, k)
		}
		if d.PeakMW > ms.PeakMW {
			ms.PeakMW, ms.PeakTS = d.PeakMW, d.PeakTS
		}
		ms.WBPPeakMW = math.Max(ms.WBPPeakMW, d.WBPPeakMW)
		ms.LWBPPeakMW = math.Max(ms.LWBPPeakMW, d.LWBPPeakMW)
		ms.EnergyMWh += d.EnergyMWh
		ms.EnergyExp += d.EnergyExp
		ms.AvgLF += d.LoadFactor
		ms.Hours80 += d.Hours80
		ms.Hours100 += d.Hours100
		ms.Days++
		ms.Completion += float64(d.Samples)
	}
	out := make([]monthStat, 0, len(keys))
	for _, k := range keys {
		ms := m[k]
		ms.AvgLF /= float64(ms.Days)
		ms.Completion = ms.Completion / float64(ms.Days*48) * 100
		if cap > 0 {
			ms.PeakUtil = ms.PeakMW / cap * 100
		}
		out = append(out, *ms)
	}
	return out
}

type periodStats struct {
	PeakMW     float64    `json:"peak_mw"`
	PeakTS     *time.Time `json:"peak_ts"`
	PeakUtil   float64    `json:"peak_util"`
	MinMW      float64    `json:"min_mw"`
	AvgMW      float64    `json:"avg_mw"`
	EnergyMWh  float64    `json:"energy_mwh"`
	EnergyExp  float64    `json:"energy_exp_mwh"`
	LoadFactor float64    `json:"load_factor"`
	WBPPeakMW  float64    `json:"wbp_peak_mw"`
	LWBPPeakMW float64    `json:"lwbp_peak_mw"`
	Hours80    float64    `json:"hours_over80"`
	Hours100   float64    `json:"hours_over100"`
	Samples    int        `json:"samples"`
	Expected   int        `json:"expected"`
}

func summarize(days []load.DayStat, cap float64, expectedDays int, members int) periodStats {
	st := periodStats{Expected: expectedDays * 48 * members}
	avgSum, n := 0.0, 0
	for _, d := range days {
		if d.PeakMW > st.PeakMW {
			st.PeakMW, st.PeakTS = d.PeakMW, d.PeakTS
		}
		if d.MinMW > 0 && (st.MinMW == 0 || d.MinMW < st.MinMW) {
			st.MinMW = d.MinMW
		}
		st.WBPPeakMW = math.Max(st.WBPPeakMW, d.WBPPeakMW)
		st.LWBPPeakMW = math.Max(st.LWBPPeakMW, d.LWBPPeakMW)
		st.EnergyMWh += d.EnergyMWh
		st.EnergyExp += d.EnergyExp
		st.Hours80 += d.Hours80
		st.Hours100 += d.Hours100
		st.Samples += d.Samples
		avgSum += d.AvgMW
		n++
	}
	if n > 0 {
		st.AvgMW = avgSum / float64(n)
	}
	if st.PeakMW > 0 {
		st.LoadFactor = st.AvgMW / st.PeakMW
	}
	if cap > 0 {
		st.PeakUtil = st.PeakMW / cap * 100
	}
	if members > 1 {
		// titik gabungan: sampel dihitung per slot, bukan per titik
		st.Expected = expectedDays * 48
	}
	return st
}

// GET /api/load/analysis?level&id&period=day|month|year&date=
func (s *Server) loadAnalysis(c *gin.Context) {
	ctx := c.Request.Context()
	e, pts, err := s.resolveEntity(ctx, c.Query("level"), c.Query("id"))
	if err != nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	st := s.loadSettings()
	day := loadDay(c)
	period := c.DefaultQuery("period", "day")
	res := gin.H{"entity": e, "period": period, "date": day.Format("2006-01-02"), "warn_pct": st.Warn, "over_pct": st.Over, "cap_pf": st.CapPF}
	repo := s.d.Load.Repo
	switch period {
	case "day":
		to := day.AddDate(0, 0, 1)
		ser, err := repo.Series(ctx, e.points, day, to, e.CapMW)
		if err != nil {
			handleErr(c, err)
			return
		}
		prev, _ := repo.Series(ctx, e.points, day.AddDate(0, 0, -7), to.AddDate(0, 0, -7), e.CapMW)
		hist, _ := repo.Series(ctx, e.points, day.AddDate(0, 0, -35), day, e.CapMW)
		fc, info := load.Forecast(hist, day, 1, st.Holidays, e.CapMW)
		days, _ := repo.DailyGroup(ctx, e.points, day, to, e.CapMW, st.Warn, st.Over)
		res["series"], res["last_week"], res["forecast"], res["forecast_info"] = ser, prev, fc, info
		st1 := summarize(days, e.CapMW, 1, 1)
		if now := time.Now(); day.Before(now) && to.After(now) {
			// hari berjalan: kelengkapan terhadap slot yang sudah lewat
			st1.Expected = int(now.Sub(day) / (30 * time.Minute))
		}
		res["stats"] = st1
		if len(pts) == 1 {
			// seluruh besaran SCADA satu titik (arus & tegangan fasa, P/Q/S, pf, frekuensi, energi)
			rs, _ := repo.Readings(ctx, e.points, day, to)
			res["readings"] = rs
		}
		res["profile"] = load.Classify(hist[max(0, len(hist)-28*48):], st.Holidays)
	case "month":
		from := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, load.Loc)
		to := from.AddDate(0, 1, 0)
		days, err := repo.DailyGroup(ctx, e.points, from, to, e.CapMW, st.Warn, st.Over)
		if err != nil {
			handleErr(c, err)
			return
		}
		ser, _ := repo.Series(ctx, e.points, from, to, e.CapMW)
		heat := make([][]float64, to.AddDate(0, 0, -1).Day())
		for i := range heat {
			heat[i] = make([]float64, 48)
		}
		for _, p := range ser {
			l := p.TS.In(load.Loc)
			if l.Day()-1 < len(heat) {
				heat[l.Day()-1][load.SlotOf(p.TS)] = p.P
			}
		}
		prevDays, _ := repo.DailyGroup(ctx, e.points, from.AddDate(-1, 0, 0), to.AddDate(-1, 0, 0), e.CapMW, st.Warn, st.Over)
		res["days"], res["heatmap"] = days, heat
		res["stats"] = summarize(days, e.CapMW, len(heat), 1)
		res["prev_year"] = summarize(prevDays, e.CapMW, len(heat), 1)
	case "year":
		from := time.Date(day.Year(), 1, 1, 0, 0, 0, 0, load.Loc)
		to := from.AddDate(1, 0, 0)
		days, err := repo.DailyGroup(ctx, e.points, from, to, e.CapMW, st.Warn, st.Over)
		if err != nil {
			handleErr(c, err)
			return
		}
		prevDays, _ := repo.DailyGroup(ctx, e.points, from.AddDate(-1, 0, 0), from, e.CapMW, st.Warn, st.Over)
		ser, _ := repo.Series(ctx, e.points, from, to, e.CapMW)
		nDays := int(math.Min(float64(time.Since(from).Hours()/24)+1, 366))
		res["months"], res["prev_months"] = monthly(days, e.CapMW), monthly(prevDays, e.CapMW)
		res["duration"] = load.DurationCurve(ser, 100)
		res["stats"] = summarize(days, e.CapMW, nDays, 1)
		res["prev_year"] = summarize(prevDays, e.CapMW, 365, 1)
	default:
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	ok(c, res)
}

// GET /api/load/ranking?period=day|month|year&date&kind=feeder|trafo_gi|gd&limit
func (s *Server) loadRanking(c *gin.Context) {
	ctx := c.Request.Context()
	day := loadDay(c)
	from, to := day, day.AddDate(0, 0, 1)
	switch c.DefaultQuery("period", "day") {
	case "month":
		from = time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, load.Loc)
		to = from.AddDate(0, 1, 0)
	case "year":
		from = time.Date(day.Year(), 1, 1, 0, 0, 0, 0, load.Loc)
		to = from.AddDate(1, 0, 0)
	case "30d":
		from, to = day.AddDate(0, 0, -29), day.AddDate(0, 0, 1)
	}
	items, err := s.loadRankItems(ctx, from, to, c.Query("kind"))
	if err != nil {
		handleErr(c, err)
		return
	}
	lim := queryInt(c, "limit", 50)
	if len(items) > lim {
		items = items[:lim]
	}
	ok(c, gin.H{"items": items, "from": from, "to": to})
}

type rankItem struct {
	load.PointDaily
	Code   string  `json:"code"`
	Kind   string  `json:"kind"`
	UP3    string  `json:"up3"`
	CapMW  float64 `json:"cap_mw"`
	Parent string  `json:"parent,omitempty"` // gardu: penyulang pemasok
}

// loadRankItems: rekap titik diurutkan dari pembebanan tertinggi. kind kosong = penyulang & trafo GI.
func (s *Server) loadRankItems(ctx context.Context, from, to time.Time, kind string) ([]rankItem, error) {
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		return nil, err
	}
	stats, err := s.d.Load.Repo.PointStats(ctx, from, to, kind)
	if err != nil {
		return nil, err
	}
	capPF := s.loadSettings().CapPF
	fcode := feederCodes(pts)
	out := []rankItem{}
	for _, p := range pts {
		st := stats[p.ID]
		if st == nil || (kind != "" && p.Kind != kind) || (kind == "" && p.Kind == "gd") {
			continue
		}
		r := rankItem{PointDaily: *st, Code: p.Code, Kind: p.Kind, UP3: p.UP3, CapMW: p.CapMW(capPF)}
		if p.Kind == "gd" && p.FeederID != nil {
			r.Parent = fcode[*p.FeederID]
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PeakUtil > out[j].PeakUtil })
	return out, nil
}

// GET /api/load/overview
func (s *Server) loadOverview(c *gin.Context) {
	ctx := c.Request.Context()
	ls := s.d.Load
	st := s.loadSettings()
	pts, err := ls.Repo.Points(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	now := time.Now()
	l := now.In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	counts := map[string]int{"feeder": 0, "trafo_gi": 0, "gd": 0, "active": 0, "stale": 0, "fresh": 0}
	for _, p := range pts {
		counts[p.Kind]++
		if !p.Active {
			continue
		}
		counts["active"]++
		if p.LastTS != nil && p.LastTS.After(now.Add(-time.Hour)) {
			counts["fresh"]++
		} else {
			counts["stale"]++
		}
	}
	base := basePoints(pts)
	ids := make([]int32, 0, len(base))
	cap := 0.0
	for _, p := range base {
		ids = append(ids, int32(p.ID))
		cap += p.CapMW(st.CapPF)
	}
	res := gin.H{"points": counts, "cap_mw": cap, "settings": gin.H{"warn": st.Warn, "over": st.Over, "cap_pf": st.CapPF}}
	if len(ids) > 0 {
		ser, _ := ls.Repo.Series(ctx, ids, today.AddDate(0, 0, -1), today.AddDate(0, 0, 1), cap)
		res["system_series"] = ser
		peak, yPeak := load.SeriesPoint{}, load.SeriesPoint{}
		eToday, eYest := 0.0, 0.0
		for _, p := range ser {
			if p.TS.Before(today) {
				eYest += p.E
				if p.P > yPeak.P {
					yPeak = p
				}
			} else {
				eToday += p.E
				if p.P > peak.P {
					peak = p
				}
			}
		}
		res["peak_today"], res["peak_yesterday"] = peak, yPeak
		res["energy_today"], res["energy_yesterday"] = eToday, eYest
	}
	// kelengkapan data hari ini
	var got int
	_ = s.d.Pool.QueryRow(ctx, `SELECT count(*) FROM load_30m WHERE ts >= $1`, today).Scan(&got)
	slots := int(now.Sub(today)/(30*time.Minute)) - 1
	if slots < 1 {
		slots = 1
	}
	if counts["active"] > 0 {
		res["completeness"] = math.Min(100, float64(got)/float64(slots*counts["active"])*100)
	}
	top, _ := s.loadRankItems(ctx, today, today.AddDate(0, 0, 1), "")
	over80, over100 := 0, 0
	for _, t := range top {
		if t.PeakUtil >= st.Over {
			over100++
		} else if t.PeakUtil >= st.Warn {
			over80++
		}
	}
	if len(top) > 10 {
		top = top[:10]
	}
	res["top"], res["over_warn"], res["over_limit"] = top, over80, over100
	gds, _ := s.loadRankItems(ctx, today, today.AddDate(0, 0, 1), "gd")
	gdOver := 0
	for _, t := range gds {
		if t.PeakUtil >= st.Over {
			gdOver++
		}
	}
	if len(gds) > 5 {
		gds = gds[:5]
	}
	res["top_gd"], res["gd_over"] = gds, gdOver
	// susut kemarin (neraca energi)
	if sum, err := s.lossSummary(ctx, today.AddDate(0, 0, -1), today); err == nil {
		res["losses_yesterday"] = sum
	}
	byKind, open, _ := ls.Repo.AnomalyCounts(ctx, now.AddDate(0, 0, -7), now.Add(time.Hour))
	res["anomalies"], res["anomalies_open"] = byKind, open
	res["ingest"], res["simulator"] = ls.Ing.Stats(), ls.Sim.Progress()
	first, last, rows := ls.Repo.DataRange(ctx)
	res["data_from"], res["data_to"], res["rows"] = first, last, rows
	res["simulator_enabled"] = s.d.Configs.Bool("load.simulator", true)
	res["topic"] = s.d.Configs.Str("load.kafka_topic", "scada.load.30m")
	res["energy_mode"] = st.EnergyMode
	ok(c, res)
}

// ---------------------------------------------------------------- anomali

func (s *Server) pointCodes(ctx context.Context) map[int]load.Point {
	out := map[int]load.Point{}
	if ps, err := s.d.Load.Repo.Points(ctx); err == nil {
		for _, p := range ps {
			out[p.ID] = p
		}
	}
	return out
}

// GET /api/load/anomalies?kind&severity&status&point&from&to&limit
func (s *Server) loadAnomalies(c *gin.Context) {
	ctx := c.Request.Context()
	to := time.Now().Add(time.Hour)
	from := to.AddDate(0, 0, -queryInt(c, "days", 30))
	if v := c.Query("from"); v != "" {
		if t, err := time.ParseInLocation("2006-01-02", v, load.Loc); err == nil {
			from = t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.ParseInLocation("2006-01-02", v, load.Loc); err == nil {
			to = t.AddDate(0, 0, 1)
		}
	}
	items, err := s.d.Load.Repo.ListAnomalies(ctx, c.Query("kind"), c.Query("severity"), c.Query("status"), queryInt(c, "point", 0), from, to, queryInt(c, "limit", 300))
	if err != nil {
		handleErr(c, err)
		return
	}
	pm := s.pointCodes(ctx)
	for i := range items {
		p := pm[items[i].PointID]
		items[i].PointCode, items[i].PointKind = p.Code, p.Kind
	}
	counts, open, _ := s.d.Load.Repo.AnomalyCounts(ctx, from, to)
	ok(c, gin.H{"items": items, "counts": counts, "open": open, "kinds": load.AnomalyKinds})
}

// GET /api/load/anomalies/:id/series — data ±6 jam di sekitar anomali + profil dasar
func (s *Server) loadAnomalySeries(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	ctx := c.Request.Context()
	var pid int
	var start, end time.Time
	if err := s.d.Pool.QueryRow(ctx, `SELECT point_id, start_ts, end_ts FROM load_anomalies WHERE id = $1`, id).Scan(&pid, &start, &end); err != nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	from, to := start.Add(-6*time.Hour), end.Add(6*time.Hour+30*time.Minute)
	if to.Sub(from) > 72*time.Hour {
		to = from.Add(72 * time.Hour)
	}
	rs, err := s.d.Load.Repo.Readings(ctx, []int32{int32(pid)}, from, to)
	if err != nil {
		handleErr(c, err)
		return
	}
	bases, _ := s.d.Load.Repo.Baselines(ctx, []int32{int32(pid)})
	st := s.loadSettings()
	type bp struct {
		TS  time.Time `json:"ts"`
		Med float64   `json:"median"`
	}
	bl := []bp{}
	for t := from; t.Before(to); t = t.Add(30 * time.Minute) {
		if b, ok := bases[pid][load.DayType(t, st.Holidays)*48+load.SlotOf(t)]; ok {
			bl = append(bl, bp{t, b.Median})
		}
	}
	ok(c, gin.H{"readings": rs, "baseline": bl, "point": s.pointCodes(ctx)[pid]})
}

// PUT /api/load/anomalies/:id {status, note}
func (s *Server) loadUpdateAnomaly(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var req struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Status != "" && !inList(req.Status, []string{"open", "ack", "closed"})) {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	_, uname := claimsUser(c)
	if err := s.d.Load.Repo.UpdateAnomaly(c.Request.Context(), id, req.Status, strings.TrimSpace(req.Note), uname); err != nil {
		if errors.Is(err, load.ErrNotFound) {
			failT(c, http.StatusNotFound, "common.not_found")
			return
		}
		handleErr(c, err)
		return
	}
	s.auditOps(c, "load.anomaly", strconv.FormatInt(id, 10), gin.H{"status": req.Status})
	ok(c, gin.H{"ok": true})
}

// ---------------------------------------------------------------- titik SCADA, simulator, ingest manual

// GET /api/load/points
func (s *Server) loadPoints(c *gin.Context) {
	ctx := c.Request.Context()
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	ids := []int64{}
	for _, p := range pts {
		if p.GIID != nil {
			ids = append(ids, *p.GIID)
		}
		if p.TrafoGIID != nil {
			ids = append(ids, *p.TrafoGIID)
		}
	}
	codes, _ := s.d.Power.NodeCodes(ctx, ids)
	fcode := feederCodes(pts)
	for i := range pts {
		if pts[i].GIID != nil {
			pts[i].GICode = codes[*pts[i].GIID].Code
		}
		if pts[i].TrafoGIID != nil {
			pts[i].TrafoGICode = codes[*pts[i].TrafoGIID].Code
		}
		if pts[i].Kind == "gd" && pts[i].FeederID != nil {
			pts[i].FeederCode = fcode[*pts[i].FeederID]
		}
	}
	un, _ := s.d.Load.Repo.UnmappedList(ctx)
	ok(c, gin.H{"items": pts, "unmapped": un})
}

var pointNodeType = map[string]string{"feeder": "kubikel_20kv", "trafo_gi": "trafo_gi", "gd": "gd"}

// POST /api/load/points {code, kind, node_id, name, rating_a, rating_mva, kv, active}
// Gardu: rating_mva = kVA ÷ 1000.
func (s *Server) loadSavePoint(c *gin.Context) {
	var p load.Point
	if err := c.ShouldBindJSON(&p); err != nil || strings.TrimSpace(p.Code) == "" || !inList(p.Kind, load.Kinds) {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	ctx := c.Request.Context()
	p.Code = strings.TrimSpace(p.Code)
	if p.KV <= 0 {
		p.KV = s.d.Configs.Float("ops.feeder_kv", 20)
		if p.Kind == "gd" {
			p.KV = s.d.Configs.Float("load.gd_kv", 0.4)
		}
	}
	// objek GIS boleh dirujuk lewat kode node yang sama dengan kode titik
	if p.NodeID == nil {
		var id int64
		if err := s.d.Pool.QueryRow(ctx, `SELECT id FROM gis_nodes WHERE code = $1 AND type_code = $2 LIMIT 1`, p.Code, pointNodeType[p.Kind]).Scan(&id); err == nil {
			p.NodeID = &id
		}
	}
	id, err := s.d.Load.Repo.UpsertPoint(ctx, p)
	if err != nil {
		handleErr(c, err)
		return
	}
	s.d.Load.Ing.InvalidatePoints()
	_ = s.syncHierarchy(ctx)
	s.auditOps(c, "load.point", p.Code, gin.H{"id": id, "node_id": p.NodeID})
	ok(c, gin.H{"id": id})
}

// DELETE /api/load/points/:id
func (s *Server) loadDeletePoint(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	if err := s.d.Load.Repo.DeletePoint(c.Request.Context(), id); err != nil {
		if errors.Is(err, load.ErrNotFound) {
			failT(c, http.StatusNotFound, "common.not_found")
			return
		}
		handleErr(c, err)
		return
	}
	s.d.Load.Ing.InvalidatePoints()
	s.auditOps(c, "load.point_delete", strconv.Itoa(id), nil)
	ok(c, gin.H{"ok": true})
}

// POST /api/load/points/automap {gd_feeders} — penyulang & trafo GI; gd_feeders > 0: juga seluruh gardu
// pada sejumlah penyulang (penyulang nyata lebih dulu).
func (s *Server) loadAutoMap(c *gin.Context) {
	var req struct {
		GDFeeders int `json:"gd_feeders"`
	}
	_ = c.ShouldBindJSON(&req)
	ctx := c.Request.Context()
	n, err := s.autoMapPoints(ctx)
	if err != nil {
		s.simErr(c, err)
		return
	}
	gd := 0
	if req.GDFeeders > 0 {
		if gd, err = s.autoMapGD(ctx, min(req.GDFeeders, 200)); err != nil {
			s.simErr(c, err)
			return
		}
	}
	s.auditOps(c, "load.automap", "", gin.H{"created": n, "gd": gd})
	ok(c, gin.H{"created": n + gd, "gd": gd})
}

// POST /api/load/ingest — kirim pesan SCADA lewat HTTP (objek / array), jalur yang sama dengan Kafka
func (s *Server) loadIngest(c *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 20<<20))
	if err != nil || len(body) == 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	ctx := c.Request.Context()
	before := s.d.Load.Ing.Stats()
	if err := s.d.Load.Ing.Handle(ctx, body); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	s.d.Load.Ing.Flush(ctx)
	after := s.d.Load.Ing.Stats()
	ok(c, gin.H{"messages": after["messages"].(int64) - before["messages"].(int64), "readings": after["readings"].(int64) - before["readings"].(int64),
		"unmapped": after["unmapped"].(int64) - before["unmapped"].(int64), "registered": after["registered"].(int64) - before["registered"].(int64)})
}

// POST /api/load/simulator/backfill {days, bulk_days}
func (s *Server) loadBackfill(c *gin.Context) {
	var req struct {
		Days     int `json:"days"`
		BulkDays int `json:"bulk_days"`
	}
	_ = c.ShouldBindJSON(&req)
	if req.Days <= 0 || req.Days > 800 {
		req.Days = 30
	}
	if req.BulkDays < 0 || req.BulkDays > 120 {
		req.BulkDays = 0
	}
	go func() {
		if err := s.backfillSim(context.Background(), req.Days, req.BulkDays); err != nil {
			s.d.Load.mu.Lock()
			s.d.Load.bootstrap["error"] = err.Error()
			s.d.Load.mu.Unlock()
		}
	}()
	s.auditOps(c, "load.backfill", "", gin.H{"days": req.Days, "bulk_days": req.BulkDays})
	ok(c, gin.H{"started": true})
}

// POST /api/load/recompute {days} — hitung ulang rekap harian, profil dasar, anomali & susut
func (s *Server) loadRecompute(c *gin.Context) {
	var req struct {
		Days int `json:"days"`
	}
	_ = c.ShouldBindJSON(&req)
	if req.Days <= 0 || req.Days > 400 {
		req.Days = 7
	}
	go func() {
		ctx := context.Background()
		ls := s.d.Load
		st := s.loadSettings()
		to := time.Now()
		from := to.AddDate(0, 0, -req.Days)
		_ = ls.Repo.RefreshDaily(ctx, nil, from, to, st.Warn, st.Over)
		_ = ls.Repo.RefreshBaseline(ctx, to, st.HolidayList())
		if ps, err := ls.Repo.Points(ctx); err == nil {
			for f := from; f.Before(to); f = f.AddDate(0, 0, 7) {
				t := f.AddDate(0, 0, 7)
				if t.After(to) {
					t = to
				}
				_, _ = ls.Det.Detect(ctx, ps, f, t)
			}
			_, _ = ls.Det.DetectDaily(ctx, ps, from, to, s.maneuverRefs(ctx, from, to))
		}
		s.detectLosses(ctx, from, to)
	}()
	ok(c, gin.H{"started": true})
}

// ---------------------------------------------------------------- laporan beban

// GET /api/load/reports?kind
func (s *Server) loadReports(c *gin.Context) {
	items, err := s.d.Exec.ListReports(c.Request.Context(), "load", c.Query("kind"), queryInt(c, "limit", 100))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/load/reports/:id
func (s *Server) loadGetReport(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	r, err := s.d.Exec.GetReport(c.Request.Context(), id)
	if err != nil || r.Category != "load" {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	ok(c, r)
}

// POST /api/load/reports {kind, date}
func (s *Server) loadGenerateReport(c *gin.Context) {
	var req struct {
		Kind string `json:"kind"`
		Date string `json:"date"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || !inList(req.Kind, []string{"daily", "monthly", "yearly"}) {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	d := time.Now()
	if req.Date != "" {
		t, err := time.ParseInLocation("2006-01-02", req.Date, load.Loc)
		if err != nil {
			failT(c, http.StatusBadRequest, "common.bad_payload")
			return
		}
		d = t
	}
	from, to := loadPeriodOf(req.Kind, d)
	if from.After(time.Now()) {
		failT(c, http.StatusBadRequest, "exec.future_period")
		return
	}
	_, uname := claimsUser(c)
	id, err := s.generateLoadReport(c.Request.Context(), req.Kind, from, to, uname)
	if err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "load.report", strconv.FormatInt(id, 10), gin.H{"kind": req.Kind})
	ok(c, gin.H{"id": id})
}

// PUT /api/load/reports/:id/narrative, DELETE /api/load/reports/:id → memakai handler eksekutif (kategori dicek)
func (s *Server) loadReportGuard(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		c.Abort()
		return
	}
	r, err := s.d.Exec.GetReport(c.Request.Context(), id)
	if err != nil || r.Category != "load" {
		failT(c, http.StatusNotFound, "common.not_found")
		c.Abort()
		return
	}
	c.Next()
}

// generateLoadReport menyusun & menyimpan laporan beban.
func (s *Server) generateLoadReport(ctx context.Context, kind string, from, to time.Time, by string) (int64, error) {
	data, err := s.buildLoadReport(ctx, kind, from, to)
	if err != nil {
		return 0, err
	}
	raw, _ := json.Marshal(data)
	return s.d.Exec.SaveReport(ctx, gis.PeriodicReport{Category: "load", Kind: kind, PeriodStart: from, PeriodEnd: to, Title: loadReportTitle(kind, from), Data: raw, GeneratedBy: by})
}

type groupRow struct {
	Level     string     `json:"level"`
	Key       string     `json:"key"`
	Name      string     `json:"name"`
	Parent    string     `json:"parent,omitempty"`
	PeakMW    float64    `json:"peak_mw"`
	PeakTS    *time.Time `json:"peak_ts"`
	EnergyMWh float64    `json:"energy_mwh"`
	CapMW     float64    `json:"cap_mw"`
	PeakUtil  float64    `json:"peak_util"`
	Points    int        `json:"points"`
}

// groupPeaks: beban puncak serentak (MW) & energi per kelompok (uid / up3 / gi) dari titik dasar.
func (s *Server) groupPeaks(ctx context.Context, base []load.Point, level string, from, to time.Time) ([]groupRow, error) {
	capPF := s.loadSettings().CapPF
	keyOf := func(p load.Point) string {
		switch level {
		case "uid":
			return p.UID
		case "up3":
			if p.UP3 == "" {
				return "-"
			}
			return p.UP3
		default:
			if p.GIID == nil {
				return ""
			}
			return strconv.FormatInt(*p.GIID, 10)
		}
	}
	groups := map[string][]int32{}
	rows := map[string]*groupRow{}
	for _, p := range base {
		k := keyOf(p)
		if k == "" {
			continue
		}
		groups[k] = append(groups[k], int32(p.ID))
		r := rows[k]
		if r == nil {
			r = &groupRow{Level: level, Key: k, Name: k}
			if level == "up3" {
				r.Parent = p.UID
			} else if level == "gi" {
				r.Parent = p.UP3
			}
			rows[k] = r
		}
		r.CapMW += p.CapMW(capPF)
		r.Points++
	}
	keys := make([]string, 0, len(groups))
	all := []int32{}
	gidx := map[int32]string{}
	for k, ids := range groups {
		keys = append(keys, k)
		all = append(all, ids...)
		for _, id := range ids {
			gidx[id] = k
		}
	}
	// satu kueri: jumlah per (kelompok, slot)
	q, err := s.d.Pool.Query(ctx, `SELECT point_id, ts, COALESCE(p_mw, 0), `+load.EnergySQL+` FROM load_30m WHERE point_id = ANY($1) AND ts >= $2 AND ts < $3`, all, from, to)
	if err != nil {
		return nil, err
	}
	type acc struct{ p, e float64 }
	sum := map[string]map[time.Time]*acc{}
	for q.Next() {
		var pid int32
		var ts time.Time
		var pv float32
		var ev float64
		if q.Scan(&pid, &ts, &pv, &ev) != nil {
			continue
		}
		k := gidx[pid]
		m := sum[k]
		if m == nil {
			m = map[time.Time]*acc{}
			sum[k] = m
		}
		a := m[ts]
		if a == nil {
			a = &acc{}
			m[ts] = a
		}
		a.p += float64(pv)
		a.e += ev
	}
	q.Close()
	out := []groupRow{}
	for _, k := range keys {
		r := rows[k]
		for ts, a := range sum[k] {
			r.EnergyMWh += a.e
			if a.p > r.PeakMW {
				t := ts
				r.PeakMW, r.PeakTS = a.p, &t
			}
		}
		if r.CapMW > 0 {
			r.PeakUtil = r.PeakMW / r.CapMW * 100
		}
		out = append(out, *r)
	}
	if level == "gi" {
		ids := []int64{}
		for _, r := range out {
			if id, err := strconv.ParseInt(r.Key, 10, 64); err == nil {
				ids = append(ids, id)
			}
		}
		codes, _ := s.d.Power.NodeCodes(ctx, ids)
		for i := range out {
			if id, err := strconv.ParseInt(out[i].Key, 10, 64); err == nil {
				out[i].Name = codes[id].Code
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PeakMW > out[j].PeakMW })
	return out, nil
}

func (s *Server) buildLoadReport(ctx context.Context, kind string, from, to time.Time) (gin.H, error) {
	ls := s.d.Load
	st := s.loadSettings()
	pts, err := ls.Repo.Points(ctx)
	if err != nil {
		return nil, err
	}
	base := basePoints(pts)
	ids := []int32{}
	cap := 0.0
	for _, p := range base {
		ids = append(ids, int32(p.ID))
		cap += p.CapMW(st.CapPF)
	}
	sysDays, err := ls.Repo.DailyGroup(ctx, ids, from, to, cap, st.Warn, st.Over)
	if err != nil {
		return nil, err
	}
	nDays := int(math.Round(to.Sub(from).Hours() / 24))
	sys := summarize(sysDays, cap, nDays, len(ids))
	// pembanding: periode sebelumnya dengan panjang sama (bulanan/tahunan: tahun lalu juga)
	pFrom, pTo := from.Add(-to.Sub(from)), from
	switch kind {
	case "monthly":
		pFrom, pTo = from.AddDate(0, -1, 0), from
	case "yearly":
		pFrom, pTo = from.AddDate(-1, 0, 0), from
	}
	prevDays, _ := ls.Repo.DailyGroup(ctx, ids, pFrom, pTo, cap, st.Warn, st.Over)
	prev := summarize(prevDays, cap, int(math.Round(pTo.Sub(pFrom).Hours()/24)), len(ids))
	yoyDays, _ := ls.Repo.DailyGroup(ctx, ids, from.AddDate(-1, 0, 0), to.AddDate(-1, 0, 0), cap, st.Warn, st.Over)
	yoy := summarize(yoyDays, cap, nDays, len(ids))
	uids, _ := s.groupPeaks(ctx, base, "uid", from, to)
	up3s, _ := s.groupPeaks(ctx, base, "up3", from, to)
	gis_, _ := s.groupPeaks(ctx, base, "gi", from, to)
	if len(gis_) > 40 {
		gis_ = gis_[:40]
	}
	rank, _ := s.loadRankItems(ctx, from, to, "")
	feeders, trafos, over := []rankItem{}, []rankItem{}, []rankItem{}
	completeness := 0.0
	for _, r := range rank {
		if r.Kind == "feeder" && len(feeders) < 20 {
			feeders = append(feeders, r)
		}
		if r.Kind == "trafo_gi" && len(trafos) < 20 {
			trafos = append(trafos, r)
		}
		if r.Hours80 > 0 && len(over) < 50 {
			over = append(over, r)
		}
		completeness += float64(r.Samples)
	}
	gdRank, _ := s.loadRankItems(ctx, from, to, "gd")
	gdOver := []rankItem{}
	for _, r := range gdRank {
		completeness += float64(r.Samples)
		if r.PeakUtil >= st.Warn && len(gdOver) < 30 {
			gdOver = append(gdOver, r)
		}
	}
	active := 0
	for _, p := range pts {
		if p.Active {
			active++
		}
	}
	if active > 0 && nDays > 0 {
		completeness = completeness / float64(active*nDays*48) * 100
	}
	counts, _, _ := ls.Repo.AnomalyCounts(ctx, from, to)
	anoms, _ := ls.Repo.ListAnomalies(ctx, "", "", "", 0, from, to, 2000)
	pm := s.pointCodes(ctx)
	serious := []load.Anomaly{}
	for _, a := range anoms {
		if (a.Severity == "serious" || a.Severity == "critical") && len(serious) < 30 {
			a.PointCode, a.PointKind = pm[a.PointID].Code, pm[a.PointID].Kind
			serious = append(serious, a)
		}
	}
	res := gin.H{"kind": kind, "from": from, "to": to, "generated_at": time.Now(), "cap_mw": cap, "cap_pf": st.CapPF, "points": len(pts), "active": active,
		"system": sys, "previous": prev, "last_year": yoy, "uid": uids, "up3": up3s, "gi": gis_, "top_feeders": feeders, "top_trafos": trafos,
		"overloaded": over, "gd_overloaded": gdOver, "gd_count": len(gdRank), "completeness": completeness, "anomaly_counts": counts, "anomalies": serious,
		"settings": gin.H{"warn": st.Warn, "over": st.Over}}
	if lr, err := s.lossReport(ctx, from, to); err == nil {
		res["losses"] = lr
	}
	if kind != "daily" {
		res["days"] = sysDays
	} else {
		ser, _ := ls.Repo.Series(ctx, ids, from, to, cap)
		res["series"] = ser
	}
	return res, nil
}

// ---------------------------------------------------------------- analisa lanjutan

// GET /api/load/forecast?level&id&days=2
func (s *Server) loadForecast(c *gin.Context) {
	ctx := c.Request.Context()
	e, _, err := s.resolveEntity(ctx, c.Query("level"), c.Query("id"))
	if err != nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	st := s.loadSettings()
	days := queryInt(c, "days", 2)
	if days < 1 || days > 7 {
		days = 2
	}
	l := time.Now().In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	hist, err := s.d.Load.Repo.Series(ctx, e.points, today.AddDate(0, 0, -35), today.AddDate(0, 0, 1), e.CapMW)
	if err != nil {
		handleErr(c, err)
		return
	}
	// prakiraan mulai hari ini (bagian yang sudah terukur ikut ditampilkan sebagai aktual)
	past := []load.SeriesPoint{}
	for _, p := range hist {
		if p.TS.Before(today) {
			past = append(past, p)
		}
	}
	fc, info := load.Forecast(past, today, days, st.Holidays, e.CapMW)
	actual := []load.SeriesPoint{}
	for _, p := range hist {
		if !p.TS.Before(today.AddDate(0, 0, -2)) {
			actual = append(actual, p)
		}
	}
	// proyeksi puncak bulanan dari 13 bulan terakhir
	dstats, _ := s.d.Load.Repo.DailyGroup(ctx, e.points, today.AddDate(-1, -1, 0), today.AddDate(0, 0, 1), e.CapMW, st.Warn, st.Over)
	// hanya bulan dengan cakupan titik ≥ 90% (bulan saat sebagian titik belum mengirim data akan menyesatkan tren)
	cover := map[string]int{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT to_char(day, 'YYYY-MM'), count(DISTINCT point_id) FROM load_daily
		WHERE point_id = ANY($1) AND day >= ($2 AT TIME ZONE 'Asia/Jakarta')::date GROUP BY 1`, e.points, today.AddDate(-1, -1, 0)); err == nil {
		for rows.Next() {
			var m string
			var n int
			if rows.Scan(&m, &n) == nil {
				cover[m] = n
			}
		}
		rows.Close()
	}
	mh := []load.MonthPeak{}
	for _, m := range monthly(dstats, e.CapMW) {
		if m.Days >= 20 && float64(cover[m.Month]) >= 0.9*float64(e.Members) {
			mh = append(mh, load.MonthPeak{Month: m.Month, PeakMW: m.PeakMW, Util: m.PeakUtil})
		}
	}
	proj, growth, reach := load.ProjectPeaks(mh, 12, e.CapMW)
	ok(c, gin.H{"entity": e, "actual": actual, "forecast": fc, "info": info, "months": mh, "projection": proj, "growth_pct": growth, "reach_capacity": reach})
}

// GET /api/load/n1?days=30 — kontingensi N-1 penyulang lewat tie saat beban puncak (MW)
func (s *Server) loadN1(c *gin.Context) {
	ctx := c.Request.Context()
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	capPF := s.loadSettings().CapPF
	byHead := map[int64]load.Point{}
	for _, p := range pts {
		if p.Kind == "feeder" && p.NodeID != nil && p.Active {
			byHead[*p.NodeID] = p
		}
	}
	ties := s.d.Graph.FeederTies()
	nb := map[int64][]gis.FeederTie{}
	involved := map[int32]bool{}
	swIDs := []int64{}
	for _, t := range ties {
		pa, okA := byHead[t.A]
		pb, okB := byHead[t.B]
		if !okA || !okB {
			continue
		}
		nb[t.A] = append(nb[t.A], t)
		nb[t.B] = append(nb[t.B], t)
		involved[int32(pa.ID)], involved[int32(pb.ID)] = true, true
		swIDs = append(swIDs, t.Switch)
	}
	days := queryInt(c, "days", 30)
	to := time.Now()
	from := to.AddDate(0, 0, -days)
	ids := []int32{}
	for id := range involved {
		ids = append(ids, id)
	}
	series := map[int32]map[time.Time]float64{}
	if len(ids) > 0 {
		rs, err := s.d.Load.Repo.Readings(ctx, ids, from, to)
		if err != nil {
			handleErr(c, err)
			return
		}
		for _, r := range rs {
			if r.P == nil {
				continue
			}
			m := series[int32(r.PointID)]
			if m == nil {
				m = map[time.Time]float64{}
				series[int32(r.PointID)] = m
			}
			m[r.TS] = *r.P
		}
	}
	codes, _ := s.d.Power.NodeCodes(ctx, swIDs)
	type nbRow struct {
		Code     string  `json:"code"`
		Switch   string  `json:"switch"`
		LoadAt   float64 `json:"load_at_peak"`
		After    float64 `json:"after"`
		Cap      float64 `json:"cap_mw"`
		PctAfter float64 `json:"pct_after"`
		Spare    float64 `json:"spare"`
	}
	type row struct {
		PointID   int        `json:"point_id"`
		Code      string     `json:"code"`
		UP3       string     `json:"up3"`
		PeakMW    float64    `json:"peak_mw"`
		PeakTS    *time.Time `json:"peak_ts"`
		Cap       float64    `json:"cap_mw"`
		Neighbors []nbRow    `json:"neighbors"`
		BestPct   float64    `json:"best_pct"`
		SpareSum  float64    `json:"spare_sum"`
		Status    string     `json:"status"` // aman | parsial | tidak_aman | tanpa_tie | tanpa_data
	}
	out := []row{}
	counts := map[string]int{}
	for head, p := range byHead {
		r := row{PointID: p.ID, Code: p.Code, UP3: p.UP3, Cap: p.CapMW(capPF), Neighbors: []nbRow{}}
		ser := series[int32(p.ID)]
		for ts, v := range ser {
			if v > r.PeakMW {
				t := ts
				r.PeakMW, r.PeakTS = v, &t
			}
		}
		switch {
		case len(nb[head]) == 0:
			r.Status = "tanpa_tie"
		case r.PeakTS == nil:
			r.Status = "tanpa_data"
		default:
			r.BestPct = math.Inf(1)
			for _, t := range nb[head] {
				other := t.A
				if other == head {
					other = t.B
				}
				q := byHead[other]
				at := series[int32(q.ID)][*r.PeakTS]
				capQ := q.CapMW(capPF)
				n := nbRow{Code: q.Code, Switch: codes[t.Switch].Code, LoadAt: at, After: at + r.PeakMW, Cap: capQ}
				if capQ > 0 {
					n.PctAfter = n.After / capQ * 100
					n.Spare = math.Max(0, capQ-at)
				}
				r.SpareSum += n.Spare
				r.BestPct = math.Min(r.BestPct, n.PctAfter)
				r.Neighbors = append(r.Neighbors, n)
			}
			sort.Slice(r.Neighbors, func(i, j int) bool { return r.Neighbors[i].PctAfter < r.Neighbors[j].PctAfter })
			switch {
			case r.BestPct <= 100:
				r.Status = "aman"
			case r.SpareSum >= r.PeakMW:
				r.Status = "parsial"
			default:
				r.Status = "tidak_aman"
			}
			if math.IsInf(r.BestPct, 1) {
				r.BestPct = 0
			}
		}
		counts[r.Status]++
		out = append(out, r)
	}
	rank := map[string]int{"tidak_aman": 0, "parsial": 1, "aman": 2, "tanpa_data": 3, "tanpa_tie": 4}
	sort.Slice(out, func(i, j int) bool {
		if rank[out[i].Status] != rank[out[j].Status] {
			return rank[out[i].Status] < rank[out[j].Status]
		}
		return out[i].PeakMW > out[j].PeakMW
	})
	if lim := queryInt(c, "limit", 300); len(out) > lim {
		out = out[:lim]
	}
	ok(c, gin.H{"items": out, "counts": counts, "ties": len(ties), "days": days})
}

// GET /api/load/gd?point=&days=30 — beban gardu distribusi sebuah penyulang: terukur (meter gardu / AMR)
// atau, bila gardu belum bermeter, alokasi beban ukur penyulang sebanding daya kontrak pelanggan.
func (s *Server) loadGDAlloc(c *gin.Context) {
	ctx := c.Request.Context()
	pid := queryInt(c, "point", 0)
	p, err := s.d.Load.Repo.Point(ctx, pid)
	if err != nil || p.Kind != "feeder" || p.NodeID == nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	st := s.loadSettings()
	days := queryInt(c, "days", 30)
	to := time.Now()
	stats, _ := s.d.Load.Repo.PointStats(ctx, to.AddDate(0, 0, -days), to.AddDate(0, 0, 1), "")
	fst := stats[p.ID]
	if fst == nil {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	gds := []gis.GDStatus{}
	total := 0.0
	for _, g := range s.d.Graph.GDStatuses() {
		if g.Feeder == *p.NodeID {
			gds = append(gds, g)
			total += g.LoadVA
		}
	}
	kva := s.gdKVA(ctx)
	defKVA := s.d.Configs.Float("load.default_gd_kva", 200)
	// gardu bermeter pada penyulang ini
	all, _ := s.d.Load.Repo.Points(ctx)
	metered := map[int64]load.Point{}
	for _, q := range all {
		if q.Kind == "gd" && q.Active && q.NodeID != nil {
			metered[*q.NodeID] = q
		}
	}
	type row struct {
		ID         int64      `json:"id"`
		PointID    int        `json:"point_id,omitempty"`
		Code       string     `json:"code"`
		Name       string     `json:"name"`
		Customers  int        `json:"customers"`
		ContractVA float64    `json:"contract_va"`
		Share      float64    `json:"share"`
		Measured   bool       `json:"measured"`
		PeakKW     float64    `json:"peak_kw"`
		PeakTS     *time.Time `json:"peak_ts,omitempty"`
		EnergyMWh  float64    `json:"energy_mwh"`
		KVA        float64    `json:"kva"`
		KVAKnown   bool       `json:"kva_known"`
		Util       float64    `json:"util"`
	}
	gdIDs := make([]int64, 0, len(gds))
	for _, g := range gds {
		gdIDs = append(gdIDs, g.ID)
	}
	names, _ := s.d.Power.NodeCodes(ctx, gdIDs)
	out := []row{}
	nMeas := 0
	for _, g := range gds {
		r := row{ID: g.ID, Code: names[g.ID].Code, Name: names[g.ID].Name, Customers: g.Customers, ContractVA: g.LoadVA}
		if total > 0 {
			r.Share = g.LoadVA / total
		}
		r.KVA, r.KVAKnown = kva[g.ID], kva[g.ID] > 0
		if !r.KVAKnown {
			r.KVA = defKVA
		}
		if q, ok := metered[g.ID]; ok && stats[q.ID] != nil {
			x := stats[q.ID]
			r.PointID, r.Measured = q.ID, true
			r.PeakKW, r.PeakTS, r.EnergyMWh, r.Util = x.PeakMW*1000, x.PeakTS, x.EnergyMWh, x.PeakUtil
			nMeas++
		} else {
			r.PeakKW = fst.PeakMW * 1000 * r.Share
			if r.KVA > 0 {
				r.Util = r.PeakKW / (r.KVA * st.CapPF) * 100
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Util > out[j].Util })
	ok(c, gin.H{"point": p, "peak_mw": fst.PeakMW, "peak_ts": fst.PeakTS, "items": out, "default_kva": defKVA, "days": days, "measured": nMeas, "cap_pf": st.CapPF})
}

// GET /api/load/profiles?kind= — klasifikasi bentuk beban tiap titik dari profil dasar
func (s *Server) loadProfiles(c *gin.Context) {
	ctx := c.Request.Context()
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	bases, err := s.d.Load.Repo.Baselines(ctx, nil)
	if err != nil {
		handleErr(c, err)
		return
	}
	kind := c.Query("kind")
	wd := time.Date(2026, 9, 21, 0, 0, 0, 0, load.Loc) // Senin
	we := time.Date(2026, 9, 27, 0, 0, 0, 0, load.Loc) // Minggu
	type row struct {
		PointID int    `json:"point_id"`
		Code    string `json:"code"`
		Kind    string `json:"kind"`
		UP3     string `json:"up3"`
		load.Profile
	}
	out := []row{}
	counts := map[string]int{}
	for _, p := range pts {
		b := bases[p.ID]
		if len(b) == 0 || (kind != "" && p.Kind != kind) {
			continue
		}
		ser := []load.SeriesPoint{}
		for slot := 0; slot < 48; slot++ {
			if v, ok := b[0*48+slot]; ok {
				ser = append(ser, load.SeriesPoint{TS: wd.Add(time.Duration(slot) * 30 * time.Minute), P: v.Median})
			}
			if v, ok := b[2*48+slot]; ok {
				ser = append(ser, load.SeriesPoint{TS: we.Add(time.Duration(slot) * 30 * time.Minute), P: v.Median})
			}
		}
		pr := load.Classify(ser, map[string]bool{})
		counts[pr.Class]++
		if c.Query("curves") != "1" {
			pr.Weekday, pr.Weekend = nil, nil
		}
		out = append(out, row{PointID: p.ID, Code: p.Code, Kind: p.Kind, UP3: p.UP3, Profile: pr})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	ok(c, gin.H{"items": out, "counts": counts})
}

// GET /api/load/health?kind=trafo_gi|feeder|gd — indeks kesehatan (pembebanan 12 bulan, umur, anomali)
func (s *Server) loadHealth(c *gin.Context) {
	ctx := c.Request.Context()
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	kind := c.DefaultQuery("kind", "trafo_gi")
	now := time.Now()
	stats, _ := s.d.Load.Repo.PointStats(ctx, now.AddDate(-1, 0, 0), now.AddDate(0, 0, 1), kind)
	anom := map[int]int{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT point_id, count(*) FROM load_anomalies WHERE start_ts > now() - interval '90 days' AND severity IN ('warning','serious','critical') GROUP BY 1`); err == nil {
		for rows.Next() {
			var pid, n int
			if rows.Scan(&pid, &n) == nil {
				anom[pid] = n
			}
		}
		rows.Close()
	}
	nodeIDs := []int64{}
	for _, p := range pts {
		if p.NodeID != nil && p.Kind == kind {
			nodeIDs = append(nodeIDs, *p.NodeID)
		}
	}
	year := map[int64]float64{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT id, NULLIF(COALESCE(properties->>'tahun', properties->>'tahun_operasi'), '')::float FROM gis_nodes WHERE id = ANY($1)`, nodeIDs); err == nil {
		for rows.Next() {
			var id int64
			var y *float64
			if rows.Scan(&id, &y) == nil && y != nil {
				year[id] = *y
			}
		}
		rows.Close()
	}
	type row struct {
		PointID  int     `json:"point_id"`
		Code     string  `json:"code"`
		Kind     string  `json:"kind"`
		UP3      string  `json:"up3"`
		PeakUtil float64 `json:"peak_util"`
		Hours80  float64 `json:"hours_over80"`
		Hours100 float64 `json:"hours_over100"`
		Age      float64 `json:"age"`
		AgeKnown bool    `json:"age_known"`
		Anoms    int     `json:"anomalies"`
		Days     int     `json:"days"`
		load.Health
	}
	out := []row{}
	counts := map[string]int{}
	for _, p := range pts {
		if p.Kind != kind || !p.Active {
			continue
		}
		st := stats[p.ID]
		if st == nil {
			continue
		}
		r := row{PointID: p.ID, Code: p.Code, Kind: p.Kind, UP3: p.UP3, PeakUtil: st.PeakUtil, Hours80: st.Hours80, Hours100: st.Hours100, Anoms: anom[p.ID], Days: st.Days}
		if p.NodeID != nil {
			if y, ok := year[*p.NodeID]; ok && y > 1900 {
				r.Age, r.AgeKnown = float64(now.Year())-y, true
			}
		}
		r.Health = load.HealthIndex(r.PeakUtil, r.Hours80, r.Hours100, r.Age, r.Anoms)
		counts[r.Category]++
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Score < out[j].Score })
	if lim := queryInt(c, "limit", 300); len(out) > lim {
		out = out[:lim]
	}
	ok(c, gin.H{"items": out, "counts": counts})
}

// GET /api/load/calibration — faktor kalibrasi beban penyulang yang dipakai simulasi & FLISR
func (s *Server) loadCalibrationList(c *gin.Context) {
	cal := s.loadCalibration(c.Request.Context())
	rows := append([]calibRow(nil), cal.rows...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].Factor > rows[j].Factor })
	if lim := queryInt(c, "limit", 300); len(rows) > lim {
		rows = rows[:lim]
	}
	ok(c, gin.H{"items": rows, "enabled": s.d.Configs.Bool("load.calibrate_sim", true), "default_load_factor": s.d.Configs.Float("powerflow.load_factor", 0.6)})
}
