package gis

import (
	"container/heap"
	"context"
	"errors"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/i18n"
)

// Graph adalah representasi jaringan kelistrikan di memori untuk trace, status
// energisasi (nyala/padam), dan pengelompokan penyulang / zona / jurusan.
// Node dan edge disimpan seringkas mungkin sehingga jutaan fitur muat di memori
// dan trace berjalan dalam milidetik. Hanya tipe bertopologi yang dimuat
// (objek pendukung seperti tiang tidak ikut membentuk graf).
type Graph struct {
	mu    sync.RWMutex
	types *Types

	typeNames []string          // indeks -> kode tipe
	typeIndex map[string]uint16 // kode tipe -> indeks

	nodes map[int64]nodeRec
	edges map[int64]edgeRec
	adj   map[int64][]int64 // node -> daftar edge id

	openWays       map[int64]map[int64]struct{} // switch multi-arah: edge yang sedang terbuka pada node
	normalOpenWays map[int64]map[int64]struct{} // posisi normal arah (untuk pengelompokan)

	dist      map[int64]int32 // jarak hop dari sumber terdekat (jalur tertutup)
	distDirty bool
	builtAt   time.Time
	distAt    time.Time
	loading   bool

	feeders  map[int64]*feederInfo // kepala penyulang (kubikel outgoing) -> info
	groupsAt time.Time

	// cache ringkasan (dihitung ulang malas setelah muat/refresh)
	countsDirty bool
	nSources    int
	nOpen       int

	rebuildMu    sync.Mutex
	rebuildTimer *time.Timer
	groupTimer   *time.Timer
	gen          uint64 // naik setiap status graf berubah (edit / manuver)

	onEnergy      func(EnergyDiff) // dipanggil bila status energisasi berubah akibat muat/edit
	defaultLoadVA float64

	sumMu    sync.Mutex
	sumCache *PowerSummary
	sumFeed  []FeederStatus
	sumGD    []GDStatus
	sumAt    time.Time
}

const (
	flagOpen       uint8 = 1
	flagSource     uint8 = 2
	flagSink       uint8 = 4
	flagSwitch     uint8 = 8
	flagNormalOpen uint8 = 16 // posisi normal switch (untuk pengelompokan penyulang/zona)
	flagEnergized  uint8 = 32 // status energisasi yang tersimpan di DB
)

type nodeRec struct {
	typ    uint16
	flags  uint8
	loadVA uint32 // beban pelanggan (VA)
	feeder int64  // id kepala penyulang (kubikel outgoing), 0 = di luar penyulang
	zone   int64  // id switch hulu terdekat (zona), 0 = -
	route  int64  // id edge TR pertama (jurusan), 0 = bukan JTR
	gd     int64  // id gardu distribusi hulu (termasuk gardu itu sendiri), 0 = -
}

func (n nodeRec) open() bool      { return n.flags&flagOpen != 0 }
func (n nodeRec) source() bool    { return n.flags&flagSource != 0 }
func (n nodeRec) sink() bool      { return n.flags&flagSink != 0 }
func (n nodeRec) isSwitch() bool  { return n.flags&flagSwitch != 0 }
func (n nodeRec) energized() bool { return n.flags&flagEnergized != 0 }

type edgeRec struct {
	from, to  int64
	typ       uint16
	open      bool
	energized bool
}

func (e edgeRec) other(id int64) int64 {
	if e.from == id {
		return e.to
	}
	return e.from
}

type feederInfo struct {
	Head    int64
	GI      int64
	TrafoGI int64
}

// EnergyDiff adalah perubahan status energisasi setelah perhitungan ulang.
type EnergyDiff struct {
	NodesOn  []int64 `json:"nodes_on"`
	NodesOff []int64 `json:"nodes_off"`
	EdgesOn  []int64 `json:"edges_on"`
	EdgesOff []int64 `json:"edges_off"`
}

// Empty menandakan tidak ada perubahan.
func (d EnergyDiff) Empty() bool {
	return len(d.NodesOn) == 0 && len(d.NodesOff) == 0 && len(d.EdgesOn) == 0 && len(d.EdgesOff) == 0
}

// ErrNotSwitch: node bukan alat switching.
var ErrNotSwitch = errors.New("not a switch")

// NewGraph membuat graf kosong.
func NewGraph(types *Types) *Graph {
	return &Graph{types: types, typeIndex: map[string]uint16{}, nodes: map[int64]nodeRec{}, edges: map[int64]edgeRec{}, adj: map[int64][]int64{},
		openWays: map[int64]map[int64]struct{}{}, normalOpenWays: map[int64]map[int64]struct{}{}, dist: map[int64]int32{}, feeders: map[int64]*feederInfo{}, defaultLoadVA: 1300}
}

// OnEnergyChange memasang hook persistensi status energisasi.
func (g *Graph) OnEnergyChange(fn func(EnergyDiff)) { g.onEnergy = fn }

// SetDefaultLoadVA mengatur beban bawaan pelanggan tanpa atribut daya.
func (g *Graph) SetDefaultLoadVA(v float64) {
	if v > 0 {
		g.defaultLoadVA = v
	}
}

// typeIdxLocked mengembalikan indeks tipe (menambah bila baru). Harus dipanggil dengan lock tulis
// atau pada struktur lokal yang belum dipublikasikan.
func (g *Graph) typeIdxLocked(code string) uint16 {
	if i, ok := g.typeIndex[code]; ok {
		return i
	}
	i := uint16(len(g.typeNames))
	g.typeNames = append(g.typeNames, code)
	g.typeIndex[code] = i
	return i
}

type nodeRow struct {
	typ, status string
	energized   bool
	loadVA      float64
	openWays    []int64
	normal      *string
}

func (g *Graph) makeNodeRecLocked(r nodeRow, old *nodeRec) nodeRec {
	ct, _ := g.types.Get(r.typ)
	var flags uint8
	if r.status == "open" {
		flags |= flagOpen
	}
	if ct.IsSource {
		flags |= flagSource
	}
	if ct.IsSink {
		flags |= flagSink
	}
	if ct.IsSwitch {
		flags |= flagSwitch
	}
	if r.energized {
		flags |= flagEnergized
	}
	// posisi normal: atribut SSOT "normal" bila ada; bila tidak, pertahankan yang lama
	// (node yang sudah ada) atau ikuti status saat dimuat (node baru).
	switch {
	case r.normal != nil && *r.normal == "open":
		flags |= flagNormalOpen
	case r.normal != nil:
	case old != nil && old.flags&flagNormalOpen != 0:
		flags |= flagNormalOpen
	case old == nil && r.status == "open":
		flags |= flagNormalOpen
	}
	rec := nodeRec{typ: g.typeIdxLocked(r.typ), flags: flags}
	if r.loadVA > 0 {
		rec.loadVA = uint32(r.loadVA)
	}
	if old != nil {
		rec.feeder, rec.zone, rec.route, rec.gd = old.feeder, old.zone, old.route, old.gd
	}
	return rec
}

func (g *Graph) typeName(i uint16) string {
	if int(i) < len(g.typeNames) {
		return g.typeNames[i]
	}
	return "?"
}

