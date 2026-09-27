package api

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/i18n"
	"quadrangis/internal/middleware"
)

// ---------------------------------------------------------------- master data aset (hirarki GI → pelanggan)

type assetRow struct {
	gis.AssetItem
	GICode      string `json:"gi_code,omitempty"`
	TrafoGICode string `json:"trafo_gi_code,omitempty"`
	FeederCode  string `json:"feeder_code,omitempty"`
	GDCode      string `json:"gd_code,omitempty"`
	TrafoCode   string `json:"trafo_code,omitempty"`
	RouteCode   string `json:"route_code,omitempty"`
	UnitID      int    `json:"unit_id,omitempty"`
	Unit        string `json:"unit,omitempty"`
}

// tipe komponen per tingkat (untuk pencarian kode/nama)
var assetLevelTypes = map[string][]string{
	gis.AssetGI: {"gi"}, gis.AssetTrafoGI: {"trafo_gi"}, gis.AssetFeeder: {"kubikel_20kv"},
	gis.AssetGD: {"gd"}, gis.AssetTrafo: {"trafo_distribusi"},
}

func validAssetLevel(l string) bool {
	for _, v := range gis.AssetLevels {
		if v == l {
			return true
		}
	}
	return false
}

func (s *Server) assetsNotReady(c *gin.Context) bool {
	if s.d.Graph.Ready() {
		return false
	}
	fail(c, http.StatusServiceUnavailable, pick(c, "Graf jaringan sedang dimuat, coba lagi sebentar.", "The network graph is loading, please try again shortly."))
	return true
}

// assetCodes mengambil kode & nama untuk simpul hirarki (node, dan edge untuk jurusan).
func (s *Server) assetCodes(ctx context.Context, refs []gis.AssetRef) (map[int64]gis.CodeName, map[int64]gis.CodeName, error) {
	nodes, edges := []int64{}, []int64{}
	for _, r := range refs {
		switch r.Kind {
		case gis.AssetNone:
		case gis.AssetRoute:
			edges = append(edges, r.ID)
		default:
			nodes = append(nodes, r.ID)
		}
	}
	nc, err := s.d.Power.NodeCodes(ctx, nodes)
	if err != nil {
		return nil, nil, err
	}
	ec, err := s.d.Power.EdgeCodes(ctx, edges)
	return nc, ec, err
}

// sortAssetRefs mengurutkan menurut tingkat lalu kode (kelompok semu di akhir).
func (s *Server) sortAssetRefs(ctx context.Context, refs []gis.AssetRef) error {
	nc, ec, err := s.assetCodes(ctx, refs)
	if err != nil {
		return err
	}
	code := func(r gis.AssetRef) string {
		if r.Kind == gis.AssetRoute {
			return ec[r.ID].Code
		}
		return nc[r.ID].Code
	}
	depth := func(k string) int {
		if k == gis.AssetNone {
			return 99
		}
		for i, l := range gis.AssetLevels {
			if l == k {
				return i
			}
		}
		return 50
	}
	sort.SliceStable(refs, func(i, j int) bool {
		if di, dj := depth(refs[i].Kind), depth(refs[j].Kind); di != dj {
			return di < dj
		}
		return naturalLess(code(refs[i]), code(refs[j]))
	})
	return nil
}

