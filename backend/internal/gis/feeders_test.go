package gis

import (
	"math/rand"
	"testing"
)

// setupFeeders menjadikan node berjarak 1 dari sumber sebagai kepala penyulang dan menetapkan
// keanggotaan normal = penyuplai pada posisi awal (sehingga belum ada override aktual).
func setupFeeders(t *testing.T, g *Graph) {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	g.feeders = map[int64]*feederInfo{}
	for id, d := range g.dist {
		if d == 1 {
			g.feeders[id] = &feederInfo{Head: id}
		}
	}
	g.live, g.liveE = map[int64]int64{}, map[int64]int64{}
	want, _ := g.desiredLiveLocked()
	for id, f := range want {
		n := g.nodes[id]
		n.feeder = f
		g.nodes[id] = n
	}
	if w, we := g.desiredLiveLocked(); len(w) != 0 || len(we) != 0 {
		t.Fatalf("posisi awal masih punya override aktual: %d node, %d saluran", len(w), len(we))
	}
}

func sameLive(t *testing.T, label string, got, want map[int64]int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: inkremental %d override, penuh %d", label, len(got), len(want))
	}
	for id, f := range want {
		if g, ok := got[id]; !ok || g != f {
			t.Fatalf("%s: objek %d inkremental=%d(%v) penuh=%d", label, id, g, ok, f)
		}
	}
}

// Penyulang aktual yang diperbarui inkremental setelah setiap manuver harus sama dengan
// perhitungan penuh dari nol.
func TestLiveFeederIncrementalMatchesFull(t *testing.T) {
	for seed := int64(1); seed <= 120; seed++ {
		r := rand.New(rand.NewSource(seed))
		g := randomGraph(r, 60+r.Intn(300), r.Intn(40))
		g.rebuild()
		setupFeeders(t, g)
		sw := switches(g)
		if len(sw) == 0 {
			continue
		}
		g.mu.RLock()
		allNodes := make([]int64, 0, len(g.nodes))
		for id := range g.nodes {
			allNodes = append(allNodes, id)
		}
		allEdges := make([]int64, 0, len(g.edges))
		for id := range g.edges {
			allEdges = append(allEdges, id)
		}
		g.mu.RUnlock()
		for step := 0; step < 120; step++ {
			var in ManeuverInput
			switch r.Intn(4) {
			case 0:
				in = ManeuverInput{NodeID: allNodes[r.Intn(len(allNodes))], Open: r.Intn(2) == 0}
			case 1:
				in = ManeuverInput{EdgeID: allEdges[r.Intn(len(allEdges))], Open: r.Intn(2) == 0}
			default:
				id := sw[r.Intn(len(sw))]
				in = ManeuverInput{NodeID: id, Open: r.Intn(2) == 0}
				g.mu.RLock()
				multi := g.nodes[id].typ == g.typeIndex["lbs_3way"]
				ways := g.adj[id]
				g.mu.RUnlock()
				if multi && len(ways) > 0 && r.Intn(2) == 0 {
					in.WayEdge = ways[r.Intn(len(ways))]
				}
			}
			if _, err := g.Maneuver(in); err != nil {
				t.Fatalf("seed %d langkah %d: %v", seed, step, err)
			}
			g.mu.RLock()
			want, wantE := g.desiredLiveLocked()
			sameLive(t, "node", g.live, want)
			sameLive(t, "saluran", g.liveE, wantE)
			g.mu.RUnlock()
		}
	}
}