const nodeLoadSQL = `SELECT n.id, n.type_code, n.status, n.energized,
	CASE WHEN t.is_sink THEN COALESCE(qgis_num(n.properties->>'daya_va'), qgis_num(n.properties->>'daya_kva')*1000, qgis_num(n.properties->>'daya_mva')*1000000, $1) ELSE 0 END,
	CASE WHEN t.is_switch AND cardinality(n.open_ways) > 0 THEN n.open_ways ELSE NULL END,
	CASE WHEN t.is_switch THEN n.properties->>'normal' ELSE NULL END
	FROM gis_nodes n JOIN component_types t ON t.code = n.type_code WHERE t.topology`

func waysSet(ids []int64) map[int64]struct{} {
	if len(ids) == 0 {
		return nil
	}
	m := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		m[id] = struct{}{}
	}
	return m
}

// Load memuat seluruh graf dari database (streaming, hemat memori).
func (g *Graph) Load(ctx context.Context, pool *pgxpool.Pool) error {
	start := time.Now()
	g.mu.Lock()
	g.loading = true
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		g.loading = false
		g.mu.Unlock()
	}()

	var nNodes, nEdges int64
	_ = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM gis_nodes), (SELECT count(*) FROM gis_edges)`).Scan(&nNodes, &nEdges)
	nodes := make(map[int64]nodeRec, nNodes)
	edges := make(map[int64]edgeRec, nEdges)
	adj := make(map[int64][]int64, nNodes)
	openWays := map[int64]map[int64]struct{}{}
	normalWays := map[int64]map[int64]struct{}{}

	// pemetaan tipe dibangun pada salinan lokal lalu dipublikasikan bersama graf
	g.mu.RLock()
	names := append([]string{}, g.typeNames...)
	g.mu.RUnlock()
	local := &Graph{types: g.types, typeNames: names, typeIndex: map[string]uint16{}}
	for i, n := range names {
		local.typeIndex[n] = uint16(i)
	}

	rows, err := pool.Query(ctx, nodeLoadSQL, g.defaultLoadVA)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var r nodeRow
		if err := rows.Scan(&id, &r.typ, &r.status, &r.energized, &r.loadVA, &r.openWays, &r.normal); err != nil {
			rows.Close()
			return err
		}
		nodes[id] = local.makeNodeRecLocked(r, nil)
		if len(r.openWays) > 0 {
			openWays[id] = waysSet(r.openWays)
			normalWays[id] = waysSet(r.openWays)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	rows, err = pool.Query(ctx, `SELECT id, from_node_id, to_node_id, type_code, status, energized FROM gis_edges`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, from, to int64
		var typ, status string
		var energized bool
		if err := rows.Scan(&id, &from, &to, &typ, &status, &energized); err != nil {
			rows.Close()
			return err
		}
		edges[id] = edgeRec{from: from, to: to, typ: local.typeIdxLocked(typ), open: status == "open", energized: energized}
		adj[from] = append(adj[from], id)
		adj[to] = append(adj[to], id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	g.mu.Lock()
	g.nodes, g.edges, g.adj = nodes, edges, adj
	g.openWays, g.normalOpenWays = openWays, normalWays
	g.typeNames, g.typeIndex = local.typeNames, local.typeIndex
	g.builtAt = time.Now()
	g.distDirty = true
	g.countsDirty = true
	g.mu.Unlock()
	log.Printf("[graph] dimuat: %d node, %d edge (%s)", len(nodes), len(edges), time.Since(start).Round(time.Millisecond))
	g.RebuildDistances()
	g.computeGroups()
	return nil
}

// Refresh menyinkronkan sebagian node/edge (setelah editing) tanpa memuat ulang semuanya.
func (g *Graph) Refresh(ctx context.Context, pool *pgxpool.Pool, nodeIDs, edgeIDs []int64) error {
	if len(nodeIDs) == 0 && len(edgeIDs) == 0 {
		return nil
	}
	present := map[int64]nodeRow{}
	if len(nodeIDs) > 0 {
		rows, err := pool.Query(ctx, nodeLoadSQL+` AND n.id = ANY($2::bigint[])`, g.defaultLoadVA, nodeIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id int64
			var r nodeRow
			if err := rows.Scan(&id, &r.typ, &r.status, &r.energized, &r.loadVA, &r.openWays, &r.normal); err != nil {
				rows.Close()
				return err
			}
			present[id] = r
		}
		rows.Close()
	}
	presentE := map[int64]edgeRec{}
	presentET := map[int64]string{}
	if len(edgeIDs) > 0 {
		rows, err := pool.Query(ctx, `SELECT id, from_node_id, to_node_id, type_code, status, energized FROM gis_edges WHERE id = ANY($1::bigint[])`, edgeIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, from, to int64
			var typ, status string
			var energized bool
			if err := rows.Scan(&id, &from, &to, &typ, &status, &energized); err != nil {
				rows.Close()
				return err
			}
			presentE[id] = edgeRec{from: from, to: to, open: status == "open", energized: energized}
			presentET[id] = typ
		}
		rows.Close()
	}

	g.mu.Lock()
	for _, id := range edgeIDs {
		if old, ok := g.edges[id]; ok {
			g.removeAdj(old.from, id)
			g.removeAdj(old.to, id)
			delete(g.edges, id)
		}
	}
	for _, id := range nodeIDs {
		if r, ok := present[id]; ok {
			var old *nodeRec
			if o, ok := g.nodes[id]; ok {
				old = &o
			}
			g.nodes[id] = g.makeNodeRecLocked(r, old)
			if len(r.openWays) > 0 {
				g.openWays[id] = waysSet(r.openWays)
				if _, ok := g.normalOpenWays[id]; !ok || old == nil {
					g.normalOpenWays[id] = waysSet(r.openWays)
				}
			} else {
				delete(g.openWays, id)
				if old == nil {
					delete(g.normalOpenWays, id)
				}
			}
		} else {
			delete(g.nodes, id)
			delete(g.adj, id)
			delete(g.openWays, id)
			delete(g.normalOpenWays, id)
		}
	}
	for id, rec := range presentE {
		rec.typ = g.typeIdxLocked(presentET[id])
		g.edges[id] = rec
		g.adj[rec.from] = append(g.adj[rec.from], id)
		g.adj[rec.to] = append(g.adj[rec.to], id)
	}
	g.gen++
	g.distDirty = true
	g.countsDirty = true
	g.mu.Unlock()
	g.scheduleRebuild()
	return nil
}

func (g *Graph) removeAdj(node, edge int64) {
	list := g.adj[node]
	for i, e := range list {
		if e == edge {
			list[i] = list[len(list)-1]
			g.adj[node] = list[:len(list)-1]
			break
		}
	}
	if len(g.adj[node]) == 0 {
		delete(g.adj, node)
	}
}

// scheduleRebuild menjadwalkan perhitungan ulang jarak sumber (debounce 300 ms) dan
// pengelompokan penyulang/zona/jurusan (debounce 5 dtk; lebih berat dan jarang berubah).
func (g *Graph) scheduleRebuild() {
	g.rebuildMu.Lock()
	defer g.rebuildMu.Unlock()
	if g.rebuildTimer != nil {
		g.rebuildTimer.Stop()
	}
	g.rebuildTimer = time.AfterFunc(300*time.Millisecond, g.RebuildDistances)
	if g.groupTimer != nil {
		g.groupTimer.Stop()
	}
	g.groupTimer = time.AfterFunc(5*time.Second, g.computeGroups)
}

func wayOpen(ways map[int64]map[int64]struct{}, node, edge int64) bool {
	if ways == nil {
		return false
	}
	if m, ok := ways[node]; ok {
		_, open := m[edge]
		return open
	}
	return false
}

// bfsLocked menghitung jarak hop dari sumber (multi-sumber) melalui elemen tertutup.
// useNormal memakai posisi normal switch (untuk pengelompokan), bukan posisi saat ini.
// Harus dipanggil dengan RLock.
func (g *Graph) bfsLocked(useNormal bool) map[int64]int32 {
	openFlag := flagOpen
	ways := g.openWays
	if useNormal {
		openFlag = flagNormalOpen
		ways = g.normalOpenWays
	}
	queue := make([]int64, 0, 1024)
	dist := make(map[int64]int32, len(g.nodes))
	for id, n := range g.nodes {
		if n.source() && n.flags&openFlag == 0 {
			dist[id] = 0
			queue = append(queue, id)
		}
	}
	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		d := dist[cur]
		if n := g.nodes[cur]; n.flags&openFlag != 0 && d != 0 {
			continue // switch terbuka tidak meneruskan daya
		}
		for _, eid := range g.adj[cur] {
			e := g.edges[eid]
			if e.open || wayOpen(ways, cur, eid) {
				continue
			}
			nb := e.other(cur)
			if wayOpen(ways, nb, eid) {
				continue // masuk lewat arah yang terbuka
			}
			if _, seen := dist[nb]; seen {
				continue
			}
			dist[nb] = d + 1
			queue = append(queue, nb)
		}
	}
	return dist
}

// rebuild menghitung ulang jarak sumber dan mengembalikan perubahan status energisasi
// (dibandingkan dengan status tersimpan), sekaligus memperbarui status tersimpan di memori.
// BFS berjalan di bawah read lock; bila status berubah di tengah jalan (manuver / edit),
// perhitungan diulang agar hasil lama tidak menimpa status yang lebih baru.
func (g *Graph) rebuild() EnergyDiff {
	start := time.Now()
	for attempt := 0; ; attempt++ {
		g.mu.RLock()
		gen := g.gen
		dist := g.bfsLocked(false)
		g.mu.RUnlock()

		g.mu.Lock()
		if g.gen != gen && attempt < 3 {
			g.mu.Unlock()
			continue
		}
		var diff EnergyDiff
		for id, n := range g.nodes {
			_, on := dist[id]
			if on != n.energized() {
				if on {
					n.flags |= flagEnergized
					diff.NodesOn = append(diff.NodesOn, id)
				} else {
					n.flags &^= flagEnergized
					diff.NodesOff = append(diff.NodesOff, id)
				}
				g.nodes[id] = n
			}
		}
		for id, e := range g.edges {
			_, a := dist[e.from]
			_, b := dist[e.to]
			on := a && b && !e.open
			if on != e.energized {
				e.energized = on
				g.edges[id] = e
				if on {
					diff.EdgesOn = append(diff.EdgesOn, id)
				} else {
					diff.EdgesOff = append(diff.EdgesOff, id)
				}
			}
		}
		g.dist = dist
		g.distDirty = false
		g.distAt = time.Now()
		g.mu.Unlock()
		g.invalidateSummary()
		log.Printf("[graph] jarak sumber dihitung: %d node terjangkau, perubahan energisasi +%d/-%d node (%s)",
			len(dist), len(diff.NodesOn), len(diff.NodesOff), time.Since(start).Round(time.Millisecond))
		return diff
	}
}

// RebuildDistances menghitung jarak hop setiap node dari sumber terdekat dan
// menyalurkan perubahan energisasi ke hook persistensi.
func (g *Graph) RebuildDistances() {
	diff := g.rebuild()
	if g.onEnergy != nil && !diff.Empty() {
		g.onEnergy(diff)
	}
}

// ---------------------------------------------------------------------
// pengelompokan: penyulang (JTM), zona (antar switch), jurusan (JTR)
// ---------------------------------------------------------------------

// computeGroups menugaskan penyulang, zona, dan jurusan ke setiap node berdasarkan
// topologi dan posisi normal switch (manuver tidak mengubah keanggotaan group).
//   - kepala penyulang = kubikel yang menempel busbar dan punya saluran ke hilir
//   - zona = wilayah di hilir sebuah alat switching sampai alat switching berikutnya
//   - jurusan = wilayah JTR di hilir tiap saluran TR pertama yang keluar dari gardu/trafo distribusi
func (g *Graph) computeGroups() {
	start := time.Now()
	g.mu.RLock()
	// bila semua switch pada posisi normal, jarak saat ini = jarak posisi normal (hemat satu BFS penuh)
	var ndist map[int64]int32
	if !g.distDirty && g.switchesAtNormalLocked() {
		ndist = g.dist
	} else {
		ndist = g.bfsLocked(true)
	}
	busbar, hasBusbar := g.typeIndex["busbar"]
	kubikel, hasKubikel := g.typeIndex["kubikel_20kv"]
	giIdx := g.typeIndex["gi"]
	trafoIdx := g.typeIndex["trafo_gi"]
	gdIdx, hasGD := g.typeIndex["gd"]
	lv := make([]bool, len(g.typeNames))
	for i, name := range g.typeNames {
		ct, _ := g.types.Get(name)
		lv[i] = ct.GeomKind == "line" && ct.VoltageKV > 0 && ct.VoltageKV < 1
	}
	type asg struct{ feeder, zone, route, gd int64 }
	assign := make(map[int64]asg, len(g.nodes))
	feeders := map[int64]*feederInfo{}
	heads := []int64{}
	if hasKubikel {
		for id, n := range g.nodes {
			if n.typ != kubikel {
				continue
			}
			d, ok := ndist[id]
			if !ok {
				continue
			}
			hasBus, hasDown := false, false
			for _, eid := range g.adj[id] {
				e := g.edges[eid]
				if hasBusbar && e.typ == busbar {
					hasBus = true
					continue
				}
				if nd, ok := ndist[e.other(id)]; ok && nd > d {
					hasDown = true
				}
			}
			if hasBus && hasDown {
				heads = append(heads, id)
			}
		}
	}
	sort.Slice(heads, func(i, j int) bool { return heads[i] < heads[j] })
	for _, h := range heads {
		fi := &feederInfo{Head: h}
		cur := h
		for step := 0; step < 64 && fi.GI == 0; step++ {
			d := ndist[cur]
			next := int64(0)
			for _, eid := range g.adj[cur] {
				nb := g.edges[eid].other(cur)
				nd, ok := ndist[nb]
				if !ok || nd >= d {
					continue
				}
				nn := g.nodes[nb]
				if nn.typ == trafoIdx && fi.TrafoGI == 0 {
					fi.TrafoGI = nb
				}
				if nn.typ == giIdx {
					fi.GI = nb
				}
				if next == 0 || nd < ndist[next] {
					next = nb
				}
			}
			if next == 0 {
				break
			}
			cur = next
		}
		feeders[h] = fi
		assign[h] = asg{feeder: h, zone: h}
	}
	queue := append([]int64{}, heads...)
	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		a := assign[cur]
		d := ndist[cur]
		cn := g.nodes[cur]
		for _, eid := range g.adj[cur] {
			e := g.edges[eid]
			nb := e.other(cur)
			if nd, ok := ndist[nb]; !ok || nd != d+1 {
				continue
			}
			if _, done := assign[nb]; done {
				continue
			}
			na := a
			if cn.isSwitch() {
				na.zone = cur
			}
			if lv[e.typ] && na.route == 0 {
				na.route = eid
			}
			if hasGD && g.nodes[nb].typ == gdIdx {
				na.gd = nb
			}
			assign[nb] = na
			queue = append(queue, nb)
		}
	}
	g.mu.RUnlock()

	g.mu.Lock()
	changed := 0
	for id, n := range g.nodes {
		a := assign[id]
		if n.feeder != a.feeder || n.zone != a.zone || n.route != a.route || n.gd != a.gd {
			n.feeder, n.zone, n.route, n.gd = a.feeder, a.zone, a.route, a.gd
			g.nodes[id] = n
			changed++
		}
	}
	g.feeders = feeders
	g.groupsAt = time.Now()
	g.mu.Unlock()
	g.invalidateSummary()
	log.Printf("[graph] pengelompokan: %d penyulang, %d node diperbarui (%s)", len(feeders), changed, time.Since(start).Round(time.Millisecond))
}

// switchesAtNormalLocked: semua alat switching berada pada posisi normalnya. Harus dengan RLock.
func (g *Graph) switchesAtNormalLocked() bool {
	for _, n := range g.nodes {
		if n.isSwitch() && (n.flags&flagOpen != 0) != (n.flags&flagNormalOpen != 0) {
			return false
		}
	}
	if len(g.openWays) != len(g.normalOpenWays) {
		return false
	}
	for id, m := range g.openWays {
		nm := g.normalOpenWays[id]
		if len(m) != len(nm) {
			return false
		}
		for eid := range m {
			if _, ok := nm[eid]; !ok {
				return false
			}
		}
	}
	return true
}

// ---------------------------------------------------------------------
// manuver jaringan
// ---------------------------------------------------------------------

// ManeuverInput adalah perintah buka/tutup alat switching (seluruh alat atau satu arah).
type ManeuverInput struct {
	NodeID  int64
	Open    bool
	WayEdge int64 // 0 = seluruh alat
}

// Maneuver mengubah posisi switch lalu memperbarui energisasi secara inkremental: hanya
// wilayah hilir yang terdampak yang dihitung ulang (bukan seluruh jaringan). Perubahan
// dikembalikan ke pemanggil (tidak lewat hook) agar dapat dicatat sebagai kejadian.
func (g *Graph) Maneuver(in ManeuverInput) (EnergyDiff, error) {
	g.mu.Lock()
	n, ok := g.nodes[in.NodeID]
	if !ok {
		g.mu.Unlock()
		return EnergyDiff{}, ErrNotFound
	}
	if !n.isSwitch() {
		g.mu.Unlock()
		return EnergyDiff{}, ErrNotSwitch
	}
	var wayEdge edgeRec
	if in.WayEdge != 0 {
		found := false
		for _, eid := range g.adj[in.NodeID] {
			if eid == in.WayEdge {
				found = true
				break
			}
		}
		if !found {
			g.mu.Unlock()
			return EnergyDiff{}, ErrBadRequest
		}
		wayEdge = g.edges[in.WayEdge]
		if wayOpen(g.openWays, in.NodeID, in.WayEdge) == in.Open {
			g.mu.Unlock()
			return EnergyDiff{}, nil // posisi sudah sesuai
		}
	} else if n.open() == in.Open {
		g.mu.Unlock()
		return EnergyDiff{}, nil // posisi sudah sesuai
	}

	// akar wilayah terdampak dihitung dari jarak LAMA (sebelum posisi berubah)
	var roots []int64
	if in.Open && !g.distDirty {
		ds, reached := g.dist[in.NodeID]
		if in.WayEdge == 0 {
			if reached {
				for _, eid := range g.adj[in.NodeID] {
					e := g.edges[eid]
					if !g.passableLocked(in.NodeID, eid, e) {
						continue
					}
					nb := e.other(in.NodeID)
					if dn, ok := g.dist[nb]; ok && dn == ds+1 {
						roots = append(roots, nb)
					}
				}
			}
		} else if g.passableLocked(in.NodeID, in.WayEdge, wayEdge) {
			other := wayEdge.other(in.NodeID)
			do, okO := g.dist[other]
			switch {
			case reached && okO && do == ds+1 && !n.open():
				roots = append(roots, other)
			case reached && okO && ds == do+1 && !g.nodes[other].open():
				roots = append(roots, in.NodeID)
			}
		}
	}

	// terapkan posisi baru
	if in.WayEdge != 0 {
		if in.Open {
			if g.openWays[in.NodeID] == nil {
				g.openWays[in.NodeID] = map[int64]struct{}{}
			}
			g.openWays[in.NodeID][in.WayEdge] = struct{}{}
		} else if m := g.openWays[in.NodeID]; m != nil {
			delete(m, in.WayEdge)
			if len(m) == 0 {
				delete(g.openWays, in.NodeID)
			}
		}
	} else {
		if in.Open {
			n.flags |= flagOpen
		} else {
			n.flags &^= flagOpen
		}
		g.nodes[in.NodeID] = n
	}
	g.gen++
	g.countsDirty = true

	if g.distDirty {
		// jarak sedang tidak valid (edit tertunda): hitung ulang penuh
		g.mu.Unlock()
		return g.rebuild(), nil
	}
	start := time.Now()
	var touched []int64
	if in.Open {
		touched = g.reseedConeLocked(roots)
	} else {
		var seeds []int64
		if in.WayEdge == 0 {
			seeds = []int64{in.NodeID}
		} else {
			seeds = []int64{in.NodeID, wayEdge.other(in.NodeID)}
		}
		touched = g.relaxFromLocked(seeds)
	}
	diff := g.applyEnergyLocked(touched)
	g.distAt = time.Now()
	g.mu.Unlock()
	g.invalidateSummary()
	log.Printf("[graph] manuver #%d inkremental: %d node dihitung ulang, +%d/-%d node (%s)",
		in.NodeID, len(touched), len(diff.NodesOn), len(diff.NodesOff), time.Since(start).Round(time.Microsecond))
	return diff, nil
}

// passableLocked: edge dapat dilalui daya dari cur (edge tertutup & arah switch di kedua ujung tertutup).
func (g *Graph) passableLocked(cur, eid int64, e edgeRec) bool {
	return !e.open && !wayOpen(g.openWays, cur, eid) && !wayOpen(g.openWays, e.other(cur), eid)
}

type distItem struct {
	d  int32
	id int64
}

type distHeap []distItem

func (h distHeap) Len() int           { return len(h) }
func (h distHeap) Less(i, j int) bool { return h[i].d < h[j].d }
func (h distHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *distHeap) Push(x any)        { *h = append(*h, x.(distItem)) }
func (h *distHeap) Pop() any {
	o := *h
	x := o[len(o)-1]
	*h = o[:len(o)-1]
	return x
}

// reseedConeLocked menangani pembukaan elemen. Wilayah terdampak ("kerucut") adalah node yang
// dapat dicapai dari akar lewat langkah jarak +1, yaitu node yang jalur terpendeknya mungkin
// melewati elemen yang dibuka. Jarak node di luar kerucut pasti tidak berubah. Jarak node
// kerucut dihitung ulang dari tetangga di luar kerucut (Dijkstra bobot satuan); node yang
// tidak tercapai menjadi padam.
func (g *Graph) reseedConeLocked(roots []int64) []int64 {
	if len(roots) == 0 {
		return nil
	}
	cone := make(map[int64]struct{}, 256)
	queue := make([]int64, 0, 256)
	for _, r := range roots {
		if _, ok := cone[r]; !ok {
			cone[r] = struct{}{}
			queue = append(queue, r)
		}
	}
	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		if g.nodes[cur].open() {
			continue
		}
		d := g.dist[cur]
		for _, eid := range g.adj[cur] {
			e := g.edges[eid]
			if !g.passableLocked(cur, eid, e) {
				continue
			}
			nb := e.other(cur)
			if _, in := cone[nb]; in {
				continue
			}
			if dn, ok := g.dist[nb]; ok && dn == d+1 {
				cone[nb] = struct{}{}
				queue = append(queue, nb)
			}
		}
	}
	for id := range cone {
		delete(g.dist, id)
	}
	// benih: tetangga di luar kerucut yang masih bertegangan
	h := &distHeap{}
	for id := range cone {
		for _, eid := range g.adj[id] {
			e := g.edges[eid]
			if !g.passableLocked(id, eid, e) {
				continue
			}
			nb := e.other(id)
			if _, in := cone[nb]; in {
				continue
			}
			if dn, ok := g.dist[nb]; ok && !g.nodes[nb].open() {
				heap.Push(h, distItem{dn + 1, id})
			}
		}
	}
	for h.Len() > 0 {
		it := heap.Pop(h).(distItem)
		if _, done := g.dist[it.id]; done {
			continue
		}
		g.dist[it.id] = it.d
		if g.nodes[it.id].open() {
			continue
		}
		for _, eid := range g.adj[it.id] {
			e := g.edges[eid]
			if !g.passableLocked(it.id, eid, e) {
				continue
			}
			nb := e.other(it.id)
			if _, in := cone[nb]; !in {
				continue
			}
			if _, done := g.dist[nb]; !done {
				heap.Push(h, distItem{it.d + 1, nb})
			}
		}
	}
	return queue
}

// relaxFromLocked menangani penutupan elemen: jarak hanya dapat berkurang, jadi cukup
// relaksasi dari benih (Dijkstra bobot satuan). Mengembalikan node yang jaraknya berubah.
func (g *Graph) relaxFromLocked(seeds []int64) []int64 {
	h := &distHeap{}
	for _, s := range seeds {
		if d, ok := g.dist[s]; ok {
			heap.Push(h, distItem{d, s})
		}
	}
	changed := []int64{}
	for h.Len() > 0 {
		it := heap.Pop(h).(distItem)
		if d, ok := g.dist[it.id]; ok && d < it.d {
			continue // entri usang
		}
		if g.nodes[it.id].open() {
			continue
		}
		for _, eid := range g.adj[it.id] {
			e := g.edges[eid]
			if !g.passableLocked(it.id, eid, e) {
				continue
			}
			nb := e.other(it.id)
			if dn, ok := g.dist[nb]; !ok || it.d+1 < dn {
				g.dist[nb] = it.d + 1
				changed = append(changed, nb)
				heap.Push(h, distItem{it.d + 1, nb})
			}
		}
	}
	return changed
}

// applyEnergyLocked menyelaraskan flag energisasi node yang tersentuh beserta edge-nya.
func (g *Graph) applyEnergyLocked(touched []int64) EnergyDiff {
	var diff EnergyDiff
	seenE := map[int64]struct{}{}
	seenN := map[int64]struct{}{}
	for _, id := range touched {
		if _, dup := seenN[id]; dup {
			continue
		}
		seenN[id] = struct{}{}
		n, ok := g.nodes[id]
		if !ok {
			continue
		}
		_, on := g.dist[id]
		if on != n.energized() {
			if on {
				n.flags |= flagEnergized
				diff.NodesOn = append(diff.NodesOn, id)
			} else {
				n.flags &^= flagEnergized
				diff.NodesOff = append(diff.NodesOff, id)
			}
			g.nodes[id] = n
		}
		for _, eid := range g.adj[id] {
			if _, dup := seenE[eid]; dup {
				continue
			}
			seenE[eid] = struct{}{}
			e := g.edges[eid]
			_, a := g.dist[e.from]
			_, b := g.dist[e.to]
			eon := a && b && !e.open
			if eon != e.energized {
				e.energized = eon
				g.edges[eid] = e
				if eon {
					diff.EdgesOn = append(diff.EdgesOn, eid)
				} else {
					diff.EdgesOff = append(diff.EdgesOff, eid)
				}
			}
		}
	}
	return diff
}

// NodeInfo adalah status sebuah node di graf.
type NodeInfo struct {
	InGraph   bool    `json:"in_graph"`
	Energized bool    `json:"energized"`
	Open      bool    `json:"open"`
	Switch    bool    `json:"switch"`
	Source    bool    `json:"source"`
	Feeder    int64   `json:"feeder_id"`
	Zone      int64   `json:"zone_id"`
	Route     int64   `json:"route_id"`
	GD        int64   `json:"gd_id"`
	OpenWays  []int64 `json:"open_ways"`
	LoadVA    float64 `json:"load_va"`
	Degree    int     `json:"degree"`
}

// NodeInfo mengembalikan status energisasi & group sebuah node.
func (g *Graph) NodeInfo(id int64) NodeInfo {
	g.mu.RLock()
	defer g.mu.RUnlock()
	n, ok := g.nodes[id]
	if !ok {
		return NodeInfo{OpenWays: []int64{}}
	}
	info := NodeInfo{InGraph: true, Energized: n.energized(), Open: n.open(), Switch: n.isSwitch(), Source: n.source(),
		Feeder: n.feeder, Zone: n.zone, Route: n.route, GD: n.gd, OpenWays: []int64{}, LoadVA: float64(n.loadVA), Degree: len(g.adj[id])}
	for eid := range g.openWays[id] {
		info.OpenWays = append(info.OpenWays, eid)
	}
	sort.Slice(info.OpenWays, func(i, j int) bool { return info.OpenWays[i] < info.OpenWays[j] })
	return info
}

// EdgeInfo mengembalikan status energisasi & group sebuah edge (mengikuti ujung hulunya).
func (g *Graph) EdgeInfo(id int64) (NodeInfo, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	e, ok := g.edges[id]
	if !ok {
		return NodeInfo{OpenWays: []int64{}}, false
	}
	info := NodeInfo{InGraph: true, Energized: e.energized, Open: e.open, OpenWays: []int64{}}
	a, okA := g.nodes[e.from]
	b, okB := g.nodes[e.to]
	pick := a
	if !okA || (okB && a.feeder == 0 && b.feeder != 0) {
		pick = b
	}
	if da, ok := g.dist[e.from]; ok && okB {
		if db, ok2 := g.dist[e.to]; ok2 && db < da && b.feeder != 0 {
			pick = b
		}
	}
	info.Feeder, info.Zone, info.Route, info.GD = pick.feeder, pick.zone, pick.route, pick.gd
	return info, true
}

// FeederOf mengembalikan info penyulang (GI & trafo GI) untuk sebuah kepala penyulang.
func (g *Graph) FeederOf(head int64) (feederInfo, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	fi, ok := g.feeders[head]
	if !ok {
		return feederInfo{}, false
	}
	return *fi, true
}

// GroupSummary merangkum sekumpulan node (mis. dampak sebuah manuver) per group.
type GroupSummary struct {
	Nodes       int            `json:"nodes"`
	Edges       int            `json:"edges"`
	CountByType map[string]int `json:"count_by_type"`
	GI          []int64        `json:"gi_ids"`        // GI yang ikut padam/nyala
	TrafoGI     []int64        `json:"trafo_gi_ids"`  // trafo GI yang ikut padam/nyala
	ParentGI    []int64        `json:"parent_gi_ids"` // GI induk dari penyulang terdampak
	Feeders     []int64        `json:"penyulang_ids"`
	Zones       []int64        `json:"zona_ids"`
	Routes      int            `json:"jurusan"`
	GD          int            `json:"gd"`
	TrafoGD     int            `json:"trafo_gd"`
	Customers   int            `json:"pelanggan"`
	LoadVA      float64        `json:"beban_va"`
}

// Summarize merangkum node-node (dan jumlah edge) per group kelistrikan.
func (g *Graph) Summarize(nodeIDs []int64, edges int) GroupSummary {
	g.mu.RLock()
	defer g.mu.RUnlock()
	s := GroupSummary{Nodes: len(nodeIDs), Edges: edges, CountByType: map[string]int{}, GI: []int64{}, TrafoGI: []int64{}, ParentGI: []int64{}, Feeders: []int64{}, Zones: []int64{}}
	giIdx, hasGI := g.typeIndex["gi"]
	trafoIdx, hasTrafo := g.typeIndex["trafo_gi"]
	gdIdx, hasGD := g.typeIndex["gd"]
	tdIdx, hasTD := g.typeIndex["trafo_distribusi"]
	feeders := map[int64]struct{}{}
	zones := map[int64]struct{}{}
	routes := map[int64]struct{}{}
	for _, id := range nodeIDs {
		n, ok := g.nodes[id]
		if !ok {
			continue
		}
		s.CountByType[g.typeName(n.typ)]++
		switch {
		case hasGI && n.typ == giIdx:
			s.GI = append(s.GI, id)
		case hasTrafo && n.typ == trafoIdx:
			s.TrafoGI = append(s.TrafoGI, id)
		case hasGD && n.typ == gdIdx:
			s.GD++
		case hasTD && n.typ == tdIdx:
			s.TrafoGD++
		}
		if n.sink() {
			s.Customers++
			s.LoadVA += float64(n.loadVA)
		}
		if n.feeder != 0 {
			feeders[n.feeder] = struct{}{}
		}
		if n.zone != 0 {
			zones[n.zone] = struct{}{}
		}
		if n.route != 0 {
			routes[n.route] = struct{}{}
		}
	}
	parents := map[int64]struct{}{}
	for f := range feeders {
		s.Feeders = append(s.Feeders, f)
		if fi, ok := g.feeders[f]; ok && fi.GI != 0 {
			parents[fi.GI] = struct{}{}
		}
	}
	for p := range parents {
		s.ParentGI = append(s.ParentGI, p)
	}
	for z := range zones {
		s.Zones = append(s.Zones, z)
	}
	s.Routes = len(routes)
	sort.Slice(s.Feeders, func(i, j int) bool { return s.Feeders[i] < s.Feeders[j] })
	sort.Slice(s.Zones, func(i, j int) bool { return s.Zones[i] < s.Zones[j] })
	sort.Slice(s.ParentGI, func(i, j int) bool { return s.ParentGI[i] < s.ParentGI[j] })
	return s
}

// ---------------------------------------------------------------------
// ringkasan monitoring kelistrikan
// ---------------------------------------------------------------------

// Counter adalah pasangan jumlah total dan padam.
type Counter struct {
	Total int `json:"total"`
	Off   int `json:"off"`
}

// StateCounter adalah jumlah per keadaan group (nyala / sebagian / padam).
type StateCounter struct {
	Total   int `json:"total"`
	On      int `json:"on"`
	Partial int `json:"partial"`
	Off     int `json:"off"`
}

// PowerSummary adalah rekap nyala/padam seluruh jaringan.
type PowerSummary struct {
	At           time.Time    `json:"at"`
	GI           Counter      `json:"gi"`
	TrafoGI      Counter      `json:"trafo_gi"`
	Feeders      StateCounter `json:"penyulang"`
	Zones        StateCounter `json:"zona"`
	GDState      StateCounter `json:"gd_state"` // gardu: nyala / sebagian (ada hilir padam) / padam
	GD           Counter      `json:"gd"`
	TrafoGD      Counter      `json:"trafo_gd"`
	Customers    Counter      `json:"pelanggan"`
	LoadVA       float64      `json:"beban_va"`
	LoadOffVA    float64      `json:"beban_off_va"`
	Nodes        Counter      `json:"nodes"`
	Edges        Counter      `json:"edges"`
	OpenSwitches int          `json:"open_switches"`
	DistDirty    bool         `json:"dist_dirty"`
}

// GDStatus adalah rekap satu gardu distribusi beserta objek di hilirnya.
type GDStatus struct {
	ID           int64   `json:"id"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Feeder       int64   `json:"feeder_id"`
	FeederCode   string  `json:"feeder_code"`
	GI           int64   `json:"gi_id"`
	GICode       string  `json:"gi_code"`
	State        string  `json:"state"` // on | partial | off
	Energized    bool    `json:"energized"`
	Nodes        int     `json:"nodes"`
	NodesOff     int     `json:"nodes_off"`
	Customers    int     `json:"pelanggan"`
	CustomersOff int     `json:"pelanggan_off"`
	LoadVA       float64 `json:"beban_va"`
	LoadOffVA    float64 `json:"beban_off_va"`
	real         bool
}

