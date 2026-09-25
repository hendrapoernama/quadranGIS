// Package gis berisi layanan peta: tipe komponen, vector tile, editing
// dengan topologi otomatis, dan graf jaringan untuk trace kelistrikan.
package gis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/i18n"
	"quadrangis/internal/models"
)

// Types adalah katalog tipe komponen kelistrikan (di-cache di memori).
type Types struct {
	pool   *pgxpool.Pool
	mu     sync.RWMutex
	list   []models.ComponentType
	byCode map[string]models.ComponentType
}

// NewTypes membuat katalog tipe.
func NewTypes(pool *pgxpool.Pool) *Types {
	return &Types{pool: pool, byCode: map[string]models.ComponentType{}}
}

// Refresh memuat ulang katalog dari database.
func (t *Types) Refresh(ctx context.Context) error {
	rows, err := t.pool.Query(ctx, `SELECT code, name, name_en, geom_kind, category, is_source, is_switch, is_sink, voltage_kv,
		color, icon, min_zoom, label_zoom, size, sort_order, is_active, footprint_size_m, topology, ways, attributes FROM component_types ORDER BY sort_order, code`)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []models.ComponentType{}
	byCode := map[string]models.ComponentType{}
	for rows.Next() {
		var ct models.ComponentType
		var attrs []byte
		if err := rows.Scan(&ct.Code, &ct.Name, &ct.NameEN, &ct.GeomKind, &ct.Category, &ct.IsSource, &ct.IsSwitch, &ct.IsSink, &ct.VoltageKV,
			&ct.Color, &ct.Icon, &ct.MinZoom, &ct.LabelZoom, &ct.Size, &ct.SortOrder, &ct.IsActive, &ct.FootprintSizeM, &ct.Topology, &ct.Ways, &attrs); err != nil {
			return err
		}
		if len(attrs) == 0 {
			attrs = []byte("[]")
		}
		ct.Attributes = json.RawMessage(attrs)
		list = append(list, ct)
		byCode[ct.Code] = ct
	}
	if err := rows.Err(); err != nil {
		return err
	}
	t.mu.Lock()
	t.list, t.byCode = list, byCode
	t.mu.Unlock()
	return nil
}

// List mengembalikan seluruh tipe.
func (t *Types) List() []models.ComponentType {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([]models.ComponentType, len(t.list))
	copy(out, t.list)
	return out
}

// Get mengambil satu tipe.
func (t *Types) Get(code string) (models.ComponentType, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	ct, ok := t.byCode[code]
	return ct, ok
}

// VisibleNodeTypes mengembalikan kode tipe node (titik & bangunan) yang tampil pada zoom tertentu.
func (t *Types) VisibleNodeTypes(zoom int) []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []string{}
	for _, ct := range t.list {
		if ct.IsActive && ct.IsNodeKind() && ct.MinZoom <= zoom {
			out = append(out, ct.Code)
		}
	}
	return out
}

// VisibleAt mengembalikan kode tipe dengan jenis geometri tertentu ('point','line','polygon') yang tampil pada zoom tertentu.
func (t *Types) VisibleAt(zoom int, kind string) []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []string{}
	for _, ct := range t.list {
		if ct.IsActive && ct.GeomKind == kind && ct.MinZoom <= zoom {
			out = append(out, ct.Code)
		}
	}
	return out
}

// HiddenAt mengembalikan kode tipe node yang BELUM tampil pada zoom tertentu (untuk layer kepadatan).
func (t *Types) HiddenAt(zoom int) []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []string{}
	for _, ct := range t.list {
		if ct.IsActive && ct.IsNodeKind() && ct.MinZoom > zoom {
			out = append(out, ct.Code)
		}
	}
	return out
}

// NonTopologyCodes mengembalikan kode tipe node yang bukan bagian topologi (objek pendukung).
func (t *Types) NonTopologyCodes() []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []string{}
	for _, ct := range t.list {
		if !ct.Topology {
			out = append(out, ct.Code)
		}
	}
	return out
}

// Update mengubah pengaturan tampilan/loading sebuah tipe.
func (t *Types) Update(ctx context.Context, lang i18n.Lang, ct models.ComponentType) error {
	if _, ok := t.Get(ct.Code); !ok {
		return errors.New(i18n.T(lang, "admin.type_not_found"))
	}
	if ct.MinZoom < 0 || ct.MinZoom > 22 {
		return errors.New(i18n.T(lang, "admin.min_zoom_range"))
	}
	attrs := []byte(ct.Attributes)
	if len(bytes.TrimSpace(attrs)) == 0 {
		attrs = []byte("[]")
	}
	var probe []map[string]any
	if err := json.Unmarshal(attrs, &probe); err != nil {
		return errors.New(i18n.T(lang, "admin.attributes_invalid"))
	}
	if ct.Ways < 0 || ct.Ways > 8 {
		ct.Ways = 0
	}
	_, err := t.pool.Exec(ctx, `UPDATE component_types SET name=$2, name_en=$3, color=$4, icon=$5, min_zoom=$6, label_zoom=$7, size=$8,
		sort_order=$9, is_active=$10, voltage_kv=$11, footprint_size_m=$12, topology=$13, ways=$14, attributes=$15 WHERE code=$1`,
		ct.Code, ct.Name, ct.NameEN, ct.Color, ct.Icon, ct.MinZoom, ct.LabelZoom, ct.Size, ct.SortOrder, ct.IsActive, ct.VoltageKV, ct.FootprintSizeM,
		ct.Topology, ct.Ways, attrs)
	if err != nil {
		return err
	}
	return t.Refresh(ctx)
}
