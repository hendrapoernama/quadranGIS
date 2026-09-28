package api

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
)

// ---------------------------------------------------------------- master data unit

// GET /api/units
func (s *Server) unitsList(c *gin.Context) {
	items, err := s.d.Units.List(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items, "levels": gis.UnitLevel, "asset_levels": gis.AssetUnitLevel,
		"default_code": s.d.Configs.Str("unit.default_code", "UID-JAKARTA-RAYA")})
}

// POST /api/units, PUT /api/units/:id
func (s *Server) unitsSave(c *gin.Context) {
	var u gis.Unit
	if err := c.ShouldBindJSON(&u); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if v := c.Param("id"); v != "" {
		id, err := strconv.Atoi(v)
		if err != nil {
			failT(c, http.StatusBadRequest, "common.invalid_id")
			return
		}
		u.ID = id
	} else {
		u.ID = 0
	}
	p := s.person(c)
	id, err := s.d.Units.Save(c.Request.Context(), u, p.FullNameOr(), string(p.Lang))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.d.Audit.Log(&p.UserID, p.Username, "unit.save", "unit", strconv.Itoa(id), gin.H{"code": u.Code, "name": u.Name, "kind": u.Kind, "parent": u.ParentID}, clientIP(c))
	s.afterUnitsChanged()
	ok(c, gin.H{"id": id})
}

// DELETE /api/units/:id
func (s *Server) unitsDelete(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	p := s.person(c)
	if err := s.d.Units.Delete(c.Request.Context(), id, string(p.Lang)); err != nil {
		handleErr(c, err)
		return
	}
	s.d.Audit.Log(&p.UserID, p.Username, "unit.delete", "unit", strconv.Itoa(id), nil, clientIP(c))
	s.afterUnitsChanged()
	ok(c, gin.H{"ok": true})
}

// afterUnitsChanged: hierarki titik ukur pembebanan mengikuti unit pemilik aset.
func (s *Server) afterUnitsChanged() {
	if s.d.Load == nil {
		return
	}
	s.d.Load.mu.Lock()
	s.d.Load.lastSync = s.d.Load.lastSync.AddDate(-1, 0, 0) // sinkron ulang pada putaran berikutnya
	s.d.Load.mu.Unlock()
}

// GET /api/units/owner?kind=node|edge&id= — pemilik efektif aset (ditetapkan / otomatis dari lokasi)
func (s *Server) unitsOwner(c *gin.Context) {
	id, err := strconv.ParseInt(c.Query("id"), 10, 64)
	if err != nil || id <= 0 {
		ok(c, gis.Owner{})
		return
	}
	o, err := s.d.Units.OwnerOf(c.Request.Context(), c.DefaultQuery("kind", "node"), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, o)
}

// POST /api/units/auto-assign {apply, overwrite, import_tag} — tetapkan pemilik aset dari lokasi (pratinjau bila apply=false)
func (s *Server) unitsAutoAssign(c *gin.Context) {
	var req struct {
		Apply     bool   `json:"apply"`
		Overwrite bool   `json:"overwrite"`
		ImportTag string `json:"import_tag"`
	}
	_ = c.ShouldBindJSON(&req)
	res, err := s.d.Units.AutoAssign(c.Request.Context(), req.Apply, req.Overwrite, req.ImportTag)
	if err != nil {
		handleErr(c, err)
		return
	}
	if req.Apply {
		p := s.person(c)
		s.d.Audit.Log(&p.UserID, p.Username, "unit.auto_assign", "unit", "", gin.H{"total": res.Total, "overwrite": req.Overwrite, "import_tag": req.ImportTag}, clientIP(c))
		s.afterUnitsChanged()
	}
	ok(c, res)
}

// GET /api/units/:id/assets?type=&limit= — aset milik unit
func (s *Server) unitsAssets(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	rows, err := s.d.Pool.Query(c.Request.Context(), `SELECT id, type_code, code, name, ST_X(geom), ST_Y(geom) FROM gis_nodes
		WHERE unit_id = $1 AND ($2 = '' OR type_code = $2) ORDER BY type_code, code LIMIT $3`, id, c.Query("type"), queryInt(c, "limit", 300))
	if err != nil {
		handleErr(c, err)
		return
	}
	defer rows.Close()
	type asset struct {
		ID       int64   `json:"id"`
		TypeCode string  `json:"type_code"`
		Code     string  `json:"code"`
		Name     string  `json:"name"`
		Lng      float64 `json:"lng"`
		Lat      float64 `json:"lat"`
	}
	out := []asset{}
	for rows.Next() {
		var a asset
		if rows.Scan(&a.ID, &a.TypeCode, &a.Code, &a.Name, &a.Lng, &a.Lat) == nil {
			out = append(out, a)
		}
	}
	ok(c, gin.H{"items": out})
}

