package gis

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"quadrangis/internal/i18n"
)

// Pertukaran data GIS: export GeoJSON (dapat diedit di QGIS lalu diimpor kembali) dan
// export Esri File Geodatabase (.gdb, lewat GDAL ogr2ogr). Data yang diekspor wajib dipilih
// (area + layer) dan dibatasi ukurannya agar tetap ringan.

// ExportMaxBytes adalah batas ukuran file export / import.
const ExportMaxBytes = 10 << 20

// exportMaxFeatures membatasi jumlah fitur yang dibaca sebelum ukuran diperiksa.
const exportMaxFeatures = 200000

// Kolom bawaan pada GeoJSON export; atribut objek lain menjadi kolom sendiri.
var reservedFields = map[string]bool{
	"qgis_kind": true, "qgis_id": true, "type_code": true, "code": true, "name": true, "status": true,
	"energized": true, "from_node_id": true, "to_node_id": true, "length_m": true, "fid": true, "geom_part": true,
}

// ExportSelection adalah pilihan data yang diekspor.
type ExportSelection struct {
	BBox      *[4]float64     `json:"bbox"`      // [minx,miny,maxx,maxy]
	Polygon   json.RawMessage `json:"polygon"`   // GeoJSON Polygon (opsional, menggantikan bbox)
	Types     []string        `json:"types"`     // kode tipe yang diekspor
	Energized string          `json:"energized"` // all | on | off
}

// ExportStats merangkum hasil export.
type ExportStats struct {
	Features int            `json:"features"`
	Bytes    int            `json:"bytes"`
	ByType   map[string]int `json:"by_type"`
	MaxBytes int            `json:"max_bytes"`
	TooLarge bool           `json:"too_large"`
}

// ErrExportTooLarge: hasil export melebihi batas ukuran.
var ErrExportTooLarge = errors.New("export too large")

// ErrSelectionRequired: area / layer belum dipilih.
var ErrSelectionRequired = errors.New("selection required")

func (sel ExportSelection) area() (string, []any, error) {
	if len(bytes.TrimSpace(sel.Polygon)) > 0 && string(bytes.TrimSpace(sel.Polygon)) != "null" {
		var g struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(sel.Polygon, &g) != nil || (g.Type != "Polygon" && g.Type != "MultiPolygon") {
			return "", nil, ErrSelectionRequired
		}
		return "ST_SetSRID(ST_GeomFromGeoJSON($1),4326)", []any{string(sel.Polygon)}, nil
	}
	if sel.BBox != nil {
		b := *sel.BBox
		if b[0] >= b[2] || b[1] >= b[3] {
			return "", nil, ErrSelectionRequired
		}
		return "ST_MakeEnvelope($1,$2,$3,$4,4326)", []any{b[0], b[1], b[2], b[3]}, nil
	}
	return "", nil, ErrSelectionRequired
}

type exportFeature struct {
	kind  string
	id    int64
	typ   string
	polyg bool
	json  []byte
}

// flattenProps menjadikan atribut objek kolom datar (nilai objek/array menjadi teks JSON).
func flattenProps(dst map[string]any, props map[string]any) {
	for k, v := range props {
		key := k
		if reservedFields[k] {
			key = "p_" + k
		}
		switch x := v.(type) {
		case map[string]any, []any:
			b, _ := json.Marshal(x)
			dst[key] = string(b)
		default:
			dst[key] = v
		}
	}
}

