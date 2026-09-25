package gis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/i18n"
	"quadrangis/internal/models"
	"quadrangis/internal/repo"
)

// Jenis kesalahan domain (dipakai untuk pemetaan kode HTTP).
var (
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
	ErrConflict   = errors.New("topology conflict")
)

// Error adalah kesalahan domain dengan pesan yang sudah diterjemahkan.
type Error struct {
	kind error
	msg  string
}

func (e *Error) Error() string { return e.msg }

// Unwrap mengembalikan jenis kesalahan (ErrNotFound/ErrBadRequest/ErrConflict).
func (e *Error) Unwrap() error { return e.kind }

func errT(kind error, lang i18n.Lang, key string, args ...any) error {
	return &Error{kind: kind, msg: i18n.T(lang, key, args...)}
}

const junctionType = "junction"

// Actor adalah pengguna yang melakukan perubahan.
type Actor struct {
	UserID   *string
	Username string
	Lang     i18n.Lang
}

// FeatureInput adalah payload pembuatan/pengubahan fitur.
// Code/Name bertipe pointer: nil berarti "tidak dikirim" (nilai lama dipertahankan saat update).
type FeatureInput struct {
	Kind       string          `json:"kind"` // node | edge
	TypeCode   string          `json:"type_code"`
	Code       *string         `json:"code"`
	Name       *string         `json:"name"`
	Status     string          `json:"status"`
	Geometry   json.RawMessage `json:"geometry"`
	Properties map[string]any  `json:"properties"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func strPtr(s string) *string { return &s }

// EditResult merangkum efek sebuah perubahan (termasuk efek topologi otomatis).
type EditResult struct {
	Action       string          `json:"action"`
	Kind         string          `json:"kind"`
	ID           int64           `json:"id"`
	Feature      *models.Feature `json:"feature,omitempty"`
	TouchedNodes []int64         `json:"touched_nodes"`
	TouchedEdges []int64         `json:"touched_edges"`
	BBox         [4]float64      `json:"bbox"`
	Messages     []string        `json:"messages"`
	hasBBox      bool
}

// Features adalah layanan CRUD fitur GIS dengan pembentukan topologi otomatis.
type Features struct {
	pool  *pgxpool.Pool
	cfg   *repo.Configs
	types *Types

	statsMu    sync.Mutex
	statsCache []TypeStat
	statsAt    time.Time
}

// NewFeatures membuat layanan fitur.
func NewFeatures(pool *pgxpool.Pool, cfg *repo.Configs, types *Types) *Features {
	return &Features{pool: pool, cfg: cfg, types: types}
}

// ---------------------------------------------------------------------
// util geometri
// ---------------------------------------------------------------------

type geoJSONGeom struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

func parsePoint(lang i18n.Lang, raw json.RawMessage) (float64, float64, error) {
	var g geoJSONGeom
	if err := json.Unmarshal(raw, &g); err != nil || !strings.EqualFold(g.Type, "Point") {
		return 0, 0, errT(ErrBadRequest, lang, "gis.geom_point")
	}
	var c []float64
	if err := json.Unmarshal(g.Coordinates, &c); err != nil || len(c) < 2 {
		return 0, 0, errT(ErrBadRequest, lang, "gis.point_invalid")
	}
	if c[0] < -180 || c[0] > 180 || c[1] < -90 || c[1] > 90 {
		return 0, 0, errT(ErrBadRequest, lang, "gis.coords_range")
	}
	return c[0], c[1], nil
}

func parseLine(lang i18n.Lang, raw json.RawMessage) ([][2]float64, error) {
	var g geoJSONGeom
	if err := json.Unmarshal(raw, &g); err != nil || !strings.EqualFold(g.Type, "LineString") {
		return nil, errT(ErrBadRequest, lang, "gis.geom_line")
	}
	var c [][]float64
	if err := json.Unmarshal(g.Coordinates, &c); err != nil || len(c) < 2 {
		return nil, errT(ErrBadRequest, lang, "gis.line_min")
	}
	out := make([][2]float64, 0, len(c))
	for _, p := range c {
		if len(p) < 2 {
			return nil, errT(ErrBadRequest, lang, "gis.coords_invalid")
		}
		if len(out) > 0 && out[len(out)-1][0] == p[0] && out[len(out)-1][1] == p[1] {
			continue // buang vertex duplikat berurutan
		}
		out = append(out, [2]float64{p[0], p[1]})
	}
	if len(out) < 2 {
		return nil, errT(ErrBadRequest, lang, "gis.line_min_distinct")
	}
	return out, nil
}

func lineToGeoJSON(coords [][2]float64) string {
	b, _ := json.Marshal(map[string]any{"type": "LineString", "coordinates": coords})
	return string(b)
}

// parsePolygonOrPoint menerima Polygon (cincin luar dipakai) atau Point untuk bangunan.
// Mengembalikan cincin (nil bila Point) dan titik sambung (centroid sederhana cincin).
func parsePolygonOrPoint(lang i18n.Lang, raw json.RawMessage) (ring [][2]float64, lng, lat float64, err error) {
	var g geoJSONGeom
	if e := json.Unmarshal(raw, &g); e != nil {
		return nil, 0, 0, errT(ErrBadRequest, lang, "gis.geom_polygon")
	}
	if strings.EqualFold(g.Type, "Point") {
		lng, lat, err = parsePoint(lang, raw)
		return nil, lng, lat, err
	}
	if !strings.EqualFold(g.Type, "Polygon") {
		return nil, 0, 0, errT(ErrBadRequest, lang, "gis.geom_polygon")
	}
	var rings [][][]float64
	if e := json.Unmarshal(g.Coordinates, &rings); e != nil || len(rings) == 0 {
		return nil, 0, 0, errT(ErrBadRequest, lang, "gis.polygon_invalid")
	}
	for _, p := range rings[0] {
		if len(p) < 2 {
			return nil, 0, 0, errT(ErrBadRequest, lang, "gis.coords_invalid")
		}
		if len(ring) > 0 && ring[len(ring)-1][0] == p[0] && ring[len(ring)-1][1] == p[1] {
			continue
		}
		ring = append(ring, [2]float64{p[0], p[1]})
	}
	// buang penutup cincin bila sama dengan titik pertama
	if len(ring) >= 2 && ring[0] == ring[len(ring)-1] {
		ring = ring[:len(ring)-1]
	}
	if len(ring) < 3 {
		return nil, 0, 0, errT(ErrBadRequest, lang, "gis.polygon_invalid")
	}
	for _, p := range ring {
		lng += p[0]
		lat += p[1]
	}
	n := float64(len(ring))
	return ring, lng / n, lat / n, nil
}

func ringToGeoJSON(ring [][2]float64) string {
	closed := append(append([][2]float64{}, ring...), ring[0])
	b, _ := json.Marshal(map[string]any{"type": "Polygon", "coordinates": [][][2]float64{closed}})
	return string(b)
}

// setFootprint menyimpan footprint bangunan: cincin yang diberikan, atau persegi bawaan
// berukuran sizeM di sekitar titik node.
func (e *editor) setFootprint(nodeID int64, ring [][2]float64, sizeM float64) error {
	if ring != nil {
		_, err := e.tx.Exec(e.ctx, `UPDATE gis_nodes SET footprint = ST_SetSRID(ST_GeomFromGeoJSON($2),4326) WHERE id=$1`, nodeID, ringToGeoJSON(ring))
		return err
	}
	if sizeM <= 0 {
		sizeM = 10
	}
	_, err := e.tx.Exec(e.ctx, `UPDATE gis_nodes SET footprint = ST_MakeEnvelope(
			ST_X(geom) - ($2/2.0)/(111320.0*cos(radians(ST_Y(geom)))), ST_Y(geom) - ($2/2.0)/110574.0,
			ST_X(geom) + ($2/2.0)/(111320.0*cos(radians(ST_Y(geom)))), ST_Y(geom) + ($2/2.0)/110574.0, 4326)
		WHERE id=$1`, nodeID, sizeM)
	return err
}

// tolDeg mengubah toleransi meter menjadi derajat (aproksimasi ekuator; cukup untuk Indonesia).
func (f *Features) tolDeg() float64 {
	m := f.cfg.Float("topology.snap_tolerance_m", 2)
	if m <= 0 {
		m = 2
	}
	return m / 111320.0
}

// ---------------------------------------------------------------------
// editor transaksional
// ---------------------------------------------------------------------

type editor struct {
	ctx   context.Context
	tx    pgx.Tx
	f     *Features
	actor Actor
	res   *EditResult
	tol   float64
	nodes map[int64]struct{}
	edges map[int64]struct{}
}

func (f *Features) newEditor(ctx context.Context, tx pgx.Tx, actor Actor, action string) *editor {
	return &editor{ctx: ctx, tx: tx, f: f, actor: actor, tol: f.tolDeg(),
		res:   &EditResult{Action: action, TouchedNodes: []int64{}, TouchedEdges: []int64{}, Messages: []string{}},
		nodes: map[int64]struct{}{}, edges: map[int64]struct{}{}}
}

func (e *editor) lang() i18n.Lang { return e.actor.Lang }

func (e *editor) touchNode(id int64) {
	if _, ok := e.nodes[id]; !ok {
		e.nodes[id] = struct{}{}
		e.res.TouchedNodes = append(e.res.TouchedNodes, id)
	}
}

func (e *editor) touchEdge(id int64) {
	if _, ok := e.edges[id]; !ok {
		e.edges[id] = struct{}{}
		e.res.TouchedEdges = append(e.res.TouchedEdges, id)
	}
}

// msg menambahkan pesan informatif (diterjemahkan) ke hasil.
func (e *editor) msg(key string, args ...any) {
	e.res.Messages = append(e.res.Messages, i18n.T(e.lang(), key, args...))
}

func (e *editor) addBBox(minx, miny, maxx, maxy float64) {
	if !e.res.hasBBox {
		e.res.BBox = [4]float64{minx, miny, maxx, maxy}
		e.res.hasBBox = true
		return
	}
	e.res.BBox[0] = math.Min(e.res.BBox[0], minx)
	e.res.BBox[1] = math.Min(e.res.BBox[1], miny)
	e.res.BBox[2] = math.Max(e.res.BBox[2], maxx)
	e.res.BBox[3] = math.Max(e.res.BBox[3], maxy)
}

func (e *editor) extendBBoxNode(id int64) {
	var x, y float64
	if err := e.tx.QueryRow(e.ctx, `SELECT ST_X(geom), ST_Y(geom) FROM gis_nodes WHERE id=$1`, id).Scan(&x, &y); err == nil {
		e.addBBox(x, y, x, y)
	}
}

func (e *editor) extendBBoxEdge(id int64) {
	var a, b, c, d float64
	if err := e.tx.QueryRow(e.ctx, `SELECT ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom) FROM gis_edges WHERE id=$1`, id).Scan(&a, &b, &c, &d); err == nil {
		e.addBBox(a, b, c, d)
	}
}

func (e *editor) history(kind string, id int64, action string, data any) {
	b, _ := json.Marshal(data)
	if b == nil {
		b = []byte("{}")
	}
	_, _ = e.tx.Exec(e.ctx, `INSERT INTO feature_history (kind, feature_id, action, user_id, username, data) VALUES ($1,$2,$3,$4,$5,$6)`,
		kind, id, action, e.actor.UserID, e.actor.Username, b)
}

// nearestNode mencari node topologi terdekat dalam toleransi (objek pendukung seperti tiang diabaikan).
func (e *editor) nearestNode(lng, lat float64, exclude int64) (id int64, typeCode string, found bool, err error) {
	err = e.tx.QueryRow(e.ctx, `SELECT id, type_code FROM gis_nodes
		WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1,$2),4326), $3)
		  AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1,$2),4326), $3) AND id <> $4
		  AND type_code <> ALL($5::text[])
		ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`, lng, lat, e.tol, exclude, e.f.types.NonTopologyCodes()).Scan(&id, &typeCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", false, nil
	}
	return id, typeCode, err == nil, err
}

// nearestEdge mencari garis terdekat dalam toleransi beserta fraksi posisi titik pada garis.
func (e *editor) nearestEdge(lng, lat float64, exclude int64) (id int64, frac float64, found bool, err error) {
	err = e.tx.QueryRow(e.ctx, `SELECT id, ST_LineLocatePoint(geom, ST_SetSRID(ST_MakePoint($1,$2),4326)) FROM gis_edges
		WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1,$2),4326), $3)
		  AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1,$2),4326), $3) AND id <> $4
		ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`, lng, lat, e.tol, exclude).Scan(&id, &frac)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, false, nil
	}
	return id, frac, err == nil, err
}

func propsJSON(p map[string]any) []byte {
	if p == nil {
		return []byte("{}")
	}
	b, err := json.Marshal(p)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func (e *editor) insertNode(in FeatureInput, lng, lat float64) (int64, error) {
	status := in.Status
	if status == "" {
		status = "closed"
	}
	var id int64
	err := e.tx.QueryRow(e.ctx, `INSERT INTO gis_nodes (type_code, code, name, geom, status, properties, created_by, updated_by)
		VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326), $6, $7, $8, $8) RETURNING id`,
		in.TypeCode, str(in.Code), str(in.Name), lng, lat, status, propsJSON(in.Properties), e.actor.UserID).Scan(&id)
	if err != nil {
		return 0, err
	}
	e.touchNode(id)
	e.addBBox(lng, lat, lng, lat)
	e.history("node", id, "create", map[string]any{"type_code": in.TypeCode, "code": str(in.Code), "name": str(in.Name)})
	return id, nil
}

// splitEdgeAt memisahkan garis pada fraksi tertentu dengan node baru (atau node yang sudah ada).
// Mengembalikan id node pada titik pisah.
func (e *editor) splitEdgeAt(edgeID int64, frac float64, in FeatureInput) (int64, error) {
	const eps = 1e-6
	var fromID, toID int64
	if err := e.tx.QueryRow(e.ctx, `SELECT from_node_id, to_node_id FROM gis_edges WHERE id=$1 FOR UPDATE`, edgeID).Scan(&fromID, &toID); err != nil {
		return 0, err
	}
	if frac <= eps {
		return fromID, nil
	}
	if frac >= 1-eps {
		return toID, nil
	}
	status := in.Status
	if status == "" {
		status = "closed"
	}
	var nodeID int64
	if err := e.tx.QueryRow(e.ctx, `INSERT INTO gis_nodes (type_code, code, name, geom, status, properties, created_by, updated_by)
		SELECT $2, $3, $4, ST_LineInterpolatePoint(geom, $5), $6, $7, $8, $8 FROM gis_edges WHERE id=$1 RETURNING id`,
		edgeID, in.TypeCode, str(in.Code), str(in.Name), frac, status, propsJSON(in.Properties), e.actor.UserID).Scan(&nodeID); err != nil {
		return 0, err
	}
	// bagian kedua (dari node baru ke ujung lama)
	var newEdgeID int64
	if err := e.tx.QueryRow(e.ctx, `INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties, created_by, updated_by)
		SELECT type_code, code, name, ST_LineSubstring(geom, $2, 1), $3, to_node_id, qgis_length_m(ST_LineSubstring(geom, $2, 1)), status, properties, $4, $4
		FROM gis_edges WHERE id=$1 RETURNING id`, edgeID, frac, nodeID, e.actor.UserID).Scan(&newEdgeID); err != nil {
		return 0, err
	}
	// bagian pertama (garis asli dipotong)
	if _, err := e.tx.Exec(e.ctx, `UPDATE gis_edges SET geom = ST_LineSubstring(geom, 0, $2), to_node_id=$3,
		length_m = qgis_length_m(ST_LineSubstring(geom, 0, $2)), updated_by=$4, updated_at=now() WHERE id=$1`,
		edgeID, frac, nodeID, e.actor.UserID); err != nil {
		return 0, err
	}
	e.touchNode(nodeID)
	e.touchEdge(edgeID)
	e.touchEdge(newEdgeID)
	e.extendBBoxEdge(edgeID)
	e.extendBBoxEdge(newEdgeID)
	e.history("node", nodeID, "create", map[string]any{"type_code": in.TypeCode, "split_edge": edgeID})
	e.history("edge", edgeID, "split", map[string]any{"new_edge": newEdgeID, "at_node": nodeID})
	e.history("edge", newEdgeID, "create", map[string]any{"split_from": edgeID})
	e.msg("gis.msg_split", edgeID, edgeID, newEdgeID, nodeID)
	return nodeID, nil
}

// resolveEndpoint menentukan node untuk ujung garis: snap ke node, pisah garis, atau buat junction.
// labelKey adalah kunci terjemahan "awal"/"akhir".
func (e *editor) resolveEndpoint(lng, lat float64, excludeEdge int64, labelKey string) (int64, error) {
	label := i18n.T(e.lang(), labelKey)
	if id, tc, ok, err := e.nearestNode(lng, lat, 0); err != nil {
		return 0, err
	} else if ok {
		e.msg("gis.msg_snapped_node", label, tc, id)
		return id, nil
	}
	// ujung berada di dalam footprint bangunan -> sambungkan ke titik sambung bangunan
	{
		var id int64
		var tc string
		err := e.tx.QueryRow(e.ctx, `SELECT id, type_code FROM gis_nodes
			WHERE footprint IS NOT NULL AND footprint && ST_SetSRID(ST_MakePoint($1,$2),4326)
			  AND ST_Contains(footprint, ST_SetSRID(ST_MakePoint($1,$2),4326)) ORDER BY ST_Area(footprint) LIMIT 1`, lng, lat).Scan(&id, &tc)
		if err == nil {
			e.msg("gis.msg_snapped_bldg", label, tc, id)
			return id, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
	}
	if e.f.cfg.Bool("topology.auto_split_edges", true) {
		if eid, frac, ok, err := e.nearestEdge(lng, lat, excludeEdge); err != nil {
			return 0, err
		} else if ok {
			nid, err := e.splitEdgeAt(eid, frac, FeatureInput{TypeCode: junctionType})
			if err != nil {
				return 0, err
			}
			e.msg("gis.msg_snapped_edge", label, eid)
			return nid, nil
		}
	}
	if e.f.cfg.Bool("topology.auto_junction", true) {
		nid, err := e.insertNode(FeatureInput{TypeCode: junctionType}, lng, lat)
		if err != nil {
			return 0, err
		}
		e.msg("gis.msg_junction_new", nid, label)
		return nid, nil
	}
	return 0, errT(ErrConflict, e.lang(), "gis.endpoint_free", label)
}

// cleanupJunction menghapus junction yang tidak lagi terhubung ke garis mana pun.
func (e *editor) cleanupJunction(id int64) {
	if id == 0 {
		return
	}
	e.extendBBoxNode(id)
	tag, err := e.tx.Exec(e.ctx, `DELETE FROM gis_nodes WHERE id=$1 AND type_code=$2
		AND NOT EXISTS (SELECT 1 FROM gis_edges WHERE from_node_id=$1 OR to_node_id=$1)`, id, junctionType)
	if err == nil && tag.RowsAffected() > 0 {
		e.touchNode(id)
		e.history("node", id, "delete", map[string]any{"reason": "orphan junction"})
		e.msg("gis.msg_junction_gone", id)
	}
}

// finish melengkapi hasil (bbox) dari fitur yang tersentuh dan masih ada.
func (e *editor) finish() {
	var a, b, c, d *float64
	err := e.tx.QueryRow(e.ctx, `SELECT ST_XMin(ext), ST_YMin(ext), ST_XMax(ext), ST_YMax(ext) FROM (
		SELECT ST_Extent(geom) AS ext FROM (
			SELECT geom FROM gis_nodes WHERE id = ANY($1::bigint[])
			UNION ALL SELECT geom FROM gis_edges WHERE id = ANY($2::bigint[])) s) x`,
		e.res.TouchedNodes, e.res.TouchedEdges).Scan(&a, &b, &c, &d)
	if err == nil && a != nil && b != nil && c != nil && d != nil {
		e.addBBox(*a, *b, *c, *d)
	}
	if !e.res.hasBBox {
		e.res.BBox = [4]float64{-180, -85, 180, 85}
	}
}

// ---------------------------------------------------------------------
// operasi publik
// ---------------------------------------------------------------------

func (f *Features) validateType(lang i18n.Lang, in *FeatureInput, wantKind string) error {
	ct, ok := f.types.Get(in.TypeCode)
	if !ok || !ct.IsActive {
		return errT(ErrBadRequest, lang, "gis.type_unknown", in.TypeCode)
	}
	mismatch := (wantKind == "line" && ct.GeomKind != "line") || (wantKind == "point" && !ct.IsNodeKind())
	if mismatch {
		kindKey := "gis.kind_point"
		if wantKind == "line" {
			kindKey = "gis.kind_line"
		}
		return errT(ErrBadRequest, lang, "gis.type_not_kind", in.TypeCode, i18n.T(lang, kindKey))
	}
	if in.Status == "" {
		in.Status = "closed"
	}
	if in.Status != "closed" && in.Status != "open" {
		return errT(ErrBadRequest, lang, "gis.status_invalid")
	}
	if in.Code != nil {
		in.Code = strPtr(strings.TrimSpace(*in.Code))
	}
	if in.Name != nil {
		in.Name = strPtr(strings.TrimSpace(*in.Name))
	}
	return nil
}

// ssotKey adalah kunci atribut kode SSOT pada properties.
const ssotKey = "kode_ssot"

// checkSSOT merapikan kode SSOT (trim; kosong = dihapus) dan memastikan kode itu belum
// dipakai objek lain (node maupun edge). selfKind/selfID mengecualikan objek itu sendiri.
func (f *Features) checkSSOT(ctx context.Context, lang i18n.Lang, props map[string]any, selfKind string, selfID int64) error {
	if props == nil {
		return nil
	}
	raw, ok := props[ssotKey]
	if !ok {
		return nil
	}
	code := strings.TrimSpace(fmt.Sprint(raw))
	if raw == nil || code == "" {
		delete(props, ssotKey)
		return nil
	}
	props[ssotKey] = code
	var kind string
	var id int64
	err := f.pool.QueryRow(ctx, `
		(SELECT 'node', id FROM gis_nodes WHERE properties ? 'kode_ssot' AND properties->>'kode_ssot' = $1 AND NOT ($2 = 'node' AND id = $3) LIMIT 1)
		UNION ALL
		(SELECT 'edge', id FROM gis_edges WHERE properties ? 'kode_ssot' AND properties->>'kode_ssot' = $1 AND NOT ($2 = 'edge' AND id = $3) LIMIT 1)
		LIMIT 1`, code, selfKind, selfID).Scan(&kind, &id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return errT(ErrConflict, lang, "gis.ssot_duplicate", code, kind, id)
}

// Create membuat fitur baru dengan snapping & pembentukan topologi otomatis.
func (f *Features) Create(ctx context.Context, in FeatureInput, actor Actor) (*EditResult, error) {
	lang := actor.Lang
	switch in.Kind {
	case "node":
		if err := f.validateType(lang, &in, "point"); err != nil {
			return nil, err
		}
	case "edge":
		if err := f.validateType(lang, &in, "line"); err != nil {
			return nil, err
		}
	default:
		return nil, errT(ErrBadRequest, lang, "gis.kind_invalid")
	}
	if err := f.checkSSOT(ctx, lang, in.Properties, "", 0); err != nil {
		return nil, err
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	e := f.newEditor(ctx, tx, actor, "create")
	e.res.Kind = in.Kind

	if in.Kind == "node" {
		ct, _ := f.types.Get(in.TypeCode)
		isBuilding := ct.GeomKind == "polygon"
		var ring [][2]float64
		var lng, lat float64
		var err error
		if isBuilding {
			ring, lng, lat, err = parsePolygonOrPoint(lang, in.Geometry)
		} else {
			lng, lat, err = parsePoint(lang, in.Geometry)
		}
		if err != nil {
			return nil, err
		}
		// objek pendukung (tiang dsb.) bukan bagian topologi: tidak menyambung, tidak memisah garis
		if !ct.Topology {
			id, err := e.insertNode(in, lng, lat)
			if err != nil {
				return nil, err
			}
			e.res.ID = id
		} else if id, tc, ok, err := e.nearestNode(lng, lat, 0); err != nil { // 1) sudah ada node di lokasi ini?
			return nil, err
		} else if ok {
			if tc == junctionType && in.TypeCode != junctionType {
				if _, err := tx.Exec(ctx, `UPDATE gis_nodes SET type_code=$2, code=$3, name=$4, status=$5, properties=$6, updated_by=$7, updated_at=now() WHERE id=$1`,
					id, in.TypeCode, str(in.Code), str(in.Name), in.Status, propsJSON(in.Properties), actor.UserID); err != nil {
					return nil, err
				}
				e.touchNode(id)
				e.history("node", id, "update", map[string]any{"converted_from": junctionType, "type_code": in.TypeCode})
				e.msg("gis.msg_junction_conv", id, in.TypeCode)
				e.res.ID = id
			} else {
				return nil, errT(ErrConflict, lang, "gis.node_exists", tc, id)
			}
		} else if !isBuilding && f.cfg.Bool("topology.auto_split_edges", true) {
			// 2) di atas garis? pisahkan garis
			if eid, frac, ok, err := e.nearestEdge(lng, lat, 0); err != nil {
				return nil, err
			} else if ok {
				id, err := e.splitEdgeAt(eid, frac, in)
				if err != nil {
					return nil, err
				}
				e.res.ID = id
			}
		}
		if e.res.ID == 0 {
			id, err := e.insertNode(in, lng, lat)
			if err != nil {
				return nil, err
			}
			e.res.ID = id
		}
		if isBuilding {
			if err := e.setFootprint(e.res.ID, ring, ct.FootprintSizeM); err != nil {
				return nil, err
			}
		}
	} else {
		coords, err := parseLine(lang, in.Geometry)
		if err != nil {
			return nil, err
		}
		fromID, err := e.resolveEndpoint(coords[0][0], coords[0][1], 0, "gis.end_start")
		if err != nil {
			return nil, err
		}
		toID, err := e.resolveEndpoint(coords[len(coords)-1][0], coords[len(coords)-1][1], 0, "gis.end_end")
		if err != nil {
			return nil, err
		}
		if fromID == toID {
			return nil, errT(ErrConflict, lang, "gis.same_endpoints", fromID)
		}
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO gis_edges (type_code, code, name, geom, from_node_id, to_node_id, length_m, status, properties, created_by, updated_by)
			SELECT $1, $2, $3, g, $5, $6, qgis_length_m(g), $7, $8, $9, $9 FROM (
				SELECT ST_SetPoint(ST_SetPoint(ST_SetSRID(ST_GeomFromGeoJSON($4),4326), 0, (SELECT geom FROM gis_nodes WHERE id=$5)), -1, (SELECT geom FROM gis_nodes WHERE id=$6)) AS g
			) s RETURNING id`,
			in.TypeCode, str(in.Code), str(in.Name), lineToGeoJSON(coords), fromID, toID, in.Status, propsJSON(in.Properties), actor.UserID).Scan(&id); err != nil {
			return nil, err
		}
		e.touchEdge(id)
		e.touchNode(fromID)
		e.touchNode(toID)
		e.history("edge", id, "create", map[string]any{"type_code": in.TypeCode, "from": fromID, "to": toID})
		e.res.ID = id
	}
	e.finish()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	feat, err := f.Get(ctx, e.res.Kind, e.res.ID)
	if err == nil {
		e.res.Feature = &feat
	}
	return e.res, nil
}

