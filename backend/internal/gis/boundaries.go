package gis

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Poligon wilayah ULP dari shapefile docs/bts_area (dikonversi ke GeoJSON WGS84).
//
//go:embed seed/bts_area.geojson
var boundarySeed []byte

// BoundaryColors adalah jumlah warna pewarnaan peta UP3 (UP3 bersebelahan selalu berbeda warna).
const BoundaryColors = 5

// Boundaries melayani overlay batas wilayah UP3 / ULP.
type Boundaries struct {
	pool  *pgxpool.Pool
	mu    sync.Mutex
	cache []byte
	etag  string
}

// NewBoundaries membuat layanan batas wilayah.
func NewBoundaries(pool *pgxpool.Pool) *Boundaries { return &Boundaries{pool: pool} }

// EnsureSeed memuat poligon ULP bawaan dan menurunkan poligon UP3 bila tabel masih kosong.
func (b *Boundaries) EnsureSeed(ctx context.Context) error {
	var n int
	if err := b.pool.QueryRow(ctx, `SELECT count(*) FROM gis_boundaries`).Scan(&n); err != nil || n > 0 {
		return err
	}
	var fc struct {
		Features []struct {
			Properties map[string]any  `json:"properties"`
			Geometry   json.RawMessage `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(boundarySeed, &fc); err != nil {
		return fmt.Errorf("seed batas wilayah: %w", err)
	}
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	str := func(p map[string]any, k string) string {
		if v, ok := p[k].(string); ok {
			return strings.TrimSpace(v)
		}
		return ""
	}
	for _, f := range fc.Features {
		props, _ := json.Marshal(f.Properties)
		code := str(f.Properties, "kd_kp")
		if _, err := tx.Exec(ctx, `INSERT INTO gis_boundaries (level, code, name, parent, properties, geom)
			VALUES ('ulp', $1, $2, $3, $4,
			        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)), 3)))`,
			code, str(f.Properties, "nama_kp"), str(f.Properties, "nama_area"), props, string(f.Geometry)); err != nil {
			return fmt.Errorf("seed ULP %s: %w", str(f.Properties, "nama_kp"), err)
		}
	}
	// UP3 = dissolve ULP per nama area (disnap ke grid ~1 m agar tidak meninggalkan celah tipis)
	if _, err := tx.Exec(ctx, `INSERT INTO gis_boundaries (level, code, name, properties, geom)
		SELECT 'up3', COALESCE(max(NULLIF(properties->>'kd_area', '')), ''), parent,
		       jsonb_build_object('ulp', array_agg(name ORDER BY name)),
		       ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_UnaryUnion(ST_Collect(ST_SnapToGrid(geom, 0.00001)))), 3))
		FROM gis_boundaries WHERE level = 'ulp' GROUP BY parent`); err != nil {
		return fmt.Errorf("seed UP3: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	log.Printf("[gis] batas wilayah dimuat: %d ULP", len(fc.Features))
	return nil
}

// GeoJSON mengembalikan FeatureCollection batas wilayah (poligon UP3 & ULP + titik label), di-cache.
func (b *Boundaries) GeoJSON(ctx context.Context) ([]byte, string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cache != nil {
		return b.cache, b.etag, nil
	}
	type area struct {
		id                     int64
		level, code, name, par string
		props                  json.RawMessage
		geom, label            json.RawMessage
		km2                    float64
		color                  int
	}
	rows, err := b.pool.Query(ctx, `SELECT id, level, code, name, parent, properties,
		ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.00005), 5), ST_AsGeoJSON(ST_PointOnSurface(geom), 5),
		ST_Area(geom::geography) / 1e6
		FROM gis_boundaries ORDER BY level, name`)
	if err != nil {
		return nil, "", err
	}
	list := []*area{}
	byID := map[int64]*area{}
	for rows.Next() {
		a := &area{}
		var g, l string
		if err := rows.Scan(&a.id, &a.level, &a.code, &a.name, &a.par, &a.props, &g, &l, &a.km2); err != nil {
			rows.Close()
			return nil, "", err
		}
		a.geom, a.label = json.RawMessage(g), json.RawMessage(l)
		list = append(list, a)
		byID[a.id] = a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	// pewarnaan peta UP3: greedy berdasarkan derajat ketetanggaan
	adj := map[int64][]int64{}
	nb, err := b.pool.Query(ctx, `SELECT a.id, c.id FROM gis_boundaries a
		JOIN gis_boundaries c ON a.id < c.id AND c.level = 'up3' AND ST_DWithin(a.geom, c.geom, 0.0005)
		WHERE a.level = 'up3'`)
	if err != nil {
		return nil, "", err
	}
	for nb.Next() {
		var x, y int64
		if err := nb.Scan(&x, &y); err == nil {
			adj[x] = append(adj[x], y)
			adj[y] = append(adj[y], x)
		}
	}
	nb.Close()
	up3 := []*area{}
	for _, a := range list {
		if a.level == "up3" {
			a.color = -1
			up3 = append(up3, a)
		}
	}
	sort.SliceStable(up3, func(i, j int) bool { return len(adj[up3[i].id]) > len(adj[up3[j].id]) })
	colorOf := map[string]int{}
	for _, a := range up3 {
		used := map[int]bool{}
		for _, o := range adj[a.id] {
			if c := byID[o].color; c >= 0 {
				used[c] = true
			}
		}
		a.color = 0
		for used[a.color] && a.color < BoundaryColors-1 {
			a.color++
		}
		colorOf[a.name] = a.color
	}

	feats := make([]map[string]any, 0, len(list)*2)
	for _, a := range list {
		color := a.color
		if a.level == "ulp" {
			color = colorOf[a.par]
		}
		p := map[string]any{"kind": "area", "level": a.level, "code": a.code, "name": a.name, "parent": a.par,
			"color": color, "area_km2": a.km2, "attrs": a.props}
		feats = append(feats, map[string]any{"type": "Feature", "id": a.id, "properties": p, "geometry": a.geom})
		feats = append(feats, map[string]any{"type": "Feature", "properties": map[string]any{"kind": "label", "level": a.level, "name": a.name, "parent": a.par, "color": color}, "geometry": a.label})
	}
	out, err := json.Marshal(map[string]any{"type": "FeatureCollection", "features": feats,
		"meta": map[string]any{"up3": len(up3), "ulp": len(list) - len(up3), "colors": BoundaryColors}})
	if err != nil {
		return nil, "", err
	}
	b.cache, b.etag = out, fmt.Sprintf(`"bnd-%d-%d"`, len(out), len(list))
	return b.cache, b.etag, nil
}
