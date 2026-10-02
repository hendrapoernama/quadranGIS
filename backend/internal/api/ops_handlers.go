package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
	"quadrangis/internal/push"
	"quadrangis/internal/stream"
)

// =====================================================================
// Operasi jaringan (grup tab Operasi di menu Pusat Operasi, /monitoring): simulasi what-if, rencana manuver, FLISR, laporan gangguan pelanggan.
// =====================================================================

// warna overlay peta hasil simulasi
const (
	colRestored = "#0ca30c" // padam → nyala
	colNewOff   = "#d03b3b" // nyala → padam
	colSection  = "#f59e0b" // seksi gangguan (FLISR)
	colStep     = "#2563eb" // objek yang dimanuver
	colStillOff = "#8a94a6" // tetap padam
)

func (s *Server) simParams() gis.SimParams {
	kv := s.d.Configs.Float("ops.feeder_kv", 20)
	amp := s.d.Configs.Float("ops.feeder_capacity_a", 400)
	p := gis.SimParams{CapacityVA: math.Sqrt(3) * kv * 1000 * amp, LoadFactor: s.d.Configs.Float("powerflow.load_factor", 0.6)}
	// kalibrasi dari beban ukur SCADA: beban puncak 7 hari & rating kubikel per penyulang
	if s.d.Load != nil && s.d.Configs.Bool("load.calibrate_sim", true) {
		cal := s.loadCalibration(context.Background())
		p.Scale, p.Caps = cal.scale, cal.caps
	}
	return p
}

func claimsUser(c *gin.Context) (*string, string) {
	cl := middleware.GetClaims(c)
	if cl == nil {
		return nil, ""
	}
	uid := cl.UserID
	return &uid, cl.Username
}

func (s *Server) simErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, gis.ErrGraphLoading):
		failT(c, http.StatusServiceUnavailable, "sld.graph_loading")
	case errors.Is(err, gis.ErrNotFound):
		failT(c, http.StatusNotFound, "common.not_found")
	case errors.Is(err, gis.ErrFlisrSource):
		failT(c, http.StatusBadRequest, "ops.flisr_source")
	case errors.Is(err, gis.ErrFlisrNoSwitch):
		failT(c, http.StatusBadRequest, "ops.flisr_no_switch")
	case errors.Is(err, gis.ErrSimEmpty), errors.Is(err, gis.ErrBadRequest):
		failT(c, http.StatusBadRequest, "common.bad_payload")
	default:
		handleErr(c, err)
	}
}

// codesFor mengumpulkan kode/nama/tipe node untuk id yang dirujuk hasil simulasi.
func (s *Server) codesFor(ctx context.Context, ids []int64) map[int64]gis.CodeName {
	uniq := map[int64]struct{}{}
	list := []int64{}
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := uniq[id]; !ok {
			uniq[id] = struct{}{}
			list = append(list, id)
		}
	}
	out, _ := s.d.Power.NodeCodes(ctx, list)
	return out
}

func simRefs(res *gis.SimResult) []int64 {
	ids := []int64{}
	if res == nil {
		return ids
	}
	for _, st := range res.Steps {
		if st.Action.TargetKind != "edge" {
			ids = append(ids, st.Action.TargetID)
		}
		for _, f := range st.Feeders {
			ids = append(ids, f.Head)
		}
		for _, w := range st.Warnings {
			ids = append(ids, w.Feeders...)
		}
	}
	for _, f := range res.BaseFeeders {
		ids = append(ids, f.Head)
	}
	return ids
}