// Update mengubah atribut dan/atau geometri fitur.
func (f *Features) Update(ctx context.Context, kind string, id int64, in FeatureInput, actor Actor) (*EditResult, error) {
	lang := actor.Lang
	if kind != "node" && kind != "edge" {
		return nil, errT(ErrBadRequest, lang, "gis.kind_invalid")
	}
	if err := f.checkSSOT(ctx, lang, in.Properties, kind, id); err != nil {
		return nil, err
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	e := f.newEditor(ctx, tx, actor, "update")
	e.res.Kind, e.res.ID = kind, id

	if kind == "node" {
		var curType, curCode, curName, curStatus string
		var curProps []byte
		err := tx.QueryRow(ctx, `SELECT type_code, code, name, status, properties FROM gis_nodes WHERE id=$1 FOR UPDATE`, id).
			Scan(&curType, &curCode, &curName, &curStatus, &curProps)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errT(ErrNotFound, lang, "common.not_found")
		} else if err != nil {
			return nil, err
		}
		if in.TypeCode == "" {
			in.TypeCode = curType
		}
		if in.Status == "" {
			in.Status = curStatus
		}
		if in.Code == nil {
			in.Code = &curCode
		}
		if in.Name == nil {
			in.Name = &curName
		}
		if err := f.validateType(lang, &in, "point"); err != nil {
			return nil, err
		}
		if in.Properties == nil {
			_ = json.Unmarshal(curProps, &in.Properties)
		}
		e.extendBBoxNode(id)
		newCT, _ := f.types.Get(in.TypeCode)
		if len(in.Geometry) > 0 {
			var ring [][2]float64
			var lng, lat float64
			var err error
			if newCT.GeomKind == "polygon" {
				ring, lng, lat, err = parsePolygonOrPoint(lang, in.Geometry)
			} else {
				lng, lat, err = parsePoint(lang, in.Geometry)
			}
			if err != nil {
				return nil, err
			}
			if oid, tc, ok, err := e.nearestNode(lng, lat, id); err != nil {
				return nil, err
			} else if ok && newCT.Topology {
				return nil, errT(ErrConflict, lang, "gis.overlap_new_loc", tc, oid)
			}
			// footprint ikut bergeser bila node dipindahkan sebagai titik
			if _, err := tx.Exec(ctx, `UPDATE gis_nodes SET footprint = ST_Translate(footprint, $2 - ST_X(geom), $3 - ST_Y(geom)) WHERE id=$1 AND footprint IS NOT NULL`, id, lng, lat); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `UPDATE gis_nodes SET geom=ST_SetSRID(ST_MakePoint($2,$3),4326) WHERE id=$1`, id, lng, lat); err != nil {
				return nil, err
			}
			if ring != nil {
				if err := e.setFootprint(id, ring, newCT.FootprintSizeM); err != nil {
					return nil, err
				}
			}
			// garis yang terhubung mengikuti posisi node (topologi terjaga)
			rows, err := tx.Query(ctx, `UPDATE gis_edges SET geom = ST_SetPoint(geom, 0, ST_SetSRID(ST_MakePoint($2,$3),4326)), updated_at = now()
				WHERE from_node_id=$1 RETURNING id`, id, lng, lat)
			if err != nil {
				return nil, err
			}
			ids, _ := collectIDs(rows)
			rows, err = tx.Query(ctx, `UPDATE gis_edges SET geom = ST_SetPoint(geom, -1, ST_SetSRID(ST_MakePoint($2,$3),4326)), updated_at = now()
				WHERE to_node_id=$1 RETURNING id`, id, lng, lat)
			if err != nil {
				return nil, err
			}
			ids2, _ := collectIDs(rows)
			ids = append(ids, ids2...)
			if len(ids) > 0 {
				if _, err := tx.Exec(ctx, `UPDATE gis_edges SET length_m = qgis_length_m(geom) WHERE id = ANY($1::bigint[])`, ids); err != nil {
					return nil, err
				}
				for _, eid := range ids {
					e.touchEdge(eid)
				}
				e.msg("gis.msg_edges_moved", len(ids))
			}
			e.addBBox(lng, lat, lng, lat)
		}
		if _, err := tx.Exec(ctx, `UPDATE gis_nodes SET type_code=$2, code=$3, name=$4, status=$5, properties=$6, updated_by=$7, updated_at=now() WHERE id=$1`,
			id, in.TypeCode, str(in.Code), str(in.Name), in.Status, propsJSON(in.Properties), actor.UserID); err != nil {
			return nil, err
		}
		// sinkronkan footprint dengan jenis tipe: bangunan tanpa footprint -> persegi bawaan; titik -> tanpa footprint
		if newCT.GeomKind == "polygon" {
			var has bool
			if err := tx.QueryRow(ctx, `SELECT footprint IS NOT NULL FROM gis_nodes WHERE id=$1`, id).Scan(&has); err != nil {
				return nil, err
			}
			if !has {
				if err := e.setFootprint(id, nil, newCT.FootprintSizeM); err != nil {
					return nil, err
				}
			}
		} else if _, err := tx.Exec(ctx, `UPDATE gis_nodes SET footprint = NULL WHERE id=$1 AND footprint IS NOT NULL`, id); err != nil {
			return nil, err
		}
		e.touchNode(id)
		e.history("node", id, "update", map[string]any{"type_code": in.TypeCode, "code": str(in.Code), "status": in.Status, "moved": len(in.Geometry) > 0})
	} else {
		var curType, curCode, curName, curStatus string
		var curProps []byte
		var fromID, toID int64
		err := tx.QueryRow(ctx, `SELECT type_code, code, name, status, properties, from_node_id, to_node_id FROM gis_edges WHERE id=$1 FOR UPDATE`, id).
			Scan(&curType, &curCode, &curName, &curStatus, &curProps, &fromID, &toID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errT(ErrNotFound, lang, "common.not_found")
		} else if err != nil {
			return nil, err
		}
		if in.TypeCode == "" {
			in.TypeCode = curType
		}
		if in.Status == "" {
			in.Status = curStatus
		}
		if in.Code == nil {
			in.Code = &curCode
		}
		if in.Name == nil {
			in.Name = &curName
		}
		if err := f.validateType(lang, &in, "line"); err != nil {
			return nil, err
		}
		if in.Properties == nil {
			_ = json.Unmarshal(curProps, &in.Properties)
		}
		e.extendBBoxEdge(id)
		newFrom, newTo := fromID, toID
		if len(in.Geometry) > 0 {
			coords, err := parseLine(lang, in.Geometry)
			if err != nil {
				return nil, err
			}
			newFrom, err = e.resolveEndpoint(coords[0][0], coords[0][1], id, "gis.end_start")
			if err != nil {
				return nil, err
			}
			newTo, err = e.resolveEndpoint(coords[len(coords)-1][0], coords[len(coords)-1][1], id, "gis.end_end")
			if err != nil {
				return nil, err
			}
			if newFrom == newTo {
				return nil, errT(ErrConflict, lang, "gis.same_endpoints", newFrom)
			}
			if _, err := tx.Exec(ctx, `UPDATE gis_edges SET
					geom = ST_SetPoint(ST_SetPoint(ST_SetSRID(ST_GeomFromGeoJSON($2),4326), 0, (SELECT geom FROM gis_nodes WHERE id=$3)), -1, (SELECT geom FROM gis_nodes WHERE id=$4)),
					from_node_id=$3, to_node_id=$4 WHERE id=$1`, id, lineToGeoJSON(coords), newFrom, newTo); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `UPDATE gis_edges SET length_m = qgis_length_m(geom) WHERE id=$1`, id); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE gis_edges SET type_code=$2, code=$3, name=$4, status=$5, properties=$6, updated_by=$7, updated_at=now() WHERE id=$1`,
			id, in.TypeCode, str(in.Code), str(in.Name), in.Status, propsJSON(in.Properties), actor.UserID); err != nil {
			return nil, err
		}
		e.touchEdge(id)
		e.touchNode(newFrom)
		e.touchNode(newTo)
		if newFrom != fromID {
			e.cleanupJunction(fromID)
		}
		if newTo != toID {
			e.cleanupJunction(toID)
		}
		e.history("edge", id, "update", map[string]any{"type_code": in.TypeCode, "code": str(in.Code), "status": in.Status, "from": newFrom, "to": newTo, "reshaped": len(in.Geometry) > 0})
	}
	e.finish()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	feat, err := f.Get(ctx, kind, id)
	if err == nil {
		e.res.Feature = &feat
	}
	return e.res, nil
}

// Delete menghapus fitur beserta konsekuensi topologinya.
func (f *Features) Delete(ctx context.Context, kind string, id int64, actor Actor) (*EditResult, error) {
	lang := actor.Lang
	if kind != "node" && kind != "edge" {
		return nil, errT(ErrBadRequest, lang, "gis.kind_invalid")
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	e := f.newEditor(ctx, tx, actor, "delete")
	e.res.Kind, e.res.ID = kind, id

	if kind == "node" {
		e.extendBBoxNode(id)
		rows, err := tx.Query(ctx, `SELECT id, CASE WHEN from_node_id=$1 THEN to_node_id ELSE from_node_id END FROM gis_edges WHERE from_node_id=$1 OR to_node_id=$1`, id)
		if err != nil {
			return nil, err
		}
		type pair struct{ edge, other int64 }
		var pairs []pair
		for rows.Next() {
			var p pair
			if err := rows.Scan(&p.edge, &p.other); err != nil {
				rows.Close()
				return nil, err
			}
			pairs = append(pairs, p)
		}
		rows.Close()
		for _, p := range pairs {
			e.extendBBoxEdge(p.edge)
			if _, err := tx.Exec(ctx, `DELETE FROM gis_edges WHERE id=$1`, p.edge); err != nil {
				return nil, err
			}
			e.touchEdge(p.edge)
			e.history("edge", p.edge, "delete", map[string]any{"reason": "node deleted", "node": id})
		}
		tag, err := tx.Exec(ctx, `DELETE FROM gis_nodes WHERE id=$1`, id)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 0 {
			return nil, errT(ErrNotFound, lang, "common.not_found")
		}
		e.touchNode(id)
		e.history("node", id, "delete", map[string]any{"edges_removed": len(pairs)})
		if len(pairs) > 0 {
			e.msg("gis.msg_edges_removed", len(pairs))
		}
		for _, p := range pairs {
			e.cleanupJunction(p.other)
		}
	} else {
		var fromID, toID int64
		err := tx.QueryRow(ctx, `SELECT from_node_id, to_node_id FROM gis_edges WHERE id=$1 FOR UPDATE`, id).Scan(&fromID, &toID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errT(ErrNotFound, lang, "common.not_found")
		} else if err != nil {
			return nil, err
		}
		e.extendBBoxEdge(id)
		if _, err := tx.Exec(ctx, `DELETE FROM gis_edges WHERE id=$1`, id); err != nil {
			return nil, err
		}
		e.touchEdge(id)
		e.history("edge", id, "delete", map[string]any{"from": fromID, "to": toID})
		e.cleanupJunction(fromID)
		e.cleanupJunction(toID)
	}
	e.finish()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return e.res, nil
}

func collectIDs(rows pgx.Rows) ([]int64, error) {
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return ids, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ---------------------------------------------------------------------
// pembacaan
// ---------------------------------------------------------------------

const nodeSelect = `SELECT n.id, n.type_code, n.code, n.name, n.status, n.properties, ST_AsGeoJSON(n.geom), n.created_at, n.updated_at,
	(SELECT count(*) FROM gis_edges e WHERE e.from_node_id=n.id OR e.to_node_id=n.id)::int, ST_AsGeoJSON(n.footprint),
	CASE WHEN n.footprint IS NULL THEN 0 ELSE ST_Area(n.footprint::geography) END, n.energized, n.open_ways FROM gis_nodes n`

const edgeSelect = `SELECT e.id, e.type_code, e.code, e.name, e.status, e.properties, ST_AsGeoJSON(e.geom), e.created_at, e.updated_at,
	e.from_node_id, e.to_node_id, e.length_m, COALESCE(fn.code,''), COALESCE(tn.code,''), COALESCE(fn.type_code,''), COALESCE(tn.type_code,''), e.energized
	FROM gis_edges e LEFT JOIN gis_nodes fn ON fn.id=e.from_node_id LEFT JOIN gis_nodes tn ON tn.id=e.to_node_id`

func scanNode(row pgx.Row) (models.Feature, error) {
	var ft models.Feature
	var props []byte
	var geom string
	var typeCode, code, name, status string
	var createdAt, updatedAt time.Time
	var degree int
	var footprint *string
	var areaM2 float64
	var energized bool
	var openWays []int64
	if err := row.Scan(&ft.ID, &typeCode, &code, &name, &status, &props, &geom, &createdAt, &updatedAt, &degree, &footprint, &areaM2, &energized, &openWays); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ft, ErrNotFound
		}
		return ft, err
	}
	var p map[string]any
	_ = json.Unmarshal(props, &p)
	if openWays == nil {
		openWays = []int64{}
	}
	ft.Type = "Feature"
	ft.Geometry = json.RawMessage(geom)
	ft.Properties = map[string]any{"kind": "node", "type_code": typeCode, "code": code, "name": name, "status": status,
		"properties": p, "created_at": createdAt, "updated_at": updatedAt, "degree": degree, "energized": energized, "open_ways": openWays}
	if footprint != nil {
		ft.Properties["footprint"] = json.RawMessage(*footprint)
		ft.Properties["area_m2"] = math.Round(areaM2*10) / 10
	}
	return ft, nil
}

// MergeAtJunction menggabungkan dua garis bertipe sama yang bertemu di sebuah junction
// berderajat dua menjadi satu garis, lalu menghapus junction tersebut (kebalikan pisah garis).
func (f *Features) MergeAtJunction(ctx context.Context, nodeID int64, actor Actor) (*EditResult, error) {
	lang := actor.Lang
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	e := f.newEditor(ctx, tx, actor, "merge")
	var typ string
	err = tx.QueryRow(ctx, `SELECT type_code FROM gis_nodes WHERE id=$1 FOR UPDATE`, nodeID).Scan(&typ)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errT(ErrNotFound, lang, "common.not_found")
	} else if err != nil {
		return nil, err
	}
	if typ != junctionType {
		return nil, errT(ErrBadRequest, lang, "gis.merge_not_junction")
	}
	type edgeRef struct {
		id, from, to int64
		typ          string
	}
	rows, err := tx.Query(ctx, `SELECT id, from_node_id, to_node_id, type_code FROM gis_edges WHERE from_node_id=$1 OR to_node_id=$1 ORDER BY id FOR UPDATE`, nodeID)
	if err != nil {
		return nil, err
	}
	var edges []edgeRef
	for rows.Next() {
		var r edgeRef
		if err := rows.Scan(&r.id, &r.from, &r.to, &r.typ); err != nil {
			rows.Close()
			return nil, err
		}
		edges = append(edges, r)
	}
	rows.Close()
	if len(edges) != 2 {
		return nil, errT(ErrBadRequest, lang, "gis.merge_degree", len(edges))
	}
	a, b := edges[0], edges[1]
	if a.typ != b.typ {
		return nil, errT(ErrBadRequest, lang, "gis.merge_type", a.typ, b.typ)
	}
	otherA := a.from
	if a.from == nodeID {
		otherA = a.to
	}
	otherB := b.to
	if b.to == nodeID {
		otherB = b.from
	}
	if otherA == otherB {
		return nil, errT(ErrBadRequest, lang, "gis.merge_loop")
	}
	e.extendBBoxEdge(a.id)
	e.extendBBoxEdge(b.id)
	// orientasi: a berakhir di junction, b berawal di junction
	if _, err := tx.Exec(ctx, `UPDATE gis_edges e SET
			geom = ST_RemoveRepeatedPoints(ST_MakeLine(
				CASE WHEN a.from_node_id=$3 THEN ST_Reverse(a.geom) ELSE a.geom END,
				CASE WHEN b.to_node_id=$3 THEN ST_Reverse(b.geom) ELSE b.geom END)),
			from_node_id = CASE WHEN a.from_node_id=$3 THEN a.to_node_id ELSE a.from_node_id END,
			to_node_id   = CASE WHEN b.to_node_id=$3 THEN b.from_node_id ELSE b.to_node_id END,
			updated_by = $4, updated_at = now()
		FROM gis_edges a, gis_edges b WHERE e.id=$1 AND a.id=$1 AND b.id=$2`, a.id, b.id, nodeID, actor.UserID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE gis_edges SET length_m = qgis_length_m(geom) WHERE id=$1`, a.id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM gis_edges WHERE id=$1`, b.id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM gis_nodes WHERE id=$1`, nodeID); err != nil {
		return nil, err
	}
	e.touchEdge(a.id)
	e.touchEdge(b.id)
	e.touchNode(nodeID)
	e.touchNode(otherA)
	e.touchNode(otherB)
	e.history("edge", a.id, "merge", map[string]any{"merged_edge": b.id, "junction": nodeID})
	e.history("edge", b.id, "delete", map[string]any{"reason": "merged into", "into": a.id})
	e.history("node", nodeID, "delete", map[string]any{"reason": "merge"})
	e.msg("gis.msg_merged", a.id, b.id, a.id, nodeID)
	e.res.Kind, e.res.ID = "edge", a.id
	e.finish()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	feat, err := f.Get(ctx, "edge", a.id)
	if err == nil {
		e.res.Feature = &feat
	}
	return e.res, nil
}