// collectExport membaca fitur terpilih sebagai GeoJSON Feature datar, berhenti bila melebihi batas.
func (f *Features) collectExport(ctx context.Context, sel ExportSelection) ([]exportFeature, ExportStats, error) {
	st := ExportStats{ByType: map[string]int{}, MaxBytes: ExportMaxBytes}
	if len(sel.Types) == 0 {
		return nil, st, ErrSelectionRequired
	}
	areaSQL, args, err := sel.area()
	if err != nil {
		return nil, st, err
	}
	n := len(args)
	energy := ""
	switch sel.Energized {
	case "on":
		energy = " AND energized"
	case "off":
		energy = " AND NOT energized"
	}
	typeArg := fmt.Sprintf("$%d", n+1)
	limitArg := fmt.Sprintf("$%d", n+2)
	qargs := append(append([]any{}, args...), sel.Types, exportMaxFeatures)
	out := []exportFeature{}
	total := 0

	rows, err := f.pool.Query(ctx, `WITH a AS (SELECT `+areaSQL+` AS g)
		SELECT n.id, n.type_code, n.code, n.name, n.status, n.energized, n.properties,
		       ST_AsGeoJSON(COALESCE(n.footprint, n.geom), 7), n.footprint IS NOT NULL
		FROM gis_nodes n, a
		WHERE n.type_code = ANY(`+typeArg+`::text[]) AND n.geom && a.g AND ST_Intersects(n.geom, a.g)`+strings.ReplaceAll(energy, "energized", "n.energized")+`
		ORDER BY n.id LIMIT `+limitArg, qargs...)
	if err != nil {
		return nil, st, err
	}
	for rows.Next() {
		var id int64
		var typ, code, name, status, geom string
		var energized, poly bool
		var props []byte
		if err := rows.Scan(&id, &typ, &code, &name, &status, &energized, &props, &geom, &poly); err != nil {
			rows.Close()
			return nil, st, err
		}
		p := map[string]any{}
		var raw map[string]any
		_ = json.Unmarshal(props, &raw)
		flattenProps(p, raw)
		p["qgis_kind"], p["qgis_id"], p["type_code"], p["code"], p["name"], p["status"], p["energized"] = "node", id, typ, code, name, status, energized
		b, _ := json.Marshal(map[string]any{"type": "Feature", "properties": p, "geometry": json.RawMessage(geom)})
		out = append(out, exportFeature{kind: "node", id: id, typ: typ, polyg: poly, json: b})
		total += len(b) + 2
		if total > ExportMaxBytes {
			rows.Close()
			st.TooLarge = true
			break
		}
	}
	rows.Close()
	if !st.TooLarge {
		rows, err = f.pool.Query(ctx, `WITH a AS (SELECT `+areaSQL+` AS g)
			SELECT e.id, e.type_code, e.code, e.name, e.status, e.energized, e.properties, ST_AsGeoJSON(e.geom, 7),
			       e.from_node_id, e.to_node_id, round(e.length_m::numeric, 2)::float8
			FROM gis_edges e, a
			WHERE e.type_code = ANY(`+typeArg+`::text[]) AND e.geom && a.g AND ST_Intersects(e.geom, a.g)`+strings.ReplaceAll(energy, "energized", "e.energized")+`
			ORDER BY e.id LIMIT `+limitArg, qargs...)
		if err != nil {
			return nil, st, err
		}
		for rows.Next() {
			var id, from, to int64
			var typ, code, name, status, geom string
			var energized bool
			var length float64
			var props []byte
			if err := rows.Scan(&id, &typ, &code, &name, &status, &energized, &props, &geom, &from, &to, &length); err != nil {
				rows.Close()
				return nil, st, err
			}
			p := map[string]any{}
			var raw map[string]any
			_ = json.Unmarshal(props, &raw)
			flattenProps(p, raw)
			p["qgis_kind"], p["qgis_id"], p["type_code"], p["code"], p["name"], p["status"], p["energized"] = "edge", id, typ, code, name, status, energized
			p["from_node_id"], p["to_node_id"], p["length_m"] = from, to, length
			b, _ := json.Marshal(map[string]any{"type": "Feature", "properties": p, "geometry": json.RawMessage(geom)})
			out = append(out, exportFeature{kind: "edge", id: id, typ: typ, json: b})
			total += len(b) + 2
			if total > ExportMaxBytes {
				st.TooLarge = true
				break
			}
		}
		rows.Close()
	}
	for _, x := range out {
		st.ByType[x.typ]++
	}
	st.Features, st.Bytes = len(out), total+64
	if st.TooLarge {
		return out, st, ErrExportTooLarge
	}
	return out, st, nil
}

