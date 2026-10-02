package gis

import (
	"reflect"
	"testing"
)

func TestParseWays(t *testing.T) {
	s := func(v string) *string { return &v }
	cases := []struct {
		in   *string
		want []int64
		ok   bool
	}{
		{nil, nil, false},
		{s(`[12, "34"]`), []int64{12, 34}, true},
		{s(`[]`), nil, true},
		{s(`bukan json`), nil, false},
	}
	for _, c := range cases {
		got, ok := parseWays(c.in)
		if ok != c.ok || !reflect.DeepEqual(got, c.want) {
			t.Fatalf("parseWays(%v) = %v %v; ingin %v %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestNormalDeviations(t *testing.T) {
	g := NewGraph(testTypes())
	closed, open := "closed", "open"
	add := func(id int64, tc, status string, normal *string, on bool) {
		g.nodes[id] = g.makeNodeRecLocked(nodeRow{typ: tc, status: status, normal: normal, energized: on}, nil)
	}
	edge := func(id, a, b int64) {
		g.edges[id] = edgeRec{from: a, to: b, typ: g.typeIdxLocked("sutm")}
		g.adj[a] = append(g.adj[a], id)
		g.adj[b] = append(g.adj[b], id)
	}
	// 1 sumber — 2 recloser normal tertutup, kini terbuka — 3 junction padam (isolasi)
	add(1, "power_grid", "closed", nil, true)
	add(2, "recloser", "open", &closed, true)
	add(3, "junction", "closed", nil, false)
	edge(1, 1, 2)
	edge(2, 2, 3)
	// 4 recloser normal terbuka, kini tertutup (tie dipakai), kedua sisi bertegangan
	add(4, "recloser", "closed", &open, true)
	add(5, "junction", "closed", nil, true)
	edge(3, 1, 4)
	edge(4, 4, 5)
	// 6 LBS 3 arah: arah saluran 5 kini terbuka, normalnya semua tertutup
	add(6, "lbs_3way", "closed", &closed, true)
	edge(5, 5, 6)
	g.openWays[6] = waysSet([]int64{5})
	// 7 recloser normal terbuka & memang terbuka: bukan penyimpangan
	add(7, "recloser", "open", &open, true)
	edge(6, 5, 7)

	got := map[int64]NormalDeviation{}
	for _, d := range g.NormalDeviations() {
		got[d.ID] = d
	}
	if len(got) != 3 {
		t.Fatalf("penyimpangan = %+v", got)
	}
	if d := got[2]; d.Normal != "closed" || d.Actual != "open" || !d.DeadSide {
		t.Fatalf("recloser isolasi = %+v", d)
	}
	if d := got[4]; d.Normal != "open" || d.Actual != "closed" || d.DeadSide {
		t.Fatalf("tie tertutup = %+v", d)
	}
	if d := got[6]; !d.MultiWay || len(d.NormalWays) != 0 || !reflect.DeepEqual(d.ActualWays, []int64{5}) {
		t.Fatalf("LBS 3 arah = %+v", d)
	}
}
