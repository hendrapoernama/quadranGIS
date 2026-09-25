// Package auth menangani token JWT, captcha matematika, dan hashing kata sandi.
package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"quadrangis/internal/models"
)

// Permission mendeskripsikan satu izin (label dwibahasa).
type Permission struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	LabelEN string `json:"label_en"`
	Group   string `json:"group"`
	GroupEN string `json:"group_en"`
}

// AllPermissions adalah katalog izin yang dikenal aplikasi.
var AllPermissions = []Permission{
	{Key: "gis.view", Label: "Melihat peta & fitur", LabelEN: "View map & features", Group: "GIS", GroupEN: "GIS"},
	{Key: "gis.edit", Label: "Menggambar / mengubah / menghapus fitur", LabelEN: "Draw / edit / delete features", Group: "GIS", GroupEN: "GIS"},
	{Key: "gis.trace", Label: "Menjalankan trace kelistrikan", LabelEN: "Run electrical traces", Group: "GIS", GroupEN: "GIS"},
	{Key: "gis.maneuver", Label: "Manuver jaringan (buka / tutup alat switching)", LabelEN: "Network switching maneuvers (open / close)", Group: "GIS", GroupEN: "GIS"},
	{Key: "ai.use", Label: "Memakai asisten AI", LabelEN: "Use the AI assistant", Group: "GIS", GroupEN: "GIS"},
	{Key: "gis.settings", Label: "Mengatur layer & loading", LabelEN: "Manage layers & loading", Group: "GIS", GroupEN: "GIS"},
	{Key: "admin.users", Label: "Administrasi pengguna", LabelEN: "User administration", Group: "Administrasi", GroupEN: "Administration"},
	{Key: "admin.roles", Label: "Administrasi roles", LabelEN: "Role administration", Group: "Administrasi", GroupEN: "Administration"},
	{Key: "admin.menus", Label: "Administrasi menu", LabelEN: "Menu administration", Group: "Administrasi", GroupEN: "Administration"},
	{Key: "admin.config", Label: "Konfigurasi aplikasi", LabelEN: "Application configuration", Group: "Administrasi", GroupEN: "Administration"},
	{Key: "admin.monitoring", Label: "Monitoring sistem", LabelEN: "System monitoring", Group: "Administrasi", GroupEN: "Administration"},
}

// Claims adalah isi token JWT.
type Claims struct {
	UserID      string   `json:"uid"`
	Username    string   `json:"usr"`
	Role        string   `json:"role"`
	Permissions []string `json:"perms"`
	jwt.RegisteredClaims
}

// Has memeriksa apakah klaim memiliki izin tertentu.
func (c *Claims) Has(perm string) bool {
	for _, p := range c.Permissions {
		if p == perm {
			return true
		}
	}
	return false
}

// JWT menandatangani dan memverifikasi token.
type JWT struct {
	secret []byte
	ttl    time.Duration
}

// NewJWT membuat penandatangan token.
func NewJWT(secret string, ttl time.Duration) *JWT {
	return &JWT{secret: []byte(secret), ttl: ttl}
}

// TTL mengembalikan umur token.
func (j *JWT) TTL() time.Duration { return j.ttl }

// Sign membuat token untuk pengguna.
func (j *JWT) Sign(u models.User, perms []string) (string, time.Time, error) {
	exp := time.Now().Add(j.ttl)
	claims := Claims{
		UserID:      u.ID,
		Username:    u.Username,
		Role:        u.RoleName,
		Permissions: perms,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.ID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(exp),
			Issuer:    "quadrangis",
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString(j.secret)
	return s, exp, err
}

// Parse memverifikasi token dan mengembalikan klaim.
func (j *JWT) Parse(token string) (*Claims, error) {
	claims := &Claims{}
	t, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("metode tanda tangan tidak valid")
		}
		return j.secret, nil
	})
	if err != nil || !t.Valid {
		return nil, errors.New("token tidak valid")
	}
	return claims, nil
}
