package gis

import (
	"math/rand"
	"testing"
)

// Simulasi harus memprediksi persis status nyala/padam yang dihasilkan manuver sungguhan.
func TestSimulateMatchesManeuver(t *testing.T) {
	p := SimParams{CapacityVA: 1e9, LoadFactor: 0.6}
	for seed := int64(1); seed <= 60; seed++ {
		r := rand.New(rand.NewSource(seed))
		g := randomGraph(r, 60+r.Intn(300), r.Intn(30))
		g.rebuild()
		g.mu.RLock()
		nodes := make([]int64, 0, len(g.nodes))
		for id := range g.nodes {
			nodes = append(nodes, id)
		}
		edges := make([]int64, 0, len(g.edges))
		for id := range g.edges {
			edges = append(edges, id)
		}
		g.mu.RUnlock()
		for trial := 0; trial < 25; trial++ {
			n := 1 + r.Intn(4)
			actions := make([]SimAction, 0, n)
			for k := 0; k < n; k++ {
				act := "close"
				if r.Intn(2) == 0 {
					act = "open"
				}
				if r.Intn(3) == 0 {
					actions = append(actions, SimAction{TargetKind: "edge", TargetID: edges[r.Intn(len(edges))], Action: act})
				} else {
					actions = append(actions, SimAction{TargetKind: "node", TargetID: nodes[r.Intn(len(nodes))], Action: act})
				}
			}
			g.mu.RLock()
			pre := make(map[int64]bool, len(g.nodes))
			for id, nd := range g.nodes {
				pre[id] = nd.energized()
			}
			g.mu.RUnlock()
			res, err := g.Simulate(actions, p, 1<<30)
			if err != nil {
				t.Fatalf("seed %d: %v", seed, err)
			}
			want := make(map[int64]bool, len(pre))
			for id, v := range pre {
				want[id] = v
			}
			for _, id := range res.NodesOn {
				want[id] = true
			}
			for _, id := range res.NodesOff {
				want[id] = false
			}
			for _, a := range actions {
				in := ManeuverInput{Open: a.Action == "open"}
				if a.TargetKind == "edge" {
					in.EdgeID = a.TargetID
				} else {
					in.NodeID = a.TargetID
				}
				if _, err := g.Maneuver(in); err != nil {
					t.Fatalf("seed %d manuver: %v", seed, err)
				}
			}
			g.mu.RLock()
			for id, nd := range g.nodes {
				if nd.energized() != want[id] {
					g.mu.RUnlock()
					t.Fatalf("seed %d uji %d: node %d simulasi=%v nyata=%v (langkah %+v)", seed, trial, id, want[id], nd.energized(), actions)
				}
			}
			g.mu.RUnlock()
		}
	}
}

