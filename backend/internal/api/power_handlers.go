package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
	"quadrangis/internal/stream"
)

// outageLevel menentukan level group kejadian padam dari tipe alat yang dimanuver.
func outageLevel(typeCode string) string {
	switch typeCode {
	case "power_grid", "gi":
		return "gi"
	case "trafo_gi", "busbar":
		return "trafo_gi"
	case "kubikel_20kv":
		return "penyulang"
	case "recloser", "lbs_2way", "lbs_3way":
		return "zona"
	case "gd", "trafo_distribusi":
		return "gardu_distribusi"
	}
	return "lainnya"
}

// groupReport adalah ringkasan dampak yang sudah dilengkapi kode (untuk disimpan & ditampilkan).
type groupReport struct {
	gis.GroupSummary
	GICodes       []gis.CodeName `json:"gi"`
	TrafoGICodes  []gis.CodeName `json:"trafo_gi"`
	ParentGICodes []gis.CodeName `json:"parent_gi"`
	FeederCodes   []gis.CodeName `json:"penyulang"`
	ZoneCodes     []gis.CodeName `json:"zona"`
}

func (s *Server) buildGroupReport(ctx context.Context, sum gis.GroupSummary) groupReport {
	ids := append(append(append(append(append([]int64{}, sum.GI...), sum.TrafoGI...), sum.ParentGI...), sum.Feeders...), sum.Zones...)
	names, _ := s.d.Power.NodeCodes(ctx, ids)
	pick := func(list []int64) []gis.CodeName {
		out := make([]gis.CodeName, 0, len(list))
		for _, id := range list {
			if c, ok := names[id]; ok {
				out = append(out, c)
			} else {
				out = append(out, gis.CodeName{ID: id})
			}
		}
		return out
	}
	return groupReport{GroupSummary: sum, GICodes: pick(sum.GI), TrafoGICodes: pick(sum.TrafoGI), ParentGICodes: pick(sum.ParentGI),
		FeederCodes: pick(sum.Feeders), ZoneCodes: pick(sum.Zones)}
}

// enrichFeature melengkapi fitur dengan status energisasi & group dari graf.
func (s *Server) enrichFeature(ctx context.Context, ft *models.Feature) {
	kind, _ := ft.Properties["kind"].(string)
	var info gis.NodeInfo
	if kind == "node" {
		info = s.d.Graph.NodeInfo(ft.ID)
	} else {
		var ok bool
		info, ok = s.d.Graph.EdgeInfo(ft.ID)
		if !ok {
			info = gis.NodeInfo{OpenWays: []int64{}}
		}
	}
	ft.Properties["graph"] = info
	if info.InGraph {
		ft.Properties["energized"] = info.Energized
	}
	codes, _ := s.d.Power.NodeCodes(ctx, []int64{info.Feeder, info.Zone})
	if c, ok := codes[info.Feeder]; ok {
		ft.Properties["feeder"] = c
		if fi, ok := s.d.Graph.FeederOf(info.Feeder); ok {
			parents, _ := s.d.Power.NodeCodes(ctx, []int64{fi.GI, fi.TrafoGI})
			if g, ok := parents[fi.GI]; ok {
				ft.Properties["feeder_gi"] = g
			}
			if t, ok := parents[fi.TrafoGI]; ok {
				ft.Properties["feeder_trafo_gi"] = t
			}
		}
	}
	if c, ok := codes[info.Zone]; ok {
		ft.Properties["zone"] = c
	}
	if info.Route != 0 {
		if ec, _ := s.d.Power.EdgeCodes(ctx, []int64{info.Route}); ec != nil {
			if c, ok := ec[info.Route]; ok {
				ft.Properties["route"] = c
			}
		}
		// trafo distribusi = ujung hulu saluran TR pertama (jurusan)
		if td, ok := s.d.Power.RouteTrafo(ctx, info.Route); ok {
			ft.Properties["trafo_gd"] = td
		}
	}
	if info.GD != 0 && info.GD != ft.ID {
		if gc, _ := s.d.Power.NodeCodes(ctx, []int64{info.GD}); gc != nil {
			if c, ok := gc[info.GD]; ok {
				ft.Properties["gd"] = c
			}
		}
	}
}

type maneuverReq struct {
	NodeID    int64  `json:"node_id"`
	Action    string `json:"action"`
	WayEdgeID int64  `json:"way_edge_id"`
	Kind      string `json:"kind"`
	Note      string `json:"note"`
}

