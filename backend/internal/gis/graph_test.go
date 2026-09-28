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

func TestFCOGrouping(t *testing.T) {
	// sumber(1) =busbar= kubikel(2) - j(3) - gd(4) - fco(5) - trafo(6) ~ pelanggan(7)
	//                                   \- fco(8) - gd(9) - trafo(10)          (FCO percabangan)
	ty := testTypes()
	for _, ct := range []models.ComponentType{
		{Code: "busbar", GeomKind: "line", Topology: true, VoltageKV: 20},
		{Code: "sktm", GeomKind: "line", Topology: true, VoltageKV: 20},
		{Code: "skutr", GeomKind: "line", Topology: true, VoltageKV: 0.4},
		{Code: "kubikel_20kv", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "fco", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "gd", GeomKind: "point", Topology: true, VoltageKV: 20},
		{Code: "trafo_distribusi", GeomKind: "point", Topology: true, VoltageKV: 0.4},
	} {
		ty.list = append(ty.list, ct)
		ty.byCode[ct.Code] = ct
	}
	g := NewGraph(ty)
	g.mu.Lock()
	nodes := []string{"power_grid", "kubikel_20kv", "junction", "gd", "fco", "trafo_distribusi", "pelanggan_tr", "fco", "gd", "trafo_distribusi"}
	for i, tc := range nodes {
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(nodeRow{typ: tc, status: "closed", loadVA: 1300}, nil)
	}
	edges := [][3]any{{1, 2, "busbar"}, {2, 3, "sktm"}, {3, 4, "sktm"}, {4, 5, "sktm"}, {5, 6, "sktm"}, {6, 7, "skutr"}, {3, 8, "sktm"}, {8, 9, "sktm"}, {9, 10, "sktm"}}
	for i, e := range edges {
		id, a, b := int64(i+1), int64(e[0].(int)), int64(e[1].(int))
		g.edges[id] = edgeRec{from: a, to: b, typ: g.typeIdxLocked(e[2].(string))}
		g.adj[a] = append(g.adj[a], id)
		g.adj[b] = append(g.adj[b], id)
	}
	g.mu.Unlock()
	g.rebuild()
	g.computeGroups()

	g.mu.RLock()
	defer g.mu.RUnlock()
	n := func(id int64) nodeRec { return g.nodes[id] }
	for _, id := range []int64{5, 6, 7} {
		if n(id).gd != 4 {
			t.Errorf("node %d: gardu = %d, diharapkan 4 (FCO trafo tidak melepas penanda gardu)", id, n(id).gd)
		}
		if n(id).zone != n(4).zone {
			t.Errorf("node %d: zona = %d, diharapkan sama dengan gardu (%d): FCO trafo tidak membentuk zona", id, n(id).zone, n(4).zone)
		}
	}
	if n(9).zone != 8 {
		t.Errorf("FCO percabangan harus membentuk zona: zona gardu 9 = %d", n(9).zone)
	}
	if n(10).gd != 9 {
		t.Errorf("trafo 10: gardu = %d, diharapkan 9", n(10).gd)
	}
	if n(7).feeder != 2 {
		t.Errorf("pelanggan: penyulang = %d, diharapkan 2", n(7).feeder)
	}
}