// SplitEdge memisahkan garis pada titik terdekat dari (lng,lat) dengan junction baru.
func (f *Features) SplitEdge(ctx context.Context, edgeID int64, lng, lat float64, actor Actor) (*EditResult, error) {
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	e := f.newEditor(ctx, tx, actor, "split")
	e.res.Kind, e.res.ID = "edge", edgeID
	var frac float64
	err = tx.QueryRow(ctx, `SELECT ST_LineLocatePoint(geom, ST_SetSRID(ST_MakePoint($2,$3),4326)) FROM gis_edges WHERE id=$1`, edgeID, lng, lat).Scan(&frac)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errT(ErrNotFound, actor.Lang, "common.not_found")
	} else if err != nil {
		return nil, err
	}
	nodeID, err := e.splitEdgeAt(edgeID, frac, FeatureInput{TypeCode: junctionType})
	if err != nil {
		return nil, err
	}
	if len(e.res.Messages) == 0 {
		// fraksi di ujung: tidak ada pemisahan, kembalikan node ujung
		e.msg("gis.msg_snapped_node", i18n.T(actor.Lang, "gis.end_end"), junctionType, nodeID)
	}
	e.res.TouchedNodes = append(e.res.TouchedNodes, nodeID)
	e.finish()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	feat, err := f.Get(ctx, "node", nodeID)
	if err == nil {
		e.res.Feature = &feat
	}
	return e.res, nil
}

