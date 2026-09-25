package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/auth"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
)

// ------------------------- Users -------------------------

type userPayload struct {
	Username string  `json:"username"`
	Email    string  `json:"email"`
	FullName string  `json:"full_name"`
	Password string  `json:"password"`
	RoleID   *string `json:"role_id"`
	IsActive *bool   `json:"is_active"`
}

func (s *Server) listUsers(c *gin.Context) {
	users, total, err := s.d.Users.List(c.Request.Context(), c.Query("q"), queryInt(c, "page", 1), queryInt(c, "size", 25))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": users, "total": total})
}

func (s *Server) createUser(c *gin.Context) {
	var p userPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if strings.TrimSpace(p.Username) == "" {
		failT(c, http.StatusBadRequest, "admin.username_required")
		return
	}
	if err := auth.ValidatePassword(middleware.GetLang(c), p.Password); err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(p.Password)
	if err != nil {
		handleErr(c, err)
		return
	}
	active := true
	if p.IsActive != nil {
		active = *p.IsActive
	}
	if p.RoleID != nil && *p.RoleID == "" {
		p.RoleID = nil
	}
	u, err := s.d.Users.Create(c.Request.Context(), models.User{Username: p.Username, Email: p.Email, FullName: p.FullName, PasswordHash: hash, RoleID: p.RoleID, IsActive: active})
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "user.create", "user", u.ID, gin.H{"username": u.Username}, clientIP(c))
	c.JSON(http.StatusCreated, u)
}

func (s *Server) getUser(c *gin.Context) {
	u, err := s.d.Users.Get(c.Request.Context(), c.Param("id"))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, u)
}

func (s *Server) updateUser(c *gin.Context) {
	defer middleware.InvalidatePermissions() // hak akses baru langsung berlaku
	var p userPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	ctx := c.Request.Context()
	u, err := s.d.Users.Get(ctx, c.Param("id"))
	if err != nil {
		handleErr(c, err)
		return
	}
	if p.Username != "" {
		u.Username = p.Username
	}
	u.Email = p.Email
	u.FullName = p.FullName
	if p.RoleID != nil {
		if *p.RoleID == "" {
			u.RoleID = nil
		} else {
			u.RoleID = p.RoleID
		}
	}
	if p.IsActive != nil {
		cl := middleware.GetClaims(c)
		if cl.UserID == u.ID && !*p.IsActive {
			failT(c, http.StatusBadRequest, "admin.cannot_disable_self")
			return
		}
		u.IsActive = *p.IsActive
	}
	hash := ""
	if p.Password != "" {
		if err := auth.ValidatePassword(middleware.GetLang(c), p.Password); err != nil {
			fail(c, http.StatusBadRequest, err.Error())
			return
		}
		hash, err = auth.HashPassword(p.Password)
		if err != nil {
			handleErr(c, err)
			return
		}
	}
	u, err = s.d.Users.Update(ctx, u, hash)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "user.update", "user", u.ID, gin.H{"username": u.Username, "password_changed": hash != ""}, clientIP(c))
	ok(c, u)
}

func (s *Server) deleteUser(c *gin.Context) {
	defer middleware.InvalidatePermissions() // hak akses baru langsung berlaku
	cl := middleware.GetClaims(c)
	if cl.UserID == c.Param("id") {
		failT(c, http.StatusBadRequest, "admin.cannot_delete_self")
		return
	}
	if err := s.d.Users.Delete(c.Request.Context(), c.Param("id")); err != nil {
		handleErr(c, err)
		return
	}
	s.d.Audit.Log(&cl.UserID, cl.Username, "user.delete", "user", c.Param("id"), nil, clientIP(c))
	ok(c, gin.H{"ok": true})
}

// ------------------------- Roles -------------------------

func (s *Server) listRoles(c *gin.Context) {
	roles, err := s.d.Roles.List(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": roles})
}

func (s *Server) listPermissions(c *gin.Context) { ok(c, gin.H{"items": auth.AllPermissions}) }

func (s *Server) createRole(c *gin.Context) {
	var p models.Role
	if err := c.ShouldBindJSON(&p); err != nil || strings.TrimSpace(p.Name) == "" {
		failT(c, http.StatusBadRequest, "admin.role_name_required")
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Permissions == nil {
		p.Permissions = []string{}
	}
	ro, err := s.d.Roles.Create(c.Request.Context(), p)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "role.create", "role", ro.ID, gin.H{"name": ro.Name}, clientIP(c))
	c.JSON(http.StatusCreated, ro)
}

func (s *Server) updateRole(c *gin.Context) {
	defer middleware.InvalidatePermissions() // hak akses baru langsung berlaku
	var p models.Role
	if err := c.ShouldBindJSON(&p); err != nil || strings.TrimSpace(p.Name) == "" {
		failT(c, http.StatusBadRequest, "admin.role_name_required")
		return
	}
	p.ID = c.Param("id")
	if p.Permissions == nil {
		p.Permissions = []string{}
	}
	ro, err := s.d.Roles.Update(c.Request.Context(), p)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "role.update", "role", ro.ID, gin.H{"name": ro.Name, "permissions": ro.Permissions}, clientIP(c))
	ok(c, ro)
}