// simGeoJSON membuat overlay peta: hijau pulih, merah padam baru, jingga seksi gangguan, biru objek yang dimanuver.
func (s *Server) simGeoJSON(ctx context.Context, res *gis.SimResult, sectionNodes, sectionEdges []int64, withStillOff bool) (models.FeatureCollection, error) {
	colorN := map[int64]string{}
	colorE := map[int64]string{}
	big := map[int64]bool{}
	if res != nil {
		for _, id := range res.NodesOn {
			colorN[id] = colRestored
		}
		for _, id := range res.NodesOff {
			colorN[id] = colNewOff
		}
		for _, id := range res.EdgesOn {
			colorE[id] = colRestored
		}
		for _, id := range res.EdgesOff {
			colorE[id] = colNewOff
		}
		if withStillOff {
			for _, id := range res.StillOffEdges {
				if _, set := colorE[id]; !set {
					colorE[id] = colStillOff
				}
			}
		}
	}
	for _, id := range sectionNodes {
		colorN[id] = colSection
	}
	for _, id := range sectionEdges {
		colorE[id] = colSection
	}
	if res != nil {
		for _, st := range res.Steps {
			if st.Action.TargetKind == "edge" {
				colorE[st.Action.TargetID] = colStep
			} else {
				colorN[st.Action.TargetID] = colStep
				big[st.Action.TargetID] = true
			}
		}
	}
	nodes := make([]int64, 0, len(colorN))
	for id := range colorN {
		nodes = append(nodes, id)
	}
	edges := make([]int64, 0, len(colorE))
	for id := range colorE {
		edges = append(edges, id)
	}
	fc, err := s.d.Features.ByIDs(ctx, nodes, edges, 6000)
	if err != nil {
		return fc, err
	}
	for i := range fc.Features {
		f := &fc.Features[i]
		kind, _ := f.Properties["kind"].(string)
		keep := map[string]any{"kind": kind, "code": f.Properties["code"], "type_code": f.Properties["type_code"]}
		if kind == "edge" {
			keep["color"] = colorE[f.ID]
		} else {
			keep["color"] = colorN[f.ID]
			if big[f.ID] {
				keep["big"] = true
			}
		}
		f.Properties = keep
	}
	return fc, nil
}

// ---------------------------------------------------------------- simulasi ad-hoc

