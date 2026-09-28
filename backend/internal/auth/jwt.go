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
	{Key: "gis.approve", Label: "Menyetujui / menolak paket perubahan jaringan", LabelEN: "Approve / reject network change sets", Group: "GIS", GroupEN: "GIS"},
	{Key: "gis.release", Label: "Merilis paket perubahan yang disetujui ke jaringan aktif", LabelEN: "Release approved change sets to the live network", Group: "GIS", GroupEN: "GIS"},
	{Key: "master.view", Label: "Melihat master data unit", LabelEN: "View unit master data", Group: "Master data", GroupEN: "Master data"},
	{Key: "master.manage", Label: "Mengelola master data unit & kepemilikan aset", LabelEN: "Manage unit master data & asset ownership", Group: "Master data", GroupEN: "Master data"},
	{Key: "power.switch_tm", Label: "Buka / tutup alat switching TM (kubikel, recloser, LBS, FCO, PMT, PMS)", LabelEN: "Open / close MV switching devices (cubicle, recloser, LBS, FCO, CB, disconnector)", Group: "Operasi jaringan", GroupEN: "Network operation"},
	{Key: "power.switch_tr", Label: "Buka / tutup switch jurusan TR", LabelEN: "Open / close LV route switches", Group: "Operasi jaringan", GroupEN: "Network operation"},
	{Key: "power.energize_tm", Label: "Energize / deenergize objek & saluran TM (gardu, SUTM, SKTM, ...)", LabelEN: "Energize / de-energize MV objects & lines (substations, MV lines, ...)", Group: "Operasi jaringan", GroupEN: "Network operation"},
	{Key: "power.plan", Label: "Menyusun, menyimulasikan & menjalankan rencana manuver / FLISR", LabelEN: "Create, simulate & execute switching plans / FLISR", Group: "Operasi jaringan", GroupEN: "Network operation"},
	{Key: "power.plan_approve", Label: "Menyetujui rencana manuver", LabelEN: "Approve switching plans", Group: "Operasi jaringan", GroupEN: "Network operation"},
	{Key: "report.manage", Label: "Mengelola laporan gangguan pelanggan", LabelEN: "Manage customer fault reports", Group: "Operasi jaringan", GroupEN: "Network operation"},
	{Key: "field.photo", Label: "Mengunggah / menghapus foto aset lapangan", LabelEN: "Upload / delete field asset photos", Group: "Lapangan", GroupEN: "Field"},
	{Key: "load.view", Label: "Melihat pembebanan trafo GI & penyulang", LabelEN: "View transformer & feeder loading", Group: "Pembebanan", GroupEN: "Loading"},
	{Key: "load.manage", Label: "Mengelola titik SCADA, anomali & laporan beban", LabelEN: "Manage SCADA points, load anomalies & reports", Group: "Pembebanan", GroupEN: "Loading"},
	{Key: "exec.view", Label: "Melihat dasbor eksekutif, laporan berkala & keandalan wilayah", LabelEN: "View executive dashboard, periodic reports & regional reliability", Group: "Eksekutif", GroupEN: "Executive"},
	{Key: "exec.report", Label: "Membuat / menghapus laporan berkala & ringkasannya", LabelEN: "Generate / delete periodic reports & summaries", Group: "Eksekutif", GroupEN: "Executive"},
	{Key: "power.energize_tr", Label: "Energize / deenergize objek & saluran TR (trafo, rak TR, SKUTR, SR, pelanggan)", LabelEN: "Energize / de-energize LV objects & lines (transformer, LV rack, LV lines, service, customer)", Group: "Operasi jaringan", GroupEN: "Network operation"},
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