func featureCollection(list []exportFeature) []byte {
	var buf bytes.Buffer
	buf.WriteString(`{"type":"FeatureCollection","name":"quadrangis","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:OGC:1.3:CRS84"}},"features":[`)
	for i, x := range list {
		if i > 0 {
			buf.WriteString(",\n")
		} else {
			buf.WriteString("\n")
		}
		buf.Write(x.json)
	}
	buf.WriteString("\n]}\n")
	return buf.Bytes()
}

// ExportGeoJSON menghasilkan FeatureCollection GeoJSON datar (EPSG:4326).
func (f *Features) ExportGeoJSON(ctx context.Context, sel ExportSelection, dry bool) ([]byte, ExportStats, error) {
	list, st, err := f.collectExport(ctx, sel)
	if err != nil || dry {
		return nil, st, err
	}
	b := featureCollection(list)
	st.Bytes = len(b)
	return b, st, nil
}

var safeName = regexp.MustCompile(`[^A-Za-z0-9_]`)

// ExportGDB menghasilkan Esri File Geodatabase (satu feature class per tipe) dalam zip.
func (f *Features) ExportGDB(ctx context.Context, sel ExportSelection, dry bool) ([]byte, ExportStats, error) {
	list, st, err := f.collectExport(ctx, sel)
	if err != nil || dry {
		return nil, st, err
	}
	if _, err := exec.LookPath("ogr2ogr"); err != nil {
		return nil, st, fmt.Errorf("ogr2ogr (GDAL) tidak tersedia di server: %w", err)
	}
	dir, err := os.MkdirTemp("", "qgis-gdb-")
	if err != nil {
		return nil, st, err
	}
	defer os.RemoveAll(dir)
	groups := map[string][]exportFeature{}
	for _, x := range list {
		key := x.typ
		if x.kind == "node" && x.polyg {
			key += "_bangunan"
		}
		groups[key] = append(groups[key], x)
	}
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	gdb := filepath.Join(dir, "quadrangis.gdb")
	for i, k := range keys {
		src := filepath.Join(dir, safeName.ReplaceAllString(k, "_")+".geojson")
		if err := os.WriteFile(src, featureCollection(groups[k]), 0o600); err != nil {
			return nil, st, err
		}
		args := []string{"-f", "OpenFileGDB", gdb, src, "-nln", safeName.ReplaceAllString(k, "_"), "-lco", "TARGET_ARCGIS_VERSION=ARCGIS_PRO_3_2_OR_LATER"}
		if i > 0 {
			args = append([]string{"-update"}, args...)
		}
		cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		out, err := exec.CommandContext(cctx, "ogr2ogr", args...).CombinedOutput()
		cancel()
		if err != nil {
			return nil, st, fmt.Errorf("ogr2ogr %s: %v: %s", k, err, strings.TrimSpace(string(out)))
		}
	}
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	err = filepath.Walk(gdb, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		w, err := zw.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		fh, err := os.Open(path)
		if err != nil {
			return err
		}
		defer fh.Close()
		_, err = io.Copy(w, fh)
		return err
	})
	if err != nil {
		return nil, st, err
	}
	if err := zw.Close(); err != nil {
		return nil, st, err
	}
	st.Bytes = zbuf.Len()
	if st.Bytes > ExportMaxBytes {
		st.TooLarge = true
		return nil, st, ErrExportTooLarge
	}
	return zbuf.Bytes(), st, nil
}

// ---------------------------------------------------------------------
// import GeoJSON
// ---------------------------------------------------------------------

// ImportMaxChanges membatasi jumlah perubahan per import (setiap perubahan = satu transaksi topologi).
const ImportMaxChanges = 5000

