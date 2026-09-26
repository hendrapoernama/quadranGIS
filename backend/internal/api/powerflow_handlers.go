package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
)

// pfReq: parameter opsional yang menggantikan nilai konfigurasi untuk satu perhitungan (skenario).
type pfReq struct {
	HeadID      int64    `json:"head_id"`
	SourcePU    *float64 `json:"source_pu"`
	LoadFactor  *float64 `json:"load_factor"`
	PowerFactor *float64 `json:"power_factor"`
	VMinPU      *float64 `json:"v_min_pu"`
	VMaxPU      *float64 `json:"v_max_pu"`
}

func (s *Server) pfParams(r pfReq) gis.PFParams {
	p := s.d.PowerFlow.Params()
	if r.SourcePU != nil {
		p.SourcePU = *r.SourcePU
	}
	if r.LoadFactor != nil {
		p.LoadFactor = *r.LoadFactor
	}
	if r.PowerFactor != nil {
		p.PowerFactor = *r.PowerFactor
	}
	if r.VMinPU != nil {
		p.VMinPU = *r.VMinPU
	}
	if r.VMaxPU != nil {
		p.VMaxPU = *r.VMaxPU
	}
	p.Normalize()
	return p
}

// fillPFCodes melengkapi ringkasan dengan kode penyulang & GI.
func (s *Server) fillPFCodes(ctx context.Context, list []gis.PFSummary) {
	ids := make([]int64, 0, len(list)*2)
	for _, x := range list {
		ids = append(ids, x.Head, x.GI)
	}
	names, _ := s.d.Power.NodeCodes(ctx, ids)
	for i := range list {
		if n, ok := names[list[i].Head]; ok {
			list[i].Code, list[i].Name = n.Code, n.Name
		}
		if n, ok := names[list[i].GI]; ok {
			list[i].GICode = n.Code
		}
	}
}

// GET /api/powerflow/params
func (s *Server) pfGetParams(c *gin.Context) {
	ok(c, gin.H{"params": s.d.PowerFlow.Params()})
}

// POST /api/powerflow/feeder: hitung satu penyulang lengkap + geometri untuk pewarnaan peta.
func (s *Server) pfFeeder(c *gin.Context) {
	var req pfReq
	if err := c.ShouldBindJSON(&req); err != nil || req.HeadID <= 0 {
		failT(c, http.StatusBadRequest, "pf.head_required")
		return
	}
	ctx := c.Request.Context()
	p := s.pfParams(req)
	res, err := s.d.PowerFlow.Feeder(ctx, req.HeadID, p)
	switch {
	case errors.Is(err, gis.ErrNotFound):
		failT(c, http.StatusNotFound, "pf.head_not_found")
		return
	case errors.Is(err, gis.ErrNotFeederHead):
		failT(c, http.StatusBadRequest, "pf.not_head")
		return
	case errors.Is(err, gis.ErrFeederNotEnergized):
		failT(c, http.StatusConflict, "pf.not_energized")
		return
	case err != nil:
		handleErr(c, err)
		return
	}
	one := []gis.PFSummary{res.Summary}
	s.fillPFCodes(ctx, one)
	res.Summary = one[0]
	fc, err := s.d.PowerFlow.GeoJSON(ctx, res)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "powerflow.feeder", "node", strconv.FormatInt(req.HeadID, 10),
			gin.H{"nodes": res.Summary.Nodes, "status": res.Summary.Status, "ms": res.Summary.DurationMS}, clientIP(c))
	}
	worstV, worstI := gis.PFWorst(res, 15)
	ok(c, gin.H{"summary": res.Summary, "trafos": res.Trafos, "worst_nodes": worstV, "worst_edges": worstI, "params": p, "geojson": fc})
}

// POST /api/powerflow/run-all: hitung semua penyulang (ringkasan saja).
func (s *Server) pfRunAll(c *gin.Context) {
	var req pfReq
	_ = c.ShouldBindJSON(&req)
	p := s.pfParams(req)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Minute)
	defer cancel()
	list, ms, err := s.d.PowerFlow.RunAll(ctx, p)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "powerflow.run_all", "powerflow", "", gin.H{"feeders": len(list), "ms": ms, "load_factor": p.LoadFactor}, clientIP(c))
	}
	s.pfResults(c)
}

// GET /api/powerflow/results?status=all|ok|warning|critical|error&q=&sort=&limit=
func (s *Server) pfResults(c *gin.Context) {
	all, at, p, ms := s.d.PowerFlow.Last()
	if all == nil {
		ok(c, gin.H{"items": []gis.PFSummary{}, "total": 0, "has_run": false, "params": s.d.PowerFlow.Params()})
		return
	}
	stats := gin.H{"feeders": len(all)}
	count := map[string]int{}
	var load, loss, send float64
	worstV := 9.0
	var worstVHead int64
	for _, x := range all {
		count[x.Status]++
		load += x.LoadKW
		loss += x.LossKW
		send += x.SendKW
		if x.Status != "error" && x.VMinPU < worstV {
			worstV, worstVHead = x.VMinPU, x.Head
		}
	}
	stats["by_status"] = count
	stats["load_kw"], stats["loss_kw"], stats["send_kw"] = load, loss, send
	if send > 0 {
		stats["loss_pct"] = loss / send * 100
	}
	stats["v_min_pu"], stats["v_min_head"] = worstV, worstVHead

	status := c.Query("status")
	list := make([]gis.PFSummary, 0, len(all))
	for _, x := range all {
		if status != "" && status != "all" && x.Status != status {
			continue
		}
		list = append(list, x)
	}
	rank := map[string]int{"error": 0, "critical": 1, "warning": 2, "ok": 3}
	switch c.DefaultQuery("sort", "severity") {
	case "v_min":
		sort.SliceStable(list, func(i, j int) bool { return list[i].VMinPU < list[j].VMinPU })
	case "loading":
		sort.SliceStable(list, func(i, j int) bool {
			return maxf(list[i].IMaxPct, list[i].TrafoMaxPct) > maxf(list[j].IMaxPct, list[j].TrafoMaxPct)
		})
	case "loss":
		sort.SliceStable(list, func(i, j int) bool { return list[i].LossKW > list[j].LossKW })
	default:
		sort.SliceStable(list, func(i, j int) bool {
			if rank[list[i].Status] != rank[list[j].Status] {
				return rank[list[i].Status] < rank[list[j].Status]
			}
			return list[i].VMinPU < list[j].VMinPU
		})
	}
	ctx := c.Request.Context()
	limit := queryInt(c, "limit", 300)
	if limit <= 0 || limit > 2000 {
		limit = 300
	}
	if q := strings.ToLower(strings.TrimSpace(c.Query("q"))); q != "" {
		s.fillPFCodes(ctx, list)
		filtered := list[:0]
		for _, x := range list {
			if strings.Contains(strings.ToLower(x.Code), q) || strings.Contains(strings.ToLower(x.Name), q) || strings.Contains(strings.ToLower(x.GICode), q) {
				filtered = append(filtered, x)
			}
		}
		list = filtered
	}
	total := len(list)
	if len(list) > limit {
		list = list[:limit]
	}
	s.fillPFCodes(ctx, list)
	ok(c, gin.H{"items": list, "total": total, "has_run": true, "at": at, "params": p, "duration_ms": ms, "stats": stats})
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
