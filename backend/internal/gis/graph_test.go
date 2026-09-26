package gis

import (
	"math/rand"
	"testing"

	"quadrangis/internal/models"
)

// testTypes membuat katalog tipe minimal tanpa database.
func testTypes() *Types {
	t := NewTypes(nil)
	for _, ct := range []models.ComponentType{
		{Code: "power_grid", GeomKind: "point", IsSource: true, Topology: true},
		{Code: "junction", GeomKind: "point", Topology: true},
		{Code: "recloser", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2},
		{Code: "lbs_3way", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 3},
		{Code: "pelanggan_tr", GeomKind: "point", IsSink: true, Topology: true},
		{Code: "sutm", GeomKind: "line", Topology: true, VoltageKV: 20},
	} {
		t.list = append(t.list, ct)
		t.byCode[ct.Code] = ct
	}
	return t
}

// randomGraph membangun jaringan acak: beberapa sumber, pohon + edge tambahan (loop / tie),
// sebagian node adalah switch.
func randomGraph(r *rand.Rand, nNodes, extraEdges int) *Graph {
	g := NewGraph(testTypes())
	g.mu.Lock()
	defer g.mu.Unlock()
	typeFor := func(i int) string {
		switch {
		case i < 2:
			return "power_grid"
		case r.Intn(6) == 0:
			return "recloser"
		case r.Intn(15) == 0:
			return "lbs_3way"
		case r.Intn(4) == 0:
			return "pelanggan_tr"
		}
		return "junction"
	}
	for i := 1; i <= nNodes; i++ {
		status := "closed"
		tc := typeFor(i - 1)
		if (tc == "recloser" || tc == "lbs_3way") && r.Intn(5) == 0 {
			status = "open"
		}
		g.nodes[int64(i)] = g.makeNodeRecLocked(nodeRow{typ: tc, status: status}, nil)
	}
	eid := int64(0)
	addEdge := func(a, b int64) {
		eid++
		g.edges[eid] = edgeRec{from: a, to: b, typ: g.typeIdxLocked("sutm")}
		g.adj[a] = append(g.adj[a], eid)
		g.adj[b] = append(g.adj[b], eid)
	}
	for i := 3; i <= nNodes; i++ {
		addEdge(int64(1+r.Intn(i-1)), int64(i))
	}
	for k := 0; k < extraEdges; k++ {
		a, b := int64(1+r.Intn(nNodes)), int64(1+r.Intn(nNodes))
		if a != b {
			addEdge(a, b)
		}
	}
	return g
}

func switches(g *Graph) []int64 {
	out := []int64{}
	for id, n := range g.nodes {
		if n.isSwitch() {
			out = append(out, id)
		}
	}
	return out
}

// checkConsistent membandingkan hasil inkremental dengan BFS penuh.
func checkConsistent(t *testing.T, g *Graph, step int) {
	t.Helper()
	g.mu.RLock()
	defer g.mu.RUnlock()
	full := g.bfsLocked(false)
	if len(full) != len(g.dist) {
		t.Fatalf("langkah %d: jumlah node terjangkau inkremental=%d penuh=%d", step, len(g.dist), len(full))
	}
	for id, d := range full {
		if got, ok := g.dist[id]; !ok || got != d {
			t.Fatalf("langkah %d: node %d jarak inkremental=%d(%v) penuh=%d", step, id, got, ok, d)
		}
	}
	for id, n := range g.nodes {
		_, on := full[id]
		if n.energized() != on {
			t.Fatalf("langkah %d: flag energized node %d=%v, seharusnya %v", step, id, n.energized(), on)
		}
	}
	for id, e := range g.edges {
		_, a := full[e.from]
		_, b := full[e.to]
		if want := a && b && !e.open; e.energized != want {
			t.Fatalf("langkah %d: flag energized edge %d=%v, seharusnya %v", step, id, e.energized, want)
		}
	}
}

func TestManeuverIncrementalMatchesFullRebuild(t *testing.T) {
	for seed := int64(1); seed <= 150; seed++ {
		r := rand.New(rand.NewSource(seed))
		g := randomGraph(r, 60+r.Intn(400), r.Intn(40))
		g.rebuild()
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
		for step := 0; step < 160; step++ {
			var in ManeuverInput
			switch r.Intn(4) {
			case 0: // node non-switch (gardu / pelanggan / sumber): ikut padam
				in = ManeuverInput{NodeID: allNodes[r.Intn(len(allNodes))], Open: r.Intn(2) == 0}
			case 1: // saluran
				in = ManeuverInput{EdgeID: allEdges[r.Intn(len(allEdges))], Open: r.Intn(2) == 0}
			default: // alat switching (seluruh / per arah)
				id := sw[r.Intn(len(sw))]
				in = ManeuverInput{NodeID: id, Open: r.Intn(2) == 0}
				g.mu.RLock()
				n := g.nodes[id]
				ways := g.adj[id]
				multi := n.typ == g.typeIndex["lbs_3way"]
				g.mu.RUnlock()
				if multi && len(ways) > 0 && r.Intn(2) == 0 {
					in.WayEdge = ways[r.Intn(len(ways))]
				}
			}
			diff, err := g.Maneuver(in)
			if err != nil {
				t.Fatalf("seed %d langkah %d: %v", seed, step, err)
			}
			_ = diff
			checkConsistent(t, g, step)
		}
	}
}