// POST /api/ops/simulate {actions:[...]}
func (s *Server) opsSimulate(c *gin.Context) {
	var req struct {
		Actions []gis.SimAction `json:"actions"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Actions) == 0 || len(req.Actions) > 100 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	res, err := s.d.Graph.Simulate(req.Actions, s.simParams(), 5000)
	if err != nil {
		s.simErr(c, err)
		return
	}
	fc, _ := s.simGeoJSON(c.Request.Context(), res, nil, nil, false)
	ok(c, gin.H{"sim": res, "codes": s.codesFor(c.Request.Context(), simRefs(res)), "geojson": fc, "params": s.simParams()})
}

// ---------------------------------------------------------------- rencana manuver

type planReq struct {
	Title    string          `json:"title"`
	Kind     string          `json:"kind"`
	Note     string          `json:"note"`
	Source   string          `json:"source"`
	OutageID *int64          `json:"outage_id"`
	Fault    json.RawMessage `json:"fault"`
	Steps    []gis.SimAction `json:"steps"`
}

func (s *Server) planFromReq(ctx context.Context, r planReq) (gis.Plan, bool) {
	r.Kind = strings.ToUpper(strings.TrimSpace(r.Kind))
	valid := false
	for _, k := range gis.ManeuverKinds {
		if k == r.Kind {
			valid = true
		}
	}
	if !valid || strings.TrimSpace(r.Title) == "" || len(r.Steps) > 100 {
		return gis.Plan{}, false
	}
	src := "manual"
	if r.Source == "flisr" {
		src = "flisr"
	}
	p := gis.Plan{Title: strings.TrimSpace(r.Title), Kind: r.Kind, Note: r.Note, Source: src, OutageID: r.OutageID, Fault: r.Fault}
	for _, a := range r.Steps {
		if (a.Action != "open" && a.Action != "close") || a.TargetID <= 0 || (a.TargetKind != "node" && a.TargetKind != "edge") {
			return gis.Plan{}, false
		}
		ft, err := s.d.Features.Get(ctx, a.TargetKind, a.TargetID)
		if err != nil {
			return gis.Plan{}, false
		}
		step := gis.PlanStep{TargetKind: a.TargetKind, TargetID: a.TargetID, Action: a.Action, Note: a.Note}
		step.TargetCode, _ = ft.Properties["code"].(string)
		step.TargetType, _ = ft.Properties["type_code"].(string)
		if a.WayEdge > 0 {
			w := a.WayEdge
			step.WayEdgeID = &w
		}
		p.Steps = append(p.Steps, step)
	}
	return p, true
}

func planActions(p gis.Plan) []gis.SimAction {
	out := make([]gis.SimAction, 0, len(p.Steps))
	for _, st := range p.Steps {
		a := gis.SimAction{TargetKind: st.TargetKind, TargetID: st.TargetID, Action: st.Action, Note: st.Note}
		if st.WayEdgeID != nil {
			a.WayEdge = *st.WayEdgeID
		}
		out = append(out, a)
	}
	return out
}

// GET /api/ops/plans?status=
func (s *Server) opsListPlans(c *gin.Context) {
	items, err := s.d.Ops.ListPlans(c.Request.Context(), c.Query("status"), queryInt(c, "limit", 100))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/ops/plans/:id
func (s *Server) opsGetPlan(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	p, err := s.d.Ops.GetPlan(c.Request.Context(), id)
	if err != nil {
		s.simErr(c, err)
		return
	}
	ok(c, p)
}

// POST /api/ops/plans · PUT /api/ops/plans/:id (hanya draft)
func (s *Server) opsSavePlan(c *gin.Context) {
	var req planReq
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	p, valid := s.planFromReq(c.Request.Context(), req)
	if !valid {
		failT(c, http.StatusBadRequest, "ops.plan_invalid")
		return
	}
	if c.Param("id") != "" {
		id, okID := paramInt64(c, "id")
		if !okID {
			return
		}
		p.ID = id
	}
	uid, uname := claimsUser(c)
	id, err := s.d.Ops.SavePlan(c.Request.Context(), p, uid, uname)
	if err != nil {
		if errors.Is(err, gis.ErrBadRequest) {
			failT(c, http.StatusConflict, "ops.plan_not_draft")
			return
		}
		handleErr(c, err)
		return
	}
	s.auditOps(c, "plan.save", strconv.FormatInt(id, 10), gin.H{"title": p.Title, "steps": len(p.Steps), "source": p.Source})
	s.publishOps("plan", id)
	saved, _ := s.d.Ops.GetPlan(c.Request.Context(), id)
	ok(c, saved)
}

// DELETE /api/ops/plans/:id
func (s *Server) opsDeletePlan(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	if err := s.d.Ops.DeletePlan(c.Request.Context(), id); err != nil {
		if errors.Is(err, gis.ErrBadRequest) {
			failT(c, http.StatusConflict, "ops.plan_not_draft")
			return
		}
		handleErr(c, err)
		return
	}
	s.auditOps(c, "plan.delete", strconv.FormatInt(id, 10), nil)
	s.publishOps("plan", id)
	ok(c, gin.H{"deleted": true})
}

// POST /api/ops/plans/:id/simulate
func (s *Server) opsSimulatePlan(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	p, err := s.d.Ops.GetPlan(c.Request.Context(), id)
	if err != nil {
		s.simErr(c, err)
		return
	}
	res, err := s.d.Graph.Simulate(planActions(p), s.simParams(), 5000)
	if err != nil {
		s.simErr(c, err)
		return
	}
	fc, _ := s.simGeoJSON(c.Request.Context(), res, nil, nil, false)
	ok(c, gin.H{"sim": res, "codes": s.codesFor(c.Request.Context(), simRefs(res)), "geojson": fc, "params": s.simParams()})
}

// POST /api/ops/plans/:id/approve | cancel
func (s *Server) opsPlanStatus(to string, from ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, okID := paramInt64(c, "id")
		if !okID {
			return
		}
		_, uname := claimsUser(c)
		if err := s.d.Ops.SetPlanStatus(c.Request.Context(), id, to, from, uname); err != nil {
			if errors.Is(err, gis.ErrBadRequest) {
				failT(c, http.StatusConflict, "ops.plan_bad_status")
				return
			}
			handleErr(c, err)
			return
		}
		s.auditOps(c, "plan."+to, strconv.FormatInt(id, 10), nil)
		s.publishOps("plan", id)
		p, _ := s.d.Ops.GetPlan(c.Request.Context(), id)
		if to == "approved" {
			s.notify("plan", push.Message{Title: fmt.Sprintf("Rencana #%d disetujui", id), Body: p.Title + " · oleh " + uname, URL: "/monitoring?tab=plans", Tag: fmt.Sprintf("plan-%d", id)}, "normal")
		}
		ok(c, p)
	}
}

// invokeManeuver menjalankan handler manuver yang sama persis (izin, kejadian padam, SOE, audit,
// siaran realtime) untuk satu langkah rencana, lalu mengembalikan status dan isi jawabannya.
func (s *Server) invokeManeuver(c *gin.Context, body map[string]any) (int, map[string]any) {
	w := httptest.NewRecorder()
	c2, _ := gin.CreateTestContext(w)
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, "/api/gis/maneuver", bytes.NewReader(b)).WithContext(c.Request.Context())
	r.Header = c.Request.Header.Clone()
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = c.Request.RemoteAddr
	c2.Request = r
	for k, v := range c.Keys {
		c2.Set(k, v)
	}
	s.powerManeuver(c2)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// POST /api/ops/plans/:id/steps/:seq/execute | skip
func (s *Server) opsStep(skip bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, okID := paramInt64(c, "id")
		if !okID {
			return
		}
		seq, err := strconv.Atoi(c.Param("seq"))
		if err != nil || seq <= 0 {
			failT(c, http.StatusBadRequest, "common.invalid_id")
			return
		}
		ctx := c.Request.Context()
		p, err := s.d.Ops.GetPlan(ctx, id)
		if err != nil {
			s.simErr(c, err)
			return
		}
		if p.Status != "approved" && p.Status != "executing" {
			failT(c, http.StatusConflict, "ops.plan_not_approved")
			return
		}
		var step *gis.PlanStep
		for i := range p.Steps {
			st := &p.Steps[i]
			if st.Seq == seq {
				step = st
				break
			}
			if st.Status != "done" && st.Status != "skipped" {
				failT(c, http.StatusConflict, "ops.step_order")
				return
			}
		}
		if step == nil {
			failT(c, http.StatusNotFound, "common.not_found")
			return
		}
		if step.Status == "done" || step.Status == "skipped" {
			failT(c, http.StatusConflict, "ops.step_done")
			return
		}
		_, uname := claimsUser(c)
		if skip {
			done, err := s.d.Ops.MarkStep(ctx, id, seq, "skipped", uname, nil, "")
			if err != nil {
				handleErr(c, err)
				return
			}
			s.auditOps(c, "plan.step_skip", strconv.FormatInt(id, 10), gin.H{"seq": seq})
			s.publishOps("plan", id)
			ok(c, gin.H{"skipped": true, "plan_done": done})
			return
		}
		body := map[string]any{"action": step.Action, "note": strings.TrimSpace("Rencana #" + strconv.FormatInt(id, 10) + " langkah " + strconv.Itoa(seq) + ": " + step.Note)}
		if step.TargetKind == "edge" {
			body["edge_id"] = step.TargetID
		} else {
			body["node_id"] = step.TargetID
		}
		if step.WayEdgeID != nil {
			body["way_edge_id"] = *step.WayEdgeID
		}
		if step.Action == "open" {
			body["kind"] = p.Kind
		}
		status, resp := s.invokeManeuver(c, body)
		if status != http.StatusOK {
			msg, _ := resp["error"].(string)
			_, _ = s.d.Ops.MarkStep(ctx, id, seq, "failed", uname, nil, msg)
			s.publishOps("plan", id)
			fail(c, status, msg)
			return
		}
		var mid *int64
		if v, ok := resp["maneuver_id"].(float64); ok {
			m := int64(v)
			mid = &m
		}
		done, err := s.d.Ops.MarkStep(ctx, id, seq, "done", uname, mid, "")
		if err != nil {
			handleErr(c, err)
			return
		}
		s.publishOps("plan", id)
		resp["plan_done"] = done
		ok(c, resp)
	}
}

// ---------------------------------------------------------------- FLISR

type flisrSection struct {
	gis.FaultSection
	BoundaryCodes []string `json:"boundary_codes"`
	EntryCode     string   `json:"entry_code"`
	Code          string   `json:"code"`
	TypeCode      string   `json:"type_code"`
	History       int      `json:"history"` // gangguan 365 hari terakhir di seksi ini
	Reports       int      `json:"reports"` // laporan pelanggan terbuka di seksi ini
}

// GET /api/ops/flisr/sections?outage_id=  (atau kind & id alat penyebab)
func (s *Server) opsFlisrSections(c *gin.Context) {
	ctx := c.Request.Context()
	kind, id := c.DefaultQuery("kind", "node"), int64(queryInt(c, "id", 0))
	if oid := int64(queryInt(c, "outage_id", 0)); oid > 0 {
		o, _, err := s.d.Power.GetOutage(ctx, oid)
		if err != nil {
			handleErr(c, err)
			return
		}
		kind, id = o.CauseKind, o.CauseNodeID
	}
	if id <= 0 {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	out, err := s.flisrSections(ctx, kind, id)
	if err != nil {
		s.simErr(c, err)
		return
	}
	ok(c, gin.H{"items": out, "cause_kind": kind, "cause_id": id})
}

// flisrSections: kandidat seksi gangguan di hilir alat penyebab + riwayat gangguan & laporan terbuka.
func (s *Server) flisrSections(ctx context.Context, kind string, id int64) ([]flisrSection, error) {
	secs, err := s.d.Graph.OutageSections(kind, id, 60)
	if err != nil {
		return nil, err
	}
	out := make([]flisrSection, 0, len(secs))
	all := []int64{}
	refs := []int64{}
	for _, sec := range secs {
		all = append(all, sec.NodeIDs...)
		refs = append(refs, sec.ID, sec.Entry)
		refs = append(refs, sec.Boundaries...)
	}
	codes := s.codesFor(ctx, refs)
	hist := map[int64]int{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT cause_node_id, count(*) FROM outages
		WHERE started_at > now() - interval '365 days' AND kind IN ('GANGGUAN','BENCANA ALAM') AND cause_node_id = ANY($1) GROUP BY 1`, all); err == nil {
		for rows.Next() {
			var n int64
			var k int
			if rows.Scan(&n, &k) == nil {
				hist[n] = k
			}
		}
		rows.Close()
	}
	reps := map[int64]int{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT customer_id, count(*) FROM customer_reports
		WHERE status IN ('BARU','DIVERIFIKASI','DIKERJAKAN') AND customer_id = ANY($1) GROUP BY 1`, all); err == nil {
		for rows.Next() {
			var n int64
			var k int
			if rows.Scan(&n, &k) == nil {
				reps[n] = k
			}
		}
		rows.Close()
	}
	for _, sec := range secs {
		fs := flisrSection{FaultSection: sec, BoundaryCodes: []string{}}
		fs.Code, fs.TypeCode = codes[sec.ID].Code, codes[sec.ID].TypeCode
		fs.EntryCode = codes[sec.Entry].Code
		for _, b := range sec.Boundaries {
			fs.BoundaryCodes = append(fs.BoundaryCodes, codes[b].Code)
		}
		for _, n := range sec.NodeIDs {
			fs.History += hist[n]
			fs.Reports += reps[n]
		}
		out = append(out, fs)
	}
	return out, nil
}

// POST /api/ops/flisr {fault_kind, fault_id}
func (s *Server) opsFlisr(c *gin.Context) {
	var req struct {
		FaultKind string `json:"fault_kind"`
		FaultID   int64  `json:"fault_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.FaultID <= 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if req.FaultKind != "edge" {
		req.FaultKind = "node"
	}
	ctx := c.Request.Context()
	res, err := s.d.Graph.FLISR(req.FaultKind, req.FaultID, s.simParams(), 5000)
	if err != nil {
		s.simErr(c, err)
		return
	}
	refs := simRefs(res.Sim)
	refs = append(refs, res.Upstream, res.Tripped)
	refs = append(refs, res.Downstream...)
	for _, isl := range res.Islands {
		refs = append(refs, isl.Boundary)
		for _, t := range isl.Alternatives {
			refs = append(refs, t.SwitchID, t.Supporting)
		}
	}
	if req.FaultKind == "node" {
		refs = append(refs, req.FaultID)
	}
	fc, _ := s.simGeoJSON(ctx, res.Sim, res.SectionNodes, res.SectionEdges, true)
	s.auditOps(c, "flisr.analyze", strconv.FormatInt(req.FaultID, 10), gin.H{"kind": req.FaultKind, "steps": len(res.Actions)})
	ok(c, gin.H{"result": res, "codes": s.codesFor(ctx, refs), "geojson": fc, "params": s.simParams()})
}