func (s *Server) deleteRole(c *gin.Context) {
	defer middleware.InvalidatePermissions() // hak akses baru langsung berlaku
	if err := s.d.Roles.Delete(c.Request.Context(), c.Param("id")); err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "role.delete", "role", c.Param("id"), nil, clientIP(c))
	ok(c, gin.H{"ok": true})
}

// ------------------------- Menus -------------------------

func (s *Server) listMenus(c *gin.Context) {
	items, err := s.d.Menus.List(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

func (s *Server) createMenu(c *gin.Context) {
	var p models.Menu
	if err := c.ShouldBindJSON(&p); err != nil || strings.TrimSpace(p.Title) == "" {
		failT(c, http.StatusBadRequest, "admin.menu_title_required")
		return
	}
	if p.ParentID != nil && *p.ParentID == "" {
		p.ParentID = nil
	}
	if p.RoleIDs == nil {
		p.RoleIDs = []string{}
	}
	m, err := s.d.Menus.Create(c.Request.Context(), p)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "menu.create", "menu", m.ID, gin.H{"title": m.Title}, clientIP(c))
	c.JSON(http.StatusCreated, m)
}

func (s *Server) updateMenu(c *gin.Context) {
	var p models.Menu
	if err := c.ShouldBindJSON(&p); err != nil || strings.TrimSpace(p.Title) == "" {
		failT(c, http.StatusBadRequest, "admin.menu_title_required")
		return
	}
	p.ID = c.Param("id")
	if p.ParentID != nil && (*p.ParentID == "" || *p.ParentID == p.ID) {
		p.ParentID = nil
	}
	if p.RoleIDs == nil {
		p.RoleIDs = []string{}
	}
	m, err := s.d.Menus.Update(c.Request.Context(), p)
	if err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "menu.update", "menu", m.ID, gin.H{"title": m.Title}, clientIP(c))
	ok(c, m)
}

func (s *Server) deleteMenu(c *gin.Context) {
	if err := s.d.Menus.Delete(c.Request.Context(), c.Param("id")); err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "menu.delete", "menu", c.Param("id"), nil, clientIP(c))
	ok(c, gin.H{"ok": true})
}

// ------------------------- Konfigurasi -------------------------

func (s *Server) listConfigs(c *gin.Context) {
	items, err := s.d.Configs.List(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

func (s *Server) upsertConfigs(c *gin.Context) {
	var p struct {
		Items []models.Config `json:"items"`
	}
	if err := c.ShouldBindJSON(&p); err != nil || len(p.Items) == 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	for _, it := range p.Items {
		if strings.TrimSpace(it.Key) == "" {
			failT(c, http.StatusBadRequest, "admin.config_key_required")
			return
		}
	}
	if err := s.d.Configs.UpsertMany(c.Request.Context(), p.Items); err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	keys := make([]string, 0, len(p.Items))
	for _, it := range p.Items {
		keys = append(keys, it.Key)
	}
	s.d.Audit.Log(&cl.UserID, cl.Username, "config.update", "config", "", gin.H{"keys": keys}, clientIP(c))
	items, _ := s.d.Configs.List(c.Request.Context())
	ok(c, gin.H{"items": items})
}

func (s *Server) deleteConfig(c *gin.Context) {
	key := c.Param("key")
	if err := s.d.Configs.Delete(c.Request.Context(), key); err != nil {
		handleErr(c, err)
		return
	}
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "config.delete", "config", key, nil, clientIP(c))
	ok(c, gin.H{"ok": true})
}

// ------------------------- Layer (tipe komponen) -------------------------

func (s *Server) updateLayerType(c *gin.Context) {
	var p models.ComponentType
	if err := c.ShouldBindJSON(&p); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	p.Code = c.Param("code")
	if err := s.d.Types.Update(c.Request.Context(), middleware.GetLang(c), p); err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	s.d.Tiles.BumpVersion(c.Request.Context())
	cl := middleware.GetClaims(c)
	s.d.Audit.Log(&cl.UserID, cl.Username, "layer.update", "component_type", p.Code, gin.H{"min_zoom": p.MinZoom, "color": p.Color}, clientIP(c))
	ok(c, gin.H{"items": s.d.Types.List(), "tile_version": s.d.Tiles.Version(c.Request.Context())})
}

// ------------------------- Monitoring -------------------------

func (s *Server) monitoringSummary(c *gin.Context) {
	ctx := c.Request.Context()
	out := s.d.Collector.Summary(ctx)
	out["graph"] = s.d.Graph.Status()
	out["tile_version"] = s.d.Tiles.Version(ctx)
	out["redis_available"] = s.d.Cache.Available()
	if stats, err := s.d.MetricsRepo.DBStats(ctx); err == nil {
		out["database"] = stats
	}
	ok(c, out)
}

func (s *Server) monitoringSeries(c *gin.Context) {
	items, err := s.d.MetricsRepo.Series(c.Request.Context(), queryInt(c, "minutes", 60))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

func (s *Server) monitoringAudit(c *gin.Context) {
	items, err := s.d.Audit.List(c.Request.Context(), queryInt(c, "limit", 100))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

func (s *Server) monitoringStream(c *gin.Context) {
	items, err := s.d.MetricsRepo.StreamEvents(c.Request.Context(), queryInt(c, "limit", 50))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items, "enabled": s.d.Producer.Enabled(), "healthy": s.d.Producer.Healthy()})
}