// POST /api/gis/maneuver
func (s *Server) powerManeuver(c *gin.Context) {
	var req maneuverReq
	if err := c.ShouldBindJSON(&req); err != nil || req.NodeID <= 0 {
		failT(c, http.StatusBadRequest, "gis.node_id_required")
		return
	}
	req.Action = strings.ToLower(strings.TrimSpace(req.Action))
	if req.Action != "open" && req.Action != "close" {
		failT(c, http.StatusBadRequest, "power.action_invalid")
		return
	}
	req.Kind = strings.ToUpper(strings.TrimSpace(req.Kind))
	validKind := false
	for _, k := range gis.ManeuverKinds {
		if k == req.Kind {
			validKind = true
		}
	}
	if !validKind {
		failT(c, http.StatusBadRequest, "power.kind_invalid")
		return
	}
	ctx := c.Request.Context()
	lang := middleware.GetLang(c)
	ft, err := s.d.Features.Get(ctx, "node", req.NodeID)
	if err != nil {
		handleErr(c, err)
		return
	}
	typeCode, _ := ft.Properties["type_code"].(string)
	code, _ := ft.Properties["code"].(string)
	ct, _ := s.d.Types.Get(typeCode)
	if !ct.IsSwitch {
		fail(c, http.StatusBadRequest, tr(c, "power.not_switch", req.NodeID, typeCode))
		return
	}
	var wayEdge *int64
	if req.WayEdgeID > 0 {
		if ct.Ways < 3 {
			failT(c, http.StatusBadRequest, "power.way_not_allowed")
			return
		}
		w := req.WayEdgeID
		wayEdge = &w
	}
	open := req.Action == "open"
	diff, err := s.d.Graph.Maneuver(gis.ManeuverInput{NodeID: req.NodeID, Open: open, WayEdge: req.WayEdgeID})
	switch {
	case errors.Is(err, gis.ErrNotFound):
		failT(c, http.StatusConflict, "power.not_in_graph")
		return
	case errors.Is(err, gis.ErrNotSwitch):
		fail(c, http.StatusBadRequest, tr(c, "power.not_switch", req.NodeID, typeCode))
		return
	case errors.Is(err, gis.ErrBadRequest):
		fail(c, http.StatusBadRequest, tr(c, "power.way_invalid", req.WayEdgeID, req.NodeID))
		return
	case err != nil:
		handleErr(c, err)
		return
	}

	// persistensi: posisi switch, energisasi, catatan manuver, kejadian padam
	pctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	info := s.d.Graph.NodeInfo(req.NodeID)
	cl := middleware.GetClaims(c)
	var userID *string
	username := ""
	if cl != nil {
		uid := cl.UserID
		userID, username = &uid, cl.Username
	}
	if err := s.d.Power.SetSwitchState(pctx, req.NodeID, info.Open, info.OpenWays, userID); err != nil {
		handleErr(c, err)
		return
	}
	if err := s.d.Power.ApplyEnergized(pctx, diff); err != nil {
		handleErr(c, err)
		return
	}
	var affectedNodes []int64
	affectedEdges := 0
	if open {
		affectedNodes, affectedEdges = diff.NodesOff, len(diff.EdgesOff)
	} else {
		affectedNodes, affectedEdges = diff.NodesOn, len(diff.EdgesOn)
	}
	report := s.buildGroupReport(pctx, s.d.Graph.Summarize(affectedNodes, affectedEdges))
	reportJSON, _ := json.Marshal(report)
	m := gis.ManeuverRecord{NodeID: req.NodeID, NodeCode: code, NodeType: typeCode, Action: req.Action, WayEdgeID: wayEdge,
		Kind: req.Kind, Note: strings.TrimSpace(req.Note), UserID: userID, Username: username, Affected: reportJSON}
	mid, err := s.d.Power.InsertManeuver(pctx, m)
	if err != nil {
		handleErr(c, err)
		return
	}
	var outageID *int64
	closedOutages := []int64{}
	if open && len(affectedNodes) > 0 {
		oid, err := s.d.Power.OpenOutage(pctx, gis.OutageRecord{Kind: req.Kind, Level: outageLevel(typeCode), GroupCode: code, CauseNodeID: req.NodeID,
			CauseNodeCode: code, CauseNodeType: typeCode, WayEdgeID: wayEdge, OpenManeuverID: &mid, Summary: reportJSON}, affectedNodes)
		if err != nil {
			handleErr(c, err)
			return
		}
		outageID = &oid
		_ = s.d.Power.LinkManeuverOutage(pctx, mid, oid)
	} else if !open {
		closedOutages, _ = s.d.Power.CloseOutages(pctx, req.NodeID, wayEdge, mid, reportJSON)
		if len(closedOutages) > 0 {
			_ = s.d.Power.LinkManeuverOutage(pctx, mid, closedOutages[0])
		}
	}

	version := s.d.Tiles.BumpVersion(pctx)
	msgKey := "power.msg_close"
	if open {
		msgKey = "power.msg_open"
	}
	label := ct.Name
	if lang == "en" && ct.NameEN != "" {
		label = ct.NameEN
	}
	message := tr(c, msgKey, label, req.NodeID, req.Kind, len(affectedNodes)+affectedEdges, report.Customers)
	evData, _ := json.Marshal(gin.H{"action": req.Action, "kind": req.Kind, "node_code": code, "way_edge_id": wayEdge, "maneuver_id": mid,
		"outage_id": outageID, "closed_outages": closedOutages, "summary": report, "message": message})
	ev := stream.Event{Type: "maneuver", Kind: "node", ID: req.NodeID, TypeCode: typeCode, Version: version, Username: username, At: time.Now(), Data: evData}
	if userID != nil {
		ev.UserID = *userID
	}
	s.d.Producer.Publish(ev)
	s.d.Hub.Publish(ev)
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "maneuver."+req.Action, "node", strconv.FormatInt(req.NodeID, 10),
			gin.H{"kind": req.Kind, "way_edge_id": wayEdge, "nodes": len(affectedNodes), "customers": report.Customers, "outage_id": outageID}, clientIP(c))
	}
	feat, err := s.d.Features.Get(ctx, "node", req.NodeID)
	if err == nil {
		s.enrichFeature(ctx, &feat)
	}
	ok(c, gin.H{"maneuver_id": mid, "outage_id": outageID, "closed_outages": closedOutages, "summary": report, "message": message,
		"tile_version": version, "feature": feat, "diff": gin.H{"nodes_on": len(diff.NodesOn), "nodes_off": len(diff.NodesOff), "edges_on": len(diff.EdgesOn), "edges_off": len(diff.EdgesOff)}})
}