func scanEdge(row pgx.Row) (models.Feature, error) {
	var ft models.Feature
	var props []byte
	var geom string
	var typeCode, code, name, status, fromCode, toCode, fromType, toType string
	var createdAt, updatedAt time.Time
	var fromID, toID int64
	var length float64
	var energized bool
	if err := row.Scan(&ft.ID, &typeCode, &code, &name, &status, &props, &geom, &createdAt, &updatedAt,
		&fromID, &toID, &length, &fromCode, &toCode, &fromType, &toType, &energized); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ft, ErrNotFound
		}
		return ft, err
	}
	var p map[string]any
	_ = json.Unmarshal(props, &p)
	ft.Type = "Feature"
	ft.Geometry = json.RawMessage(geom)
	ft.Properties = map[string]any{"kind": "edge", "type_code": typeCode, "code": code, "name": name, "status": status,
		"properties": p, "created_at": createdAt, "updated_at": updatedAt, "from_node_id": fromID, "to_node_id": toID,
		"length_m": math.Round(length*100) / 100, "from_code": fromCode, "to_code": toCode, "from_type": fromType, "to_type": toType, "energized": energized}
	return ft, nil
}

// Get mengambil satu fitur sebagai GeoJSON.
func (f *Features) Get(ctx context.Context, kind string, id int64) (models.Feature, error) {
	switch kind {
	case "node":
		return scanNode(f.pool.QueryRow(ctx, nodeSelect+` WHERE n.id=$1`, id))
	case "edge":
		return scanEdge(f.pool.QueryRow(ctx, edgeSelect+` WHERE e.id=$1`, id))
	}
	return models.Feature{}, errT(ErrBadRequest, i18n.ID, "gis.kind_invalid")
}

