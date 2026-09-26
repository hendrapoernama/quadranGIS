package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
)

type exportReq struct {
	gis.ExportSelection
	Format string `json:"format"` // geojson | gdb
	Dry    bool   `json:"dry"`    // hanya hitung ukuran
}

// POST /api/exchange/export: {format, dry, bbox|polygon, types, energized}
func (s *Server) exchangeExport(c *gin.Context) {
	var req exportReq
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	ctx := c.Request.Context()
	var (
		data []byte
		st   gis.ExportStats
		err  error
	)
	switch req.Format {
	case "gdb":
		data, st, err = s.d.Features.ExportGDB(ctx, req.ExportSelection, req.Dry)
	case "", "geojson":
		req.Format = "geojson"
		data, st, err = s.d.Features.ExportGeoJSON(ctx, req.ExportSelection, req.Dry)
	default:
		failT(c, http.StatusBadRequest, "xchg.format_invalid")
		return
	}
	switch {
	case errors.Is(err, gis.ErrSelectionRequired):
		failT(c, http.StatusBadRequest, "xchg.selection_required")
		return
	case errors.Is(err, gis.ErrExportTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": tr(c, "xchg.too_large", gis.ExportMaxBytes>>20, st.Features), "stats": st})
		return
	case err != nil:
		handleErr(c, err)
		return
	}
	if req.Dry {
		ok(c, gin.H{"stats": st, "format": req.Format})
		return
	}
	cl := middleware.GetClaims(c)
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "export."+req.Format, "gis", "", gin.H{"features": st.Features, "bytes": st.Bytes, "types": req.Types}, clientIP(c))
	}
	stamp := time.Now().Format("20060102-150405")
	name, ctype := "quadrangis-"+stamp+".geojson", "application/geo+json"
	if req.Format == "gdb" {
		name, ctype = "quadrangis-"+stamp+".gdb.zip", "application/zip"
	}
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	c.Header("X-Export-Features", strconv.Itoa(st.Features))
	c.Header("Access-Control-Expose-Headers", "Content-Disposition, X-Export-Features")
	c.Data(http.StatusOK, ctype, data)
}

// POST /api/exchange/import?apply=0|1  (badan: GeoJSON FeatureCollection, maks. 10 MB)
func (s *Server) exchangeImport(c *gin.Context) {
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, gis.ExportMaxBytes+1))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if len(raw) > gis.ExportMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": tr(c, "xchg.file_too_large", gis.ExportMaxBytes>>20)})
		return
	}
	apply := c.Query("apply") == "1" || c.Query("apply") == "true"
	actor := actorFrom(c)
	rep, err := s.d.Features.ImportGeoJSON(c.Request.Context(), raw, apply, actor)
	if err != nil {
		handleErr(c, err)
		return
	}
	if apply && len(rep.Results) > 0 {
		// satu efek samping gabungan: invalidasi tile, sinkron graf, siaran realtime, audit
		agg := &gis.EditResult{Action: "import", Kind: "node", TouchedNodes: []int64{}, TouchedEdges: []int64{}, Messages: []string{}}
		first := true
		for _, r := range rep.Results {
			agg.TouchedNodes = append(agg.TouchedNodes, r.TouchedNodes...)
			agg.TouchedEdges = append(agg.TouchedEdges, r.TouchedEdges...)
			if first {
				agg.BBox, first = r.BBox, false
				continue
			}
			agg.BBox[0], agg.BBox[1] = minf(agg.BBox[0], r.BBox[0]), minf(agg.BBox[1], r.BBox[1])
			agg.BBox[2], agg.BBox[3] = maxf(agg.BBox[2], r.BBox[2]), maxf(agg.BBox[3], r.BBox[3])
		}
		s.afterEdit(c, agg)
	}
	ok(c, rep)
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