// ---------------------------------------------------------------- laporan gangguan pelanggan

func (s *Server) fillReportCodes(ctx context.Context, items []gis.Report) {
	nodeIDs, edgeIDs := []int64{}, []int64{}
	for _, r := range items {
		if r.GDID != nil {
			nodeIDs = append(nodeIDs, *r.GDID)
		}
		if r.FeederID != nil {
			nodeIDs = append(nodeIDs, *r.FeederID)
		}
		if r.RouteID != nil {
			edgeIDs = append(edgeIDs, *r.RouteID)
		}
	}
	nc, _ := s.d.Power.NodeCodes(ctx, nodeIDs)
	ec, _ := s.d.Power.EdgeCodes(ctx, edgeIDs)
	for i := range items {
		r := &items[i]
		if r.GDID != nil {
			r.GDCode = nc[*r.GDID].Code
		}
		if r.FeederID != nil {
			r.FeederCode = nc[*r.FeederID].Code
		}
		if r.RouteID != nil {
			r.RouteCode = ec[*r.RouteID].Code
		}
	}
}

// GET /api/ops/reports?status=open|BARU|...&category&q&limit
func (s *Server) opsListReports(c *gin.Context) {
	ctx := c.Request.Context()
	items, err := s.d.Ops.ListReports(ctx, gis.ReportFilter{Status: c.Query("status"), Category: c.Query("category"), Q: c.Query("q"), Limit: queryInt(c, "limit", 300)})
	if err != nil {
		handleErr(c, err)
		return
	}
	s.fillReportCodes(ctx, items)
	sla := s.d.Configs.Float("ops.report_sla_minutes", 120)
	stats, _ := s.d.Ops.ReportStats(ctx, sla)
	ok(c, gin.H{"items": items, "stats": stats, "sla_minutes": sla,
		"categories": gis.ReportCategories, "channels": gis.ReportChannels, "statuses": gis.ReportStatuses, "priorities": gis.ReportPriorities})
}