// ByIDs mengambil kumpulan fitur berdasarkan id (dipakai untuk hasil trace).
func (f *Features) ByIDs(ctx context.Context, nodeIDs, edgeIDs []int64, limit int) (models.FeatureCollection, error) {
	fc := models.NewFeatureCollection()
	if limit <= 0 {
		limit = 5000
	}
	truncated := false
	if len(nodeIDs) > 0 {
		ids := nodeIDs
		if len(ids) > limit {
			ids, truncated = ids[:limit], true
		}
		rows, err := f.pool.Query(ctx, nodeSelect+` WHERE n.id = ANY($1::bigint[])`, ids)
		if err != nil {
			return fc, err
		}
		for rows.Next() {
			ft, err := scanNode(rows)
			if err != nil {
				rows.Close()
				return fc, err
			}
			fc.Features = append(fc.Features, ft)
		}
		rows.Close()
	}
	if len(edgeIDs) > 0 {
		ids := edgeIDs
		if len(ids) > limit {
			ids, truncated = ids[:limit], true
		}
		rows, err := f.pool.Query(ctx, edgeSelect+` WHERE e.id = ANY($1::bigint[])`, ids)
		if err != nil {
			return fc, err
		}
		for rows.Next() {
			ft, err := scanEdge(rows)
			if err != nil {
				rows.Close()
				return fc, err
			}
			fc.Features = append(fc.Features, ft)
		}
		rows.Close()
	}
	fc.Meta = &models.ListMeta{Total: len(nodeIDs) + len(edgeIDs), Truncated: truncated}
	return fc, nil
}