// ImportItem adalah satu baris laporan import.
type ImportItem struct {
	Index   int    `json:"index"`
	Action  string `json:"action"` // update | create | unchanged | error
	Kind    string `json:"kind"`
	ID      int64  `json:"id,omitempty"`
	Type    string `json:"type_code,omitempty"`
	Code    string `json:"code,omitempty"`
	Changes string `json:"changes,omitempty"` // kolom yang berubah
	Error   string `json:"error,omitempty"`
}

// ImportReport adalah hasil (atau pratinjau) import.
type ImportReport struct {
	Applied   bool          `json:"applied"`
	Features  int           `json:"features"`
	Updates   int           `json:"updates"`
	Creates   int           `json:"creates"`
	Unchanged int           `json:"unchanged"`
	Errors    int           `json:"errors"`
	Items     []ImportItem  `json:"items"` // perubahan & galat (maks. 500 baris)
	Results   []*EditResult `json:"-"`
}

type importCandidate struct {
	item  ImportItem
	input FeatureInput
}

type geoJSONFeature struct {
	Type       string          `json:"type"`
	Properties map[string]any  `json:"properties"`
	Geometry   json.RawMessage `json:"geometry"`
}

// normalizeGeometry mengubah Multi* satu bagian (umum dari QGIS) menjadi geometri tunggal.
func normalizeGeometry(raw json.RawMessage) (string, json.RawMessage, error) {
	var g struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(raw, &g); err != nil || g.Type == "" {
		return "", nil, errors.New("geometry")
	}
	if strings.HasPrefix(g.Type, "Multi") {
		var parts []json.RawMessage
		if err := json.Unmarshal(g.Coordinates, &parts); err != nil || len(parts) != 1 {
			return "", nil, errors.New("multipart")
		}
		single := strings.TrimPrefix(g.Type, "Multi")
		b, _ := json.Marshal(map[string]any{"type": single, "coordinates": parts[0]})
		return single, b, nil
	}
	return g.Type, raw, nil
}

func asInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		if x == math.Trunc(x) && x > 0 {
			return int64(x), true
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64); err == nil && n > 0 {
			return n, true
		}
	case json.Number:
		if n, err := x.Int64(); err == nil && n > 0 {
			return n, true
		}
	}
	return 0, false
}

func asString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// propsFromFields menyusun kembali atribut objek dari kolom datar (kolom kosong diabaikan).
func propsFromFields(fields map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range fields {
		if reservedFields[k] || v == nil {
			continue
		}
		key := k
		if strings.HasPrefix(k, "p_") && reservedFields[strings.TrimPrefix(k, "p_")] {
			key = strings.TrimPrefix(k, "p_")
		}
		if s, ok := v.(string); ok && s == "" {
			continue
		}
		out[key] = v
	}
	return out
}

func sameValue(a, b any) bool {
	fa, okA := toFloat(a)
	fb, okB := toFloat(b)
	if okA && okB {
		return math.Abs(fa-fb) < 1e-9
	}
	return asString(a) == asString(b)
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case int:
		return float64(x), true
	}
	return 0, false
}

func propsChanged(cur, next map[string]any) bool {
	if len(cur) != len(next) {
		return true
	}
	for k, v := range cur {
		nv, ok := next[k]
		if !ok || !sameValue(v, nv) {
			return true
		}
	}
	return false
}

// coordsClose membandingkan dua geometri GeoJSON dengan toleransi (presisi QGIS vs export 7 desimal).
func coordsClose(a, b json.RawMessage) bool {
	var ga, gb struct {
		Type        string `json:"type"`
		Coordinates any    `json:"coordinates"`
	}
	if json.Unmarshal(a, &ga) != nil || json.Unmarshal(b, &gb) != nil || ga.Type != gb.Type {
		return false
	}
	var fa, fb []float64
	var walk func(v any, dst *[]float64)
	walk = func(v any, dst *[]float64) {
		switch x := v.(type) {
		case []any:
			for _, y := range x {
				walk(y, dst)
			}
		case float64:
			*dst = append(*dst, x)
		}
	}
	walk(ga.Coordinates, &fa)
	walk(gb.Coordinates, &fb)
	if len(fa) != len(fb) {
		return false
	}
	for i := range fa {
		if math.Abs(fa[i]-fb[i]) > 2e-7 {
			return false
		}
	}
	return true
}