// naturalLess membandingkan kode dengan angka sebagai bilangan (GD-2 < GD-10).
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		ca, cb := a[0], b[0]
		if isDigit(ca) && isDigit(cb) {
			i, j := 0, 0
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			for j < len(b) && isDigit(b[j]) {
				j++
			}
			na, _ := strconv.ParseInt(a[:i], 10, 64)
			nb, _ := strconv.ParseInt(b[:j], 10, 64)
			if na != nb {
				return na < nb
			}
			a, b = a[i:], b[j:]
			continue
		}
		la, lb := strings.ToLower(string(ca)), strings.ToLower(string(cb))
		if la != lb {
			return la < lb
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// assetRows melengkapi baris dengan kode/nama sendiri & hulu, serta unit pemilik.
func (s *Server) assetRows(ctx context.Context, items []gis.AssetItem, withUnit bool) ([]assetRow, error) {
	refs := []gis.AssetRef{}
	add := func(kind string, id int64) {
		if id != 0 {
			refs = append(refs, gis.AssetRef{Kind: kind, ID: id})
		}
	}
	for _, it := range items {
		if it.Kind != gis.AssetNone {
			add(it.Kind, it.ID)
		}
		add(gis.AssetGI, it.GI)
		add(gis.AssetTrafoGI, it.TrafoGI)
		add(gis.AssetFeeder, it.Feeder)
		add(gis.AssetGD, it.GD)
		add(gis.AssetTrafo, it.Trafo)
		add(gis.AssetRoute, it.Route)
	}
	nc, ec, err := s.assetCodes(ctx, refs)
	if err != nil {
		return nil, err
	}
	units := map[int64]int{}
	var all map[int]gis.Unit
	if withUnit {
		byLevel := map[string][]int64{}
		for _, it := range items {
			if it.Kind != gis.AssetNone {
				byLevel[it.Kind] = append(byLevel[it.Kind], it.ID)
			}
		}
		anchorOf := map[string]map[int64]int64{}
		anchors := []int64{}
		for lvl, ids := range byLevel {
			an := s.d.Graph.AssetAnchors(lvl, ids)
			m := map[int64]int64{}
			for i, id := range ids {
				m[id] = an[i]
				anchors = append(anchors, an[i])
			}
			anchorOf[lvl] = m
		}
		nu, err := s.d.Units.NodeUnits(ctx, anchors)
		if err != nil {
			return nil, err
		}
		for _, it := range items {
			if m := anchorOf[it.Kind]; m != nil {
				units[it.ID] = nu[m[it.ID]]
			}
		}
		all, _ = s.d.Units.All(ctx)
	}
	out := make([]assetRow, len(items))
	for i, it := range items {
		r := assetRow{AssetItem: it}
		if it.Kind == gis.AssetRoute {
			r.Code, r.Name = ec[it.ID].Code, ec[it.ID].Name
		} else if it.Kind != gis.AssetNone {
			r.Code, r.Name = nc[it.ID].Code, nc[it.ID].Name
		}
		r.GICode, r.TrafoGICode, r.FeederCode = nc[it.GI].Code, nc[it.TrafoGI].Code, nc[it.Feeder].Code
		r.GDCode, r.TrafoCode, r.RouteCode = nc[it.GD].Code, nc[it.Trafo].Code, ec[it.Route].Code
		if u := units[it.ID]; u != 0 {
			r.UnitID = u
			if all != nil {
				r.Unit = all[u].Name
			}
		}
		out[i] = r
	}
	return out, nil
}

// GET /api/assets/tree?kind=root|gi|trafo_gi|feeder|gd|trafo|route|none&id=&offset=&limit=&around=
func (s *Server) assetsTree(c *gin.Context) {
	if s.assetsNotReady(c) {
		return
	}
	ctx := c.Request.Context()
	kind := c.DefaultQuery("kind", gis.AssetRoot)
	id, _ := strconv.ParseInt(c.Query("id"), 10, 64)
	limit := queryInt(c, "limit", 200)
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	offset := queryInt(c, "offset", 0)
	refs := s.d.Graph.AssetChildren(kind, id)
	// daftar kecil diurutkan menurut kode; daftar besar menurut id (urutan pembuatan)
	if len(refs) <= 5000 {
		if err := s.sortAssetRefs(ctx, refs); err != nil {
			handleErr(c, err)
			return
		}
	}
	if around, err := strconv.ParseInt(c.Query("around"), 10, 64); err == nil && around != 0 {
		for i, r := range refs {
			if r.ID == around {
				offset = i / limit * limit
				break
			}
		}
	}
	if offset < 0 || offset > len(refs) {
		offset = 0
	}
	end := offset + limit
	if end > len(refs) {
		end = len(refs)
	}
	rows, err := s.assetRows(ctx, s.d.Graph.AssetItems(refs[offset:end]), true)
	if err != nil {
		handleErr(c, err)
		return
	}
	resp := gin.H{"items": rows, "total": len(refs), "offset": offset, "limit": limit}
	if kind == gis.AssetRoot {
		resp["counts"] = s.d.Graph.AssetCounts()
	}
	ok(c, resp)
}

// GET /api/assets/locate?kind=node|edge&id= — jalur hirarki sampai objek
func (s *Server) assetsLocate(c *gin.Context) {
	if s.assetsNotReady(c) {
		return
	}
	id, err := strconv.ParseInt(c.Query("id"), 10, 64)
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	path := s.d.Graph.AssetLocate(c.DefaultQuery("kind", "node"), id)
	if len(path) == 0 {
		fail(c, http.StatusNotFound, pick(c, "Objek tidak berada dalam hirarki GI → pelanggan.", "The object is not part of the substation → customer hierarchy."))
		return
	}
	ok(c, gin.H{"path": path})
}

// GET /api/assets/table?level=&scope_kind=&scope_id=&q=&state=&unit=&sort=&dir=&offset=&limit=&format=csv
func (s *Server) assetsTable(c *gin.Context) {
	if s.assetsNotReady(c) {
		return
	}
	ctx := c.Request.Context()
	level := c.DefaultQuery("level", gis.AssetFeeder)
	if !validAssetLevel(level) {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	scopeID, _ := strconv.ParseInt(c.Query("scope_id"), 10, 64)
	src := s.d.Graph.AssetIDs(level, c.Query("scope_kind"), scopeID)
	ids := append([]int64(nil), src...)
	capped := false

	if q := strings.TrimSpace(c.Query("q")); q != "" {
		match, hit, err := s.assetSearch(ctx, level, q)
		if err != nil {
			handleErr(c, err)
			return
		}
		capped = hit
		ids = filterIDs(ids, func(id int64) bool { return match[id] })
	}
	if st := c.Query("state"); st == "on" || st == "off" || st == "partial" {
		ids = s.d.Graph.AssetFilterState(level, ids, st)
	}
	if unit := queryInt(c, "unit", 0); unit > 0 {
		keep, err := s.assetUnitFilter(ctx, level, ids, unit)
		if err != nil {
			handleErr(c, err)
			return
		}
		ids = keep
	}

	// pengurutan: kode (bawaan), pelanggan, beban, padam — hanya untuk hasil <= 60.000
	sortKey, desc := c.DefaultQuery("sort", "code"), c.Query("dir") == "desc"
	sorted := "id"
	if len(ids) <= 60000 {
		refs := make([]gis.AssetRef, len(ids))
		for i, id := range ids {
			refs[i] = gis.AssetRef{Kind: level, ID: id}
		}
		if sortKey == "code" {
			if err := s.sortAssetRefs(ctx, refs); err != nil {
				handleErr(c, err)
				return
			}
			if desc {
				for i, j := 0, len(refs)-1; i < j; i, j = i+1, j-1 {
					refs[i], refs[j] = refs[j], refs[i]
				}
			}
			sorted = "code"
		} else {
			items := s.d.Graph.AssetItems(refs)
			val := func(it gis.AssetItem) float64 {
				switch sortKey {
				case "pelanggan":
					return float64(it.Pelanggan)
				case "off":
					return float64(it.PelangganOff)
				case "children":
					return float64(it.Children)
				}
				return it.BebanVA
			}
			sort.SliceStable(items, func(i, j int) bool {
				if desc {
					return val(items[i]) > val(items[j])
				}
				return val(items[i]) < val(items[j])
			})
			for i, it := range items {
				refs[i] = gis.AssetRef{Kind: level, ID: it.ID}
			}
			sorted = sortKey
		}
		for i, r := range refs {
			ids[i] = r.ID
		}
	}

	csvOut := c.Query("format") == "csv"
	limit := queryInt(c, "limit", 100)
	maxLimit := 1000
	if csvOut {
		maxLimit = 100000
		if c.Query("limit") == "" {
			limit = maxLimit
		}
	}
	if limit < 1 || limit > maxLimit {
		limit = maxLimit
	}
	offset := queryInt(c, "offset", 0)
	if offset < 0 || offset > len(ids) {
		offset = 0
	}
	end := offset + limit
	if end > len(ids) {
		end = len(ids)
	}
	page := make([]gis.AssetRef, 0, end-offset)
	for _, id := range ids[offset:end] {
		page = append(page, gis.AssetRef{Kind: level, ID: id})
	}
	rows, err := s.assetRows(ctx, s.d.Graph.AssetItems(page), len(page) <= 20000)
	if err != nil {
		handleErr(c, err)
		return
	}
	if csvOut {
		s.assetsCSV(c, level, rows, len(ids))
		return
	}
	ok(c, gin.H{"items": rows, "total": len(ids), "offset": offset, "limit": limit, "sorted": sorted, "search_capped": capped})
}

func filterIDs(ids []int64, keep func(int64) bool) []int64 {
	out := ids[:0]
	for _, id := range ids {
		if keep(id) {
			out = append(out, id)
		}
	}
	return out
}

// assetSearch mencari id aset per tingkat berdasar kode, nama, atau kode SSOT (maks. 50.000 hasil).
func (s *Server) assetSearch(ctx context.Context, level, q string) (map[int64]bool, bool, error) {
	const max = 50000
	pat := "%" + strings.ReplaceAll(strings.ReplaceAll(q, "%", `\%`), "_", `\_`) + "%"
	var sql string
	args := []any{pat, max}
	if level == gis.AssetRoute {
		sql = `SELECT id FROM gis_edges WHERE code ILIKE $1 UNION SELECT id FROM gis_edges WHERE name ILIKE $1 LIMIT $2`
	} else {
		typeCond := ""
		if t, ok := assetLevelTypes[level]; ok {
			typeCond = " AND type_code = ANY($3)"
			args = append(args, t)
		}
		sql = `SELECT id FROM gis_nodes WHERE code ILIKE $1` + typeCond + `
			UNION SELECT id FROM gis_nodes WHERE name ILIKE $1` + typeCond + `
			UNION SELECT id FROM gis_nodes WHERE properties ? 'kode_ssot' AND properties->>'kode_ssot' ILIKE $1` + typeCond + ` LIMIT $2`
	}
	rows, err := s.d.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out, len(out) >= max, rows.Err()
}

// assetUnitFilter menyisakan aset milik unit (termasuk unit bawahannya); kepemilikan efektif
// = unit yang ditetapkan, atau otomatis dari lokasi (lihat Master Data › Unit).
func (s *Server) assetUnitFilter(ctx context.Context, level string, ids []int64, unit int) ([]int64, error) {
	all, err := s.d.Units.All(ctx)
	if err != nil {
		return nil, err
	}
	in := map[int]bool{}
	for id := range all {
		for _, a := range gis.Ancestors(all, id) {
			if a.ID == unit {
				in[id] = true
				break
			}
		}
	}
	anchors := s.d.Graph.AssetAnchors(level, ids)
	uniq := map[int64]bool{}
	list := []int64{}
	for _, a := range anchors {
		if !uniq[a] {
			uniq[a] = true
			list = append(list, a)
		}
	}
	owner := map[int64]int{}
	for i := 0; i < len(list); i += 20000 {
		j := i + 20000
		if j > len(list) {
			j = len(list)
		}
		m, err := s.d.Units.NodeUnits(ctx, list[i:j])
		if err != nil {
			return nil, err
		}
		for k, v := range m {
			owner[k] = v
		}
	}
	out := make([]int64, 0, len(ids))
	for i, id := range ids {
		if in[owner[anchors[i]]] {
			out = append(out, id)
		}
	}
	return out, nil
}

func (s *Server) assetsCSV(c *gin.Context, level string, rows []assetRow, total int) {
	name := fmt.Sprintf("aset-%s-%s.csv", level, time.Now().In(jakartaLoc()).Format("20060102-1504"))
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	c.Header("X-Total", strconv.Itoa(total))
	c.Header("Access-Control-Expose-Headers", "Content-Disposition, X-Total")
	c.Status(http.StatusOK)
	_, _ = c.Writer.Write([]byte("\xEF\xBB\xBF"))
	w := csv.NewWriter(c.Writer)
	_ = w.Write([]string{"tingkat", "id", "tipe", "kode", "nama", "status", "gi", "trafo_gi", "penyulang", "gardu", "trafo", "jurusan",
		"anak", "pelanggan", "pelanggan_padam", "beban_va", "beban_padam_va", "unit"})
	for _, r := range rows {
		_ = w.Write([]string{level, strconv.FormatInt(r.ID, 10), r.TypeCode, r.Code, r.Name, r.State, r.GICode, r.TrafoGICode, r.FeederCode,
			r.GDCode, r.TrafoCode, r.RouteCode, strconv.Itoa(r.Children), strconv.Itoa(r.Pelanggan), strconv.Itoa(r.PelangganOff),
			strconv.FormatFloat(r.BebanVA, 'f', 0, 64), strconv.FormatFloat(r.BebanOffVA, 'f', 0, 64), r.Unit})
	}
	w.Flush()
}

// pick memilih pesan sesuai bahasa permintaan.
func pick(c *gin.Context, id, en string) string {
	if middleware.GetLang(c) == i18n.EN {
		return en
	}
	return id
}
