package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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

// OperatePermissions adalah izin operasi buka/tutup & energize/deenergize (salah satu cukup untuk endpoint).
var OperatePermissions = []string{"power.switch_tm", "power.switch_tr", "power.energize_tm", "power.energize_tr"}

// operateDomain menentukan domain tegangan objek (tm | tr) untuk izin operasi.
func (s *Server) operateDomain(targetKind string, targetID int64, ct models.ComponentType) string {
	kv := ct.VoltageKV
	if kv <= 0 && targetKind == "node" {
		kv = s.d.Graph.AdjacentMaxKV(targetID)
	}
	if kv > 0 && kv < 1 {
		return "tr"
	}
	return "tm"
}

// operatePermission adalah izin yang dibutuhkan untuk mengoperasikan objek.
func operatePermission(targetKind string, ct models.ComponentType, domain string) string {
	if targetKind == "node" && ct.IsSwitch {
		return "power.switch_" + domain
	}
	return "power.energize_" + domain
}

// OutageLevels adalah urutan level kejadian padam (untuk pengelompokan).
var OutageLevels = []string{"gi", "trafo_gi", "penyulang", "zona", "gardu_distribusi", "trafo_gd", "jurusan", "pelanggan"}

// outageLevel menentukan level kejadian padam dari objek penyebab dan dampaknya.
func outageLevel(targetKind, typeCode string, ct models.ComponentType, sum gis.GroupSummary, isFeederHead bool) string {
	switch {
	case len(sum.GI) > 0:
		return "gi"
	case len(sum.TrafoGI) > 0:
		return "trafo_gi"
	}
	if targetKind == "edge" {
		switch {
		case typeCode == "busbar":
			return "trafo_gi"
		case typeCode == "sr":
			return "pelanggan"
		case ct.VoltageKV > 0 && ct.VoltageKV < 1:
			return "jurusan"
		}
		return "zona"
	}
	switch {
	case typeCode == "power_grid" || typeCode == "gi":
		return "gi"
	case typeCode == "trafo_gi":
		return "trafo_gi"
	case typeCode == "kubikel_20kv" && isFeederHead:
		return "penyulang"
	case typeCode == "kubikel_20kv":
		if len(sum.Feeders) > 1 {
			return "trafo_gi" // kubikel incoming / kopel: beberapa penyulang
		}
		return "penyulang"
	case typeCode == "recloser" || typeCode == "lbs_2way" || typeCode == "lbs_3way" || typeCode == "gh":
		return "zona"
	case typeCode == "gd":
		return "gardu_distribusi"
	case typeCode == "trafo_distribusi" || typeCode == "rak_tr":
		return "trafo_gd"
	case typeCode == "switch_jurusan_tr":
		return "jurusan"
	case ct.IsSink:
		return "pelanggan"
	}
	// lainnya (junction dsb.): dari cakupan dampak
	switch {
	case sum.GD > 0:
		return "zona"
	case sum.Routes > 0 && sum.Customers > 1:
		return "jurusan"
	}
	return "pelanggan"
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
	if ct, ok := s.d.Types.Get(fmt.Sprint(ft.Properties["type_code"])); ok {
		ft.Properties["operate_domain"] = s.operateDomain(kind, ft.ID, ct)
	}
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
	// rekap pelanggan & daya terpasang di hilir gardu / switch / kubikel outgoing
	if kind == "node" {
		if sec, ok := s.d.Graph.Section(ft.ID); ok {
			ft.Properties["section"] = sec
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
	EdgeID    int64  `json:"edge_id"` // bila diisi: memutus / menyambung saluran
	Action    string `json:"action"`
	WayEdgeID int64  `json:"way_edge_id"`
	Kind      string `json:"kind"`
	Note      string `json:"note"`
}

// POST /api/gis/maneuver: buka/tutup alat switching, pemutusan objek (gardu, trafo, pelanggan)
// atau saluran, dengan kategori GANGGUAN / PEMELIHARAAN / MLS / MANUVER / BENCANA ALAM.
func (s *Server) powerManeuver(c *gin.Context) {
	var req maneuverReq
	if err := c.ShouldBindJSON(&req); err != nil || (req.NodeID <= 0 && req.EdgeID <= 0) {
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
	// kategori pemadaman wajib saat membuka / deenergize; saat menutup boleh kosong (ikut kejadian aktif)
	if !validKind && (req.Action == "open" || req.Kind != "") {
		failT(c, http.StatusBadRequest, "power.kind_invalid")
		return
	}
	ctx := c.Request.Context()
	lang := middleware.GetLang(c)
	targetKind, targetID := "node", req.NodeID
	if req.EdgeID > 0 {
		targetKind, targetID = "edge", req.EdgeID
	}
	ft, err := s.d.Features.Get(ctx, targetKind, targetID)
	if err != nil {
		handleErr(c, err)
		return
	}
	typeCode, _ := ft.Properties["type_code"].(string)
	code, _ := ft.Properties["code"].(string)
	ct, _ := s.d.Types.Get(typeCode)
	if targetKind == "node" && !ct.Topology {
		fail(c, http.StatusBadRequest, tr(c, "power.not_switch", targetID, typeCode))
		return
	}
	// hak akses sesuai role: switching / energize, domain TM / TR
	domain := s.operateDomain(targetKind, targetID, ct)
	if perm := operatePermission(targetKind, ct, domain); !middleware.GetClaims(c).Has(perm) {
		fail(c, http.StatusForbidden, tr(c, "auth.no_permission", perm))
		return
	}
	var wayEdge *int64
	if req.WayEdgeID > 0 && targetKind == "node" {
		if ct.Ways < 3 {
			failT(c, http.StatusBadRequest, "power.way_not_allowed")
			return
		}
		w := req.WayEdgeID
		wayEdge = &w
	}
	open := req.Action == "open"
	if req.Kind == "" {
		if req.Kind = s.d.Power.ActiveOutageKind(ctx, targetKind, targetID, wayEdge); req.Kind == "" {
			req.Kind = "MANUVER"
		}
	}
	in := gis.ManeuverInput{NodeID: req.NodeID, Open: open, WayEdge: req.WayEdgeID}
	if targetKind == "edge" {
		in = gis.ManeuverInput{EdgeID: req.EdgeID, Open: open}
	}
	diff, err := s.d.Graph.Maneuver(in)
	switch {
	case errors.Is(err, gis.ErrNotFound):
		failT(c, http.StatusConflict, "power.not_in_graph")
		return
	case errors.Is(err, gis.ErrNotSwitch):
		failT(c, http.StatusBadRequest, "power.way_not_allowed")
		return
	case errors.Is(err, gis.ErrBadRequest):
		fail(c, http.StatusBadRequest, tr(c, "power.way_invalid", req.WayEdgeID, req.NodeID))
		return
	case err != nil:
		handleErr(c, err)
		return
	}

	// persistensi: posisi, energisasi, catatan manuver, kejadian padam
	pctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cl := middleware.GetClaims(c)
	var userID *string
	username := ""
	if cl != nil {
		uid := cl.UserID
		userID, username = &uid, cl.Username
	}
	if targetKind == "edge" {
		err = s.d.Power.SetEdgeState(pctx, targetID, open, userID)
	} else {
		info := s.d.Graph.NodeInfo(req.NodeID)
		err = s.d.Power.SetSwitchState(pctx, req.NodeID, info.Open, info.OpenWays, userID)
	}
	if err != nil {
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
	sum := s.d.Graph.Summarize(affectedNodes, affectedEdges)
	report := s.buildGroupReport(pctx, sum)
	reportJSON, _ := json.Marshal(report)
	m := gis.ManeuverRecord{TargetKind: targetKind, NodeID: targetID, NodeCode: code, NodeType: typeCode, Action: req.Action, WayEdgeID: wayEdge,
		Kind: req.Kind, Note: strings.TrimSpace(req.Note), UserID: userID, Username: username, Affected: reportJSON}
	mid, err := s.d.Power.InsertManeuver(pctx, m)
	if err != nil {
		handleErr(c, err)
		return
	}
	var outageID *int64
	closedOutages := []int64{}
	level := ""
	if open && len(affectedNodes) > 0 {
		_, isHead := s.d.Graph.FeederOf(targetID)
		level = outageLevel(targetKind, typeCode, ct, sum, targetKind == "node" && isHead)
		oid, err := s.d.Power.OpenOutage(pctx, gis.OutageRecord{Kind: req.Kind, Level: level, GroupCode: code, CauseKind: targetKind, CauseNodeID: targetID,
			CauseNodeCode: code, CauseNodeType: typeCode, WayEdgeID: wayEdge, OpenManeuverID: &mid, Summary: reportJSON}, affectedNodes)
		if err != nil {
			handleErr(c, err)
			return
		}
		outageID = &oid
		_ = s.d.Power.LinkManeuverOutage(pctx, mid, oid)
	} else if !open {
		closedOutages, _ = s.d.Power.CloseOutages(pctx, targetKind, targetID, wayEdge, mid, reportJSON)
		if len(closedOutages) > 0 {
			_ = s.d.Power.LinkManeuverOutage(pctx, mid, closedOutages[0])
		}
	}

	// SOE: aksi manuver, lalu padam mulai / selesai (urut sesuai cap waktu)
	var tinfo gis.NodeInfo
	if targetKind == "edge" {
		tinfo, _ = s.d.Graph.EdgeInfo(targetID)
	} else {
		tinfo = s.d.Graph.NodeInfo(targetID)
	}
	feederCode := ""
	if fc, err := s.d.Power.NodeCodes(pctx, []int64{tinfo.Feeder}); err == nil {
		feederCode = fc[tinfo.Feeder].Code
	}
	category, sev := "cut", "warning"
	if ct.IsSwitch {
		category = "switch"
	}
	switch {
	case !open:
		sev = "good"
	case req.Kind == "GANGGUAN" || req.Kind == "BENCANA ALAM":
		sev = "serious"
	}
	tid := targetID
	base := gis.SOEEvent{TargetKind: targetKind, TargetID: &tid, TargetCode: code, TargetType: typeCode, WayEdgeID: wayEdge,
		Kind: req.Kind, FeederCode: feederCode, Username: username}
	ev1 := base
	ev1.Category, ev1.Event, ev1.Severity, ev1.Level = category, strings.ToUpper(req.Action), sev, level
	ev1.Customers, ev1.LoadVA, ev1.Nodes, ev1.ManeuverID, ev1.OutageID, ev1.Note = report.Customers, report.LoadVA, len(affectedNodes), &mid, outageID, m.Note
	s.recordSOE(pctx, &ev1)
	if outageID != nil {
		ev := base
		ev.Category, ev.Event, ev.Severity, ev.Level = "outage", "OUTAGE_START", gis.OutageSeverity(level), level
		ev.Customers, ev.LoadVA, ev.Nodes, ev.ManeuverID, ev.OutageID = report.Customers, report.LoadVA, len(affectedNodes), &mid, outageID
		s.recordSOE(pctx, &ev)
	}
	for _, oid := range closedOutages {
		o, _, err := s.d.Power.GetOutage(pctx, oid)
		if err != nil {
			continue
		}
		var osum struct {
			Customers int     `json:"pelanggan"`
			LoadVA    float64 `json:"beban_va"`
		}
		_ = json.Unmarshal(o.Summary, &osum)
		ev := base
		id, dur := oid, o.DurationSec
		ev.Category, ev.Event, ev.Severity, ev.Level, ev.Kind = "outage", "OUTAGE_END", "good", o.Level, o.Kind
		ev.Customers, ev.LoadVA, ev.Nodes, ev.ManeuverID, ev.OutageID, ev.DurationSec = osum.Customers, osum.LoadVA, o.AffectedCount, &mid, &id, &dur
		s.recordSOE(pctx, &ev)
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
	message := tr(c, msgKey, label, targetID, req.Kind, len(affectedNodes)+affectedEdges, report.Customers)
	evData, _ := json.Marshal(gin.H{"action": req.Action, "kind": req.Kind, "target_kind": targetKind, "node_code": code, "way_edge_id": wayEdge, "maneuver_id": mid,
		"outage_id": outageID, "level": level, "closed_outages": closedOutages, "summary": report, "message": message})
	ev := stream.Event{Type: "maneuver", Kind: targetKind, ID: targetID, TypeCode: typeCode, Version: version, Username: username, At: time.Now(), Data: evData}
	if userID != nil {
		ev.UserID = *userID
	}
	s.d.Producer.Publish(ev)
	s.d.Hub.Publish(ev)
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "maneuver."+req.Action, targetKind, strconv.FormatInt(targetID, 10),
			gin.H{"kind": req.Kind, "level": level, "way_edge_id": wayEdge, "nodes": len(affectedNodes), "customers": report.Customers, "outage_id": outageID}, clientIP(c))
	}
	feat, err := s.d.Features.Get(ctx, targetKind, targetID)
	if err == nil {
		s.enrichFeature(ctx, &feat)
	}
	ok(c, gin.H{"maneuver_id": mid, "outage_id": outageID, "level": level, "closed_outages": closedOutages, "summary": report, "message": message,
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

// giStatus adalah rekap satu gardu induk (dari penyulang-penyulangnya).
type giStatus struct {
	ID             int64   `json:"id"`
	Code           string  `json:"code"`
	Name           string  `json:"name"`
	Energized      bool    `json:"energized"`
	State          string  `json:"state"` // on | partial | off
	TrafoGI        int     `json:"trafo_gi"`
	TrafoGIOff     int     `json:"trafo_gi_off"`
	Feeders        int     `json:"feeders"`
	FeedersPartial int     `json:"feeders_partial"`
	FeedersOff     int     `json:"feeders_off"`
	GD             int     `json:"gd"`
	GDOff          int     `json:"gd_off"`
	Customers      int     `json:"pelanggan"`
	CustomersOff   int     `json:"pelanggan_off"`
	LoadVA         float64 `json:"beban_va"`
	LoadOffVA      float64 `json:"beban_off_va"`
}

// GET /api/power/gi?state=all|on|partial|off&q=: daftar gardu induk beserta rekap penyulangnya
func (s *Server) powerGI(c *gin.Context) {
	ctx := c.Request.Context()
	_, feeders := s.d.Graph.PowerSummary()
	byID := map[int64]*giStatus{}
	list := []*giStatus{}
	rows, err := s.d.Pool.Query(ctx, `SELECT id, code, name, energized FROM gis_nodes WHERE type_code = 'gi' ORDER BY code, id`)
	if err != nil {
		handleErr(c, err)
		return
	}
	for rows.Next() {
		g := &giStatus{}
		if err := rows.Scan(&g.ID, &g.Code, &g.Name, &g.Energized); err != nil {
			rows.Close()
			handleErr(c, err)
			return
		}
		byID[g.ID] = g
		list = append(list, g)
	}
	rows.Close()
	// trafo GI per GI (dari penyulang yang dilayaninya)
	trafoOf := map[int64]int64{}
	for _, f := range feeders {
		g := byID[f.GI]
		if g == nil {
			continue
		}
		if f.TrafoGI != 0 {
			trafoOf[f.TrafoGI] = f.GI
		}
		g.Feeders++
		switch f.State {
		case "off":
			g.FeedersOff++
		case "partial":
			g.FeedersPartial++
		}
		g.GD += f.GD
		g.GDOff += f.GDOff
		g.Customers += f.Customers
		g.CustomersOff += f.CustomersOff
		g.LoadVA += f.LoadVA
		g.LoadOffVA += f.LoadOffVA
	}
	if len(trafoOf) > 0 {
		ids := make([]int64, 0, len(trafoOf))
		for id := range trafoOf {
			ids = append(ids, id)
		}
		tr, err := s.d.Pool.Query(ctx, `SELECT id, energized FROM gis_nodes WHERE id = ANY($1)`, ids)
		if err == nil {
			for tr.Next() {
				var id int64
				var on bool
				if tr.Scan(&id, &on) == nil {
					g := byID[trafoOf[id]]
					g.TrafoGI++
					if !on {
						g.TrafoGIOff++
					}
				}
			}
			tr.Close()
		}
	}
	state, q := c.Query("state"), strings.ToLower(strings.TrimSpace(c.Query("q")))
	out := make([]giStatus, 0, len(list))
	counts := map[string]int{"on": 0, "partial": 0, "off": 0}
	for _, g := range list {
		switch {
		case !g.Energized || (g.Feeders > 0 && g.FeedersOff >= g.Feeders):
			g.State = "off"
		case g.FeedersOff+g.FeedersPartial > 0 || g.TrafoGIOff > 0:
			g.State = "partial"
		default:
			g.State = "on"
		}
		counts[g.State]++
		if state != "" && state != "all" && g.State != state {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(g.Code), q) && !strings.Contains(strings.ToLower(g.Name), q) {
			continue
		}
		out = append(out, *g)
	}
	rank := map[string]int{"off": 0, "partial": 1, "on": 2}
	sort.SliceStable(out, func(i, j int) bool {
		if rank[out[i].State] != rank[out[j].State] {
			return rank[out[i].State] < rank[out[j].State]
		}
		return out[i].Code < out[j].Code
	})
	ok(c, gin.H{"items": out, "total": len(out), "counts": counts})
}

// customerRow adalah satu pelanggan pada daftar pelanggan nyala / padam.
type customerRow struct {
	ID         int64         `json:"id"`
	Code       string        `json:"code"`
	Name       string        `json:"name"`
	TypeCode   string        `json:"type_code"`
	Energized  bool          `json:"energized"`
	DayaVA     float64       `json:"daya_va"`
	KodeSSOT   string        `json:"kode_ssot"`
	Feeder     *gis.CodeName `json:"feeder"`
	GD         *gis.CodeName `json:"gd"`
	Route      *gis.CodeName `json:"route"`
	OutageID   *int64        `json:"outage_id"`
	OutageKind string        `json:"outage_kind,omitempty"`
	OffSince   *time.Time    `json:"off_since"`
}

// GET /api/power/customers?state=all|on|off&q=&limit=&offset=: daftar pelanggan (paging di server)
func (s *Server) powerCustomers(c *gin.Context) {
	ctx := c.Request.Context()
	sinks := []string{}
	for _, ct := range s.d.Types.List() {
		if ct.IsSink {
			sinks = append(sinks, ct.Code)
		}
	}
	limit, offset := queryInt(c, "limit", 100), queryInt(c, "offset", 0)
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	where, args := []string{"type_code = ANY($1)"}, []any{sinks}
	switch c.Query("state") {
	case "off":
		where = append(where, "NOT energized")
	case "on":
		where = append(where, "energized")
	}
	q := strings.TrimSpace(c.Query("q"))
	if q != "" {
		args = append(args, "%"+q+"%")
		// UNION agar tiap bagian memakai indeks trigramnya sendiri (OR memaksa pemindaian penuh)
		where = append(where, fmt.Sprintf(`id IN (SELECT id FROM gis_nodes WHERE code ILIKE $%[1]d
			UNION SELECT id FROM gis_nodes WHERE name ILIKE $%[1]d
			UNION SELECT id FROM gis_nodes WHERE properties ? 'kode_ssot' AND properties->>'kode_ssot' ILIKE $%[1]d)`, len(args)))
	}
	cond := strings.Join(where, " AND ")
	// jumlah: dari rekap graf bila tanpa pencarian (murah), selain itu dihitung dibatasi 10.000
	sum, _ := s.d.Graph.PowerSummary()
	total, capped := 0, false
	if q == "" {
		switch c.Query("state") {
		case "off":
			total = sum.Customers.Off
		case "on":
			total = sum.Customers.Total - sum.Customers.Off
		default:
			total = sum.Customers.Total
		}
	} else {
		if err := s.d.Pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM gis_nodes WHERE `+cond+` LIMIT 10001) x`, args...).Scan(&total); err != nil {
			handleErr(c, err)
			return
		}
		capped = total > 10000
	}
	args = append(args, limit, offset)
	rows, err := s.d.Pool.Query(ctx, `SELECT id, code, name, type_code, energized,
		COALESCE(NULLIF(properties->>'daya_va','')::float8, NULLIF(properties->>'daya_kva','')::float8 * 1000, 0),
		COALESCE(properties->>'kode_ssot','')
		FROM gis_nodes WHERE `+cond+fmt.Sprintf(` ORDER BY energized, code, id LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		handleErr(c, err)
		return
	}
	items := []customerRow{}
	for rows.Next() {
		var r customerRow
		if err := rows.Scan(&r.ID, &r.Code, &r.Name, &r.TypeCode, &r.Energized, &r.DayaVA, &r.KodeSSOT); err != nil {
			rows.Close()
			handleErr(c, err)
			return
		}
		items = append(items, r)
	}
	rows.Close()

	// penyulang, gardu, jurusan dari graf; kejadian padam aktif untuk pelanggan padam
	nodeIDs, edgeIDs := []int64{}, []int64{}
	infos := make([]gis.NodeInfo, len(items))
	offIDs := []int64{}
	for i, r := range items {
		infos[i] = s.d.Graph.NodeInfo(r.ID)
		if infos[i].Feeder != 0 {
			nodeIDs = append(nodeIDs, infos[i].Feeder)
		}
		if infos[i].GD != 0 {
			nodeIDs = append(nodeIDs, infos[i].GD)
		}
		if infos[i].Route != 0 {
			edgeIDs = append(edgeIDs, infos[i].Route)
		}
		if !r.Energized {
			offIDs = append(offIDs, r.ID)
		}
	}
	ncodes, _ := s.d.Power.NodeCodes(ctx, nodeIDs)
	ecodes, _ := s.d.Power.EdgeCodes(ctx, edgeIDs)
	type act struct {
		id    int64
		kind  string
		start time.Time
	}
	outageOf := map[int64]act{}
	if len(offIDs) > 0 {
		orows, err := s.d.Pool.Query(ctx, `SELECT o.id, o.kind, o.started_at, n FROM outages o, unnest(o.affected_nodes) n
			WHERE o.ended_at IS NULL AND n = ANY($1) ORDER BY o.started_at`, offIDs)
		if err == nil {
			for orows.Next() {
				var a act
				var n int64
				if orows.Scan(&a.id, &a.kind, &a.start, &n) == nil {
					if _, seen := outageOf[n]; !seen {
						outageOf[n] = a
					}
				}
			}
			orows.Close()
		}
	}
	for i := range items {
		if v, ok := ncodes[infos[i].Feeder]; ok {
			items[i].Feeder = &v
		}
		if v, ok := ncodes[infos[i].GD]; ok {
			items[i].GD = &v
		}
		if v, ok := ecodes[infos[i].Route]; ok {
			items[i].Route = &v
		}
		if a, ok := outageOf[items[i].ID]; ok {
			id, start := a.id, a.start
			items[i].OutageID, items[i].OutageKind, items[i].OffSince = &id, a.kind, &start
		}
	}
	ok(c, gin.H{"items": items, "total": total, "total_capped": capped, "offset": offset, "limit": limit,
		"counts": gin.H{"total": sum.Customers.Total, "off": sum.Customers.Off, "on": sum.Customers.Total - sum.Customers.Off}})
}

func (s *Server) reliabilityParams() gis.ReliabilityParams {
	return gis.ReliabilityParams{
		TariffRpPerKWh:   s.d.Configs.Float("reliability.tariff_rp_per_kwh", 1444.70),
		LoadFactor:       s.d.Configs.Float("reliability.load_factor", 0.6),
		PowerFactor:      s.d.Configs.Float("reliability.power_factor", 0.85),
		SustainedMinutes: s.d.Configs.Float("reliability.sustained_minutes", 5),
	}
}

// reliabilityPeriod membaca periode: period=today|month|year|30d atau from/to (RFC3339 / YYYY-MM-DD).
func reliabilityPeriod(c *gin.Context) (time.Time, time.Time, string) {
	loc := time.Now().Location()
	if tz, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		loc = tz
	}
	now := time.Now().In(loc)
	parse := func(v string) (time.Time, bool) {
		for _, f := range []string{time.RFC3339, "2006-01-02"} {
			if t, err := time.ParseInLocation(f, v, loc); err == nil {
				return t, true
			}
		}
		return time.Time{}, false
	}
	if f, ok1 := parse(c.Query("from")); ok1 {
		t, ok2 := parse(c.Query("to"))
		if !ok2 {
			t = now
		} else if len(c.Query("to")) == 10 {
			t = t.AddDate(0, 0, 1) // tanggal akhir inklusif
		}
		return f, t, "custom"
	}
	switch c.DefaultQuery("period", "month") {
	case "today":
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc), now, "today"
	case "year":
		return time.Date(now.Year(), 1, 1, 0, 0, 0, 0, loc), now, "year"
	case "30d":
		return now.AddDate(0, 0, -30), now, "30d"
	}
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc), now, "month"
}

// GET /api/power/outages?active=1 | period=... (riwayat periode), dikelompokkan per level
func (s *Server) powerOutages(c *gin.Context) {
	active := c.Query("active") == "1" || c.Query("active") == "true"
	rp := s.reliabilityParams()
	from, to, period := reliabilityPeriod(c)
	var items []gis.OutageRecord
	var err error
	if active {
		items, err = s.d.Power.ListOutages(c.Request.Context(), true, queryInt(c, "limit", 500))
		from, to = time.Time{}, time.Time{}
	} else {
		items, err = s.d.Power.ListOutagesBetween(c.Request.Context(), from, to, queryInt(c, "limit", 1000))
	}
	if err != nil {
		handleErr(c, err)
		return
	}
	sum, _ := s.d.Graph.PowerSummary()
	groups := map[string]*gis.ReliabilityGroup{}
	for i := range items {
		gis.ApplyReliability(&items[i], from, to, rp)
		g := groups[items[i].Level]
		if g == nil {
			g = &gis.ReliabilityGroup{}
			groups[items[i].Level] = g
		}
		g.Add(items[i])
	}
	for _, g := range groups {
		g.Finish(sum.Customers.Total)
	}
	ok(c, gin.H{"items": items, "groups": groups, "levels": OutageLevels, "period": period, "from": from, "to": to})
}

// GET /api/power/reliability?period=today|month|year|30d (atau from, to): SAIDI, SAIFI, ENS
func (s *Server) powerReliability(c *gin.Context) {
	rp := s.reliabilityParams()
	from, to, period := reliabilityPeriod(c)
	items, err := s.d.Power.ListOutagesBetween(c.Request.Context(), from, to, 5000)
	if err != nil {
		handleErr(c, err)
		return
	}
	sum, _ := s.d.Graph.PowerSummary()
	total := &gis.ReliabilityGroup{}
	byLevel := map[string]*gis.ReliabilityGroup{}
	byKind := map[string]*gis.ReliabilityGroup{}
	active := 0
	for i := range items {
		o := &items[i]
		gis.ApplyReliability(o, from, to, rp)
		total.Add(*o)
		for _, m := range []struct {
			mp  map[string]*gis.ReliabilityGroup
			key string
		}{{byLevel, o.Level}, {byKind, o.Kind}} {
			g := m.mp[m.key]
			if g == nil {
				g = &gis.ReliabilityGroup{}
				m.mp[m.key] = g
			}
			g.Add(*o)
		}
		if o.EndedAt == nil {
			active++
		}
	}
	total.Finish(sum.Customers.Total)
	for _, g := range byLevel {
		g.Finish(sum.Customers.Total)
	}
	for _, g := range byKind {
		g.Finish(sum.Customers.Total)
	}
	ok(c, gin.H{"period": period, "from": from, "to": to, "customers_served": sum.Customers.Total, "params": rp,
		"total": total, "by_level": byLevel, "by_kind": byKind, "levels": OutageLevels, "active": active})
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

// recordSOE menyimpan event SOE lalu menyiarkannya (WebSocket & Kafka).
func (s *Server) recordSOE(ctx context.Context, e *gis.SOEEvent) {
	if err := s.d.Power.InsertSOE(ctx, e); err != nil {
		log.Printf("[soe] simpan gagal: %v", err)
		return
	}
	data, _ := json.Marshal(e)
	ev := stream.Event{Type: "soe", Kind: e.TargetKind, TypeCode: e.TargetType, Username: e.Username, At: e.TS, Data: data}
	if e.TargetID != nil {
		ev.ID = *e.TargetID
	}
	s.d.Hub.Publish(ev)
	s.d.Producer.Publish(ev)
}

// GET /api/power/soe?limit&before_id&after_id&category&severity&kind&q&from&to&target_kind&target_id
func (s *Server) powerSOE(c *gin.Context) {
	f := gis.SOEFilter{
		BeforeID: int64(queryInt(c, "before_id", 0)), AfterID: int64(queryInt(c, "after_id", 0)),
		Category: c.Query("category"), Severity: c.Query("severity"), Kind: strings.ToUpper(c.Query("kind")), Q: c.Query("q"),
		TargetKind: c.Query("target_kind"), TargetID: int64(queryInt(c, "target_id", 0)), Limit: queryInt(c, "limit", 300),
	}
	for _, p := range []struct {
		key string
		dst *time.Time
	}{{"from", &f.From}, {"to", &f.To}} {
		if v := c.Query(p.key); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				failT(c, http.StatusBadRequest, "common.bad_payload")
				return
			}
			*p.dst = t
		}
	}
	items, err := s.d.Power.ListSOE(c.Request.Context(), f)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
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
