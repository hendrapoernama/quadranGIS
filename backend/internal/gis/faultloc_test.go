package gis

import (
	"math"
	"testing"

	"quadrangis/internal/models"
)

func TestDetectFaultType(t *testing.T) {
	cases := []struct {
		ia, ib, ic, in float64
		want           string
	}{
		{4000, 4100, 3900, 0, "3ph"},
		{3500, 3400, 150, 0, "2ph"},
		{900, 120, 110, 850, "1ph"},
	}
	for _, c := range cases {
		if got, _ := DetectFaultType(c.ia, c.ib, c.ic, c.in); got != c.want {
			t.Errorf("DetectFaultType(%v,%v,%v,%v) = %s, diharapkan %s", c.ia, c.ib, c.ic, c.in, got, c.want)
		}
	}
}

func TestFaultLocateBranches(t *testing.T) {
	// sumber(1) - kubikel(2) -1 km- j(3) -1 km- j(4)
	//                                  \-1 km- j(5)
	ty := testTypes()
	for _, ct := range []models.ComponentType{
		{Code: "kubikel_20kv", GeomKind: "point", IsSwitch: true, Topology: true, Ways: 2, VoltageKV: 20},
		{Code: "sktm", GeomKind: "line", Topology: true, VoltageKV: 20},
	} {
		ty.list = append(ty.list, ct)
		ty.byCode[ct.Code] = ct
	}
	g := NewGraph(ty)
	g.mu.Lock()
	for i, tc := range []string{"power_grid", "kubikel_20kv", "junction", "junction", "junction"} {
		g.nodes[int64(i+1)] = g.makeNodeRecLocked(nodeRow{typ: tc, status: "closed"}, nil)
	}
	for i, e := range [][3]any{{1, 2, 0.0}, {2, 3, 1000.0}, {3, 4, 1000.0}, {3, 5, 1000.0}} {
		id, a, b := int64(i+1), int64(e[0].(int)), int64(e[1].(int))
		g.edges[id] = edgeRec{from: a, to: b, typ: g.typeIdxLocked("sktm"), lengthM: float32(e[2].(float64))}
		g.adj[a] = append(g.adj[a], id)
		g.adj[b] = append(g.adj[b], id)
	}
	g.mu.Unlock()
	g.rebuild()

	lines := map[string]LineParam{"sktm": {R: 0.125, X: 0.097}}
	p := FaultLocParams{DeviceID: 2, FaultType: "3ph", SourceMVA: 500, SourceXR: 10, KV: 20, Z0Ratio: 3, TolPct: 5}
	p.Normalize()
	zmag := 20.0 * 20 / 500
	rs := zmag / math.Sqrt(101)
	z1s := complex(rs, rs*10)
	want := p.faultCurrent("3ph", z1s, z1s, complex(0.125*1.5, 0.097*1.5), 0) // arus tepat di 1,5 km
	p.CurrentA = want
	res, err := g.FaultLocate(p, lines, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Candidates) != 2 {
		t.Fatalf("diharapkan 2 kandidat (dua cabang), dapat %d: %+v", len(res.Candidates), res.Candidates)
	}
	for _, c := range res.Candidates {
		if math.Abs(c.DistanceM-1500) > 5 {
			t.Errorf("kandidat di %.1f m, diharapkan ±1500 m", c.DistanceM)
		}
		if c.EdgeID != 3 && c.EdgeID != 4 {
			t.Errorf("kandidat pada saluran %d, diharapkan 3 atau 4", c.EdgeID)
		}
		if math.Abs(c.Frac-0.5) > 0.01 {
			t.Errorf("posisi pada saluran %.3f, diharapkan 0,5", c.Frac)
		}
	}
	if res.IMaxA <= want || res.IMinA >= want {
		t.Errorf("rentang arus %.0f–%.0f A tidak memuat %.0f A", res.IMinA, res.IMaxA, want)
	}
	// arus di atas maksimum alat → peringatan
	p.CurrentA = res.IMaxA * 1.5
	if r2, _ := g.FaultLocate(p, lines, nil); len(r2.Candidates) != 0 || len(r2.Warnings) == 0 || r2.Warnings[0] != "above_max" {
		t.Errorf("arus di atas maksimum: %+v", r2.Warnings)
	}
}