func TestPMTPMSZoneAndGarduBusbar(t *testing.T) {
	// sumber(1) =busbar= kubikel(2) - gh(3) - PMT(4, pembatas zona) - j(5) - gd(6) =busbar_gardu= j(10) - fco(11) - trafo(12)
	//                                    \- PMS(7, hanya pemutus) - j(8) - gd(9)
	ty := testTypes()
	for _, ct := range []models.ComponentType{
		{Code: "busbar", GeomKind: "line", Topology: true, VoltageKV: 20},
		{Code: "busbar_gardu", GeomKind: "line", Topology: true, VoltageKV: 20},
		{Code: "sktm", GeomKind: "line", Topology: true, VoltageKV: 20},
		{Code: "kubikel_20kv", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "pmt_20kv", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "pms_20kv", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "fco", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "gh", GeomKind: "point", Topology: true, VoltageKV: 20},
		{Code: "gd", GeomKind: "point", Topology: true, VoltageKV: 20},
		{Code: "trafo_distribusi", GeomKind: "point", Topology: true, VoltageKV: 0.4},
	} {
		ty.list = append(ty.list, ct)
		ty.byCode[ct.Code] = ct
	}
	g := NewGraph(ty)
	g.mu.Lock()
	ya, tidak := "Ya", "Tidak"
	rows := []nodeRow{
		{typ: "power_grid"}, {typ: "kubikel_20kv"}, {typ: "gh"}, {typ: "pmt_20kv", zone: &ya}, {typ: "junction"}, {typ: "gd"},
		{typ: "pms_20kv", zone: &tidak}, {typ: "junction"}, {typ: "gd"}, {typ: "junction"}, {typ: "fco"}, {typ: "trafo_distribusi"},
	}
	for i, r := range rows {
		r.status = "closed"
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(r, nil)
	}
	edges := [][3]any{{1, 2, "busbar"}, {2, 3, "sktm"}, {3, 4, "sktm"}, {4, 5, "sktm"}, {5, 6, "sktm"}, {3, 7, "sktm"}, {7, 8, "sktm"}, {8, 9, "sktm"},
		{6, 10, "busbar_gardu"}, {10, 11, "sktm"}, {11, 12, "sktm"}}
	for i, e := range edges {
		id, a, b := int64(i+1), int64(e[0].(int)), int64(e[1].(int))
		g.edges[id] = edgeRec{from: a, to: b, typ: g.typeIdxLocked(e[2].(string))}
		g.adj[a] = append(g.adj[a], id)
		g.adj[b] = append(g.adj[b], id)
	}
	g.mu.Unlock()
	g.rebuild()
	g.computeGroups()

	g.mu.RLock()
	defer g.mu.RUnlock()
	n := func(id int64) nodeRec { return g.nodes[id] }
	if !n(7).noZone() || n(4).noZone() {
		t.Fatalf("flag pembatas zona: PMT=%v PMS=%v", !n(4).noZone(), !n(7).noZone())
	}
	if n(6).zone != 4 {
		t.Errorf("PMT pembatas zona: zona gardu 6 = %d, diharapkan 4", n(6).zone)
	}
	if n(9).zone != n(3).zone {
		t.Errorf("PMS hanya pemutus: zona gardu 9 = %d, diharapkan sama dengan GH (%d)", n(9).zone, n(3).zone)
	}
	if n(12).gd != 6 || n(11).gd != 6 || n(10).gd != 6 {
		t.Errorf("busbar gardu: penanda gardu j=%d fco=%d trafo=%d, diharapkan 6", n(10).gd, n(11).gd, n(12).gd)
	}
	if n(12).zone != 4 {
		t.Errorf("trafo di gardu 6 harus di zona PMT (4), dapat %d", n(12).zone)
	}
}

func TestBulkCustomerCount(t *testing.T) {
	// sumber(1) - recloser(2) - j(3) - pelanggan kolektif(4, 50 plg) ; j(3) - pelanggan(5)
	ty := testTypes()
	ct := models.ComponentType{Code: "pelanggan_bulk", GeomKind: "point", IsSink: true, Topology: true, VoltageKV: 0.4}
	ty.list = append(ty.list, ct)
	ty.byCode[ct.Code] = ct
	g := NewGraph(ty)
	g.mu.Lock()
	fifty := 50.0
	rows := []nodeRow{{typ: "power_grid"}, {typ: "recloser"}, {typ: "junction"}, {typ: "pelanggan_bulk", loadVA: 90000, cust: &fifty}, {typ: "pelanggan_tr", loadVA: 1300}}
	for i, r := range rows {
		r.status = "closed"
		id := int64(i + 1)
		g.nodes[id] = g.makeNodeRecLocked(r, nil)
		g.setBulkLocked(id, r)
	}
	for i, e := range [][2]int64{{1, 2}, {2, 3}, {3, 4}, {3, 5}} {
		id := int64(i + 1)
		g.edges[id] = edgeRec{from: e[0], to: e[1], typ: g.typeIdxLocked("sutm")}
		g.adj[e[0]] = append(g.adj[e[0]], id)
		g.adj[e[1]] = append(g.adj[e[1]], id)
	}
	g.mu.Unlock()
	g.rebuild()
	if c := g.CustomerCount(4); c != 50 {
		t.Fatalf("jumlah pelanggan kolektif = %d, diharapkan 50", c)
	}
	diff, err := g.Maneuver(ManeuverInput{NodeID: 2, Open: true})
	if err != nil {
		t.Fatal(err)
	}
	sum := g.Summarize(diff.NodesOff, len(diff.EdgesOff))
	if sum.Customers != 51 || sum.LoadVA != 91300 {
		t.Fatalf("ringkasan padam: pelanggan=%d beban=%v, diharapkan 51 & 91300", sum.Customers, sum.LoadVA)
	}
	ps, _ := g.PowerSummary()
	if ps.Customers.Total != 51 || ps.Customers.Off != 51 {
		t.Fatalf("rekap pelanggan: total=%d padam=%d, diharapkan 51/51", ps.Customers.Total, ps.Customers.Off)
	}
}

