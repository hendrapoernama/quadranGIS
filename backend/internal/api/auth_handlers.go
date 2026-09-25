package api

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/auth"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
)

type loginRequest struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	CaptchaID     string `json:"captcha_id"`
	CaptchaAnswer string `json:"captcha_answer"`
}

// GET /api/auth/captcha
func (s *Server) captcha(c *gin.Context) {
	id, q := s.d.Captcha.Generate(c.Request.Context())
	ok(c, gin.H{"captcha_id": id, "question": q, "ttl_seconds": int(s.captchaTTL().Seconds())})
}

func (s *Server) captchaTTL() time.Duration {
	return time.Duration(s.d.Configs.Int("auth.captcha_ttl_seconds", 300)) * time.Second
}

// POST /api/auth/login
func (s *Server) login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		failT(c, http.StatusBadRequest, "auth.required_fields")
		return
	}
	ctx := c.Request.Context()
	ip := clientIP(c)

	// rate limit per username+ip
	maxAttempts := s.d.Configs.Int("auth.max_login_attempts", 10)
	rlKey := "login:fail:" + strings.ToLower(req.Username) + ":" + ip
	if n, ok := s.d.Cache.GetString(ctx, rlKey); ok {
		var cnt int
		fmt.Sscanf(n, "%d", &cnt)
		if cnt >= maxAttempts {
			failT(c, http.StatusTooManyRequests, "auth.too_many_attempts")
			return
		}
	}

	if !s.d.Captcha.Verify(ctx, req.CaptchaID, req.CaptchaAnswer) {
		_, _ = s.d.Cache.Incr(ctx, rlKey, 15*time.Minute)
		failT(c, http.StatusUnauthorized, "auth.captcha_wrong")
		return
	}

	u, err := s.d.Users.GetByUsername(ctx, req.Username)
	if err != nil || !auth.CheckPassword(u.PasswordHash, req.Password) {
		_, _ = s.d.Cache.Incr(ctx, rlKey, 15*time.Minute)
		s.d.Audit.Log(nil, req.Username, "login.failed", "auth", "", gin.H{"reason": "bad credentials"}, ip)
		failT(c, http.StatusUnauthorized, "auth.bad_credentials")
		return
	}
	if !u.IsActive {
		failT(c, http.StatusForbidden, "auth.account_disabled")
		return
	}
	perms := []string{}
	if u.RoleID != nil {
		if role, err := s.d.Roles.Get(ctx, *u.RoleID); err == nil {
			perms = role.Permissions
		}
	}
	token, exp, err := s.d.JWT.Sign(u, perms)
	if err != nil {
		handleErr(c, err)
		return
	}
	s.d.Cache.Del(ctx, rlKey)
	s.d.Users.TouchLogin(ctx, u.ID)
	s.setAuthCookie(c, token, exp)
	s.d.Audit.Log(&u.ID, u.Username, "login.success", "auth", u.ID, nil, ip)
	ok(c, gin.H{"token": token, "expires_at": exp, "user": u, "permissions": perms})
}

func (s *Server) setAuthCookie(c *gin.Context, token string, exp time.Time) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     middleware.CookieName,
		Value:    token,
		Path:     "/",
		Expires:  exp,
		HttpOnly: true,
		Secure:   s.d.Cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

// POST /api/auth/logout
func (s *Server) logout(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{Name: middleware.CookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		Secure: s.d.Cfg.CookieSecure, SameSite: http.SameSiteLaxMode})
	if cl := middleware.GetClaims(c); cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "logout", "auth", cl.UserID, nil, clientIP(c))
	}
	ok(c, gin.H{"ok": true})
}

// GET /api/auth/me
func (s *Server) me(c *gin.Context) {
	cl := middleware.GetClaims(c)
	ctx := c.Request.Context()
	u, err := s.d.Users.Get(ctx, cl.UserID)
	if err != nil {
		failT(c, http.StatusUnauthorized, "auth.user_not_found")
		return
	}
	if !u.IsActive {
		failT(c, http.StatusForbidden, "auth.account_disabled")
		return
	}
	perms := []string{}
	menus := []*models.Menu{}
	if u.RoleID != nil {
		if role, err := s.d.Roles.Get(ctx, *u.RoleID); err == nil {
			perms = role.Permissions
		}
		if tree, err := s.d.Menus.TreeForRole(ctx, *u.RoleID); err == nil {
			menus = tree
		}
	}
	ok(c, gin.H{
		"user":           u,
		"permissions":    perms,
		"menus":          menus,
		"app_name":       s.d.Configs.Str("app.name", "QuadranGIS"),
		"default_locale": s.d.Configs.Str("app.default_locale", "id"),
		"default_theme":  s.d.Configs.Str("app.default_theme", "system"),
	})
}

// POST /api/auth/change-password
func (s *Server) changePassword(c *gin.Context) {
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	cl := middleware.GetClaims(c)
	ctx := c.Request.Context()
	u, err := s.d.Users.Get(ctx, cl.UserID)
	if err != nil {
		handleErr(c, err)
		return
	}
	if !auth.CheckPassword(u.PasswordHash, req.OldPassword) {
		failT(c, http.StatusBadRequest, "auth.old_password")
		return
	}
	if err := auth.ValidatePassword(middleware.GetLang(c), req.NewPassword); err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		handleErr(c, err)
		return
	}
	if _, err := s.d.Users.Update(ctx, u, hash); err != nil {
		handleErr(c, err)
		return
	}
	s.d.Audit.Log(&u.ID, u.Username, "password.changed", "user", u.ID, nil, clientIP(c))
	ok(c, gin.H{"ok": true})
}