// GDStatuses mengembalikan rekap seluruh gardu distribusi (dari cache ringkasan).
func (g *Graph) GDStatuses() []GDStatus {
	g.PowerSummary()
	g.sumMu.Lock()
	defer g.sumMu.Unlock()
	return g.sumGD
}

// FeederStatus adalah rekap satu penyulang.
type FeederStatus struct {
	Head         int64   `json:"head_id"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	GI           int64   `json:"gi_id"`
	GICode       string  `json:"gi_code"`
	TrafoGI      int64   `json:"trafo_gi_id"`
	TrafoGICode  string  `json:"trafo_gi_code"`
	State        string  `json:"state"` // on | partial | off
	Nodes        int     `json:"nodes"`
	NodesOff     int     `json:"nodes_off"`
	GD           int     `json:"gd"`
	GDOff        int     `json:"gd_off"`
	Customers    int     `json:"pelanggan"`
	CustomersOff int     `json:"pelanggan_off"`
	LoadVA       float64 `json:"beban_va"`
	LoadOffVA    float64 `json:"beban_off_va"`
	Zones        int     `json:"zona"`
	ZonesOff     int     `json:"zona_off"`
}

func (g *Graph) invalidateSummary() {
	g.sumMu.Lock()
	g.sumCache = nil
	g.sumMu.Unlock()
}

// PowerSummary menghitung rekap nyala/padam (di-cache 5 detik; satu lintasan atas seluruh node).
func (g *Graph) PowerSummary() (PowerSummary, []FeederStatus) {
	g.sumMu.Lock()
	defer g.sumMu.Unlock()
	if g.sumCache != nil && time.Since(g.sumAt) < 5*time.Second {
		return *g.sumCache, g.sumFeed
	}
	g.mu.RLock()
	giIdx, hasGI := g.typeIndex["gi"]
	trafoIdx, hasTrafo := g.typeIndex["trafo_gi"]
	gdIdx, hasGD := g.typeIndex["gd"]
	tdIdx, hasTD := g.typeIndex["trafo_distribusi"]
	s := PowerSummary{At: time.Now(), DistDirty: g.distDirty}
	feed := make(map[int64]*FeederStatus, len(g.feeders))
	for h, fi := range g.feeders {
		feed[h] = &FeederStatus{Head: h, GI: fi.GI, TrafoGI: fi.TrafoGI}
	}
	zones := map[int64]*Counter{}
	zoneFeeder := map[int64]int64{}
	gds := map[int64]*GDStatus{}
	gdOf := func(id int64) *GDStatus {
		x := gds[id]
		if x == nil {
			x = &GDStatus{ID: id}
			gds[id] = x
		}
		return x
	}
	for id, n := range g.nodes {
		on := n.energized()
		s.Nodes.Total++
		if !on {
			s.Nodes.Off++
		}
		if n.open() || len(g.openWays[id]) > 0 {
			s.OpenSwitches++
		}
		switch {
		case hasGI && n.typ == giIdx:
			s.GI.Total++
			if !on {
				s.GI.Off++
			}
		case hasTrafo && n.typ == trafoIdx:
			s.TrafoGI.Total++
			if !on {
				s.TrafoGI.Off++
			}
		case hasGD && n.typ == gdIdx:
			s.GD.Total++
			if !on {
				s.GD.Off++
			}
			x := gdOf(id)
			x.Energized = on
			x.real = true
			x.Feeder = n.feeder
			if fi := g.feeders[n.feeder]; fi != nil {
				x.GI = fi.GI
			}
		case hasTD && n.typ == tdIdx:
			s.TrafoGD.Total++
			if !on {
				s.TrafoGD.Off++
			}
		}
		if n.sink() {
			s.Customers.Total++
			s.LoadVA += float64(n.loadVA)
			if !on {
				s.Customers.Off++
				s.LoadOffVA += float64(n.loadVA)
			}
		}
		if n.feeder != 0 {
			f := feed[n.feeder]
			if f == nil {
				f = &FeederStatus{Head: n.feeder}
				feed[n.feeder] = f
			}
			if id != n.feeder { // kepala penyulang sendiri tidak dihitung sebagai anggota
				f.Nodes++
				if !on {
					f.NodesOff++
				}
			}
			if hasGD && n.typ == gdIdx {
				f.GD++
				if !on {
					f.GDOff++
				}
			}
			if n.sink() {
				f.Customers++
				f.LoadVA += float64(n.loadVA)
				if !on {
					f.CustomersOff++
					f.LoadOffVA += float64(n.loadVA)
				}
			}
		}
		if n.gd != 0 && id != n.gd {
			x := gdOf(n.gd)
			x.Nodes++
			if !on {
				x.NodesOff++
			}
			if n.sink() {
				x.Customers++
				x.LoadVA += float64(n.loadVA)
				if !on {
					x.CustomersOff++
					x.LoadOffVA += float64(n.loadVA)
				}
			}
		}
		if n.zone != 0 && id != n.zone {
			z := zones[n.zone]
			if z == nil {
				z = &Counter{}
				zones[n.zone] = z
				zoneFeeder[n.zone] = n.feeder
			}
			z.Total++
			if !on {
				z.Off++
			}
		}
	}
	for _, e := range g.edges {
		s.Edges.Total++
		if !e.energized {
			s.Edges.Off++
		}
	}
	g.mu.RUnlock()

	gdList := make([]GDStatus, 0, len(gds))
	for _, x := range gds {
		if !x.real {
			continue // pengelompokan lama menunjuk gardu yang sudah tidak ada
		}
		s.GDState.Total++
		switch {
		case !x.Energized:
			x.State = "off"
			s.GDState.Off++
		case x.NodesOff > 0:
			x.State = "partial"
			s.GDState.Partial++
		default:
			x.State = "on"
			s.GDState.On++
		}
		gdList = append(gdList, *x)
	}
	sort.Slice(gdList, func(i, j int) bool { return gdList[i].ID < gdList[j].ID })
	for zid, z := range zones {
		s.Zones.Total++
		f := feed[zoneFeeder[zid]]
		if f != nil {
			f.Zones++
		}
		switch {
		case z.Off == 0:
			s.Zones.On++
		case z.Off >= z.Total:
			s.Zones.Off++
			if f != nil {
				f.ZonesOff++
			}
		default:
			s.Zones.Partial++
		}
	}
	list := make([]FeederStatus, 0, len(feed))
	for _, f := range feed {
		switch {
		case f.NodesOff == 0:
			f.State = "on"
			s.Feeders.On++
		case f.NodesOff >= f.Nodes:
			f.State = "off"
			s.Feeders.Off++
		default:
			f.State = "partial"
			s.Feeders.Partial++
		}
		s.Feeders.Total++
		list = append(list, *f)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Head < list[j].Head })
	g.sumCache, g.sumFeed, g.sumGD, g.sumAt = &s, list, gdList, time.Now()
	return s, list
}

// ---------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------

// TraceRequest adalah parameter trace.
type TraceRequest struct {
	NodeID    int64     `json:"node_id"`
	Direction string    `json:"direction"` // down | up | connected
	MaxDepth  int       `json:"max_depth"`
	MaxNodes  int       `json:"max_nodes"`
	StopTypes []string  `json:"stop_types"`
	Lang      i18n.Lang `json:"-"`
}

// TraceResult adalah hasil trace (id fitur + ringkasan).
type TraceResult struct {
	Direction    string         `json:"direction"`
	StartNode    int64          `json:"start_node"`
	Nodes        []int64        `json:"nodes"`
	Edges        []int64        `json:"edges"`
	Depth        int            `json:"depth"`
	CountByType  map[string]int `json:"count_by_type"`
	Sources      []int64        `json:"sources"`
	Sinks        int            `json:"sinks"`
	OpenSwitches []int64        `json:"open_switches"`
	Truncated    bool           `json:"truncated"`
	Warnings     []string       `json:"warnings"`
	DurationMS   float64        `json:"duration_ms"`
}

// Trace menjalankan penelusuran jaringan dari sebuah node.
func (g *Graph) Trace(req TraceRequest) TraceResult {
	start := time.Now()
	res := TraceResult{Direction: req.Direction, StartNode: req.NodeID, Nodes: []int64{}, Edges: []int64{},
		CountByType: map[string]int{}, Sources: []int64{}, OpenSwitches: []int64{}, Warnings: []string{}}
	if req.MaxDepth <= 0 {
		req.MaxDepth = 5000
	}
	if req.MaxNodes <= 0 {
		req.MaxNodes = 200000
	}

	// tunggu sebentar bila jarak sumber sedang dihitung ulang
	for i := 0; i < 20; i++ {
		g.mu.RLock()
		dirty := g.distDirty
		g.mu.RUnlock()
		if !dirty {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

	stop := map[uint16]struct{}{}
	for _, s := range req.StopTypes {
		if i, ok := g.typeIndex[s]; ok {
			stop[i] = struct{}{}
		}
	}
	startNode, ok := g.nodes[req.NodeID]
	if !ok {
		res.Warnings = append(res.Warnings, i18n.T(req.Lang, "trace.no_start"))
		return res
	}
	if g.distDirty {
		res.Warnings = append(res.Warnings, i18n.T(req.Lang, "trace.dist_updating"))
	}
	dir := req.Direction
	_, reachable := g.dist[req.NodeID]
	if (dir == "down" || dir == "up") && !reachable {
		res.Warnings = append(res.Warnings, i18n.T(req.Lang, "trace.unreachable"))
		dir = "connected"
	}
	if startNode.open() {
		res.Warnings = append(res.Warnings, i18n.T(req.Lang, "trace.start_open"))
	}

	visitedN := map[int64]struct{}{req.NodeID: {}}
	visitedE := map[int64]struct{}{}
	type item struct {
		id    int64
		depth int
	}
	queue := []item{{req.NodeID, 0}}
	res.Nodes = append(res.Nodes, req.NodeID)
	res.CountByType[g.typeName(startNode.typ)]++
	if startNode.source() {
		res.Sources = append(res.Sources, req.NodeID)
	}

	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		if cur.depth > res.Depth {
			res.Depth = cur.depth
		}
		if cur.depth >= req.MaxDepth {
			res.Truncated = true
			continue
		}
		n := g.nodes[cur.id]
		if cur.id != req.NodeID {
			if n.open() {
				continue // switch terbuka: batas penelusuran
			}
			if _, isStop := stop[n.typ]; isStop {
				continue
			}
			if dir == "up" && n.source() {
				continue
			}
		}
		curDist := g.dist[cur.id]
		for _, eid := range g.adj[cur.id] {
			if _, seen := visitedE[eid]; seen {
				continue
			}
			e := g.edges[eid]
			nb := e.other(cur.id)
			nbRec, exists := g.nodes[nb]
			if !exists {
				continue
			}
			if dir == "down" || dir == "up" {
				nbDist, ok := g.dist[nb]
				if !ok {
					if dir == "up" {
						continue
					}
				} else if dir == "down" && nbDist <= curDist {
					continue
				} else if dir == "up" && nbDist >= curDist {
					continue
				}
			}
			visitedE[eid] = struct{}{}
			res.Edges = append(res.Edges, eid)
			if e.open || wayOpen(g.openWays, cur.id, eid) || wayOpen(g.openWays, nb, eid) {
				continue // edge / arah switch terbuka memutus aliran
			}
			if _, seen := visitedN[nb]; seen {
				continue
			}
			visitedN[nb] = struct{}{}
			res.Nodes = append(res.Nodes, nb)
			res.CountByType[g.typeName(nbRec.typ)]++
			if nbRec.source() {
				res.Sources = append(res.Sources, nb)
			}
			if nbRec.sink() {
				res.Sinks++
			}
			if nbRec.open() {
				res.OpenSwitches = append(res.OpenSwitches, nb)
			}
			if len(res.Nodes) >= req.MaxNodes {
				res.Truncated = true
				res.Warnings = append(res.Warnings, i18n.T(req.Lang, "trace.truncated"))
				res.DurationMS = float64(time.Since(start).Microseconds()) / 1000
				return res
			}
			queue = append(queue, item{nb, cur.depth + 1})
		}
	}
	res.DurationMS = float64(time.Since(start).Microseconds()) / 1000
	return res
}

// Status mengembalikan ringkasan graf. Jumlah sumber/switch dihitung dari cache yang
// diperbarui saat muat/refresh agar tidak memindai jutaan node setiap kali dipanggil.
func (g *Graph) Status() map[string]any {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.countsDirty {
		g.mu.RUnlock()
		g.mu.Lock()
		if g.countsDirty {
			s, o := 0, 0
			for id, n := range g.nodes {
				if n.source() {
					s++
				}
				if n.open() || len(g.openWays[id]) > 0 {
					o++
				}
			}
			g.nSources, g.nOpen, g.countsDirty = s, o, false
		}
		g.mu.Unlock()
		g.mu.RLock()
	}
	unreachable := len(g.nodes) - len(g.dist)
	if unreachable < 0 {
		unreachable = 0
	}
	return map[string]any{
		"nodes":       len(g.nodes),
		"edges":       len(g.edges),
		"sources":     g.nSources,
		"open_switch": g.nOpen,
		"unreachable": unreachable,
		"feeders":     len(g.feeders),
		"built_at":    g.builtAt,
		"dist_at":     g.distAt,
		"groups_at":   g.groupsAt,
		"dist_dirty":  g.distDirty,
		"loading":     g.loading,
	}
}

// ValidationIssue adalah temuan pemeriksaan topologi.
type ValidationIssue struct {
	Kind    string `json:"kind"`
	ID      int64  `json:"id"`
	Type    string `json:"type_code"`
	Problem string `json:"problem"`
}

// Validate memeriksa masalah topologi umum (node terisolasi, tidak terjangkau sumber).
func (g *Graph) Validate(limit int, lang i18n.Lang) ([]ValidationIssue, map[string]int) {
	if limit <= 0 {
		limit = 200
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	junctionIdx, hasJunction := g.typeIndex[junctionType]
	issues := []ValidationIssue{}
	summary := map[string]int{"isolated": 0, "unreachable": 0, "dangling_junction": 0}
	for id, n := range g.nodes {
		deg := len(g.adj[id])
		switch {
		case deg == 0 && hasJunction && n.typ == junctionIdx:
			summary["dangling_junction"]++
			if len(issues) < limit {
				issues = append(issues, ValidationIssue{"node", id, g.typeName(n.typ), i18n.T(lang, "valid.junction_no_edge")})
			}
		case deg == 0:
			summary["isolated"]++
			if len(issues) < limit {
				issues = append(issues, ValidationIssue{"node", id, g.typeName(n.typ), i18n.T(lang, "valid.isolated")})
			}
		default:
			if _, ok := g.dist[id]; !ok && !n.source() {
				summary["unreachable"]++
				if len(issues) < limit {
					issues = append(issues, ValidationIssue{"node", id, g.typeName(n.typ), i18n.T(lang, "valid.unreachable")})
				}
			}
		}
	}
	return issues, summary
}