func TestInactiveCustomerNotCounted(t *testing.T) {
	// sumber(1) - recloser(2) - j(3) - pelanggan(4, tidak operasi) ; j(3) - pelanggan(5) ; pelanggan(6, bongkar, tanpa SR)
	g := NewGraph(testTypes())
	g.mu.Lock()
	rows := []nodeRow{{typ: "power_grid"}, {typ: "recloser"}, {typ: "junction"}, {typ: "pelanggan_tr", nonOp: true}, {typ: "pelanggan_tr", loadVA: 1300}, {typ: "pelanggan_tr", nonOp: true}}
	for i, r := range rows {
		r.status = "closed"
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(r, nil)
	}
	for i, e := range [][2]int64{{1, 2}, {2, 3}, {3, 4}, {3, 5}} {
		id := int64(i + 1)
		g.edges[id] = edgeRec{from: e[0], to: e[1], typ: g.typeIdxLocked("sutm")}
		g.adj[e[0]] = append(g.adj[e[0]], id)
		g.adj[e[1]] = append(g.adj[e[1]], id)
	}
	g.mu.Unlock()
	g.rebuild()
	sum, _ := g.PowerSummary()
	if sum.Customers.Total != 1 || sum.Customers.Off != 0 {
		t.Fatalf("pelanggan total/padam = %d/%d, diharapkan 1/0 (tidak operasi & bongkar tidak dihitung)", sum.Customers.Total, sum.Customers.Off)
	}
}

func TestPlannedSubstationNotCounted(t *testing.T) {
	// sumber(1) - recloser(2) - gd(3) - pelanggan(4) ; gd rencana(5) lepas ; gd lepas(6) tanpa status
	g := NewGraph(testTypes())
	g.mu.Lock()
	rows := []nodeRow{{typ: "power_grid"}, {typ: "recloser"}, {typ: "gd"}, {typ: "pelanggan_tr", loadVA: 1300}, {typ: "gd", nonOp: true}, {typ: "gd"}}
	for i, r := range rows {
		r.status = "closed"
		id := int64(i + 1)
		g.nodes[id] = g.makeNodeRecLocked(r, nil)
		g.setNonOpLocked(id, r.nonOp)
	}
	for i, e := range [][2]int64{{1, 2}, {2, 3}, {3, 4}} {
		id := int64(i + 1)
		g.edges[id] = edgeRec{from: e[0], to: e[1], typ: g.typeIdxLocked("sutm")}
		g.adj[e[0]] = append(g.adj[e[0]], id)
		g.adj[e[1]] = append(g.adj[e[1]], id)
	}
	g.mu.Unlock()
	g.rebuild()
	sum, _ := g.PowerSummary()
	if sum.GD.Total != 2 || sum.GD.Off != 1 {
		t.Fatalf("gardu total/padam = %d/%d, diharapkan 2/1 (gardu rencana tidak dihitung)", sum.GD.Total, sum.GD.Off)
	}
	for _, x := range g.GDStatuses() {
		if x.ID == 5 {
			t.Fatal("gardu rencana muncul di daftar status gardu")
		}
	}
	if sum := g.Summarize([]int64{3, 5}, 0); sum.GD != 1 {
		t.Fatalf("gardu terdampak = %d, diharapkan 1", sum.GD)
	}
}