// BBox mengambil fitur dalam kotak [minx,miny,maxx,maxy] (dibatasi limit).
func (f *Features) BBox(ctx context.Context, bbox [4]float64, types []string, limit int) (models.FeatureCollection, error) {
	fc := models.NewFeatureCollection()
	maxLimit := f.cfg.Int("loading.max_bbox_features", 5000)
	if limit <= 0 || limit > maxLimit {
		limit = maxLimit
	}
	typeFilter := ""
	args := []any{bbox[0], bbox[1], bbox[2], bbox[3], limit}
	if len(types) > 0 {
		args = append(args, types)
		typeFilter = " AND n.type_code = ANY($6::text[])"
	}
	rows, err := f.pool.Query(ctx, nodeSelect+` WHERE n.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)`+typeFilter+` LIMIT $5`, args...)
	if err != nil {
		return fc, err
	}
	for rows.Next() {
		ft, err := scanNode(rows)
		if err != nil {
			rows.Close()
			return fc, err
		}
		fc.Features = append(fc.Features, ft)
	}
	rows.Close()
	if len(types) > 0 {
		typeFilter = " AND e.type_code = ANY($6::text[])"
	}
	rows, err = f.pool.Query(ctx, edgeSelect+` WHERE e.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)`+typeFilter+` LIMIT $5`, args...)
	if err != nil {
		return fc, err
	}
	for rows.Next() {
		ft, err := scanEdge(rows)
		if err != nil {
			rows.Close()
			return fc, err
		}
		fc.Features = append(fc.Features, ft)
	}
	rows.Close()
	fc.Meta = &models.ListMeta{Total: len(fc.Features), Truncated: len(fc.Features) >= limit}
	return fc, nil
}

