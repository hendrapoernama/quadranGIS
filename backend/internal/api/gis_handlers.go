package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/stream"
)

func actorFrom(c *gin.Context) gis.Actor {
	a := gis.Actor{Lang: middleware.GetLang(c)}
	if cl := middleware.GetClaims(c); cl != nil {
		uid := cl.UserID
		a.UserID = &uid
		a.Username = cl.Username
	}
	return a
}

// GET /api/gis/types
func (s *Server) gisTypes(c *gin.Context) {
	ok(c, gin.H{"items": s.d.Types.List(), "tile_version": s.d.Tiles.Version(c.Request.Context())})
}

// GET /api/gis/tiles/:z/:x/:y
func (s *Server) gisTile(c *gin.Context) {
	z, err1 := strconv.Atoi(c.Param("z"))
	x, err2 := strconv.Atoi(c.Param("x"))
	yRaw := strings.TrimSuffix(strings.TrimSuffix(c.Param("y"), ".pbf"), ".mvt")
	y, err3 := strconv.Atoi(yRaw)
	if err1 != nil || err2 != nil || err3 != nil {
		failT(c, http.StatusBadRequest, "gis.tile_invalid")
		return
	}
	b, err := s.d.Tiles.Get(c.Request.Context(), z, x, y)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(c.Request.Context().Err(), context.Canceled) {
			// klien membatalkan (menggeser/zoom peta); bukan kesalahan server
			c.AbortWithStatus(499)
			return
		}
		if strings.Contains(err.Error(), "tidak valid") {
			failT(c, http.StatusBadRequest, "gis.tile_invalid")
			return
		}
		handleErr(c, err)
		return
	}
	c.Header("Cache-Control", "private, max-age=20")
	if len(b) == 0 {
		c.Status(http.StatusNoContent)
		return
	}
	c.Data(http.StatusOK, "application/x-protobuf", b)
}