// ---------------------------------------------------------------- identitas aplikasi (branding)

const maxLogoBytes = 512 << 10

var logoTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/svg+xml": true, "image/webp": true}

// GET /api/branding (tanpa login) — nama, deskripsi, versi logo
func (s *Server) branding(c *gin.Context) {
	c.Header("Cache-Control", "no-cache")
	ok(c, gin.H{"name": s.d.Configs.Str("app.name", "QuadranGIS"), "description": s.d.Configs.Str("app.description", "GIS Kelistrikan"),
		"has_logo": strings.HasPrefix(s.d.Configs.Str("app.logo", ""), "data:"), "logo_version": s.d.Configs.Int("app.logo_version", 0)})
}

// GET /api/branding/logo (tanpa login)
func (s *Server) brandingLogo(c *gin.Context) {
	mime, data, okLogo := decodeDataURL(s.d.Configs.Str("app.logo", ""))
	if !okLogo {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "public, max-age=86400")
	c.Header("X-Content-Type-Options", "nosniff")
	// SVG tidak boleh menjalankan skrip bila dibuka langsung
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	c.Data(http.StatusOK, mime, data)
}

func decodeDataURL(v string) (string, []byte, bool) {
	if !strings.HasPrefix(v, "data:") {
		return "", nil, false
	}
	head, b64, found := strings.Cut(v[5:], ",")
	if !found || !strings.HasSuffix(head, ";base64") {
		return "", nil, false
	}
	mime := strings.TrimSuffix(head, ";base64")
	if !logoTypes[mime] {
		return "", nil, false
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", nil, false
	}
	return mime, data, true
}

// PUT /api/admin/branding {name, description, logo} — logo: data URL baru, "" = tidak diubah, "-" = hapus
func (s *Server) brandingSave(c *gin.Context) {
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Logo        string `json:"logo"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	req.Name, req.Description = strings.TrimSpace(req.Name), strings.TrimSpace(req.Description)
	lang := middleware.GetLang(c)
	if req.Name == "" || len([]rune(req.Name)) > 60 || len([]rune(req.Description)) > 120 {
		fail(c, http.StatusBadRequest, map[bool]string{true: "Nama aplikasi wajib (maks. 60 karakter); deskripsi maks. 120 karakter.", false: "App name is required (max 60 characters); description max 120 characters."}[lang != "en"])
		return
	}
	items := []models.Config{{Key: "app.name", Value: req.Name}, {Key: "app.description", Value: req.Description}}
	switch req.Logo {
	case "":
	case "-":
		items = append(items, models.Config{Key: "app.logo", Value: ""}, models.Config{Key: "app.logo_version", Value: strconv.Itoa(s.d.Configs.Int("app.logo_version", 0) + 1)})
	default:
		_, data, okLogo := decodeDataURL(req.Logo)
		if !okLogo || len(data) == 0 || len(data) > maxLogoBytes {
			fail(c, http.StatusBadRequest, map[bool]string{true: "Logo harus PNG, JPEG, SVG, atau WebP berukuran maks. 512 KB.", false: "The logo must be PNG, JPEG, SVG, or WebP, max 512 KB."}[lang != "en"])
			return
		}
		items = append(items, models.Config{Key: "app.logo", Value: req.Logo}, models.Config{Key: "app.logo_version", Value: strconv.Itoa(s.d.Configs.Int("app.logo_version", 0) + 1)})
	}
	if err := s.d.Configs.UpsertMany(c.Request.Context(), items); err != nil {
		handleErr(c, err)
		return
	}
	p := s.person(c)
	s.d.Audit.Log(&p.UserID, p.Username, "config.branding", "config", "app", gin.H{"name": req.Name, "logo_changed": req.Logo != ""}, clientIP(c))
	s.branding(c)
}
