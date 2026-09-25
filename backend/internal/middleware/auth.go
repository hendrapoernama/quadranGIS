// Package middleware berisi middleware Gin: autentikasi, bahasa, metrik, keamanan.
package middleware

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/auth"
	"quadrangis/internal/i18n"
)

// CookieName adalah nama cookie sesi.
const CookieName = "qgis_token"

const (
	claimsKey = "claims"
	langKey   = "lang"
)

// Locale menentukan bahasa respons dari header X-Lang atau Accept-Language.
func Locale() gin.HandlerFunc {
	return func(c *gin.Context) {
		v := c.GetHeader("X-Lang")
		if v == "" {
			v = c.GetHeader("Accept-Language")
		}
		if v == "" {
			v = c.Query("lang")
		}
		c.Set(langKey, i18n.Parse(v))
		c.Next()
	}
}

// GetLang mengembalikan bahasa permintaan saat ini.
func GetLang(c *gin.Context) i18n.Lang {
	if v, ok := c.Get(langKey); ok {
		if l, ok := v.(i18n.Lang); ok {
			return l
		}
	}
	return i18n.ID
}

// ExtractToken mengambil token dari header Authorization, cookie, atau query (khusus WebSocket).
func ExtractToken(c *gin.Context) string {
	if h := c.GetHeader("Authorization"); strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	if v, err := c.Cookie(CookieName); err == nil && v != "" {
		return v
	}
	if v := c.Query("token"); v != "" {
		return v
	}
	return ""
}

// PermissionResolver mengembalikan izin terkini pengguna dari role-nya dan status aktif akun.
type PermissionResolver func(ctx context.Context, userID string) (perms []string, active bool, err error)

type permEntry struct {
	perms  []string
	active bool
	at     time.Time
}

var (
	permMu    sync.Mutex
	permCache = map[string]permEntry{}
)

const permTTL = 30 * time.Second

// InvalidatePermissions mengosongkan cache izin (dipanggil saat role / pengguna diubah)
// sehingga perubahan hak akses langsung berlaku tanpa login ulang.
func InvalidatePermissions() {
	permMu.Lock()
	permCache = map[string]permEntry{}
	permMu.Unlock()
}

func currentPermissions(ctx context.Context, r PermissionResolver, userID string) (permEntry, error) {
	permMu.Lock()
	e, ok := permCache[userID]
	permMu.Unlock()
	if ok && time.Since(e.at) < permTTL {
		return e, nil
	}
	perms, active, err := r(ctx, userID)
	if err != nil {
		return permEntry{}, err
	}
	e = permEntry{perms: perms, active: active, at: time.Now()}
	permMu.Lock()
	permCache[userID] = e
	permMu.Unlock()
	return e, nil
}

// Auth memverifikasi JWT dan menyimpan klaim pada context. Bila resolver diberikan, izin
// diambil dari role pengguna saat ini (cache 30 dtk), bukan dari izin yang tertanam di token,
// sehingga perubahan role / penonaktifan akun berlaku tanpa login ulang.
func Auth(j *auth.JWT, resolvers ...PermissionResolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		tok := ExtractToken(c)
		if tok == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": i18n.T(GetLang(c), "auth.not_logged_in")})
			return
		}
		claims, err := j.Parse(tok)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": i18n.T(GetLang(c), "auth.session_invalid")})
			return
		}
		if len(resolvers) > 0 && resolvers[0] != nil {
			e, err := currentPermissions(c.Request.Context(), resolvers[0], claims.UserID)
			if err != nil || !e.active {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": i18n.T(GetLang(c), "auth.session_invalid")})
				return
			}
			claims.Permissions = e.perms
		}
		c.Set(claimsKey, claims)
		c.Next()
	}
}

// RequirePermission memastikan pengguna memiliki izin tertentu.
func RequirePermission(perm string) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := GetClaims(c)
		if claims == nil || !claims.Has(perm) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": i18n.T(GetLang(c), "auth.no_permission", perm)})
			return
		}
		c.Next()
	}
}

// RequireAnyPermission memastikan pengguna memiliki minimal satu dari izin yang disebut.
func RequireAnyPermission(perms ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := GetClaims(c)
		if claims != nil {
			for _, p := range perms {
				if claims.Has(p) {
					c.Next()
					return
				}
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": i18n.T(GetLang(c), "auth.no_permission_any")})
	}
}

// GetClaims mengembalikan klaim pengguna yang sedang login (nil jika tidak ada).
func GetClaims(c *gin.Context) *auth.Claims {
	v, ok := c.Get(claimsKey)
	if !ok {
		return nil
	}
	cl, _ := v.(*auth.Claims)
	return cl
}