func inList(v string, list []string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// POST /api/ops/reports
func (s *Server) opsCreateReport(c *gin.Context) {
	var req struct {
		Channel       string   `json:"channel"`
		ReporterName  string   `json:"reporter_name"`
		ReporterPhone string   `json:"reporter_phone"`
		CustomerID    int64    `json:"customer_id"`
		CustomerCode  string   `json:"customer_code"`
		Address       string   `json:"address"`
		Lng           *float64 `json:"lng"`
		Lat           *float64 `json:"lat"`
		Category      string   `json:"category"`
		Description   string   `json:"description"`
		Priority      string   `json:"priority"`
		ClientID      string   `json:"client_id"`  // antrean offline (idempoten)
		CreatedAt     string   `json:"created_at"` // waktu laporan dibuat di perangkat (offline)
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.ClientID) > 64 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	req.Channel, req.Category, req.Priority = strings.ToUpper(req.Channel), strings.ToUpper(req.Category), strings.ToUpper(req.Priority)
	if !inList(req.Channel, gis.ReportChannels) || !inList(req.Category, gis.ReportCategories) {
		failT(c, http.StatusBadRequest, "ops.report_invalid")
		return
	}
	if req.Priority == "" || !inList(req.Priority, gis.ReportPriorities) {
		switch req.Category {
		case "BAHAYA", "KABEL_PUTUS":
			req.Priority = "DARURAT"
		case "TIANG":
			req.Priority = "TINGGI"
		default:
			req.Priority = "NORMAL"
		}
	}
	ctx := c.Request.Context()
	r := gis.Report{Channel: req.Channel, ReporterName: strings.TrimSpace(req.ReporterName), ReporterPhone: strings.TrimSpace(req.ReporterPhone),
		Address: strings.TrimSpace(req.Address), Lng: req.Lng, Lat: req.Lat, Category: req.Category, Description: strings.TrimSpace(req.Description),
		Priority: req.Priority, CustomerCode: strings.TrimSpace(req.CustomerCode)}
	if cid := strings.TrimSpace(req.ClientID); cid != "" {
		r.ClientID = &cid
		// waktu offline dipakai sebagai waktu terima (maks. 3 hari ke belakang, tidak di masa depan)
		if t, err := time.Parse(time.RFC3339, req.CreatedAt); err == nil && t.Before(time.Now()) && time.Since(t) < 72*time.Hour {
			r.OfflineAt = &t
		}
	}
	// kenali pelanggan: id → kode / idpel / kode SSOT → titik terdekat (50 m)
	custID := req.CustomerID
	if custID <= 0 && r.CustomerCode != "" {
		if id, code, err := s.d.Ops.FindCustomer(ctx, r.CustomerCode); err == nil {
			custID, r.CustomerCode = id, code
		}
	}
	if custID <= 0 && req.Lng != nil && req.Lat != nil {
		if id, code, err := s.d.Ops.NearestCustomer(ctx, *req.Lng, *req.Lat, 50); err == nil {
			custID, r.CustomerCode = id, code
		}
	}
	if custID <= 0 && r.Address == "" && (req.Lng == nil || req.Lat == nil) {
		failT(c, http.StatusBadRequest, "ops.report_location")
		return
	}
	if custID > 0 {
		info := s.d.Graph.NodeInfo(custID)
		if info.InGraph {
			id := custID
			r.CustomerID = &id
			on := info.Energized
			r.Energized = &on
			if info.GD != 0 {
				v := info.GD
				r.GDID = &v
			}
			if info.Feeder != 0 {
				v := info.Feeder
				r.FeederID = &v
			}
			if info.Route != 0 {
				v := info.Route
				r.RouteID = &v
			}
			if r.CustomerCode == "" {
				if cn, err := s.d.Power.NodeCodes(ctx, []int64{custID}); err == nil {
					r.CustomerCode = cn[custID].Code
				}
			}
			if !on {
				var oid int64
				if err := s.d.Pool.QueryRow(ctx, `SELECT id FROM outages WHERE ended_at IS NULL AND $1 = ANY(affected_nodes) ORDER BY started_at DESC LIMIT 1`, custID).Scan(&oid); err == nil {
					r.OutageID = &oid
				}
			}
		}
	}
	uid, uname := claimsUser(c)
	id, ticket, err := s.d.Ops.CreateReport(ctx, r, uid, uname)
	if errors.Is(err, gis.ErrConflict) && id > 0 {
		// sudah pernah diterima (kiriman ulang dari antrean offline)
		saved, _ := s.d.Ops.GetReport(ctx, id)
		items := []gis.Report{saved}
		s.fillReportCodes(ctx, items)
		ok(c, items[0])
		return
	}
	if err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "report.create", ticket, gin.H{"category": r.Category, "customer_id": r.CustomerID, "outage_id": r.OutageID})
	s.publishReportEvent("created", id)
	urg := "normal"
	if r.Priority == "DARURAT" {
		urg = "high"
	}
	body := r.Category
	if r.CustomerCode != "" {
		body += " · " + r.CustomerCode
	} else if r.Address != "" {
		body += " · " + r.Address
	}
	s.notify("report", push.Message{Title: "Laporan " + ticket + " (" + r.Priority + ")", Body: body, URL: "/monitoring?tab=reports", Tag: ticket}, urg)
	saved, _ := s.d.Ops.GetReport(ctx, id)
	items := []gis.Report{saved}
	s.fillReportCodes(ctx, items)
	ok(c, items[0])
}