// SnapResult adalah kandidat snapping di sekitar sebuah koordinat.
type SnapResult struct {
	Kind     string  `json:"kind"`
	ID       int64   `json:"id"`
	TypeCode string  `json:"type_code"`
	Code     string  `json:"code"`
	Lng      float64 `json:"lng"`
	Lat      float64 `json:"lat"`
	DistM    float64 `json:"dist_m"`
}

// Snap mencari node/garis terdekat dalam radius meter untuk bantuan menggambar.
func (f *Features) Snap(ctx context.Context, lng, lat, radiusM float64) ([]SnapResult, error) {
	if radiusM <= 0 {
		radiusM = f.cfg.Float("topology.snap_tolerance_m", 2) * 5
	}
	tol := radiusM / 111320.0
	out := []SnapResult{}
	rows, err := f.pool.Query(ctx, `SELECT id, type_code, code, ST_X(geom), ST_Y(geom),
			ST_DistanceSphere(geom, ST_SetSRID(ST_MakePoint($1,$2),4326))
		FROM gis_nodes WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1,$2),4326), $3)
		ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 3`, lng, lat, tol)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s SnapResult
		if err := rows.Scan(&s.ID, &s.TypeCode, &s.Code, &s.Lng, &s.Lat, &s.DistM); err != nil {
			rows.Close()
			return nil, err
		}
		s.Kind = "node"
		if s.DistM <= radiusM {
			out = append(out, s)
		}
	}
	rows.Close()
	rows, err = f.pool.Query(ctx, `SELECT id, type_code, code, ST_X(cp), ST_Y(cp), ST_DistanceSphere(cp, ST_SetSRID(ST_MakePoint($1,$2),4326)) FROM (
			SELECT id, type_code, code, ST_ClosestPoint(geom, ST_SetSRID(ST_MakePoint($1,$2),4326)) AS cp
			FROM gis_edges WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1,$2),4326), $3)
			ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 3) s`, lng, lat, tol)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s SnapResult
		if err := rows.Scan(&s.ID, &s.TypeCode, &s.Code, &s.Lng, &s.Lat, &s.DistM); err != nil {
			rows.Close()
			return nil, err
		}
		s.Kind = "edge"
		if s.DistM <= radiusM {
			out = append(out, s)
		}
	}
	rows.Close()
	return out, nil
}