// lineCoords membaca koordinat LineString.
func lineCoords(raw json.RawMessage) ([][]float64, bool) {
	var g struct {
		Type        string      `json:"type"`
		Coordinates [][]float64 `json:"coordinates"`
	}
	if json.Unmarshal(raw, &g) != nil || g.Type != "LineString" || len(g.Coordinates) < 2 {
		return nil, false
	}
	return g.Coordinates, true
}

// edgeGeometryUpdate menentukan perubahan geometri garis dari file. Ujung garis diatur oleh
// topologi aplikasi (menempel ke node), jadi perbedaan di titik ujung saja diabaikan: bila node
// dipindah di QGIS, garis ikut bergeser di aplikasi dan file lama tidak boleh memutus sambungan.
// Bila vertex tengah berubah, geometri baru dipakai dengan ujung tetap di posisi node saat ini.
func edgeGeometryUpdate(cur, next json.RawMessage) (json.RawMessage, bool) {
	c, ok1 := lineCoords(cur)
	n, ok2 := lineCoords(next)
	if !ok1 || !ok2 {
		return next, !coordsClose(cur, next)
	}
	if len(c) == len(n) {
		same := true
		for i := 1; i < len(c)-1 && same; i++ {
			if len(c[i]) < 2 || len(n[i]) < 2 || math.Abs(c[i][0]-n[i][0]) > 2e-7 || math.Abs(c[i][1]-n[i][1]) > 2e-7 {
				same = false
			}
		}
		if same {
			return nil, false
		}
	}
	out := append([][]float64{}, n...)
	out[0], out[len(out)-1] = c[0], c[len(c)-1]
	b, _ := json.Marshal(map[string]any{"type": "LineString", "coordinates": out})
	return b, true
}

type currentFeature struct {
	typ, code, name, status string
	props                   map[string]any
	geom                    json.RawMessage
}

func (f *Features) loadCurrent(ctx context.Context, kind string, ids []int64) (map[int64]currentFeature, error) {
	out := map[int64]currentFeature{}
	if len(ids) == 0 {
		return out, nil
	}
	q := `SELECT id, type_code, code, name, status, properties, ST_AsGeoJSON(COALESCE(footprint, geom), 7) FROM gis_nodes WHERE id = ANY($1::bigint[])`
	if kind == "edge" {
		q = `SELECT id, type_code, code, name, status, properties, ST_AsGeoJSON(geom, 7) FROM gis_edges WHERE id = ANY($1::bigint[])`
	}
	rows, err := f.pool.Query(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c currentFeature
		var props []byte
		var geom string
		if err := rows.Scan(&id, &c.typ, &c.code, &c.name, &c.status, &props, &geom); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(props, &c.props)
		if c.props == nil {
			c.props = map[string]any{}
		}
		c.geom = json.RawMessage(geom)
		out[id] = c
	}
	return out, rows.Err()
}

// alreadyExists: fitur bertipe & berkode sama sudah ada di lokasi yang sama (toleransi +-1 m).
func (f *Features) alreadyExists(ctx context.Context, kind, typ, code string, geom json.RawMessage) (bool, error) {
	table, col := "gis_nodes", "geom"
	if kind == "edge" {
		table = "gis_edges"
	}
	var n int
	err := f.pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE type_code=$1 AND code=$2
		AND `+col+` && ST_Expand(ST_SetSRID(ST_GeomFromGeoJSON($3),4326), 0.00001)
		AND ST_HausdorffDistance(`+col+`, ST_SetSRID(ST_GeomFromGeoJSON($3),4326)) < 0.00001`, typ, code, string(geom)).Scan(&n)
	if err != nil {
		// geometri poligon untuk node: bandingkan dengan titik pusat
		if kind == "node" {
			err = f.pool.QueryRow(ctx, `SELECT count(*) FROM gis_nodes WHERE type_code=$1 AND code=$2
				AND ST_DWithin(geom, ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)), 0.00001)`, typ, code, string(geom)).Scan(&n)
		}
		if err != nil {
			return false, err
		}
	}
	if n == 0 && kind == "node" {
		// bangunan: node disimpan sebagai titik pusat, file berisi poligon denah
		if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM gis_nodes WHERE type_code=$1 AND code=$2 AND footprint IS NOT NULL
			AND ST_HausdorffDistance(footprint, ST_SetSRID(ST_GeomFromGeoJSON($3),4326)) < 0.00001`, typ, code, string(geom)).Scan(&n); err != nil {
			return false, nil
		}
	}
	return n > 0, nil
}

