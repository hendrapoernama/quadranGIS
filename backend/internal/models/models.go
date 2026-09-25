// Package models berisi struktur data yang dipakai lintas lapisan.
package models

import (
	"encoding/json"
	"time"
)

// User adalah akun pengguna aplikasi.
type User struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	Email        string     `json:"email"`
	FullName     string     `json:"full_name"`
	RoleID       *string    `json:"role_id"`
	RoleName     string     `json:"role_name"`
	IsActive     bool       `json:"is_active"`
	LastLoginAt  *time.Time `json:"last_login_at"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	PasswordHash string     `json:"-"`
}

// Role adalah peran dengan daftar izin.
type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Permissions []string  `json:"permissions"`
	IsSystem    bool      `json:"is_system"`
	UserCount   int       `json:"user_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Menu adalah item navigasi (bisa bertingkat).
type Menu struct {
	ID        string   `json:"id"`
	ParentID  *string  `json:"parent_id"`
	Title     string   `json:"title"`
	TitleEN   string   `json:"title_en"`
	Path      string   `json:"path"`
	Icon      string   `json:"icon"`
	SortOrder int      `json:"sort_order"`
	IsActive  bool     `json:"is_active"`
	RoleIDs   []string `json:"role_ids"`
	Children  []*Menu  `json:"children,omitempty"`
}

// Config adalah satu entri konfigurasi aplikasi.
type Config struct {
	Key         string    `json:"key"`
	Value       string    `json:"value"`
	ValueType   string    `json:"value_type"`
	Group       string    `json:"group"`
	Description string    `json:"description"`
	UpdatedAt   time.Time `json:"updated_at"`
	// HasValue menandakan konfigurasi bertipe secret sudah berisi (nilainya tidak pernah dikirim ke klien).
	HasValue bool `json:"has_value,omitempty"`
}

// AuditLog adalah catatan aktivitas pengguna.
type AuditLog struct {
	Time     time.Time       `json:"time"`
	UserID   *string         `json:"user_id"`
	Username string          `json:"username"`
	Action   string          `json:"action"`
	Entity   string          `json:"entity"`
	EntityID string          `json:"entity_id"`
	Detail   json.RawMessage `json:"detail"`
	IP       string          `json:"ip"`
}

// MetricSample adalah satu titik metrik sistem.
type MetricSample struct {
	Time           time.Time `json:"time"`
	CPUPercent     float64   `json:"cpu_percent"`
	MemUsedMB      float64   `json:"mem_used_mb"`
	MemTotalMB     float64   `json:"mem_total_mb"`
	HeapMB         float64   `json:"heap_mb"`
	Goroutines     int       `json:"goroutines"`
	DBConnsTotal   int       `json:"db_conns_total"`
	DBConnsIdle    int       `json:"db_conns_idle"`
	DBOK           bool      `json:"db_ok"`
	RedisLatencyMS float64   `json:"redis_latency_ms"`
	RedisOK        bool      `json:"redis_ok"`
	KafkaOK        bool      `json:"kafka_ok"`
	HTTPRequests   int64     `json:"http_requests"`
	HTTPAvgMS      float64   `json:"http_avg_ms"`
	HTTPErrors     int64     `json:"http_errors"`
	WSClients      int       `json:"ws_clients"`
}

// ComponentType adalah tipe komponen kelistrikan beserta gaya tampilannya.
type ComponentType struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	NameEN    string  `json:"name_en"`
	GeomKind  string  `json:"geom_kind"`
	Category  string  `json:"category"`
	IsSource  bool    `json:"is_source"`
	IsSwitch  bool    `json:"is_switch"`
	IsSink    bool    `json:"is_sink"`
	VoltageKV float64 `json:"voltage_kv"`
	Color     string  `json:"color"`
	Icon      string  `json:"icon"`
	MinZoom   int     `json:"min_zoom"`
	LabelZoom int     `json:"label_zoom"`
	Size      float64 `json:"size"`
	SortOrder int     `json:"sort_order"`
	IsActive  bool    `json:"is_active"`
	// FootprintSizeM adalah sisi persegi bawaan (meter) bangunan bila digambar sebagai titik.
	FootprintSizeM float64 `json:"footprint_size_m"`
	// Topology: ikut membentuk graf jaringan (false = objek pendukung seperti tiang).
	Topology bool `json:"topology"`
	// Ways: jumlah arah alat switching (2 / 3), 0 bila bukan switch.
	Ways int `json:"ways"`
	// Attributes adalah skema atribut SSOT: [{key,label,label_en,type,unit,options}].
	Attributes json.RawMessage `json:"attributes"`
}

// IsNodeKind menandakan tipe disimpan sebagai node topologi (titik atau bangunan poligon).
func (c ComponentType) IsNodeKind() bool { return c.GeomKind == "point" || c.GeomKind == "polygon" }

// Feature adalah representasi GeoJSON satu fitur GIS.
type Feature struct {
	Type       string          `json:"type"`
	ID         int64           `json:"id"`
	Geometry   json.RawMessage `json:"geometry"`
	Properties map[string]any  `json:"properties"`
}

// FeatureCollection adalah kumpulan fitur GeoJSON.
type FeatureCollection struct {
	Type     string    `json:"type"`
	Features []Feature `json:"features"`
	Meta     *ListMeta `json:"meta,omitempty"`
}

// ListMeta membawa informasi paginasi/limit.
type ListMeta struct {
	Total     int  `json:"total"`
	Truncated bool `json:"truncated"`
}

// NewFeatureCollection membuat koleksi kosong.
func NewFeatureCollection() FeatureCollection {
	return FeatureCollection{Type: "FeatureCollection", Features: []Feature{}}
}
