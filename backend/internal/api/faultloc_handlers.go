package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
)

// ---------------------------------------------------------------- estimasi lokasi gangguan (arus relai)

// faultParamsDefault: parameter bawaan dari konfigurasi; daya hubung singkat & NGR dapat diisi per
// trafo GI (atribut daya_hs_mva, ngr_ohm) atau per GI.
func (s *Server) faultParamsDefault() gis.FaultLocParams {
	c := s.d.Configs
	return gis.FaultLocParams{
		SourceMVA: c.Float("fault.source_mva", 500), SourceXR: c.Float("fault.source_xr", 10), KV: c.Float("fault.kv", 20),
		NGROhm: c.Float("fault.ngr_ohm", 40), FaultOhm: c.Float("fault.fault_ohm", 0), Z0Ratio: c.Float("fault.z0_ratio", 3),
		TolPct: c.Float("fault.tol_pct", 10),
	}
}

// GET /api/ops/fault-locate/defaults?device_id= — parameter bawaan untuk alat (sumber dari trafo GI / GI bila ada)
func (s *Server) opsFaultDefaults(c *gin.Context) {
	p := s.faultParamsDefault()
	id, _ := strconv.ParseInt(c.Query("device_id"), 10, 64)
	src := s.faultSourceParams(c, id, &p)
	ok(c, gin.H{"params": p, "source": src})
}

// faultSourceParams mengisi daya hubung singkat & NGR dari atribut trafo GI / GI penyulang alat.
func (s *Server) faultSourceParams(c *gin.Context, deviceID int64, p *gis.FaultLocParams) gin.H {
	src := gin.H{"from": "config"}
	if deviceID <= 0 {
		return src
	}
	info := s.d.Graph.NodeInfo(deviceID)
	fi, okF := s.d.Graph.FeederOf(info.Feeder)
	if !okF {
		return src
	}
	for _, id := range []int64{fi.TrafoGI, fi.GI} {
		if id == 0 {
			continue
		}
		var mva, ngr *float64
		var code string
		if err := s.d.Pool.QueryRow(c.Request.Context(), `SELECT code, qgis_num(properties->>'daya_hs_mva'), qgis_num(properties->>'ngr_ohm') FROM gis_nodes WHERE id=$1`, id).
			Scan(&code, &mva, &ngr); err != nil {
			continue
		}
		used := false
		if mva != nil && *mva > 0 {
			p.SourceMVA, used = *mva, true
		}
		if ngr != nil && *ngr >= 0 {
			p.NGROhm, used = *ngr, true
		}
		if used {
			src = gin.H{"from": "asset", "id": id, "code": code}
			break
		}
	}
	return src
}

// POST /api/ops/fault-locate — estimasi lokasi gangguan dari arus gangguan relai
func (s *Server) opsFaultLocate(c *gin.Context) {
	ctx := c.Request.Context()
	p := s.faultParamsDefault()
	var req gis.FaultLocParams
	if err := c.ShouldBindJSON(&req); err != nil || req.DeviceID <= 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	src := s.faultSourceParams(c, req.DeviceID, &p)
	// nilai dari operator menimpa bawaan
	p.DeviceID, p.FaultType, p.CurrentA, p.Ia, p.Ib, p.Ic, p.In = req.DeviceID, req.FaultType, req.CurrentA, req.Ia, req.Ib, req.Ic, req.In
	if req.SourceMVA > 0 {
		p.SourceMVA = req.SourceMVA
	}
	if req.SourceXR > 0 {
		p.SourceXR = req.SourceXR
	}
	if req.NGROhm > 0 {
		p.NGROhm = req.NGROhm
	}
	if req.FaultOhm > 0 {
		p.FaultOhm = req.FaultOhm
	}
	if req.Z0Ratio > 0 {
		p.Z0Ratio = req.Z0Ratio
	}
	if req.TolPct > 0 {
		p.TolPct = req.TolPct
	}
	lines, ov, err := s.d.PowerFlow.LineModel(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	res, err := s.d.Graph.FaultLocate(p, lines, ov)
	switch {
	case errors.Is(err, gis.ErrFaultCurrent):
		fail(c, http.StatusBadRequest, pick(c, "Isi arus gangguan (A) atau arus per fasa.", "Enter the fault current (A) or the per-phase currents."))
		return
	case errors.Is(err, gis.ErrFaultDevice):
		failT(c, http.StatusNotFound, "common.not_found")
		return
	case err != nil:
		s.simErr(c, err)
		return
	}

	// lokasi titik kandidat & geometri saluran dalam toleransi
	type pt struct {
		Lng float64 `json:"lng"`
		Lat float64 `json:"lat"`
	}
	points := make([]pt, len(res.Candidates))
	features := []map[string]any{}
	for i, cd := range res.Candidates {
		var gj string
		if err := s.d.Pool.QueryRow(ctx, `SELECT ST_X(q), ST_Y(q), ST_AsGeoJSON(q) FROM (SELECT ST_LineInterpolatePoint(geom, $2) q FROM gis_edges WHERE id=$1) x`,
			cd.EdgeID, cd.Frac).Scan(&points[i].Lng, &points[i].Lat, &gj); err != nil {
			continue
		}
		features = append(features, map[string]any{"type": "Feature", "geometry": rawJSON(gj),
			"properties": map[string]any{"kind": "node", "color": "#dc2626", "big": true, "rank": i + 1}})
	}
	if len(res.BandEdges) > 0 {
		rows, err := s.d.Pool.Query(ctx, `SELECT id, ST_AsGeoJSON(geom) FROM gis_edges WHERE id = ANY($1)`, res.BandEdges)
		if err == nil {
			for rows.Next() {
				var id int64
				var gj string
				if rows.Scan(&id, &gj) == nil {
					features = append(features, map[string]any{"type": "Feature", "id": id, "geometry": rawJSON(gj),
						"properties": map[string]any{"kind": "edge", "color": "#f59e0b"}})
				}
			}
			rows.Close()
		}
	}
	var dgj string
	if s.d.Pool.QueryRow(ctx, `SELECT ST_AsGeoJSON(geom) FROM gis_nodes WHERE id=$1`, p.DeviceID).Scan(&dgj) == nil {
		features = append(features, map[string]any{"type": "Feature", "geometry": rawJSON(dgj),
			"properties": map[string]any{"kind": "node", "color": "#2563eb", "big": true}})
	}

	refs := []int64{p.DeviceID}
	edgeIDs := []int64{}
	for _, cd := range res.Candidates {
		refs = append(refs, cd.Zone, cd.GD, cd.FromNode, cd.ToNode)
		edgeIDs = append(edgeIDs, cd.EdgeID)
	}
	edgeCodes, _ := s.d.Power.EdgeCodes(ctx, edgeIDs)
	s.auditOps(c, "fault.locate", strconv.FormatInt(p.DeviceID, 10), gin.H{"type": res.FaultType, "current_a": res.MeasuredA, "candidates": len(res.Candidates)})
	ok(c, gin.H{"result": res, "points": points, "codes": s.codesFor(ctx, refs), "edge_codes": edgeCodes, "source": src,
		"geojson": map[string]any{"type": "FeatureCollection", "features": features}})
}

func rawJSON(s string) json.RawMessage { return json.RawMessage(s) }