// GET /api/power/summary
func (s *Server) powerSummary(c *gin.Context) {
	sum, feeders := s.d.Graph.PowerSummary()
	active, _ := s.d.Power.CountActiveOutages(c.Request.Context())
	off := make([]gis.FeederStatus, 0)
	for _, f := range feeders {
		if f.State != "on" {
			off = append(off, f)
		}
	}
	sort.Slice(off, func(i, j int) bool { return off[i].CustomersOff > off[j].CustomersOff })
	if len(off) > 20 {
		off = off[:20]
	}
	s.fillFeederCodes(c.Request.Context(), off)
	ok(c, gin.H{"summary": sum, "active_outages": active, "feeders_off": off, "graph": s.d.Graph.Status()})
}

func (s *Server) fillFeederCodes(ctx context.Context, list []gis.FeederStatus) {
	ids := make([]int64, 0, len(list)*3)
	for _, f := range list {
		ids = append(ids, f.Head, f.GI, f.TrafoGI)
	}
	names, _ := s.d.Power.NodeCodes(ctx, ids)
	for i := range list {
		if c, ok := names[list[i].Head]; ok {
			list[i].Code, list[i].Name = c.Code, c.Name
		}
		if c, ok := names[list[i].GI]; ok {
			list[i].GICode = c.Code
		}
		if c, ok := names[list[i].TrafoGI]; ok {
			list[i].TrafoGICode = c.Code
		}
	}
}

