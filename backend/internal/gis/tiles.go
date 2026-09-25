package gis

import (
	"context"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/cache"
	"quadrangis/internal/repo"
)

const (
	tileExtent  = 4096
	tileBuffer  = 128
	worldMeters = 40075016.686
	versionKey  = "tile:version"
	maxTileZoom = 22
)

// Tiles menghasilkan Mapbox Vector Tile (MVT) langsung dari PostGIS.
// Satu tile berisi tiga source-layer: nodes, edges, density.
// Ringan & cepat: hanya tipe yang min_zoom-nya terpenuhi yang di-query,
// hasil di-cache di Redis, dan invalidasi hanya menyasar tile yang terdampak.
type Tiles struct {
	pool  *pgxpool.Pool
	cache *cache.Cache
	cfg   *repo.Configs
	types *Types

	localVersion atomic.Int64
	refreshing   atomic.Bool
}

// NewTiles membuat layanan tile.
func NewTiles(pool *pgxpool.Pool, c *cache.Cache, cfg *repo.Configs, types *Types) *Tiles {
	t := &Tiles{pool: pool, cache: c, cfg: cfg, types: types}
	t.localVersion.Store(time.Now().Unix())
	return t
}

// Version mengembalikan versi tile saat ini (untuk cache busting di klien).
func (t *Tiles) Version(ctx context.Context) int64 {
	if v, ok := t.cache.GetInt64(ctx, versionKey); ok {
		if v > t.localVersion.Load() {
			t.localVersion.Store(v)
		}
		return t.localVersion.Load()
	}
	return t.localVersion.Load()
}

// BumpVersion menaikkan versi tile (semua cache tile lama menjadi tidak dipakai).
func (t *Tiles) BumpVersion(ctx context.Context) int64 {
	v := t.localVersion.Add(1)
	if nv, err := t.cache.IncrPersistent(ctx, versionKey); err == nil {
		if nv < v {
			// sinkronkan Redis ke nilai lokal yang lebih besar
			t.cache.SetString(ctx, versionKey, strconv.FormatInt(v, 10), 0)
		} else {
			t.localVersion.Store(nv)
			v = nv
		}
	}
	return v
}

// Get mengembalikan tile z/x/y (protobuf MVT).
func (t *Tiles) Get(ctx context.Context, z, x, y int) ([]byte, error) {
	if z < 0 || z > maxTileZoom || x < 0 || y < 0 || x >= 1<<uint(z) || y >= 1<<uint(z) {
		return nil, fmt.Errorf("koordinat tile tidak valid")
	}
	v := t.Version(ctx)
	key := fmt.Sprintf("tile:%d:%d:%d:%d", v, z, x, y)
	if b, ok := t.cache.GetBytes(ctx, key); ok {
		return b, nil
	}
	b, err := t.build(ctx, z, x, y)
	if err != nil {
		return nil, err
	}
	ttl := time.Duration(t.cfg.Int("loading.tile_cache_ttl_seconds", 300)) * time.Second
	if ttl > 0 {
		t.cache.SetBytes(ctx, key, b, ttl)
	}
	return b, nil
}

func (t *Tiles) build(ctx context.Context, z, x, y int) ([]byte, error) {
	maxFeat := t.cfg.Int("loading.max_features_per_tile", 20000)
	if maxFeat <= 0 {
		maxFeat = 20000
	}
	densityMaxZoom := t.cfg.Int("loading.density_max_zoom", 9)
	simplifyPx := t.cfg.Float("loading.simplify_tolerance_px", 1)

	pointTypes := t.types.VisibleNodeTypes(z) // titik + bangunan (titik sambung)
	lineTypes := t.types.VisibleAt(z, "line")
	polyTypes := t.types.VisibleAt(z, "polygon")
	hiddenTypes := t.types.HiddenAt(z)

	// toleransi simplifikasi dalam meter (hanya di zoom rendah)
	simplifyM := 0.0
	if z < 14 && simplifyPx > 0 {
		simplifyM = worldMeters / math.Pow(2, float64(z)) / tileExtent * simplifyPx
	}
	// sel agregasi kepadatan dalam derajat, membesar saat zoom mengecil
	densityCell := 0.02 * math.Pow(2, float64(densityMaxZoom-z))
	if densityCell < 0.02 {
		densityCell = 0.02
	}
	showDensity := z < densityMaxZoom && len(hiddenTypes) > 0

	// margin dinonaktifkan pada zoom sangat rendah agar transformasi ke 4326 aman
	margin := 0.03125
	if z < 2 {
		margin = 0
	}

	// Seluruh nilai disematkan sebagai literal SQL (bukan parameter). Dengan literal, planner
	// memakai statistik per nilai: pada zoom rendah (kotak tile mencakup jutaan fitur, tipe yang
	// tampil langka) ia memilih index tipe, pada zoom tinggi index spasial, dan kotak tile
	// (fungsi immutable) dilipat menjadi konstanta saat perencanaan. Parameter `= ANY($n)` atau
	// kotak yang berasal dari CTE diestimasi buruk dan berujung pemindaian jutaan baris.
	// Semua nilai bertipe numerik atau berasal dari katalog tipe internal (bukan masukan pengguna).
	q := buildTileSQL(tileQuery{
		z: z, x: x, y: y, limit: maxFeat,
		simplifyM: simplifyM, margin: margin, densityCell: densityCell,
		pointTypes: pointTypes, lineTypes: lineTypes, polyTypes: polyTypes, hiddenTypes: hiddenTypes,
		hasDensity: showDensity,
	})

	var out []byte
	err := t.pool.QueryRow(ctx, q).Scan(&out)
	if err != nil {
		return nil, fmt.Errorf("bangun tile: %w", err)
	}
	return out, nil
}

