package gis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// =====================================================================
// Single Line Diagram: pohon skematik diturunkan dari graf topologi
// (posisi normal switch), disederhanakan, lalu ditata di klien.
// =====================================================================

// Tingkat detail SLD (urut dari yang paling ringkas).
var SLDLevels = []string{"tm", "gd", "jurusan", "pelanggan"}

var ErrSLDScope = errors.New("cakupan SLD tidak dikenal")

// ErrGraphLoading: graf topologi belum selesai dimuat setelah server dimulai.
var ErrGraphLoading = errors.New("graf topologi sedang dimuat")

// SLDRequest adalah cakupan diagram.
type SLDRequest struct {
	Scope   string       `json:"scope"` // feeder | gi | gd | node | area
	ID      int64        `json:"id"`
	Level   string       `json:"level"`
	Polygon [][2]float64 `json:"polygon,omitempty"` // area: cincin [lng,lat]
}

// SLDNode adalah elemen diagram (objek jaringan atau kelompok pelanggan teragregasi).
type SLDNode struct {
	ID         int64   `json:"id"`
	Kind       string  `json:"kind"` // node | customers
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	TypeCode   string  `json:"type_code"`
	Energized  bool    `json:"energized"`
	Open       bool    `json:"open"`
	OpenWays   []int64 `json:"open_ways,omitempty"`
	NormalOpen bool    `json:"normal_open,omitempty"`
	Switch     bool    `json:"switch,omitempty"`
	Source     bool    `json:"source,omitempty"`
	Sink       bool    `json:"sink,omitempty"`
	Parent     int64   `json:"parent"`  // 0 = akar
	Section    int64   `json:"section"` // seksi dari induk ke elemen ini
	Depth      int     `json:"depth"`
	Feeder     int64   `json:"feeder,omitempty"`
	Zone       int64   `json:"zone,omitempty"`
	Customers  int     `json:"customers"` // pelanggan di hilir (seluruh pohon, tanpa memandang tingkat detail)
	LoadVA     float64 `json:"load_va"`
	OffCust    int     `json:"customers_off"`
	Count      int     `json:"count,omitempty"` // customers: jumlah pelanggan yang diagregasi
	KVA        float64 `json:"kva,omitempty"`   // trafo: kapasitas
	SSOT       string  `json:"kode_ssot,omitempty"`
	Outside    bool    `json:"outside,omitempty"`   // area: di luar area (jalur hulu)
	Collapsed  int     `json:"collapsed,omitempty"` // jumlah objek yang dilipat di seksi induk
	Head       bool    `json:"head,omitempty"`      // kepala penyulang
}

// SLDSection adalah satu ruas diagram: satu saluran atau gabungan segmen berurutan.
type SLDSection struct {
	ID        int64   `json:"id"` // id saluran pertama
	EdgeIDs   []int64 `json:"edge_ids"`
	From      int64   `json:"from"`
	To        int64   `json:"to"`
	TypeCode  string  `json:"type_code"`
	Code      string  `json:"code"`
	Conductor string  `json:"conductor,omitempty"`
	LengthM   float64 `json:"length_m"`
	Energized bool    `json:"energized"`
	Open      bool    `json:"open"`    // saluran diputus
	Skipped   int     `json:"skipped"` // objek pass-through yang dihapus
	Mixed     bool    `json:"mixed,omitempty"`
}

// SLDTie adalah sambungan di luar pohon: tie normally-open ke penyulang lain, loop, atau
// penghubung antar-halaman (area).
type SLDTie struct {
	ID        int64  `json:"id"` // id saluran
	From      int64  `json:"from"`
	To        int64  `json:"to"`
	ToCode    string `json:"to_code"`
	ToType    string `json:"to_type"`
	ToFeeder  int64  `json:"to_feeder,omitempty"`
	FeederCd  string `json:"to_feeder_code,omitempty"`
	Kind      string `json:"kind"` // tie | loop | offpage
	Open      bool   `json:"open"` // jalur terbuka (switch / arah / saluran)
	Energized bool   `json:"energized"`
	Customers int    `json:"customers,omitempty"` // offpage: pelanggan di hilir
}

// SLDDiagram adalah hasil penyusunan.
type SLDDiagram struct {
	Scope     string        `json:"scope"`
	ScopeID   int64         `json:"scope_id"`
	ScopeKey  string        `json:"scope_key"`
	Level     string        `json:"level"`
	Title     string        `json:"title"`
	Roots     []int64       `json:"roots"`
	Nodes     []SLDNode     `json:"nodes"`
	Sections  []SLDSection  `json:"sections"`
	Ties      []SLDTie      `json:"ties"`
	Warnings  []string      `json:"warnings"`
	Truncated bool          `json:"truncated"`
	Stats     SLDStats      `json:"stats"`
	Gen       uint64        `json:"gen"`
	At        time.Time     `json:"at"`
	Feeders   []SLDFeederIn `json:"feeders"` // penyulang yang tercakup
}