// GET /api/power/feeders?state=all|off|partial|on&q=&limit=
func (s *Server) powerFeeders(c *gin.Context) {
	_, feeders := s.d.Graph.PowerSummary()
	state := c.Query("state")
	limit := queryInt(c, "limit", 200)
	if limit <= 0 || limit > 2000 {
		limit = 200
	}
	list := make([]gis.FeederStatus, 0)
	for _, f := range feeders {
		if state != "" && state != "all" && f.State != state {
			continue
		}
		list = append(list, f)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].NodesOff != list[j].NodesOff {
			return list[i].NodesOff > list[j].NodesOff
		}
		return list[i].Head < list[j].Head
	})
	total := len(list)
	if q := strings.ToLower(strings.TrimSpace(c.Query("q"))); q != "" {
		s.fillFeederCodes(c.Request.Context(), list)
		filtered := list[:0]
		for _, f := range list {
			if strings.Contains(strings.ToLower(f.Code), q) || strings.Contains(strings.ToLower(f.Name), q) || strings.Contains(strings.ToLower(f.GICode), q) {
				filtered = append(filtered, f)
			}
		}
		list = filtered
		total = len(list)
		if len(list) > limit {
			list = list[:limit]
		}
	} else {
		if len(list) > limit {
			list = list[:limit]
		}
		s.fillFeederCodes(c.Request.Context(), list)
	}
	ok(c, gin.H{"items": list, "total": total})
}

// GET /api/power/outages?active=1&limit=
func (s *Server) powerOutages(c *gin.Context) {
	active := c.Query("active") == "1" || c.Query("active") == "true"
	items, err := s.d.Power.ListOutages(c.Request.Context(), active, queryInt(c, "limit", 50))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/power/outages/:id
func (s *Server) powerOutage(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	o, affected, err := s.d.Power.GetOutage(c.Request.Context(), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	limit := s.d.Configs.Int("trace.max_result_features", 5000)
	fc, _ := s.d.Features.ByIDs(c.Request.Context(), affected, nil, limit)
	ok(c, gin.H{"outage": o, "affected_nodes": len(affected), "geojson": fc})
}

// GET /api/power/maneuvers?node_id=&limit=
func (s *Server) powerManeuvers(c *gin.Context) {
	nodeID := int64(queryInt(c, "node_id", 0))
	items, err := s.d.Power.ListManeuvers(c.Request.Context(), nodeID, queryInt(c, "limit", 50))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/power/gardu?state=all|on|partial|off&q=&limit=
func (s *Server) powerGardu(c *gin.Context) {
	all := s.d.Graph.GDStatuses()
	state := c.Query("state")
	limit := queryInt(c, "limit", 200)
	if limit <= 0 || limit > 2000 {
		limit = 200
	}
	list := make([]gis.GDStatus, 0)
	for _, x := range all {
		if state != "" && state != "all" && x.State != state {
			continue
		}
		list = append(list, x)
	}
	// yang bermasalah di atas: padam, lalu sebagian (terbanyak pelanggan padam), lalu nyala
	rank := map[string]int{"off": 0, "partial": 1, "on": 2}
	sort.SliceStable(list, func(i, j int) bool {
		if rank[list[i].State] != rank[list[j].State] {
			return rank[list[i].State] < rank[list[j].State]
		}
		if list[i].CustomersOff != list[j].CustomersOff {
			return list[i].CustomersOff > list[j].CustomersOff
		}
		return list[i].ID < list[j].ID
	})
	ctx := c.Request.Context()
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		// cari lewat index kode/nama/kode SSOT, lalu irisan dengan daftar status
		hits, err := s.d.Features.Search(ctx, q, 100)
		if err != nil {
			handleErr(c, err)
			return
		}
		want := map[int64]bool{}
		for _, h := range hits {
			if h.Kind == "node" && h.TypeCode == "gd" {
				want[h.ID] = true
			}
		}
		filtered := list[:0]
		for _, x := range list {
			if want[x.ID] {
				filtered = append(filtered, x)
			}
		}
		list = filtered
	}
	total := len(list)
	if len(list) > limit {
		list = list[:limit]
	}
	ids := make([]int64, 0, len(list)*3)
	for _, x := range list {
		ids = append(ids, x.ID, x.Feeder, x.GI)
	}
	names, _ := s.d.Power.NodeCodes(ctx, ids)
	for i := range list {
		if n, ok := names[list[i].ID]; ok {
			list[i].Code, list[i].Name = n.Code, n.Name
		}
		if n, ok := names[list[i].Feeder]; ok {
			list[i].FeederCode = n.Code
		}
		if n, ok := names[list[i].GI]; ok {
			list[i].GICode = n.Code
		}
	}
	ok(c, gin.H{"items": list, "total": total})
}