// PUT /api/ops/reports/:id {status, priority, assigned_to, note}
func (s *Server) opsUpdateReport(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var req struct {
		Status     string `json:"status"`
		Priority   string `json:"priority"`
		AssignedTo string `json:"assigned_to"`
		Note       string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	req.Status, req.Priority = strings.ToUpper(req.Status), strings.ToUpper(req.Priority)
	if (req.Status != "" && !inList(req.Status, gis.ReportStatuses)) || (req.Priority != "" && !inList(req.Priority, gis.ReportPriorities)) {
		failT(c, http.StatusBadRequest, "ops.report_invalid")
		return
	}
	_, uname := claimsUser(c)
	if err := s.d.Ops.UpdateReport(c.Request.Context(), id, req.Status, req.Priority, strings.TrimSpace(req.AssignedTo), strings.TrimSpace(req.Note), uname); err != nil {
		s.simErr(c, err)
		return
	}
	s.auditOps(c, "report.update", strconv.FormatInt(id, 10), gin.H{"status": req.Status, "assigned_to": req.AssignedTo})
	s.publishReportEvent("updated", id)
	r, _ := s.d.Ops.GetReport(c.Request.Context(), id)
	items := []gis.Report{r}
	s.fillReportCodes(c.Request.Context(), items)
	ok(c, items[0])
}

type suspectOut struct {
	*gis.ReportSuspect
	Code      string   `json:"code"`
	Name      string   `json:"name"`
	TypeCode  string   `json:"type_code"`
	Group     string   `json:"group"` // kode gardu / penyulang pengelompok
	Tickets   []string `json:"tickets"`
	ReportIDs []int64  `json:"report_ids"`
}

// GET /api/ops/reports/suspects: dugaan lokasi gangguan dari laporan terbuka yang belum tertaut padam
func (s *Server) opsReportSuspects(c *gin.Context) {
	out, err := s.reportSuspects(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": out})
}

// reportSuspects mengelompokkan laporan terbuka yang belum tertaut padam lalu mencari titik bersamanya.
func (s *Server) reportSuspects(ctx context.Context) ([]suspectOut, error) {
	items, err := s.d.Ops.ListReports(ctx, gis.ReportFilter{Status: "open", Limit: 1000})
	if err != nil {
		return nil, err
	}
	type grp struct {
		key     int64
		custs   []int64
		tickets []string
		ids     []int64
	}
	groups := map[int64]*grp{}
	for _, r := range items {
		if r.OutageID != nil || r.CustomerID == nil {
			continue
		}
		if r.Category != "PADAM" && r.Category != "PADAM_SEBAGIAN" && r.Category != "TEGANGAN" && r.Category != "KABEL_PUTUS" {
			continue
		}
		key := int64(0)
		switch {
		case r.GDID != nil:
			key = *r.GDID
		case r.FeederID != nil:
			key = *r.FeederID
		}
		g := groups[key]
		if g == nil {
			g = &grp{key: key}
			groups[key] = g
		}
		g.custs = append(g.custs, *r.CustomerID)
		g.tickets = append(g.tickets, r.Ticket)
		g.ids = append(g.ids, r.ID)
	}
	out := []suspectOut{}
	refs := []int64{}
	for _, g := range groups {
		sp, err := s.d.Graph.SuspectFromCustomers(g.custs)
		if err != nil {
			continue
		}
		out = append(out, suspectOut{ReportSuspect: sp, Tickets: g.tickets, ReportIDs: g.ids, Group: strconv.FormatInt(g.key, 10)})
		refs = append(refs, sp.NodeID, g.key)
	}
	codes := s.codesFor(ctx, refs)
	for i := range out {
		cn := codes[out[i].NodeID]
		out[i].Code, out[i].Name, out[i].TypeCode = cn.Code, cn.Name, cn.TypeCode
		if k, err := strconv.ParseInt(out[i].Group, 10, 64); err == nil && k > 0 {
			out[i].Group = codes[k].Code
		} else {
			out[i].Group = ""
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Reported != out[j].Reported {
			return out[i].Reported > out[j].Reported
		}
		return out[i].Ratio > out[j].Ratio
	})
	return out, nil
}

// ---------------------------------------------------------------- utilitas

func (s *Server) publishOps(kind string, id int64) {
	data, _ := json.Marshal(gin.H{"kind": kind, "id": id})
	s.d.Hub.Publish(stream.Event{Type: "ops." + kind, ID: id, At: time.Now(), Data: data})
}

func (s *Server) publishReportEvent(action string, id int64) {
	data, _ := json.Marshal(gin.H{"action": action, "id": id})
	ev := stream.Event{Type: "ops.report", ID: id, At: time.Now(), Data: data}
	s.d.Hub.Publish(ev)
	s.d.Producer.Publish(ev)
}

func (s *Server) auditOps(c *gin.Context, action, target string, detail gin.H) {
	cl := middleware.GetClaims(c)
	if cl == nil {
		return
	}
	s.d.Audit.Log(&cl.UserID, cl.Username, "ops."+action, "ops", target, detail, clientIP(c))
}

func feederCodeOf(s *Server, ctx context.Context, kind string, id int64) string {
	var info gis.NodeInfo
	if kind == "edge" {
		info, _ = s.d.Graph.EdgeInfo(id)
	} else {
		info = s.d.Graph.NodeInfo(id)
	}
	if fc, err := s.d.Power.NodeCodes(ctx, []int64{info.Feeder}); err == nil {
		return fc[info.Feeder].Code
	}
	return ""
}

// openContinuations: setelah kejadian padam ditutup, pelanggan yang masih padam (mis. seksi yang
// diisolasi FLISR) dicatat sebagai kejadian lanjutan per switch isolasi. Kejadian lanjutan menambah
// SAIDI & ENS tetapi tidak menambah SAIFI, dan tertutup saat switch isolasinya ditutup.
func (s *Server) openContinuations(ctx context.Context, closed []int64, maneuverID int64, username, feederCode string) {
	for _, oid := range closed {
		o, affected, err := s.d.Power.GetOutage(ctx, oid)
		if err != nil || len(affected) == 0 {
			continue
		}
		groups := s.d.Graph.StillOffByIsolator(affected)
		for iso, nodes := range groups {
			if iso == 0 || len(nodes) == 0 {
				continue
			}
			sum := s.d.Graph.Summarize(nodes, 0)
			report := s.buildGroupReport(ctx, sum)
			if report.Customers == 0 {
				continue
			}
			report.Alloc = s.allocateLoad(ctx, sum.LoadByFeeder, time.Now())
			rj, _ := json.Marshal(report)
			cn, _ := s.d.Power.NodeCodes(ctx, []int64{iso})
			c := cn[iso]
			ct, _ := s.d.Types.Get(c.TypeCode)
			level := outageLevel("node", c.TypeCode, ct, sum, false)
			parent := oid
			mid := maneuverID
			nid, err := s.d.Power.OpenOutage(ctx, gis.OutageRecord{Kind: o.Kind, Level: level, GroupCode: c.Code, CauseKind: "node", CauseNodeID: iso,
				CauseNodeCode: c.Code, CauseNodeType: c.TypeCode, OpenManeuverID: &mid, Summary: rj, ParentID: &parent}, nodes)
			if err != nil {
				continue
			}
			_, _ = s.d.Ops.LinkReportsToOutage(ctx, nid, nodes)
			isoID, newID := iso, nid
			ev := gis.SOEEvent{Category: "outage", Event: "OUTAGE_CONTINUE", Severity: gis.OutageSeverity(level), TargetKind: "node", TargetID: &isoID,
				TargetCode: c.Code, TargetType: c.TypeCode, Kind: o.Kind, Level: level, FeederCode: feederCode, Customers: report.Customers,
				LoadVA: report.LoadVA, Nodes: len(nodes), OutageID: &newID, ManeuverID: &mid, Username: username,
				Note: "sisa padam dari kejadian #" + strconv.FormatInt(oid, 10)}
			s.recordSOE(ctx, &ev)
		}
	}
}
