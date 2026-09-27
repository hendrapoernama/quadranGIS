package gis

import (
	"sort"
	"time"
)

// ---------------------------------------------------------------------
// Hirarki aset: GI → trafo GI → penyulang → gardu distribusi → trafo distribusi
// → jurusan TR → pelanggan. Diturunkan dari pengelompokan graf (posisi normal
// switch), disimpan sebagai indeks yang dibangun ulang malas.
// ---------------------------------------------------------------------

// Jenis simpul hirarki aset.
const (
	AssetRoot      = "root"
	AssetGI        = "gi"
	AssetTrafoGI   = "trafo_gi"
	AssetFeeder    = "feeder"
	AssetGD        = "gd"
	AssetTrafo     = "trafo"
	AssetRoute     = "route"
	AssetPelanggan = "pelanggan"
	AssetNone      = "none" // kelompok semu: aset yang tidak tersambung ke sumber / penyulang
)

// AssetLevels adalah urutan tingkat hirarki (untuk tabel).
var AssetLevels = []string{AssetGI, AssetTrafoGI, AssetFeeder, AssetGD, AssetTrafo, AssetRoute, AssetPelanggan}

type assetAgg struct {
	pel, pelOff   int
	beban, bebanO float64
}

type assetIndex struct {
	groupsAt time.Time
	gen      uint64
	at       time.Time

	gis, trafoGI, feeders, gds, tds, routes, sinks []int64

	giTrafo   map[int64][]int64 // GI -> trafo GI
	giFeed    map[int64][]int64 // GI -> penyulang tanpa trafo GI
	trafoFeed map[int64][]int64 // trafo GI -> penyulang
	trafoGIOf map[int64]int64   // trafo GI -> GI
	feedGD    map[int64][]int64 // penyulang -> gardu
	feedSink  map[int64][]int64 // penyulang -> pelanggan tanpa gardu (mis. pelanggan TM)
	gdTD      map[int64][]int64 // gardu -> trafo distribusi
	gdRoute   map[int64][]int64 // gardu -> jurusan tanpa trafo distribusi
	gdSink    map[int64][]int64 // gardu -> pelanggan tanpa jurusan
	tdRoute   map[int64][]int64 // trafo distribusi -> jurusan
	routeSink map[int64][]int64 // jurusan -> pelanggan
	routeTD   map[int64]int64
	routeGD   map[int64]int64

	orphanFeed, orphanGD, orphanTD, orphanRoute, orphanSink []int64

	stat      map[int64]*assetAgg // GI, trafo GI, penyulang, gardu, trafo distribusi
	routeStat map[int64]*assetAgg
}

// AssetRef menunjuk satu simpul hirarki.
type AssetRef struct {
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
}

