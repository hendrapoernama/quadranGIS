package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
)

// POST /api/sld/build {scope, id, level, polygon?}: susun diagram satu garis
func (s *Server) sldBuild(c *gin.Context) {
	var req gis.SLDRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	req.Scope = strings.ToLower(strings.TrimSpace(req.Scope))
	if req.Scope == "" {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	d, err := s.d.SLD.Build(c.Request.Context(), req)
	switch {
	case errors.Is(err, gis.ErrGraphLoading):
		failT(c, http.StatusServiceUnavailable, "sld.graph_loading")
		return
	case errors.Is(err, gis.ErrNotFound):
		failT(c, http.StatusNotFound, "common.not_found")
		return
	case errors.Is(err, gis.ErrBadRequest), errors.Is(err, gis.ErrSLDScope):
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	case err != nil:
		handleErr(c, err)
		return
	}
	pos, _ := s.d.SLD.Positions(c.Request.Context(), d.ScopeKey)
	ok(c, gin.H{"diagram": d, "positions": pos})
}

// GET /api/sld/resolve?kind=node|edge&id=: cakupan bawaan untuk sebuah objek
func (s *Server) sldResolve(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Query("id"), 10, 64)
	kind := c.DefaultQuery("kind", "node")
	if id <= 0 || (kind != "node" && kind != "edge") {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	req, found := s.d.SLD.Resolve(kind, id)
	if !found {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	ok(c, req)
}

// GET /api/sld/positions?scope=
func (s *Server) sldPositions(c *gin.Context) {
	pos, err := s.d.SLD.Positions(c.Request.Context(), c.Query("scope"))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"positions": pos})
}

// PUT /api/sld/positions {scope, positions:{id:{dx,dy}}} (izin gis.edit)
func (s *Server) sldSavePositions(c *gin.Context) {
	var req struct {
		Scope     string               `json:"scope"`
		Positions map[int64]gis.SLDPos `json:"positions"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Scope == "" {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	cl := middleware.GetClaims(c)
	var uid *string
	if cl != nil {
		u := cl.UserID
		uid = &u
	}
	if err := s.d.SLD.SavePositions(c.Request.Context(), req.Scope, req.Positions, uid); err != nil {
		handleErr(c, err)
		return
	}
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "sld.positions", "sld", req.Scope, gin.H{"n": len(req.Positions)}, clientIP(c))
	}
	ok(c, gin.H{"saved": len(req.Positions)})
}

// DELETE /api/sld/positions?scope= (izin gis.edit)
func (s *Server) sldResetPositions(c *gin.Context) {
	scope := c.Query("scope")
	if scope == "" {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if err := s.d.SLD.ResetPositions(c.Request.Context(), scope); err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"reset": true})
}