// SearchHit adalah hasil pencarian fitur.
type SearchHit struct {
	Kind     string  `json:"kind"`
	ID       int64   `json:"id"`
	TypeCode string  `json:"type_code"`
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Lng      float64 `json:"lng"`
	Lat      float64 `json:"lat"`
}

// Search mencari fitur berdasarkan kode/nama.
func (f *Features) Search(ctx context.Context, q string, limit int) ([]SearchHit, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []SearchHit{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	pat := "%" + q + "%"
	// ILIKE memakai index GIN trigram (pg_trgm) pada code/name sehingga tetap cepat pada jutaan baris
	// kode SSOT dicari lewat index parsial (hanya baris yang punya properti kode_ssot)
	rows, err := f.pool.Query(ctx, `
		(SELECT 'node', id, type_code, code, name, ST_X(geom), ST_Y(geom) FROM gis_nodes
		   WHERE code ILIKE $1 OR name ILIKE $1 OR ($3 <> 0 AND id=$3)
		      OR (properties ? 'kode_ssot' AND properties->>'kode_ssot' ILIKE $1) LIMIT $2)
		UNION ALL
		(SELECT 'edge', id, type_code, code, name, ST_X(ST_Centroid(geom)), ST_Y(ST_Centroid(geom)) FROM gis_edges
		   WHERE code ILIKE $1 OR name ILIKE $1 OR ($3 <> 0 AND id=$3)
		      OR (properties ? 'kode_ssot' AND properties->>'kode_ssot' ILIKE $1) LIMIT $2)
		LIMIT $2`, pat, limit, parseInt64(q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SearchHit{}
	for rows.Next() {
		var h SearchHit
		if err := rows.Scan(&h.Kind, &h.ID, &h.TypeCode, &h.Code, &h.Name, &h.Lng, &h.Lat); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func parseInt64(s string) int64 {
	var v int64
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		v = v*10 + int64(r-'0')
		if v > 1<<53 {
			return 0
		}
	}
	return v
}

// TypeStat adalah statistik per tipe komponen.
type TypeStat struct {
	TypeCode string  `json:"type_code"`
	Kind     string  `json:"kind"`
	Count    int64   `json:"count"`
	LengthM  float64 `json:"length_m"`
}

// Stats mengembalikan jumlah fitur per tipe (di-cache 60 detik karena memindai seluruh tabel).
func (f *Features) Stats(ctx context.Context) ([]TypeStat, error) {
	f.statsMu.Lock()
	if f.statsAt.Add(60*time.Second).After(time.Now()) && f.statsCache != nil {
		out := f.statsCache
		f.statsMu.Unlock()
		return out, nil
	}
	f.statsMu.Unlock()
	out, err := f.statsQuery(ctx)
	if err != nil {
		return nil, err
	}
	f.statsMu.Lock()
	f.statsCache, f.statsAt = out, time.Now()
	f.statsMu.Unlock()
	return out, nil
}

func (f *Features) statsQuery(ctx context.Context) ([]TypeStat, error) {
	rows, err := f.pool.Query(ctx, `
		SELECT type_code, 'node', count(*)::bigint, 0::float8 FROM gis_nodes GROUP BY type_code
		UNION ALL
		SELECT type_code, 'edge', count(*)::bigint, COALESCE(sum(length_m),0) FROM gis_edges GROUP BY type_code
		ORDER BY 2, 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TypeStat{}
	for rows.Next() {
		var s TypeStat
		if err := rows.Scan(&s.TypeCode, &s.Kind, &s.Count, &s.LengthM); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// History mengembalikan riwayat perubahan sebuah fitur.
func (f *Features) History(ctx context.Context, kind string, id int64, limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := f.pool.Query(ctx, `SELECT time, action, username, data FROM feature_history WHERE kind=$1 AND feature_id=$2 ORDER BY time DESC LIMIT $3`, kind, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var t time.Time
		var action, username string
		var data []byte
		if err := rows.Scan(&t, &action, &username, &data); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"time": t, "action": action, "username": username, "data": json.RawMessage(data)})
	}
	return out, rows.Err()
}

// Neighbors mengembalikan garis yang terhubung ke sebuah node beserta node di seberangnya.
func (f *Features) Neighbors(ctx context.Context, nodeID int64) ([]map[string]any, error) {
	rows, err := f.pool.Query(ctx, `SELECT e.id, e.type_code, e.code, e.status, round(e.length_m)::int,
			CASE WHEN e.from_node_id=$1 THEN e.to_node_id ELSE e.from_node_id END AS other_id,
			o.type_code, o.code, o.name, o.status
		FROM gis_edges e JOIN gis_nodes o ON o.id = CASE WHEN e.from_node_id=$1 THEN e.to_node_id ELSE e.from_node_id END
		WHERE e.from_node_id=$1 OR e.to_node_id=$1 ORDER BY e.id`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var eid, oid int64
		var etype, ecode, estatus, otype, ocode, oname, ostatus string
		var length int
		if err := rows.Scan(&eid, &etype, &ecode, &estatus, &length, &oid, &otype, &ocode, &oname, &ostatus); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"edge_id": eid, "edge_type": etype, "edge_code": ecode, "edge_status": estatus, "length_m": length,
			"node_id": oid, "node_type": otype, "node_code": ocode, "node_name": oname, "node_status": ostatus})
	}
	return out, rows.Err()
}