// AssetItem adalah satu baris hirarki / tabel aset. Kode, nama, dan unit diisi pemanggil.
type AssetItem struct {
	Kind         string  `json:"kind"`
	ID           int64   `json:"id"`
	TypeCode     string  `json:"type_code"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	State        string  `json:"state"` // on | partial | off
	Energized    bool    `json:"energized"`
	Children     int     `json:"children"`
	Pelanggan    int     `json:"pelanggan"`
	PelangganOff int     `json:"pelanggan_off"`
	BebanVA      float64 `json:"beban_va"`
	BebanOffVA   float64 `json:"beban_off_va"`
	GI           int64   `json:"gi_id,omitempty"`
	TrafoGI      int64   `json:"trafo_gi_id,omitempty"`
	Feeder       int64   `json:"feeder_id,omitempty"`
	GD           int64   `json:"gd_id,omitempty"`
	Trafo        int64   `json:"trafo_id,omitempty"`
	Route        int64   `json:"route_id,omitempty"`
}

// AssetCounts adalah jumlah aset per tingkat.
type AssetCounts map[string]int

func (g *Graph) assetIdx() *assetIndex {
	g.assetMu.Lock()
	defer g.assetMu.Unlock()
	g.mu.RLock()
	groupsAt, gen := g.groupsAt, g.gen
	g.mu.RUnlock()
	if c := g.assetCache; c != nil && c.groupsAt.Equal(groupsAt) && (c.gen == gen || time.Since(c.at) < 15*time.Second) {
		return c
	}
	g.assetCache = g.buildAssetIndex()
	return g.assetCache
}

func (g *Graph) buildAssetIndex() *assetIndex {
	g.mu.RLock()
	defer g.mu.RUnlock()
	x := &assetIndex{
		groupsAt: g.groupsAt, gen: g.gen, at: time.Now(),
		giTrafo: map[int64][]int64{}, giFeed: map[int64][]int64{}, trafoFeed: map[int64][]int64{}, trafoGIOf: map[int64]int64{},
		feedGD: map[int64][]int64{}, feedSink: map[int64][]int64{}, gdTD: map[int64][]int64{}, gdRoute: map[int64][]int64{},
		gdSink: map[int64][]int64{}, tdRoute: map[int64][]int64{}, routeSink: map[int64][]int64{},
		routeTD: map[int64]int64{}, routeGD: map[int64]int64{},
		stat: map[int64]*assetAgg{}, routeStat: map[int64]*assetAgg{},
	}
	idx := func(code string) int {
		if i, ok := g.typeIndex[code]; ok {
			return int(i)
		}
		return -1
	}
	giIdx, tgiIdx, gdIdx, tdIdx, rakIdx := idx("gi"), idx("trafo_gi"), idx("gd"), idx("trafo_distribusi"), idx("rak_tr")

	// penyulang -> trafo GI -> GI
	for h, fi := range g.feeders {
		x.feeders = append(x.feeders, h)
		switch {
		case fi.GI == 0:
			x.orphanFeed = append(x.orphanFeed, h)
		case fi.TrafoGI != 0:
			if _, seen := x.trafoGIOf[fi.TrafoGI]; !seen {
				x.trafoGIOf[fi.TrafoGI] = fi.GI
				x.giTrafo[fi.GI] = append(x.giTrafo[fi.GI], fi.TrafoGI)
				x.trafoGI = append(x.trafoGI, fi.TrafoGI)
			}
			x.trafoFeed[fi.TrafoGI] = append(x.trafoFeed[fi.TrafoGI], h)
		default:
			x.giFeed[fi.GI] = append(x.giFeed[fi.GI], h)
		}
	}
	// jurusan: gardu dari node di dalamnya
	for id, n := range g.nodes {
		t := int(n.typ)
		switch {
		case t == giIdx:
			x.gis = append(x.gis, id)
		case t == tgiIdx:
			if _, ok := x.trafoGIOf[id]; !ok {
				// trafo GI tanpa penyulang: cari GI tetangga (langsung atau lewat busbar)
				x.trafoGI = append(x.trafoGI, id)
				if gi := g.neighborOfTypeLocked(id, giIdx, 2); gi != 0 {
					x.trafoGIOf[id] = gi
					x.giTrafo[gi] = append(x.giTrafo[gi], id)
				}
			}
		case t == gdIdx:
			x.gds = append(x.gds, id)
			if _, ok := g.feeders[n.feeder]; ok {
				x.feedGD[n.feeder] = append(x.feedGD[n.feeder], id)
			} else {
				x.orphanGD = append(x.orphanGD, id)
			}
		case t == tdIdx:
			x.tds = append(x.tds, id)
			if n.gd != 0 {
				x.gdTD[n.gd] = append(x.gdTD[n.gd], id)
			} else {
				x.orphanTD = append(x.orphanTD, id)
			}
		}
		if n.route != 0 {
			if _, ok := x.routeGD[n.route]; !ok || x.routeGD[n.route] == 0 {
				x.routeGD[n.route] = n.gd
			}
		}
	}
	// jurusan -> trafo distribusi (ujung saluran TR pertama, langsung atau lewat rak TR)
	for r, gd := range x.routeGD {
		x.routes = append(x.routes, r)
		td := int64(0)
		if e, ok := g.edges[r]; ok && tdIdx >= 0 {
			for _, end := range []int64{e.from, e.to} {
				en := g.nodes[end]
				if int(en.typ) == tdIdx {
					td = end
				} else if int(en.typ) == rakIdx && td == 0 {
					td = g.neighborOfTypeLocked(end, tdIdx, 1)
				}
				if td != 0 {
					break
				}
			}
		}
		switch {
		case td != 0:
			x.routeTD[r] = td
			x.tdRoute[td] = append(x.tdRoute[td], r)
		case gd != 0:
			x.gdRoute[gd] = append(x.gdRoute[gd], r)
		default:
			x.orphanRoute = append(x.orphanRoute, r)
		}
	}
	// pelanggan + agregasi beban ke semua tingkat hulu
	add := func(m map[int64]*assetAgg, id int64, n nodeRec) {
		if id == 0 {
			return
		}
		a := m[id]
		if a == nil {
			a = &assetAgg{}
			m[id] = a
		}
		a.pel++
		a.beban += float64(n.loadVA)
		if !n.energized() {
			a.pelOff++
			a.bebanO += float64(n.loadVA)
		}
	}
	for id, n := range g.nodes {
		if !n.sink() {
			continue
		}
		x.sinks = append(x.sinks, id)
		switch {
		case n.route != 0:
			x.routeSink[n.route] = append(x.routeSink[n.route], id)
		case n.gd != 0:
			x.gdSink[n.gd] = append(x.gdSink[n.gd], id)
		case n.feeder != 0:
			x.feedSink[n.feeder] = append(x.feedSink[n.feeder], id)
		default:
			x.orphanSink = append(x.orphanSink, id)
		}
		add(x.routeStat, n.route, n)
		add(x.stat, x.routeTD[n.route], n)
		add(x.stat, n.gd, n)
		if fi, ok := g.feeders[n.feeder]; ok {
			add(x.stat, n.feeder, n)
			add(x.stat, fi.TrafoGI, n)
			add(x.stat, fi.GI, n)
		}
	}
	sortIDs := func(s []int64) {
		sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	}
	for _, s := range [][]int64{x.gis, x.trafoGI, x.feeders, x.gds, x.tds, x.routes, x.sinks, x.orphanFeed, x.orphanGD, x.orphanTD, x.orphanRoute, x.orphanSink} {
		sortIDs(s)
	}
	for _, m := range []map[int64][]int64{x.giTrafo, x.giFeed, x.trafoFeed, x.feedGD, x.feedSink, x.gdTD, x.gdRoute, x.gdSink, x.tdRoute, x.routeSink} {
		for _, s := range m {
			sortIDs(s)
		}
	}
	return x
}

// neighborOfTypeLocked mencari node bertipe typ dalam jarak hop tertentu. Harus dengan RLock.
func (g *Graph) neighborOfTypeLocked(id int64, typ int, hops int) int64 {
	if typ < 0 {
		return 0
	}
	front := []int64{id}
	seen := map[int64]bool{id: true}
	for h := 0; h < hops; h++ {
		next := []int64{}
		for _, cur := range front {
			for _, eid := range g.adj[cur] {
				nb := g.edges[eid].other(cur)
				if seen[nb] {
					continue
				}
				seen[nb] = true
				if int(g.nodes[nb].typ) == typ {
					return nb
				}
				next = append(next, nb)
			}
		}
		front = next
	}
	return 0
}

// AssetCounts mengembalikan jumlah aset per tingkat hirarki.
func (g *Graph) AssetCounts() AssetCounts {
	x := g.assetIdx()
	return AssetCounts{
		AssetGI: len(x.gis), AssetTrafoGI: len(x.trafoGI), AssetFeeder: len(x.feeders), AssetGD: len(x.gds),
		AssetTrafo: len(x.tds), AssetRoute: len(x.routes), AssetPelanggan: len(x.sinks),
		AssetNone: len(x.orphanFeed) + len(x.orphanGD) + len(x.orphanTD) + len(x.orphanRoute) + len(x.orphanSink),
	}
}

// AssetChildren mengembalikan anak langsung satu simpul hirarki (tanpa kode/nama).
func (g *Graph) AssetChildren(kind string, id int64) []AssetRef {
	x := g.assetIdx()
	out := []AssetRef{}
	put := func(k string, ids []int64) {
		for _, v := range ids {
			out = append(out, AssetRef{k, v})
		}
	}
	switch kind {
	case AssetRoot:
		put(AssetGI, x.gis)
		if len(x.orphanFeed)+len(x.orphanGD)+len(x.orphanTD)+len(x.orphanRoute)+len(x.orphanSink) > 0 {
			out = append(out, AssetRef{AssetNone, 0})
		}
	case AssetNone:
		put(AssetFeeder, x.orphanFeed)
		put(AssetGD, x.orphanGD)
		put(AssetTrafo, x.orphanTD)
		put(AssetRoute, x.orphanRoute)
		put(AssetPelanggan, x.orphanSink)
	case AssetGI:
		put(AssetTrafoGI, x.giTrafo[id])
		put(AssetFeeder, x.giFeed[id])
	case AssetTrafoGI:
		put(AssetFeeder, x.trafoFeed[id])
	case AssetFeeder:
		put(AssetGD, x.feedGD[id])
		put(AssetPelanggan, x.feedSink[id])
	case AssetGD:
		put(AssetTrafo, x.gdTD[id])
		put(AssetRoute, x.gdRoute[id])
		put(AssetPelanggan, x.gdSink[id])
	case AssetTrafo:
		put(AssetRoute, x.tdRoute[id])
	case AssetRoute:
		put(AssetPelanggan, x.routeSink[id])
	}
	return out
}

func (x *assetIndex) childCount(kind string, id int64) int {
	switch kind {
	case AssetGI:
		return len(x.giTrafo[id]) + len(x.giFeed[id])
	case AssetTrafoGI:
		return len(x.trafoFeed[id])
	case AssetFeeder:
		return len(x.feedGD[id]) + len(x.feedSink[id])
	case AssetGD:
		return len(x.gdTD[id]) + len(x.gdRoute[id]) + len(x.gdSink[id])
	case AssetTrafo:
		return len(x.tdRoute[id])
	case AssetRoute:
		return len(x.routeSink[id])
	case AssetNone:
		return len(x.orphanFeed) + len(x.orphanGD) + len(x.orphanTD) + len(x.orphanRoute) + len(x.orphanSink)
	}
	return 0
}

// AssetIDs mengembalikan id semua aset pada tingkat level di dalam cakupan (scope kosong = seluruh jaringan).
func (g *Graph) AssetIDs(level, scopeKind string, scopeID int64) []int64 {
	x := g.assetIdx()
	if scopeKind == "" || scopeKind == AssetRoot {
		switch level {
		case AssetGI:
			return x.gis
		case AssetTrafoGI:
			return x.trafoGI
		case AssetFeeder:
			return x.feeders
		case AssetGD:
			return x.gds
		case AssetTrafo:
			return x.tds
		case AssetRoute:
			return x.routes
		case AssetPelanggan:
			return x.sinks
		}
		return nil
	}
	if scopeKind == level {
		return []int64{scopeID}
	}
	out := []int64{}
	var walk func(kind string, id int64)
	walk = func(kind string, id int64) {
		for _, c := range g.AssetChildren(kind, id) {
			if c.Kind == level {
				out = append(out, c.ID)
				continue
			}
			if assetDepth(c.Kind) < assetDepth(level) {
				walk(c.Kind, c.ID)
			}
		}
	}
	walk(scopeKind, scopeID)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func assetDepth(kind string) int {
	for i, l := range AssetLevels {
		if l == kind {
			return i
		}
	}
	return -1
}

// AssetItems menyusun baris lengkap (status, agregat, rantai hulu) untuk simpul-simpul hirarki.
func (g *Graph) AssetItems(refs []AssetRef) []AssetItem {
	x := g.assetIdx()
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]AssetItem, 0, len(refs))
	for _, r := range refs {
		it := AssetItem{Kind: r.Kind, ID: r.ID, Children: x.childCount(r.Kind, r.ID)}
		var a *assetAgg
		feeder := int64(0)
		switch r.Kind {
		case AssetNone:
			it.TypeCode = ""
			a = &assetAgg{}
			for _, s := range x.orphanSink {
				n := g.nodes[s]
				a.pel++
				a.beban += float64(n.loadVA)
				if !n.energized() {
					a.pelOff++
					a.bebanO += float64(n.loadVA)
				}
			}
		case AssetRoute:
			e := g.edges[r.ID]
			it.TypeCode = g.typeName(e.typ)
			it.Energized = e.energized
			a = x.routeStat[r.ID]
			it.Route, it.Trafo, it.GD = r.ID, x.routeTD[r.ID], x.routeGD[r.ID]
			if it.GD != 0 {
				feeder = g.nodes[it.GD].feeder
			} else if it.Trafo != 0 {
				feeder = g.nodes[it.Trafo].feeder
			}
		default:
			n := g.nodes[r.ID]
			it.TypeCode = g.typeName(n.typ)
			it.Energized = n.energized()
			feeder = n.feeder
			switch r.Kind {
			case AssetPelanggan:
				a = &assetAgg{pel: 1, beban: float64(n.loadVA)}
				if !n.energized() {
					a.pelOff, a.bebanO = 1, float64(n.loadVA)
				}
				it.Route, it.GD, it.Trafo = n.route, n.gd, x.routeTD[n.route]
			case AssetTrafo:
				a = x.stat[r.ID]
				it.Trafo, it.GD = r.ID, n.gd
			case AssetGD:
				a = x.stat[r.ID]
				it.GD = r.ID
			case AssetFeeder:
				a = x.stat[r.ID]
				feeder = r.ID
			case AssetTrafoGI:
				a = x.stat[r.ID]
				it.TrafoGI, it.GI = r.ID, x.trafoGIOf[r.ID]
			case AssetGI:
				a = x.stat[r.ID]
				it.GI = r.ID
			}
		}
		if fi, ok := g.feeders[feeder]; ok && r.Kind != AssetGI && r.Kind != AssetTrafoGI {
			it.Feeder, it.TrafoGI, it.GI = fi.Head, fi.TrafoGI, fi.GI
		}
		if a != nil {
			it.Pelanggan, it.PelangganOff, it.BebanVA, it.BebanOffVA = a.pel, a.pelOff, a.beban, a.bebanO
		}
		it.State = assetState(r.Kind, it)
		out = append(out, it)
	}
	return out
}

func assetState(kind string, it AssetItem) string {
	switch {
	case kind == AssetNone:
		if it.Pelanggan > 0 && it.PelangganOff == 0 {
			return "on"
		}
		return "off"
	case !it.Energized, it.Pelanggan > 0 && it.PelangganOff == it.Pelanggan:
		return "off"
	case it.PelangganOff > 0:
		return "partial"
	}
	return "on"
}

// AssetLocate mengembalikan jalur hirarki dari akar sampai simpul yang memuat fitur
// (node / edge). Fitur yang bukan tingkat hirarki (tiang, switch, saluran TM, dll.)
// diarahkan ke kelompok terdekat yang memuatnya.
func (g *Graph) AssetLocate(featKind string, id int64) []AssetRef {
	x := g.assetIdx()
	g.mu.RLock()
	var target AssetRef
	var n nodeRec
	if featKind == "edge" {
		if _, ok := x.routeGD[id]; ok {
			target = AssetRef{AssetRoute, id}
		} else if e, ok := g.edges[id]; ok {
			// saluran lain: ikut node ujung yang lebih hilir
			a, b := g.nodes[e.from], g.nodes[e.to]
			n = a
			if b.route != 0 || (b.gd != 0 && a.gd == 0) {
				n = b
			}
		}
	} else if nr, ok := g.nodes[id]; ok {
		n = nr
		switch {
		case nr.sink():
			target = AssetRef{AssetPelanggan, id}
		case g.typeName(nr.typ) == "gi":
			target = AssetRef{AssetGI, id}
		case g.typeName(nr.typ) == "trafo_gi":
			target = AssetRef{AssetTrafoGI, id}
		case g.typeName(nr.typ) == "gd":
			target = AssetRef{AssetGD, id}
		case g.typeName(nr.typ) == "trafo_distribusi":
			target = AssetRef{AssetTrafo, id}
		default:
			if _, ok := g.feeders[id]; ok {
				target = AssetRef{AssetFeeder, id}
			}
		}
	}
	if target.Kind == "" {
		switch {
		case n.route != 0:
			target = AssetRef{AssetRoute, n.route}
		case n.gd != 0:
			target = AssetRef{AssetGD, n.gd}
		case n.feeder != 0:
			target = AssetRef{AssetFeeder, n.feeder}
		default:
			g.mu.RUnlock()
			return nil
		}
	}
	g.mu.RUnlock()
	its := g.AssetItems([]AssetRef{target})
	it := its[0]
	path := []AssetRef{}
	orphan := it.GI == 0 && target.Kind != AssetGI && target.Kind != AssetTrafoGI
	if orphan {
		path = append(path, AssetRef{AssetNone, 0})
	}
	push := func(kind string, v int64) {
		if v != 0 && !(kind == target.Kind && v == target.ID) {
			path = append(path, AssetRef{kind, v})
		}
	}
	if !orphan {
		push(AssetGI, it.GI)
		push(AssetTrafoGI, it.TrafoGI)
	}
	if it.Feeder != 0 && (target.Kind == AssetGD || target.Kind == AssetTrafo || target.Kind == AssetRoute || target.Kind == AssetPelanggan) {
		push(AssetFeeder, it.Feeder)
	}
	switch target.Kind {
	case AssetTrafo, AssetRoute, AssetPelanggan:
		push(AssetGD, it.GD)
	}
	switch target.Kind {
	case AssetRoute, AssetPelanggan:
		push(AssetTrafo, it.Trafo)
	}
	if target.Kind == AssetPelanggan {
		push(AssetRoute, it.Route)
	}
	return append(path, target)
}

// AssetFilterState menyaring id aset pada tingkat level menurut status (on | partial | off)
// tanpa menyusun baris lengkap (cukup ringan untuk jutaan pelanggan).
func (g *Graph) AssetFilterState(level string, ids []int64, state string) []int64 {
	x := g.assetIdx()
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		var it AssetItem
		var a *assetAgg
		switch level {
		case AssetRoute:
			it.Energized = g.edges[id].energized
			a = x.routeStat[id]
		case AssetPelanggan:
			n := g.nodes[id]
			it.Energized = n.energized()
			if n.sink() {
				a = &assetAgg{pel: 1}
				if !it.Energized {
					a.pelOff = 1
				}
			}
		default:
			it.Energized = g.nodes[id].energized()
			a = x.stat[id]
		}
		if a != nil {
			it.Pelanggan, it.PelangganOff = a.pel, a.pelOff
		}
		if assetState(level, it) == state {
			out = append(out, id)
		}
	}
	return out
}

// AssetAnchors mengembalikan node penentu unit pemilik untuk tiap aset (sejajar dengan ids):
// aset node memakai dirinya sendiri; jurusan & pelanggan memakai gardunya (atau penyulang).
func (g *Graph) AssetAnchors(level string, ids []int64) []int64 {
	x := g.assetIdx()
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]int64, len(ids))
	for i, id := range ids {
		switch level {
		case AssetRoute:
			out[i] = x.routeGD[id]
			if out[i] == 0 {
				out[i] = x.routeTD[id]
			}
		case AssetPelanggan:
			n := g.nodes[id]
			out[i] = n.gd
			if out[i] == 0 {
				out[i] = n.feeder
			}
			if out[i] == 0 {
				out[i] = id
			}
		default:
			out[i] = id
		}
	}
	return out
}