// GET /api/gis/features/:kind/:id
func (s *Server) gisGetFeature(c *gin.Context) {
	if !validKind(c) {
		return
	}
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	ft, err := s.d.Features.Get(c.Request.Context(), c.Param("kind"), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	s.enrichFeature(c.Request.Context(), &ft)
	ok(c, ft)
}

// GET /api/gis/features/:kind/:id/history
func (s *Server) gisFeatureHistory(c *gin.Context) {
	if !validKind(c) {
		return
	}
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	items, err := s.d.Features.History(c.Request.Context(), c.Param("kind"), id, queryInt(c, "limit", 50))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/gis/nodes/:id/neighbors
func (s *Server) gisNeighbors(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	items, err := s.d.Features.Neighbors(c.Request.Context(), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// afterEdit menjalankan efek samping setelah perubahan: invalidasi tile, sinkronisasi graf,
// event Kafka, siaran realtime, dan audit.
func (s *Server) afterEdit(c *gin.Context, res *gis.EditResult) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	version := s.d.Tiles.Invalidate(ctx, res.BBox)
	if err := s.d.Graph.Refresh(ctx, s.d.Pool, res.TouchedNodes, res.TouchedEdges); err != nil {
		log.Printf("[graph] refresh gagal: %v", err)
	}
	cl := middleware.GetClaims(c)
	ev := stream.Event{
		Type:     "feature." + res.Action,
		Kind:     res.Kind,
		ID:       res.ID,
		BBox:     res.BBox[:],
		Affected: append(append([]int64{}, res.TouchedNodes...), res.TouchedEdges...),
		Version:  version,
		At:       time.Now(),
	}
	if res.Feature != nil {
		if tc, ok := res.Feature.Properties["type_code"].(string); ok {
			ev.TypeCode = tc
		}
	}
	if cl != nil {
		ev.UserID, ev.Username = cl.UserID, cl.Username
	}
	data, _ := json.Marshal(gin.H{"touched_nodes": res.TouchedNodes, "touched_edges": res.TouchedEdges, "messages": res.Messages})
	ev.Data = data
	s.d.Producer.Publish(ev)
	s.d.Hub.Publish(ev)
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "feature."+res.Action, res.Kind, strconv.FormatInt(res.ID, 10),
			gin.H{"touched_nodes": len(res.TouchedNodes), "touched_edges": len(res.TouchedEdges)}, clientIP(c))
	}
	// fitur hasil edit dilengkapi status graf (energisasi, penyulang, zona, jurusan)
	if res.Feature != nil {
		s.enrichFeature(ctx, res.Feature)
	}
}

// POST /api/gis/features
func (s *Server) gisCreateFeature(c *gin.Context) {
	var in gis.FeatureInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, tr(c, "common.bad_payload")+": "+err.Error())
		return
	}
	res, err := s.d.Features.Create(c.Request.Context(), in, actorFrom(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.afterEdit(c, res)
	if res.Feature != nil {
		res.Feature.Properties["tile_version"] = s.d.Tiles.Version(c.Request.Context())
	}
	c.JSON(http.StatusCreated, res)
}

// PUT /api/gis/features/:kind/:id
func (s *Server) gisUpdateFeature(c *gin.Context) {
	if !validKind(c) {
		return
	}
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var in gis.FeatureInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, tr(c, "common.bad_payload")+": "+err.Error())
		return
	}
	res, err := s.d.Features.Update(c.Request.Context(), c.Param("kind"), id, in, actorFrom(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.afterEdit(c, res)
	ok(c, res)
}

// DELETE /api/gis/features/:kind/:id
func (s *Server) gisDeleteFeature(c *gin.Context) {
	if !validKind(c) {
		return
	}
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	res, err := s.d.Features.Delete(c.Request.Context(), c.Param("kind"), id, actorFrom(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.afterEdit(c, res)
	ok(c, res)
}

// POST /api/gis/edges/:id/split  {lng, lat}
func (s *Server) gisSplitEdge(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var req struct {
		Lng *float64 `json:"lng"`
		Lat *float64 `json:"lat"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Lng == nil || req.Lat == nil {
		failT(c, http.StatusBadRequest, "gis.split_point")
		return
	}
	res, err := s.d.Features.SplitEdge(c.Request.Context(), id, *req.Lng, *req.Lat, actorFrom(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.afterEdit(c, res)
	ok(c, res)
}

// POST /api/gis/nodes/:id/merge  (gabungkan dua garis pada junction)
func (s *Server) gisMergeAtJunction(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	res, err := s.d.Features.MergeAtJunction(c.Request.Context(), id, actorFrom(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.afterEdit(c, res)
	ok(c, res)
}

// GET /api/gis/features/bbox?bbox=minx,miny,maxx,maxy&types=a,b&limit=n
func (s *Server) gisBBox(c *gin.Context) {
	parts := strings.Split(c.Query("bbox"), ",")
	if len(parts) != 4 {
		failT(c, http.StatusBadRequest, "gis.bbox_format")
		return
	}
	var bbox [4]float64
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			failT(c, http.StatusBadRequest, "gis.bbox_invalid")
			return
		}
		bbox[i] = v
	}
	var types []string
	if t := strings.TrimSpace(c.Query("types")); t != "" {
		types = strings.Split(t, ",")
	}
	fc, err := s.d.Features.BBox(c.Request.Context(), bbox, types, queryInt(c, "limit", 0))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, fc)
}

// GET /api/gis/snap?lng=&lat=&radius_m=
func (s *Server) gisSnap(c *gin.Context) {
	lng, lat := queryFloat(c, "lng", 999), queryFloat(c, "lat", 999)
	if lng == 999 || lat == 999 {
		failT(c, http.StatusBadRequest, "gis.lnglat_required")
		return
	}
	items, err := s.d.Features.Snap(c.Request.Context(), lng, lat, queryFloat(c, "radius_m", 0))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/gis/search?q=
func (s *Server) gisSearch(c *gin.Context) {
	items, err := s.d.Features.Search(c.Request.Context(), c.Query("q"), queryInt(c, "limit", 20))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/gis/stats
func (s *Server) gisStats(c *gin.Context) {
	items, err := s.d.Features.Stats(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items, "graph": s.d.Graph.Status()})
}

// GET /api/gis/topology/status
func (s *Server) topologyStatus(c *gin.Context) { ok(c, s.d.Graph.Status()) }

// POST /api/gis/topology/rebuild
func (s *Server) topologyRebuild(c *gin.Context) {
	go func() {
		if err := s.d.Graph.Load(context.Background(), s.d.Pool); err != nil {
			log.Printf("[graph] muat ulang gagal: %v", err)
			return
		}
		s.d.Hub.Publish(stream.Event{Type: "topology.rebuilt", At: time.Now()})
	}()
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "topology.rebuild", "graph", "", nil, clientIP(c))
	c.JSON(http.StatusAccepted, gin.H{"ok": true, "message": tr(c, "admin.graph_reloading")})
}

// GET /api/gis/topology/validate
func (s *Server) topologyValidate(c *gin.Context) {
	issues, summary := s.d.Graph.Validate(queryInt(c, "limit", 200), middleware.GetLang(c))
	ok(c, gin.H{"items": issues, "summary": summary})
}

// POST /api/gis/trace
func (s *Server) gisTrace(c *gin.Context) {
	var req gis.TraceRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.NodeID <= 0 {
		failT(c, http.StatusBadRequest, "gis.node_id_required")
		return
	}
	switch req.Direction {
	case "down", "up", "connected":
	case "":
		req.Direction = "down"
	default:
		failT(c, http.StatusBadRequest, "gis.direction_invalid")
		return
	}
	req.Lang = middleware.GetLang(c)
	maxDepth := s.d.Configs.Int("trace.max_depth", 5000)
	if req.MaxDepth <= 0 || req.MaxDepth > maxDepth {
		req.MaxDepth = maxDepth
	}
	res := s.d.Graph.Trace(req)
	limit := s.d.Configs.Int("trace.max_result_features", 5000)
	fc, err := s.d.Features.ByIDs(c.Request.Context(), res.Nodes, res.Edges, limit)
	if err != nil {
		handleErr(c, err)
		return
	}
	lengthByType, _ := s.d.Features.LengthByType(c.Request.Context(), res.Edges)
	total := 0.0
	for _, v := range lengthByType {
		total += v
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "trace."+req.Direction, "node", strconv.FormatInt(req.NodeID, 10),
		gin.H{"nodes": len(res.Nodes), "edges": len(res.Edges), "duration_ms": res.DurationMS}, clientIP(c))
	ok(c, gin.H{"result": res, "geojson": fc, "length_by_type": lengthByType, "total_length_m": total})
}