// Pelimpahan lewat tie point: seksi di hilir tie berpindah ke penyulang seberang, lalu kembali
// ke keanggotaan normal (tanpa override) setelah posisi dinormalkan.
func TestLiveFeederTransferViaTie(t *testing.T) {
	g := NewGraph(testTypes())
	g.mu.Lock()
	for id, tc := range map[int64]string{1: "power_grid", 2: "junction", 3: "junction", 4: "recloser", 5: "junction", 6: "junction", 7: "power_grid"} {
		status := "closed"
		if id == 4 {
			status = "open" // tie normally open
		}
		g.nodes[id] = g.makeNodeRecLocked(nodeRow{typ: tc, status: status}, nil)
	}
	add := func(eid, a, b int64) {
		g.edges[eid] = edgeRec{from: a, to: b, typ: g.typeIdxLocked("sutm")}
		g.adj[a] = append(g.adj[a], eid)
		g.adj[b] = append(g.adj[b], eid)
	}
	// penyulang A: 1-2-3-(4 tie)-5-6-7 penyulang B
	add(10, 1, 2)
	add(11, 2, 3)
	add(12, 3, 4)
	add(13, 4, 5)
	add(14, 5, 6)
	add(15, 6, 7)
	g.mu.Unlock()
	g.rebuild()
	setupFeeders(t, g)
	g.mu.RLock()
	a, b := g.nodes[3].feeder, g.nodes[5].feeder
	edgeTie := g.edgeFeederLocked(13, g.edges[13], false, nil)
	g.mu.RUnlock()
	if a != 2 || b != 6 {
		t.Fatalf("keanggotaan normal: node 3=%d (harap 2), node 5=%d (harap 6)", a, b)
	}
	if edgeTie != b {
		t.Fatalf("saluran tie 4-5 harus ikut sisi yang tidak terbuka (%d), dapat %d", b, edgeTie)
	}
	if par := g.ParallelFeeders(); len(par) != 0 {
		t.Fatalf("posisi normal tidak boleh paralel: %+v", par)
	}
	// kepala penyulang yang tersambung langsung (busbar antar-kubikel di GI) bukan paralel
	g.mu.Lock()
	g.edges[16] = edgeRec{from: 2, to: 6, typ: g.typeIdxLocked("sutm"), energized: true}
	g.adj[2] = append(g.adj[2], 16)
	g.adj[6] = append(g.adj[6], 16)
	g.parCache = nil
	g.mu.Unlock()
	if par := g.ParallelFeeders(); len(par) != 0 {
		t.Fatalf("saluran antar-kepala penyulang terbaca paralel: %+v", par)
	}
	g.mu.Lock()
	delete(g.edges, 16)
	g.adj[2], g.adj[6] = g.adj[2][:len(g.adj[2])-1], g.adj[6][:len(g.adj[6])-1]
	g.parCache = nil
	g.mu.Unlock()
	// tutup tie: kedua penyulang paralel lewat tie 4
	if _, err := g.Maneuver(ManeuverInput{NodeID: 4, Open: false}); err != nil {
		t.Fatal(err)
	}
	par := g.ParallelFeeders()
	if len(par) != 1 || par[0].A != 2 || par[0].B != 6 || len(par[0].Ties) != 1 || par[0].Ties[0] != 4 {
		t.Fatalf("paralel penyulang 2 & 6 lewat tie 4 tidak terdeteksi: %+v", par)
	}
	// buka saluran 2-3: node 3 & 4 kini disuplai penyulang B saja (radial, tidak paralel lagi)
	if _, err := g.Maneuver(ManeuverInput{EdgeID: 11, Open: true}); err != nil {
		t.Fatal(err)
	}
	if par := g.ParallelFeeders(); len(par) != 0 {
		t.Fatalf("setelah pelimpahan radial tidak boleh paralel: %+v", par)
	}
	if f, ok := g.LiveFeeder("node", 3); !ok || f != b {
		t.Fatalf("node 3 setelah pelimpahan: %d(%v), harap %d", f, ok, b)
	}
	if f, ok := g.LiveFeeder("edge", 12); !ok || f != b {
		t.Fatalf("saluran 3-4 setelah pelimpahan: %d(%v), harap %d", f, ok, b)
	}
	// normalkan kembali
	for _, in := range []ManeuverInput{{EdgeID: 11, Open: false}, {NodeID: 4, Open: true}} {
		if _, err := g.Maneuver(in); err != nil {
			t.Fatal(err)
		}
	}
	if n, e := g.LiveCounts(); n != 0 || e != 0 {
		t.Fatalf("setelah dinormalkan masih ada override: %d node, %d saluran", n, e)
	}
}

func TestAssignFeederColors(t *testing.T) {
	w := map[[2]int64]float64{{1, 2}: 100, {2, 3}: 100, {1, 3}: 100, {3, 4}: 1}
	c := AssignFeederColors([]int64{1, 2, 3, 4}, nil, w, FeederPaletteSize)
	if c[1] == c[2] || c[2] == c[3] || c[1] == c[3] {
		t.Fatalf("penyulang yang tersambung tie harus beda warna: %v", c)
	}
	if c[3] == c[4] {
		t.Fatalf("penyulang berdekatan sebaiknya beda warna bila masih ada warna bebas: %v", c)
	}
	// bertetangga kuat juga tidak mendapat warna yang mirip (mis. biru & indigo)
	sim := map[[2]int]bool{}
	for _, p := range feederSimilar {
		sim[p] = true
		sim[[2]int{p[1], p[0]}] = true
	}
	for _, p := range [][2]int64{{1, 2}, {2, 3}, {1, 3}} {
		if sim[[2]int{c[p[0]], c[p[1]]}] {
			t.Fatalf("penyulang %d & %d mendapat warna mirip (%d, %d)", p[0], p[1], c[p[0]], c[p[1]])
		}
	}
	// warna lama dipertahankan bila tidak lebih buruk
	prev := map[int64]int{1: 7, 2: 8, 3: 9, 4: 10}
	c2 := AssignFeederColors([]int64{1, 2, 3, 4}, prev, w, FeederPaletteSize)
	for id, p := range prev {
		if c2[id] != p {
			t.Fatalf("warna penyulang %d berubah %d → %d padahal tidak perlu", id, p, c2[id])
		}
	}
	// palet lebih kecil dari klik: tetap memberi warna valid
	c3 := AssignFeederColors([]int64{1, 2, 3}, nil, w, 2)
	for id, col := range c3 {
		if col < 0 || col >= 2 {
			t.Fatalf("warna penyulang %d di luar palet: %d", id, col)
		}
	}
}