type SLDStats struct {
	Elements  int     `json:"elements"`
	Raw       int     `json:"raw_nodes"`
	Customers int     `json:"customers"`
	OffCust   int     `json:"customers_off"`
	LoadVA    float64 `json:"load_va"`
	LengthM   float64 `json:"length_m"`
	BuildMS   int64   `json:"build_ms"`
}

type SLDFeederIn struct {
	Head int64  `json:"head"`
	Code string `json:"code"`
}

// SLD membangun diagram satu garis dari graf.
type SLD struct {
	pool  *pgxpool.Pool
	graph *Graph
	types *Types
	max   func() int

	mu    sync.Mutex
	cache map[string]*SLDDiagram

	pendingNDist map[int64]int32 // jarak normal yang baru dihitung (build berjalan di bawah s.mu build)
	buildMu      sync.Mutex
}

// NewSLD membuat layanan SLD.
func NewSLD(pool *pgxpool.Pool, g *Graph, t *Types, maxElements func() int) *SLD {
	return &SLD{pool: pool, graph: g, types: t, max: maxElements, cache: map[string]*SLDDiagram{}}
}

// ScopeKey adalah kunci cakupan (untuk cache & posisi manual).
func (r SLDRequest) ScopeKey() string {
	if r.Scope == "area" {
		h := uint64(1469598103934665603)
		for _, p := range r.Polygon {
			for _, v := range p {
				h ^= uint64(int64(v * 1e6))
				h *= 1099511628211
			}
		}
		return fmt.Sprintf("area:%x", h)
	}
	return fmt.Sprintf("%s:%d", r.Scope, r.ID)
}