// Skenario FLISR: recloser trip, gangguan di seksi tengah, hilir dipulihkan lewat tie dari sumber kedua.
//
//	src1 - j2 - rec3 - j4 - lbs5 - j6(gangguan) - lbs7 - j8 - plg9
//	                                                    |
//	                                        tie10(NO) - j11 - src12
func TestFLISRIsolatesAndRestores(t *testing.T) {
	g := NewGraph(testTypes())
	g.mu.Lock()
	spec := []struct {
		typ, status string
	}{
		{"power_grid", "closed"}, {"junction", "closed"}, {"recloser", "closed"}, {"junction", "closed"},
		{"lbs_3way", "closed"}, {"junction", "closed"}, {"recloser", "closed"}, {"junction", "closed"},
		{"pelanggan_tr", "closed"}, {"recloser", "open"}, {"junction", "closed"}, {"power_grid", "closed"},
	}
	for i, s := range spec {
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(nodeRow{typ: s.typ, status: s.status, loadVA: 1300}, nil)
	}
	link := [][2]int64{{1, 2}, {2, 3}, {3, 4}, {4, 5}, {5, 6}, {6, 7}, {7, 8}, {8, 9}, {8, 10}, {10, 11}, {11, 12}}
	for i, l := range link {
		eid := int64(i + 1)
		g.edges[eid] = edgeRec{from: l[0], to: l[1], typ: g.typeIdxLocked("sutm"), lengthM: 100}
		g.adj[l[0]] = append(g.adj[l[0]], eid)
		g.adj[l[1]] = append(g.adj[l[1]], eid)
	}
	g.mu.Unlock()
	g.rebuild()
	// recloser trip
	if _, err := g.Maneuver(ManeuverInput{NodeID: 3, Open: true}); err != nil {
		t.Fatal(err)
	}
	g.mu.RLock()
	if g.nodes[9].energized() {
		g.mu.RUnlock()
		t.Fatal("pelanggan 9 seharusnya padam setelah trip")
	}
	g.mu.RUnlock()

	res, err := g.FLISR("node", 6, SimParams{CapacityVA: 1e7, LoadFactor: 0.6}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if res.Upstream != 5 || res.Tripped != 3 {
		t.Fatalf("hulu=%d (harus 5) trip=%d (harus 3)", res.Upstream, res.Tripped)
	}
	got := map[string]bool{}
	for _, a := range res.Actions {
		got[a.Action+":"+itoa(a.TargetID)] = true
	}
	for _, want := range []string{"open:5", "open:7", "close:3", "close:10"} {
		if !got[want] {
			t.Fatalf("langkah %s tidak ada: %+v", want, res.Actions)
		}
	}
	if len(res.Islands) != 1 || res.Islands[0].Tie == nil || res.Islands[0].Tie.SwitchID != 10 {
		t.Fatalf("pulau hilir harus dipulihkan lewat tie 10: %+v", res.Islands)
	}
	if res.Sim.CustomersRestored != 1 || res.Sim.CustomersOffAfter != 0 {
		t.Fatalf("pelanggan pulih=%d (harus 1), padam setelah=%d (harus 0)", res.Sim.CustomersRestored, res.Sim.CustomersOffAfter)
	}
	// seksi gangguan (j6) tetap padam setelah rencana dijalankan
	for _, a := range res.Actions {
		in := ManeuverInput{NodeID: a.TargetID, Open: a.Action == "open", WayEdge: a.WayEdge}
		if _, err := g.Maneuver(in); err != nil {
			t.Fatal(err)
		}
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.nodes[6].energized() || !g.nodes[9].energized() || !g.nodes[4].energized() {
		t.Fatalf("setelah eksekusi: j6=%v (padam) plg9=%v (nyala) j4=%v (nyala)", g.nodes[6].energized(), g.nodes[9].energized(), g.nodes[4].energized())
	}
}

// Menutup tie di antara dua sisi bertegangan harus memberi peringatan paralel.
func TestSimulateParallelWarning(t *testing.T) {
	g := NewGraph(testTypes())
	g.mu.Lock()
	for i, typ := range []string{"power_grid", "junction", "recloser", "junction", "power_grid"} {
		status := "closed"
		if i == 2 {
			status = "open"
		}
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(nodeRow{typ: typ, status: status}, nil)
	}
	for i := int64(1); i < 5; i++ {
		g.edges[i] = edgeRec{from: i, to: i + 1, typ: g.typeIdxLocked("sutm")}
		g.adj[i] = append(g.adj[i], i)
		g.adj[i+1] = append(g.adj[i+1], i)
	}
	// tandai kedua sumber sebagai kepala "penyulang" berbeda agar label pemasok berbeda
	g.feeders[1] = &feederInfo{Head: 1}
	g.feeders[5] = &feederInfo{Head: 5}
	g.mu.Unlock()
	g.rebuild()
	res, err := g.Simulate([]SimAction{{TargetKind: "node", TargetID: 3, Action: "close"}}, SimParams{CapacityVA: 1e9, LoadFactor: 0.6}, 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, w := range res.Steps[0].Warnings {
		if w.Code == "parallel" && len(w.Feeders) == 2 {
			found = true
		}
	}
	if !found {
		t.Fatalf("peringatan paralel tidak muncul: %+v", res.Steps[0].Warnings)
	}
}
