package gis

import "testing"

func TestTrafoStatuses(t *testing.T) {
	g := NewGraph(testTypes())
	g.mu.Lock()
	node := func(id int64, tc string, on bool, gd, route int64) {
		n := g.makeNodeRecLocked(nodeRow{typ: tc, status: "closed", energized: on}, nil)
		n.gd, n.route = gd, route
		g.nodes[id] = n
	}
	edge := func(id, a, b int64) {
		g.edges[id] = edgeRec{from: a, to: b, typ: g.typeIdxLocked("sktr"), energized: true}
		g.adj[a] = append(g.adj[a], id)
		g.adj[b] = append(g.adj[b], id)
	}
	// gardu 10: trafo 11 → rak 12 → jurusan 101 (pelanggan 21, 22); trafo 11 → jurusan 102 langsung (pelanggan 23 padam)
	node(10, "gd", true, 10, 0)
	node(11, "trafo_distribusi", true, 10, 0)
	node(12, "rak_tr", true, 10, 0)
	node(21, "pelanggan_tr", true, 10, 101)
	node(22, "pelanggan_tr", true, 10, 101)
	node(23, "pelanggan_tr", false, 10, 102)
	edge(100, 11, 12)
	edge(101, 12, 21)
	edge(103, 21, 22)
	edge(102, 11, 23)
	// trafo 14 padam tanpa jurusan; trafo 15 berstatus rencana (dikecualikan)
	node(14, "trafo_distribusi", false, 10, 0)
	node(15, "trafo_distribusi", true, 10, 0)
	g.setNonOpLocked(15, true)
	g.mu.Unlock()

	got := map[int64]TrafoStatus{}
	for _, x := range g.TrafoStatuses() {
		got[x.ID] = x
	}
	if len(got) != 2 {
		t.Fatalf("trafo = %+v", got)
	}
	if x := got[11]; x.State != "partial" || x.Routes != 2 || x.Customers != 3 || x.CustomersOff != 1 || x.GD != 10 {
		t.Fatalf("trafo 11 = %+v", x)
	}
	if x := got[14]; x.State != "off" || x.Routes != 0 || x.Customers != 0 {
		t.Fatalf("trafo 14 = %+v", x)
	}
	list := []TrafoStatus{got[11], got[14]}
	SortTrafoStatuses(list)
	if list[0].ID != 14 {
		t.Fatalf("urutan: padam harus di atas, dapat %+v", list)
	}
}