// Resolve menentukan cakupan bawaan untuk sebuah objek: GI → gi, gardu → gd, lainnya → penyulangnya.
func (s *SLD) Resolve(kind string, id int64) (SLDRequest, bool) {
	g := s.graph
	if kind == "edge" {
		g.mu.RLock()
		e, ok := g.edges[id]
		g.mu.RUnlock()
		if !ok {
			return SLDRequest{}, false
		}
		id = e.from
		if ct, ok := s.types.Get(g.typeNames[e.typ]); ok && ct.VoltageKV >= 1 {
			g.mu.RLock()
			n := g.nodes[id]
			g.mu.RUnlock()
			if n.feeder != 0 {
				return SLDRequest{Scope: "feeder", ID: n.feeder}, true
			}
		}
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	n, ok := g.nodes[id]
	if !ok {
		return SLDRequest{}, false
	}
	typ := g.typeNames[n.typ]
	switch typ {
	case "gi", "power_grid":
		return SLDRequest{Scope: "gi", ID: id}, true
	case "gd":
		return SLDRequest{Scope: "gd", ID: id}, true
	}
	if _, head := g.feeders[id]; head {
		return SLDRequest{Scope: "feeder", ID: id}, true
	}
	if n.feeder != 0 {
		return SLDRequest{Scope: "feeder", ID: n.feeder}, true
	}
	if n.gd != 0 {
		return SLDRequest{Scope: "gd", ID: n.gd}, true
	}
	return SLDRequest{Scope: "node", ID: id}, true
}

// Build menyusun (atau mengambil dari cache) diagram.
func (s *SLD) Build(ctx context.Context, req SLDRequest) (*SLDDiagram, error) {
	level := req.Level
	if level == "" {
		level = "tm"
	}
	lv := -1
	for i, l := range SLDLevels {
		if l == level {
			lv = i
		}
	}
	if lv < 0 {
		return nil, ErrBadRequest
	}
	req.Level = level
	key := req.ScopeKey() + "|" + level
	s.graph.mu.RLock()
	gen := s.graph.gen
	s.graph.mu.RUnlock()
	s.mu.Lock()
	if d, ok := s.cache[key]; ok && d.Gen == gen && time.Since(d.At) < 10*time.Minute {
		s.mu.Unlock()
		return d, nil
	}
	s.mu.Unlock()

	start := time.Now()
	var members map[int64]struct{}
	if req.Scope == "area" {
		if len(req.Polygon) < 3 {
			return nil, ErrBadRequest
		}
		m, err := s.nodesInPolygon(ctx, req.Polygon)
		if err != nil {
			return nil, err
		}
		members = m
	}
	s.buildMu.Lock()
	d, err := s.build(req, lv, members)
	if nd := s.pendingNDist; nd != nil {
		s.pendingNDist = nil
		s.graph.mu.Lock()
		if s.graph.ndist == nil && s.graph.gen == gen {
			s.graph.ndist = nd
		}
		s.graph.mu.Unlock()
	}
	s.buildMu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := s.fillCodes(ctx, d); err != nil {
		return nil, err
	}
	d.Gen, d.At, d.ScopeKey = gen, time.Now(), req.ScopeKey()
	d.Stats.BuildMS = time.Since(start).Milliseconds()
	incomplete := false
	for _, w := range d.Warnings {
		if w == "graph_loading" {
			incomplete = true
		}
	}
	if !incomplete {
		s.mu.Lock()
		if len(s.cache) > 64 {
			s.cache = map[string]*SLDDiagram{}
		}
		s.cache[key] = d
		s.mu.Unlock()
	}
	return d, nil
}

// nodesInPolygon mengembalikan id node topologi di dalam poligon [lng,lat].
func (s *SLD) nodesInPolygon(ctx context.Context, ring [][2]float64) (map[int64]struct{}, error) {
	if ring[0] != ring[len(ring)-1] {
		ring = append(ring, ring[0])
	}
	gj, _ := json.Marshal(map[string]any{"type": "Polygon", "coordinates": [][][2]float64{ring}})
	rows, err := s.pool.Query(ctx, `SELECT n.id FROM gis_nodes n
		JOIN component_types t ON t.code = n.type_code AND t.topology
		WHERE n.geom && ST_GeomFromGeoJSON($1) AND ST_Intersects(n.geom, ST_GeomFromGeoJSON($1)) LIMIT 200000`, string(gj))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]struct{}{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// detailRank: 0 = TM, 1 = trafo/rak gardu, 2 = jaringan TR, 3 = pelanggan TR.
func (s *SLD) detailRank(typ string, viaLV bool, sink bool) int {
	ct, _ := s.types.Get(typ)
	lvType := ct.VoltageKV > 0 && ct.VoltageKV < 1
	switch {
	case sink && lvType:
		return 3
	case typ == "trafo_distribusi" || typ == "rak_tr":
		return 1
	case typ == "switch_jurusan_tr":
		return 2
	case viaLV || (lvType && typ != "gd"):
		return 2
	}
	return 0
}

// keeper: objek yang selalu dipertahankan (tidak dilipat) dalam penyederhanaan.
func (s *SLD) keeper(typ string, n nodeRec) bool {
	if n.source() || n.sink() || n.isSwitch() {
		return true
	}
	switch typ {
	case "junction", "tiang_tm", "tiang_tr":
		return false
	}
	return true
}

type sldWork struct {
	id       int64
	parent   int64
	edge     int64 // edge dari induk
	depth    int
	rank     int
	children []int64
	cust     int
	custOff  int
	loadVA   float64
	viaLV    bool
	outside  bool
	keep     bool
}

func (s *SLD) build(req SLDRequest, lv int, members map[int64]struct{}) (*SLDDiagram, error) {
	g := s.graph
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.loading || len(g.nodes) == 0 {
		return nil, ErrGraphLoading
	}

	// jarak posisi normal (topologi normal): diagram tidak berubah karena manuver
	ndist, fresh := g.normalDistLocked()
	if fresh {
		s.pendingNDist = ndist // disimpan ke graf setelah RLock dilepas
	}
	lvEdge := make([]bool, len(g.typeNames))
	busbarIdx, hasBusbar := g.typeIndex["busbar"]
	for i, name := range g.typeNames {
		ct, _ := g.types.Get(name)
		lvEdge[i] = ct.GeomKind == "line" && ct.VoltageKV > 0 && ct.VoltageKV < 1
	}
	passable := func(cur, eid int64, e edgeRec) bool {
		return !wayOpen(g.normalOpenWays, cur, eid) && !wayOpen(g.normalOpenWays, e.other(cur), eid)
	}

	d := &SLDDiagram{Scope: req.Scope, ScopeID: req.ID, Level: SLDLevels[lv], Warnings: []string{}, Ties: []SLDTie{},
		Roots: []int64{}, Nodes: []SLDNode{}, Sections: []SLDSection{}, Feeders: []SLDFeederIn{}}
	if g.loading || g.distDirty || len(g.feeders) == 0 {
		// graf baru dimuat / pengelompokan penyulang belum selesai: diagram belum lengkap
		d.Warnings = append(d.Warnings, "graph_loading")
	}

	// ---- akar & jalur hulu
	roots := []int64{}
	prefix := map[int64]struct{}{}         // node pada jalur hulu (selalu dipertahankan, di luar cakupan utama)
	upstream := func(from int64) []int64 { // jalur from → sumber (jarak menurun)
		path := []int64{}
		cur := from
		for guard := 0; guard < 100000; guard++ {
			path = append(path, cur)
			d0, ok := ndist[cur]
			if !ok || d0 == 0 {
				break
			}
			next := int64(0)
			for _, eid := range g.adj[cur] {
				e := g.edges[eid]
				if !passable(cur, eid, e) {
					continue
				}
				nb := e.other(cur)
				if dn, ok := ndist[nb]; ok && dn == d0-1 && !(g.nodes[nb].flags&flagNormalOpen != 0 && dn != 0) {
					if next == 0 || nb < next {
						next = nb
					}
				}
			}
			if next == 0 {
				break
			}
			cur = next
		}
		return path
	}
	// pohon dibangun dari akar dengan aturan turun: nb dengan ndist = d+1
	parentOf := map[int64]int64{}
	edgeOf := map[int64]int64{}
	inTree := map[int64]*sldWork{}
	order := []int64{}
	feederScope := req.Scope == "feeder"
	gdScope := req.Scope == "gd"
	giNode := int64(0)
	pathOf := func(id int64) []int64 { // jalur hulu; semua node jalur (kecuali objek) = prefix
		if _, ok := g.nodes[id]; !ok {
			return nil
		}
		path := upstream(id)
		for _, p := range path[1:] {
			prefix[p] = struct{}{}
		}
		return path
	}
	switch req.Scope {
	case "feeder":
		if _, ok := g.feeders[req.ID]; !ok {
			return nil, ErrNotFound
		}
		path := pathOf(req.ID)
		roots = []int64{path[len(path)-1]}
	case "gi", "node":
		path := pathOf(req.ID)
		if path == nil {
			return nil, ErrNotFound
		}
		roots = []int64{path[len(path)-1]}
		if req.Scope == "gi" {
			giNode = req.ID
		}
	case "gd":
		path := pathOf(req.ID)
		if path == nil {
			return nil, ErrNotFound
		}
		roots = []int64{path[len(path)-1]}
		if lv < 3 {
			lv = 3 // gardu: selalu sampai pelanggan
			d.Level = "pelanggan"
		}
	case "area":
		seen := map[int64]struct{}{}
		for id := range members {
			if _, ok := ndist[id]; !ok {
				continue
			}
			path := upstream(id)
			for _, p := range path[1:] {
				if _, in := members[p]; !in {
					prefix[p] = struct{}{}
				}
			}
			r := path[len(path)-1]
			if _, ok := seen[r]; !ok {
				seen[r] = struct{}{}
				roots = append(roots, r)
			}
		}
		sort.Slice(roots, func(i, j int) bool { return roots[i] < roots[j] })
		if len(roots) == 0 {
			d.Warnings = append(d.Warnings, "area_empty")
		}
	default:
		return nil, ErrSLDScope
	}
	// gd: objek cakupan sendiri bukan prefix; node lain di jalur (termasuk gardu lain) dilipat
	delete(prefix, req.ID)

	// ---- BFS pohon (topologi normal) dengan batas cakupan
	queue := []int64{}
	push := func(id, parent, edge int64, depth int, viaLV, outside bool) {
		rank := 0
		if _, isPrefix := prefix[id]; !isPrefix {
			n := g.nodes[id]
			rank = s.detailRank(g.typeNames[n.typ], viaLV, n.sink())
		}
		w := &sldWork{id: id, parent: parent, edge: edge, depth: depth, rank: rank, viaLV: viaLV, outside: outside}
		inTree[id] = w
		parentOf[id] = parent
		edgeOf[id] = edge
		order = append(order, id)
		queue = append(queue, id)
	}
	for _, r := range roots {
		_, out := prefix[r]
		push(r, 0, 0, 0, false, out && req.Scope == "area")
	}
	rawLimit := 400000
	for qi := 0; qi < len(queue) && len(order) < rawLimit; qi++ {
		cur := queue[qi]
		w := inTree[cur]
		cn := g.nodes[cur]
		d0 := ndist[cur]
		_, curPrefix := prefix[cur]
		if cn.flags&flagNormalOpen != 0 && d0 != 0 {
			// switch normally-open: ujung pohon; sisi lain = tie
			for _, eid := range g.adj[cur] {
				if eid == w.edge {
					continue
				}
				e := g.edges[eid]
				nb := e.other(cur)
				d.Ties = append(d.Ties, s.tieLocked(cur, nb, eid, e, "tie", true))
			}
			continue
		}
		for _, eid := range g.adj[cur] {
			if eid == w.edge {
				continue
			}
			e := g.edges[eid]
			nb := e.other(cur)
			nn := g.nodes[nb]
			nbTyp := g.typeNames[nn.typ]
			dn, reached := ndist[nb]
			_, nbPrefix := prefix[nb]
			if curPrefix {
				// jalur hulu: hanya ikuti jalur menuju objek cakupan / anggota area (tanpa tie)
				_, member := members[nb]
				if !nbPrefix && nb != req.ID && !member {
					continue
				}
			}
			if !passable(cur, eid, e) {
				// arah normally-open (LBS 3 way): tie
				d.Ties = append(d.Ties, s.tieLocked(cur, nb, eid, e, "tie", true))
				continue
			}
			if !reached {
				continue // tidak bertegangan pada topologi normal: pulau; diabaikan
			}
			if dn != d0+1 {
				if dn == d0-1 || (dn == d0 && nb < cur) {
					continue // sisi hulu / sejajar sudah ditangani dari sisi lain
				}
				if dn == d0 {
					d.Ties = append(d.Ties, s.tieLocked(cur, nb, eid, e, "loop", false))
				}
				continue
			}
			if _, done := inTree[nb]; done {
				d.Ties = append(d.Ties, s.tieLocked(cur, nb, eid, e, "loop", false))
				continue
			}
			if feederScope && !curPrefix {
				// di dalam penyulang: tidak menyeberang busbar / ke kepala penyulang lain
				if hasBusbar && e.typ == busbarIdx {
					continue
				}
				if _, otherHead := g.feeders[nb]; otherHead && nb != req.ID {
					continue
				}
			}
			if giNode != 0 && nbTyp == "gi" && nb != giNode {
				continue // jangan turun ke GI lain lewat transmisi
			}
			if gdScope && !curPrefix {
				// di dalam gardu: hanya trafo, rak, jaringan TR, dan pelanggan (bukan TM hilir)
				if s.detailRank(nbTyp, w.viaLV || lvEdge[e.typ], nn.sink()) == 0 && !nn.sink() {
					continue
				}
			}
			if members != nil && !nbPrefix {
				if _, in := members[nb]; !in {
					// keluar area di hilir: penghubung antar-halaman
					d.Ties = append(d.Ties, s.tieLocked(cur, nb, eid, e, "offpage", e.open))
					continue
				}
			}
			viaLV := w.viaLV || lvEdge[e.typ]
			push(nb, cur, eid, w.depth+1, viaLV, nbPrefix && members != nil)
			w.children = append(w.children, nb)
		}
	}
	if len(order) >= rawLimit {
		d.Warnings = append(d.Warnings, "raw_limit")
		d.Truncated = true
	}
	d.Stats.Raw = len(order)

	// ---- rekap hilir (urutan terbalik BFS = anak sebelum induk)
	for i := len(order) - 1; i >= 0; i-- {
		w := inTree[order[i]]
		n := g.nodes[w.id]
		if n.sink() {
			w.cust++
			w.loadVA += float64(n.loadVA)
			if !n.energized() {
				w.custOff++
			}
		}
		if p := inTree[w.parent]; p != nil {
			p.cust += w.cust
			p.custOff += w.custOff
			p.loadVA += w.loadVA
		}
	}

	// ---- tingkat detail: potong subpohon di bawah rank yang diminta, agregasi pelanggan
	included := map[int64]bool{}
	aggregate := map[int64]*SLDNode{} // pseudo node pelanggan per titik potong
	for _, id := range order {
		w := inTree[id]
		if w.parent != 0 && !included[w.parent] {
			continue
		}
		if w.rank > lv {
			// dipotong: agregasi ke induk (hanya bila subpohon punya pelanggan)
			if w.cust > 0 && lv >= 1 {
				a := aggregate[w.parent]
				if a == nil {
					a = &SLDNode{ID: -w.parent, Kind: "customers", Parent: w.parent, Depth: inTree[w.parent].depth + 1}
					aggregate[w.parent] = a
				}
				a.Count += w.cust
				a.Customers += w.cust
				a.OffCust += w.custOff
				a.LoadVA += w.loadVA
			}
			continue
		}
		included[id] = true
	}
	// tie yang ujungnya dipotong tingkat detail tidak digambar
	ties := d.Ties[:0]
	for _, t := range d.Ties {
		if included[t.From] {
			ties = append(ties, t)
		}
	}
	d.Ties = ties
	tieAt := map[int64]bool{}
	for _, t := range d.Ties {
		tieAt[t.From] = true
	}

	// ---- penyederhanaan: lipat objek pass-through (satu anak, bukan keeper)
	childrenInc := map[int64][]int64{}
	for _, id := range order {
		if !included[id] {
			continue
		}
		w := inTree[id]
		if w.parent != 0 {
			childrenInc[w.parent] = append(childrenInc[w.parent], id)
		}
	}
	scopeNode := g.nodes[req.ID]
	prefixKeep := func(id int64) bool { // node jalur hulu yang dipertahankan sebagai konteks
		n := g.nodes[id]
		typ := g.typeNames[n.typ]
		_, head := g.feeders[id]
		if n.source() || typ == "gi" || typ == "trafo_gi" || typ == "gh" {
			return true
		}
		switch req.Scope {
		case "feeder", "gi":
			return typ == "kubikel_20kv" && !head // kubikel incoming / kopel; kepala penyulang lain dilipat
		case "node":
			return (head && id == scopeNode.feeder) || n.isSwitch()
		case "gd":
			return id == scopeNode.feeder || id == scopeNode.zone
		}
		return head || n.isSwitch() // area
	}
	keep := func(id int64) bool {
		w := inTree[id]
		if w.parent == 0 || tieAt[id] || aggregate[id] != nil || len(childrenInc[id]) != 1 {
			return true
		}
		if _, isPrefix := prefix[id]; isPrefix {
			return prefixKeep(id)
		}
		return s.keeper(g.typeNames[g.nodes[id].typ], g.nodes[id])
	}
	// urutan anak: cabang utama (pelanggan terbanyak, lalu elemen terbanyak) dulu, sisanya per id
	sizeOf := map[int64]int{}
	for i := len(order) - 1; i >= 0; i-- {
		id := order[i]
		if !included[id] {
			continue
		}
		sz := 1
		for _, c := range childrenInc[id] {
			sz += sizeOf[c]
		}
		sizeOf[id] = sz
	}

	nodes := []SLDNode{}
	sections := []SLDSection{}
	var custTotal, custOff int
	var loadTotal, lenTotal float64
	var walk func(id, parentOut int64, sec *SLDSection, depth int)
	walk = func(id, parentOut int64, sec *SLDSection, depth int) {
		w := inTree[id]
		n := g.nodes[id]
		typ := g.typeNames[n.typ]
		if !keep(id) {
			// lipat: seksi diteruskan ke anak tunggal
			c := childrenInc[id][0]
			cw := inTree[c]
			e := g.edges[cw.edge]
			if sec == nil {
				sec = &SLDSection{ID: cw.edge, EdgeIDs: []int64{cw.edge}, From: parentOut, TypeCode: g.typeNames[e.typ], LengthM: float64(e.lengthM), Energized: e.energized, Open: e.open}
			} else {
				sec.EdgeIDs = append(sec.EdgeIDs, cw.edge)
				sec.LengthM += float64(e.lengthM)
				sec.Skipped++
				sec.Energized = sec.Energized && e.energized
				sec.Open = sec.Open || e.open
				if g.typeNames[e.typ] != sec.TypeCode {
					sec.Mixed = true
				}
			}
			walk(c, parentOut, sec, depth)
			return
		}
		out := SLDNode{ID: id, Kind: "node", TypeCode: typ, Energized: n.energized(), Open: n.open(), Switch: n.isSwitch(), Source: n.source(), Sink: n.sink(),
			Parent: parentOut, Depth: depth, Feeder: n.feeder, Zone: n.zone, Customers: w.cust, OffCust: w.custOff, LoadVA: w.loadVA, Outside: w.outside,
			NormalOpen: n.flags&flagNormalOpen != 0}
		if _, head := g.feeders[id]; head {
			out.Head = true
		}
		if m := g.openWays[id]; len(m) > 0 {
			for eid := range m {
				out.OpenWays = append(out.OpenWays, eid)
			}
			sort.Slice(out.OpenWays, func(i, j int) bool { return out.OpenWays[i] < out.OpenWays[j] })
		}
		if sec != nil {
			out.Section = sec.ID
			sec.To = id
			out.Collapsed = sec.Skipped
			lenTotal += sec.LengthM
			sections = append(sections, *sec)
		}
		nodes = append(nodes, out)
		if a := aggregate[id]; a != nil {
			a.Depth = depth + 1
			custTotal += 0
		}
		kids := append([]int64{}, childrenInc[id]...)
		sort.Slice(kids, func(i, j int) bool {
			a, b := inTree[kids[i]], inTree[kids[j]]
			if a.cust != b.cust {
				return a.cust > b.cust
			}
			if sizeOf[kids[i]] != sizeOf[kids[j]] {
				return sizeOf[kids[i]] > sizeOf[kids[j]]
			}
			return kids[i] < kids[j]
		})
		for _, c := range kids {
			cw := inTree[c]
			e := g.edges[cw.edge]
			ns := &SLDSection{ID: cw.edge, EdgeIDs: []int64{cw.edge}, From: id, TypeCode: g.typeNames[e.typ], LengthM: float64(e.lengthM), Energized: e.energized, Open: e.open}
			walk(c, id, ns, depth+1)
		}
		if a := aggregate[id]; a != nil {
			a.Parent = id
			a.Energized = a.OffCust < a.Count
			nodes = append(nodes, *a)
		}
	}
	for _, r := range roots {
		if included[r] {
			walk(r, 0, nil, 0)
		}
	}
	for _, r := range roots {
		if w := inTree[r]; w != nil {
			custTotal += w.cust
			custOff += w.custOff
			loadTotal += w.loadVA
		}
	}
	d.Roots = roots
	d.Nodes, d.Sections = nodes, sections
	d.Stats.Elements = len(nodes) + len(sections)
	d.Stats.Customers, d.Stats.OffCust, d.Stats.LoadVA, d.Stats.LengthM = custTotal, custOff, loadTotal, lenTotal
	if mx := s.max(); mx > 0 && len(nodes) > mx {
		d.Truncated = true
		d.Warnings = append(d.Warnings, "too_many_elements")
		d.Nodes = d.Nodes[:mx]
		keepN := map[int64]bool{}
		for _, n := range d.Nodes {
			keepN[n.ID] = true
		}
		secs := d.Sections[:0]
		for _, sc := range d.Sections {
			if keepN[sc.To] {
				secs = append(secs, sc)
			}
		}
		d.Sections = secs
	}
	// penyulang tercakup
	fseen := map[int64]struct{}{}
	for _, n := range d.Nodes {
		if n.Head {
			if _, ok := fseen[n.ID]; !ok {
				fseen[n.ID] = struct{}{}
				d.Feeders = append(d.Feeders, SLDFeederIn{Head: n.ID})
			}
		}
	}
	return d, nil
}

func (s *SLD) tieLocked(from, to, eid int64, e edgeRec, kind string, open bool) SLDTie {
	g := s.graph
	nn := g.nodes[to]
	t := SLDTie{ID: eid, From: from, To: to, ToType: g.typeNames[nn.typ], ToFeeder: nn.feeder, Kind: kind, Open: open || e.open || g.nodes[from].open() || nn.open(), Energized: e.energized}
	if kind == "loop" && t.Open {
		t.Kind = "tie" // sambungan terbuka ke bagian lain jaringan = tie normally-open
	}
	if kind == "offpage" {
		// pelanggan di hilir titik keluar (dari rekap zona/gardu tidak tersedia di sini): dihitung cepat dengan BFS kecil dibatasi
		t.Customers = s.downstreamCustomersLocked(to, from, 20000)
	}
	return t
}

// downstreamCustomersLocked menghitung pelanggan di hilir `start` (tanpa melewati `exclude`), dibatasi.
func (s *SLD) downstreamCustomersLocked(start, exclude int64, limit int) int {
	g := s.graph
	seen := map[int64]struct{}{start: {}, exclude: {}}
	queue := []int64{start}
	cnt := 0
	for head := 0; head < len(queue) && head < limit; head++ {
		cur := queue[head]
		n := g.nodes[cur]
		if n.sink() {
			cnt++
		}
		d0, ok := g.dist[cur]
		if !ok {
			continue
		}
		for _, eid := range g.adj[cur] {
			nb := g.edges[eid].other(cur)
			if _, done := seen[nb]; done {
				continue
			}
			if dn, ok := g.dist[nb]; ok && dn == d0+1 {
				seen[nb] = struct{}{}
				queue = append(queue, nb)
			}
		}
	}
	return cnt
}

// fillCodes mengisi kode / nama / atribut dari basis data.
func (s *SLD) fillCodes(ctx context.Context, d *SLDDiagram) error {
	nodeIDs := make([]int64, 0, len(d.Nodes)+len(d.Ties))
	for _, n := range d.Nodes {
		if n.Kind == "node" {
			nodeIDs = append(nodeIDs, n.ID)
		}
	}
	for _, t := range d.Ties {
		nodeIDs = append(nodeIDs, t.To)
		if t.ToFeeder != 0 {
			nodeIDs = append(nodeIDs, t.ToFeeder)
		}
	}
	for _, f := range d.Feeders {
		nodeIDs = append(nodeIDs, f.Head)
	}
	nodeIDs = append(nodeIDs, d.ScopeID)
	type nrow struct {
		code, name, ssot string
		kva              float64
	}
	names := map[int64]nrow{}
	rows, err := s.pool.Query(ctx, `SELECT id, code, name, COALESCE(properties->>'kode_ssot',''),
		COALESCE(NULLIF(properties->>'daya_kva','')::float8, NULLIF(properties->>'kapasitas_kva','')::float8, NULLIF(properties->>'daya_mva','')::float8 * 1000, 0)
		FROM gis_nodes WHERE id = ANY($1)`, nodeIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var r nrow
		if err := rows.Scan(&id, &r.code, &r.name, &r.ssot, &r.kva); err != nil {
			rows.Close()
			return err
		}
		names[id] = r
	}
	rows.Close()
	edgeIDs := make([]int64, 0, len(d.Sections)+len(d.Ties))
	for _, sc := range d.Sections {
		edgeIDs = append(edgeIDs, sc.ID)
	}
	for _, t := range d.Ties {
		edgeIDs = append(edgeIDs, t.ID)
	}
	type erow struct{ code, cond string }
	ecodes := map[int64]erow{}
	erows, err := s.pool.Query(ctx, `SELECT id, code, COALESCE(properties->>'penghantar', properties->>'jenis_penghantar', '') FROM gis_edges WHERE id = ANY($1)`, edgeIDs)
	if err != nil {
		return err
	}
	for erows.Next() {
		var id int64
		var r erow
		if err := erows.Scan(&id, &r.code, &r.cond); err != nil {
			erows.Close()
			return err
		}
		ecodes[id] = r
	}
	erows.Close()
	for i := range d.Nodes {
		n := &d.Nodes[i]
		if n.Kind != "node" {
			continue
		}
		r := names[n.ID]
		n.Code, n.Name, n.SSOT, n.KVA = r.code, r.name, r.ssot, r.kva
	}
	for i := range d.Sections {
		r := ecodes[d.Sections[i].ID]
		d.Sections[i].Code, d.Sections[i].Conductor = r.code, r.cond
	}
	for i := range d.Ties {
		t := &d.Ties[i]
		t.ToCode = names[t.To].code
		if t.ToFeeder != 0 {
			t.FeederCd = names[t.ToFeeder].code
		}
	}
	for i := range d.Feeders {
		d.Feeders[i].Code = names[d.Feeders[i].Head].code
	}
	sc := names[d.ScopeID]
	switch d.Scope {
	case "feeder":
		d.Title = "Penyulang " + sc.code
	case "gi":
		d.Title = sc.code
	case "gd":
		d.Title = "Gardu " + sc.code
	case "node":
		d.Title = sc.code
	default:
		d.Title = fmt.Sprintf("Area (%d penyulang)", len(d.Feeders))
	}
	if sc.name != "" && d.Scope != "area" {
		d.Title += " · " + sc.name
	}
	d.Title = strings.TrimSpace(d.Title)
	return nil
}

// ---------------------------------------------------------------- posisi manual

type SLDPos struct {
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
}

func (s *SLD) Positions(ctx context.Context, scope string) (map[int64]SLDPos, error) {
	rows, err := s.pool.Query(ctx, `SELECT node_id, dx, dy FROM sld_positions WHERE scope = $1`, scope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]SLDPos{}
	for rows.Next() {
		var id int64
		var p SLDPos
		if err := rows.Scan(&id, &p.DX, &p.DY); err != nil {
			return nil, err
		}
		out[id] = p
	}
	return out, rows.Err()
}

func (s *SLD) SavePositions(ctx context.Context, scope string, pos map[int64]SLDPos, userID *string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for id, p := range pos {
		if p.DX == 0 && p.DY == 0 {
			if _, err := tx.Exec(ctx, `DELETE FROM sld_positions WHERE scope=$1 AND node_id=$2`, scope, id); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sld_positions (scope, node_id, dx, dy, updated_by) VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (scope, node_id) DO UPDATE SET dx=EXCLUDED.dx, dy=EXCLUDED.dy, updated_by=EXCLUDED.updated_by, updated_at=now()`,
			scope, id, p.DX, p.DY, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *SLD) ResetPositions(ctx context.Context, scope string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sld_positions WHERE scope=$1`, scope)
	return err
}