func TestManeuverDiffReportsDownstream(t *testing.T) {
	// sumber(1) - j(2) - recloser(3) - j(4) - pelanggan(5); recloser dibuka -> 4,5 padam
	g := NewGraph(testTypes())
	g.mu.Lock()
	types := []string{"power_grid", "junction", "recloser", "junction", "pelanggan_tr"}
	for i, tc := range types {
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(nodeRow{typ: tc, status: "closed", loadVA: 1300}, nil)
	}
	for i := int64(1); i < 5; i++ {
		g.edges[i] = edgeRec{from: i, to: i + 1, typ: g.typeIdxLocked("sutm")}
		g.adj[i] = append(g.adj[i], i)
		g.adj[i+1] = append(g.adj[i+1], i)
	}
	g.mu.Unlock()
	g.rebuild()

	diff, err := g.Maneuver(ManeuverInput{NodeID: 3, Open: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(diff.NodesOff) != 2 || len(diff.EdgesOff) != 2 {
		t.Fatalf("buka: diharapkan 2 node & 2 edge padam, dapat %+v", diff)
	}
	sum := g.Summarize(diff.NodesOff, len(diff.EdgesOff))
	if sum.Customers != 1 || sum.LoadVA != 1300 {
		t.Fatalf("ringkasan: pelanggan=%d beban=%v", sum.Customers, sum.LoadVA)
	}
	if again, _ := g.Maneuver(ManeuverInput{NodeID: 3, Open: true}); !again.Empty() {
		t.Fatalf("manuver berulang seharusnya tanpa perubahan: %+v", again)
	}
	diff, _ = g.Maneuver(ManeuverInput{NodeID: 3, Open: false})
	if len(diff.NodesOn) != 2 || len(diff.EdgesOn) != 2 {
		t.Fatalf("tutup: diharapkan 2 node & 2 edge menyala, dapat %+v", diff)
	}
	if _, err := g.Maneuver(ManeuverInput{NodeID: 2, Open: true, WayEdge: 1}); err != ErrNotSwitch {
		t.Fatalf("arah hanya untuk switch: err=%v", err)
	}
}

func TestManeuverNonSwitchAndLine(t *testing.T) {
	// sumber(1) - j(2) - j(3) - pelanggan(4)
	g := NewGraph(testTypes())
	g.mu.Lock()
	for i, tc := range []string{"power_grid", "junction", "junction", "pelanggan_tr"} {
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(nodeRow{typ: tc, status: "closed", loadVA: 900}, nil)
	}
	for i := int64(1); i < 4; i++ {
		g.edges[i] = edgeRec{from: i, to: i + 1, typ: g.typeIdxLocked("sutm")}
		g.adj[i] = append(g.adj[i], i)
		g.adj[i+1] = append(g.adj[i+1], i)
	}
	g.mu.Unlock()
	g.rebuild()
	d, err := g.Maneuver(ManeuverInput{NodeID: 4, Open: true})
	if err != nil || len(d.NodesOff) != 1 || d.NodesOff[0] != 4 {
		t.Fatalf("pelanggan diputus harus padam sendiri: %+v %v", d, err)
	}
	d, _ = g.Maneuver(ManeuverInput{NodeID: 4, Open: false})
	if len(d.NodesOn) != 1 {
		t.Fatalf("pelanggan dinormalkan harus menyala: %+v", d)
	}
	d, _ = g.Maneuver(ManeuverInput{EdgeID: 2, Open: true})
	if len(d.NodesOff) != 2 {
		t.Fatalf("saluran 2-3 diputus: node 3 & 4 padam, dapat %+v", d)
	}
	d, _ = g.Maneuver(ManeuverInput{EdgeID: 2, Open: false})
	if len(d.NodesOn) != 2 {
		t.Fatalf("saluran disambung: node 3 & 4 menyala, dapat %+v", d)
	}
	checkConsistent(t, g, 0)
}