// ImportGeoJSON membandingkan GeoJSON (hasil export yang diedit di QGIS) dengan data saat ini,
// lalu bila apply=true menerapkan pembaruan & pembuatan fitur baru lewat editor bertopologi.
// Fitur yang tidak ada di file TIDAK dihapus.
func (f *Features) ImportGeoJSON(ctx context.Context, raw []byte, apply bool, actor Actor) (*ImportReport, error) {
	lang := actor.Lang
	if len(raw) > ExportMaxBytes {
		return nil, errT(ErrBadRequest, lang, "xchg.file_too_large", ExportMaxBytes>>20)
	}
	var fc struct {
		Type     string           `json:"type"`
		Features []geoJSONFeature `json:"features"`
	}
	if err := json.Unmarshal(raw, &fc); err != nil || fc.Type != "FeatureCollection" {
		return nil, errT(ErrBadRequest, lang, "xchg.not_geojson")
	}
	rep := &ImportReport{Applied: apply, Features: len(fc.Features), Items: []ImportItem{}}
	addItem := func(it ImportItem) {
		switch it.Action {
		case "update":
			rep.Updates++
		case "create":
			rep.Creates++
		case "unchanged":
			rep.Unchanged++
		case "error":
			rep.Errors++
		}
		if it.Action != "unchanged" && len(rep.Items) < 500 {
			rep.Items = append(rep.Items, it)
		}
	}
	// kumpulkan id yang dirujuk
	nodeIDs, edgeIDs := []int64{}, []int64{}
	type parsed struct {
		kind, gtype string
		id          int64
		geom        json.RawMessage
		err         string
	}
	pre := make([]parsed, len(fc.Features))
	for i, ft := range fc.Features {
		p := parsed{}
		if ft.Properties == nil {
			ft.Properties = map[string]any{}
			fc.Features[i].Properties = ft.Properties
		}
		gtype, geom, err := normalizeGeometry(ft.Geometry)
		if err != nil {
			p.err = i18n.T(lang, "xchg.bad_geometry")
		}
		p.gtype, p.geom = gtype, geom
		p.kind = asString(ft.Properties["qgis_kind"])
		if p.kind != "node" && p.kind != "edge" {
			if gtype == "LineString" {
				p.kind = "edge"
			} else {
				p.kind = "node"
			}
		}
		if id, ok := asInt64(ft.Properties["qgis_id"]); ok {
			p.id = id
			if p.kind == "node" {
				nodeIDs = append(nodeIDs, id)
			} else {
				edgeIDs = append(edgeIDs, id)
			}
		}
		pre[i] = p
	}
	curNodes, err := f.loadCurrent(ctx, "node", nodeIDs)
	if err != nil {
		return nil, err
	}
	curEdges, err := f.loadCurrent(ctx, "edge", edgeIDs)
	if err != nil {
		return nil, err
	}

	cands := []importCandidate{}
	for i, ft := range fc.Features {
		p := pre[i]
		fields := ft.Properties
		it := ImportItem{Index: i + 1, Kind: p.kind, ID: p.id, Type: asString(fields["type_code"]), Code: asString(fields["code"])}
		if p.err != "" {
			it.Action, it.Error = "error", p.err
			addItem(it)
			continue
		}
		wantKind := "point"
		if p.kind == "edge" {
			wantKind = "line"
			if p.gtype != "LineString" {
				it.Action, it.Error = "error", i18n.T(lang, "xchg.edge_needs_line")
				addItem(it)
				continue
			}
		} else if p.gtype != "Point" && p.gtype != "Polygon" {
			it.Action, it.Error = "error", i18n.T(lang, "xchg.node_needs_point")
			addItem(it)
			continue
		}
		props := propsFromFields(fields)
		code, name, status, typ := asString(fields["code"]), asString(fields["name"]), asString(fields["status"]), asString(fields["type_code"])
		if p.id > 0 {
			cur, ok := curNodes[p.id]
			if p.kind == "edge" {
				cur, ok = curEdges[p.id]
			}
			if !ok {
				it.Action, it.Error = "error", i18n.T(lang, "xchg.id_not_found", p.kind, p.id)
				addItem(it)
				continue
			}
			if typ == "" {
				typ = cur.typ
			}
			if status == "" {
				status = cur.status
			}
			changes := []string{}
			in := FeatureInput{Kind: p.kind, TypeCode: typ, Status: status, Properties: props}
			if typ != cur.typ {
				changes = append(changes, "type_code")
			}
			if code != cur.code {
				changes = append(changes, "code")
			}
			if name != cur.name {
				changes = append(changes, "name")
			}
			if status != cur.status {
				changes = append(changes, "status")
			}
			if propsChanged(cur.props, props) {
				changes = append(changes, "atribut")
			}
			if p.kind == "edge" {
				if g, changed := edgeGeometryUpdate(cur.geom, p.geom); changed {
					changes = append(changes, "geometri")
					in.Geometry = g
				}
			} else if !coordsClose(cur.geom, p.geom) {
				changes = append(changes, "geometri")
				in.Geometry = p.geom
			}
			if len(changes) == 0 {
				it.Action = "unchanged"
				addItem(it)
				continue
			}
			in.Code, in.Name = strPtr(code), strPtr(name)
			it.Action, it.Changes, it.Type = "update", strings.Join(changes, ", "), typ
			cands = append(cands, importCandidate{item: it, input: in})
			continue
		}
		// fitur baru
		if typ == "" {
			it.Action, it.Error = "error", i18n.T(lang, "xchg.type_required")
			addItem(it)
			continue
		}
		in := FeatureInput{Kind: p.kind, TypeCode: typ, Status: status, Code: strPtr(code), Name: strPtr(name), Properties: props, Geometry: p.geom}
		if err := f.validateType(lang, &FeatureInput{Kind: p.kind, TypeCode: typ, Status: status}, wantKind); err != nil {
			it.Action, it.Error = "error", err.Error()
			addItem(it)
			continue
		}
		if exists, err := f.alreadyExists(ctx, p.kind, typ, code, p.geom); err != nil {
			return nil, err
		} else if exists {
			it.Action = "unchanged" // sudah ada (mis. file yang sama diimpor ulang)
			addItem(it)
			continue
		}
		it.Action = "create"
		cands = append(cands, importCandidate{item: it, input: in})
	}
	if len(cands) > ImportMaxChanges {
		return nil, errT(ErrBadRequest, lang, "xchg.too_many_changes", len(cands), ImportMaxChanges)
	}
	if !apply {
		for _, c := range cands {
			addItem(c.item)
		}
		return rep, nil
	}
	for _, c := range cands {
		if ctx.Err() != nil {
			return rep, ctx.Err()
		}
		it := c.item
		var res *EditResult
		var err error
		if it.Action == "update" {
			res, err = f.Update(ctx, it.Kind, it.ID, c.input, actor)
		} else {
			res, err = f.Create(ctx, c.input, actor)
			if err == nil {
				it.ID = res.ID
			}
		}
		if err != nil {
			it.Action, it.Error = "error", err.Error()
		} else {
			rep.Results = append(rep.Results, res)
		}
		addItem(it)
	}
	return rep, nil
}