// sqlTypeCond membentuk kondisi `col IN ('a','b')` atau `false` bila daftar kosong.
// Kode tipe berasal dari katalog internal; tanda kutip tetap di-escape untuk keamanan.
func sqlTypeCond(col string, codes []string) string {
	if len(codes) == 0 {
		return "false"
	}
	parts := make([]string, 0, len(codes))
	for _, c := range codes {
		parts = append(parts, "'"+strings.ReplaceAll(c, "'", "''")+"'")
	}
	return col + " IN (" + strings.Join(parts, ",") + ")"
}

// tileQuery adalah seluruh masukan pembangun SQL tile.
type tileQuery struct {
	z, x, y     int
	limit       int
	simplifyM   float64
	margin      float64
	densityCell float64
	pointTypes  []string
	lineTypes   []string
	polyTypes   []string
	hiddenTypes []string
	hasDensity  bool
}

// sqlFloat memformat angka sebagai literal SQL tanpa notasi eksponen.
func sqlFloat(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// buildTileSQL merangkai SQL tile sepenuhnya literal (tanpa parameter) — lihat catatan di build.
// Kotak tile ditulis ulang di tiap CTE (bukan lewat CTE bersama) agar planner melipatnya
// menjadi konstanta dan mengestimasi selektivitas `&&` dari statistik indeks spasial.
func buildTileSQL(p tileQuery) string {
	env := fmt.Sprintf("ST_TileEnvelope(%d,%d,%d)", p.z, p.x, p.y)
	box := fmt.Sprintf("ST_Transform(ST_TileEnvelope(%d,%d,%d, margin => %s), 4326)", p.z, p.x, p.y, sqlFloat(p.margin))
	lim := strconv.Itoa(p.limit)
	ext := strconv.Itoa(tileExtent)
	buf := strconv.Itoa(tileBuffer)
	dens := "false"
	if p.hasDensity {
		dens = sqlTypeCond("d.type_code", p.hiddenTypes)
	}
	return `
WITH n AS (
  SELECT n.id, n.type_code, n.code, n.name, n.status, n.energized,
         ST_AsMVTGeom(ST_Transform(n.geom, 3857), ` + env + `, ` + ext + `, ` + buf + `, true) AS geom
  FROM gis_nodes n
  WHERE ` + sqlTypeCond("n.type_code", p.pointTypes) + ` AND n.geom && ` + box + `
  LIMIT ` + lim + `
),
e AS (
  SELECT e.id, e.type_code, e.code, e.name, e.status, e.energized, e.from_node_id, e.to_node_id, round(e.length_m)::int AS length_m,
         ST_AsMVTGeom(ST_Simplify(ST_Transform(e.geom, 3857), ` + sqlFloat(p.simplifyM) + `), ` + env + `, ` + ext + `, ` + buf + `, true) AS geom
  FROM gis_edges e
  WHERE ` + sqlTypeCond("e.type_code", p.lineTypes) + ` AND e.geom && ` + box + `
  LIMIT ` + lim + `
),
d AS (
  SELECT min(d.id) AS id, d.type_code, sum(d.cnt)::int AS cnt,
         ST_AsMVTGeom(ST_Transform(ST_Centroid(ST_Collect(d.geom)), 3857), ` + env + `, ` + ext + `, 64, true) AS geom
  FROM gis_nodes_density d
  WHERE ` + dens + ` AND d.geom && ` + box + `
  GROUP BY d.type_code, ST_SnapToGrid(d.geom, ` + sqlFloat(p.densityCell) + `)
),
p AS (
  SELECT n.id, n.type_code, n.code, n.name, n.status, n.energized,
         ST_AsMVTGeom(ST_Transform(n.footprint, 3857), ` + env + `, ` + ext + `, ` + buf + `, true) AS geom
  FROM gis_nodes n
  WHERE ` + sqlTypeCond("n.type_code", p.polyTypes) + ` AND n.footprint IS NOT NULL AND n.footprint && ` + box + `
  LIMIT ` + lim + `
)
SELECT COALESCE((SELECT ST_AsMVT(n, 'nodes', ` + ext + `, 'geom', 'id') FROM n), ''::bytea)
    || COALESCE((SELECT ST_AsMVT(e, 'edges', ` + ext + `, 'geom', 'id') FROM e), ''::bytea)
    || COALESCE((SELECT ST_AsMVT(d, 'density', ` + ext + `, 'geom', 'id') FROM d), ''::bytea)
    || COALESCE((SELECT ST_AsMVT(p, 'buildings', ` + ext + `, 'geom', 'id') FROM p), ''::bytea)`
}

// Invalidate menghapus cache tile yang bersinggungan dengan bbox [minx,miny,maxx,maxy].
// Bila jumlah tile terlalu banyak, versi dinaikkan (semua tile lama kadaluarsa).
func (t *Tiles) Invalidate(ctx context.Context, bbox [4]float64) int64 {
	if !t.cache.Available() {
		return t.BumpVersion(ctx)
	}
	v := t.Version(ctx)
	keys := make([]string, 0, 64)
	const maxKeys = 4000
	for z := 0; z <= maxTileZoom; z++ {
		x0, y0 := lngLatToTile(bbox[0], bbox[3], z)
		x1, y1 := lngLatToTile(bbox[2], bbox[1], z)
		// perluas satu tile untuk mengakomodasi buffer tile
		x0, y0 = x0-1, y0-1
		x1, y1 = x1+1, y1+1
		n := 1 << uint(z)
		if x0 < 0 {
			x0 = 0
		}
		if y0 < 0 {
			y0 = 0
		}
		if x1 >= n {
			x1 = n - 1
		}
		if y1 >= n {
			y1 = n - 1
		}
		cnt := (x1 - x0 + 1) * (y1 - y0 + 1)
		if len(keys)+cnt > maxKeys {
			return t.BumpVersion(ctx)
		}
		for xx := x0; xx <= x1; xx++ {
			for yy := y0; yy <= y1; yy++ {
				keys = append(keys, fmt.Sprintf("tile:%d:%d:%d:%d", v, z, xx, yy))
			}
		}
	}
	t.cache.Del(ctx, keys...)
	return v
}

func lngLatToTile(lng, lat float64, z int) (int, int) {
	n := math.Pow(2, float64(z))
	lat = math.Max(-85.05112878, math.Min(85.05112878, lat))
	x := int(math.Floor((lng + 180) / 360 * n))
	latRad := lat * math.Pi / 180
	y := int(math.Floor((1 - math.Log(math.Tan(latRad)+1/math.Cos(latRad))/math.Pi) / 2 * n))
	return x, y
}

// RefreshDensity memperbarui ringkasan kepadatan (materialized view) tanpa mengunci pembacaan.
func (t *Tiles) RefreshDensity(ctx context.Context) error {
	if !t.refreshing.CompareAndSwap(false, true) {
		return nil
	}
	defer t.refreshing.Store(false)
	start := time.Now()
	if _, err := t.pool.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY gis_nodes_density`); err != nil {
		return err
	}
	log.Printf("[tiles] kepadatan diperbarui (%s)", time.Since(start).Round(time.Millisecond))
	t.BumpVersion(ctx)
	return nil
}

// StartDensityRefresher menjalankan refresh kepadatan berkala.
func (t *Tiles) StartDensityRefresher(ctx context.Context) {
	go func() {
		for {
			every := time.Duration(t.cfg.Int("loading.density_refresh_seconds", 300)) * time.Second
			if every < 30*time.Second {
				every = 30 * time.Second
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(every):
				if err := t.RefreshDensity(ctx); err != nil {
					log.Printf("[tiles] refresh kepadatan gagal: %v", err)
				}
			}
		}
	}()
}
