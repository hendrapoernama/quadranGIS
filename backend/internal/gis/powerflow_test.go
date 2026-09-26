package gis

import (
	"math"
	"testing"

	"quadrangis/internal/models"
)

func pfTypes() *Types {
	t := NewTypes(nil)
	for _, ct := range []models.ComponentType{
		{Code: "kubikel_20kv", GeomKind: "point", IsSwitch: true, VoltageKV: 20, Topology: true},
		{Code: "junction", GeomKind: "point", Topology: true},
		{Code: "gd", GeomKind: "polygon", VoltageKV: 20, Topology: true},
		{Code: "pelanggan_tm", GeomKind: "point", IsSink: true, VoltageKV: 20, Topology: true},
		{Code: "pelanggan_tr", GeomKind: "point", IsSink: true, VoltageKV: 0.22, Topology: true},
		{Code: "sutm", GeomKind: "line", VoltageKV: 20, Topology: true},
		{Code: "skutr", GeomKind: "line", VoltageKV: 0.4, Topology: true},
	} {
		t.list = append(t.list, ct)
		t.byCode[ct.Code] = ct
	}
	return t
}

func testParams() PFParams {
	p := PFParams{SourcePU: 1.0, LoadFactor: 1, PowerFactor: 0.85, VMinPU: 0.9, VMaxPU: 1.05, TrafoZPct: 4, TrafoXR: 3,
		DefaultTrafoKVA: 200, MaxIter: 100, Tol: 1e-10, Lines: map[string]LineParam{}}
	for k, v := range DefaultLineParams {
		p.Lines[k] = v
	}
	return p
}

// Dua bus: tegangan ujung harus sama dengan solusi analitik persamaan kuadrat |V2|^2.
func TestPowerFlowTwoBusMatchesAnalytic(t *testing.T) {
	const lengthM = 8000.0 // 8 km SUTM
	const loadVA = 3e6     // 3 MVA kontrak
	tree := &pfTree{head: 1,
		ids: []int64{1, 2}, parent: []int32{-1, 0}, edge: []int64{0, 10}, edgeType: []string{"", "sutm"},
		lengthM: []float32{0, lengthM}, loadVA: []float64{0, loadVA}, sink: []bool{false, true},
		nodeType: []string{"kubikel_20kv", "pelanggan_tm"}, customers: 1}
	p := testParams()
	res := solve(tree, pfTypes(), p, PFOverrides{}, true)
	if !res.Summary.Converged {
		t.Fatalf("tidak konvergen: %+v", res.Summary)
	}
	lp := DefaultLineParams["sutm"]
	zb := 20.0 * 20.0
	R, X := lp.R*lengthM/1000/zb, lp.X*lengthM/1000/zb
	P, Q := loadVA/1e6*0.85, loadVA/1e6*math.Sqrt(1-0.85*0.85)
	b := 2*(P*R+Q*X) - 1
	c := (P*P + Q*Q) * (R*R + X*X)
	v2 := math.Sqrt((-b + math.Sqrt(b*b-4*c)) / 2)
	got := res.Nodes[1].VPU
	if math.Abs(got-v2) > 1e-4 {
		t.Fatalf("tegangan ujung %.6f pu, analitik %.6f pu", got, v2)
	}
	// neraca daya: kirim = beban + susut
	if d := res.Summary.SendKW - res.Summary.LoadKW - res.Summary.LossKW; math.Abs(d) > 0.05 {
		t.Fatalf("neraca daya tidak seimbang: kirim %.3f, beban %.3f, susut %.3f", res.Summary.SendKW, res.Summary.LoadKW, res.Summary.LossKW)
	}
	// arus = S / (sqrt3 V)
	wantA := math.Hypot(res.Summary.SendKW, res.Summary.SendKVAr) / (math.Sqrt(3) * 20)
	if math.Abs(res.Edges[0].IA-wantA) > 0.5 {
		t.Fatalf("arus %.2f A, harapan %.2f A", res.Edges[0].IA, wantA)
	}
	t.Logf("V2=%.5f pu (analitik %.5f), susut %.2f kW, arus %.1f A", got, v2, res.Summary.LossKW, res.Edges[0].IA)
}

// Kepala -> SUTM -> GD (MV) -> SKUTR (TR) -> pelanggan: trafo di gardu, tegangan TR lebih rendah.
func TestPowerFlowTrafoTransition(t *testing.T) {
	tree := &pfTree{head: 1,
		ids: []int64{1, 2, 3, 4}, parent: []int32{-1, 0, 1, 2}, edge: []int64{0, 10, 11, 12},
		edgeType: []string{"", "sutm", "skutr", "skutr"}, lengthM: []float32{0, 2000, 150, 150},
		loadVA: []float64{0, 0, 0, 100000}, sink: []bool{false, false, false, true},
		nodeType: []string{"kubikel_20kv", "gd", "junction", "pelanggan_tr"}, customers: 1}
	p := testParams()
	res := solve(tree, pfTypes(), p, PFOverrides{TrafoKVA: map[int64]float64{2: 160}}, true)
	if len(res.Trafos) != 1 || res.Trafos[0].ID != 2 || res.Trafos[0].RatedKVA != 160 || res.Trafos[0].Assumed {
		t.Fatalf("trafo di gardu #2 (160 kVA) tidak terdeteksi: %+v", res.Trafos)
	}
	if lp := res.Trafos[0].LoadingPct; lp < 60 || lp > 70 { // ~100 kVA / 160 kVA (+ susut)
		t.Fatalf("pembebanan trafo %.1f%%, harapan sekitar 63%%", lp)
	}
	vMV, vLV := res.Nodes[1].VPU, res.Nodes[3].VPU
	if !(vLV < res.Trafos[0].VSecPU && res.Trafos[0].VSecPU < vMV) {
		t.Fatalf("urutan tegangan salah: MV %.4f, sekunder %.4f, pelanggan %.4f", vMV, res.Trafos[0].VSecPU, vLV)
	}
	if !res.Nodes[3].LV || res.Nodes[1].LV {
		t.Fatalf("penanda level tegangan salah: %+v", res.Nodes)
	}
	if d := res.Summary.SendKW - res.Summary.LoadKW - res.Summary.LossKW; math.Abs(d) > 0.01 {
		t.Fatalf("neraca daya: selisih %.4f kW", d)
	}
	// beban daya konstan: arus di saluran terakhir = S / (sqrt3 x V aktual pelanggan)
	wantA := 100.0 / (math.Sqrt(3) * 0.4 * vLV)
	if e := res.Edges[2]; math.Abs(e.IA-wantA)/wantA > 0.01 || !e.LV {
		t.Fatalf("arus SKUTR %.1f A, harapan %.1f A (V pelanggan %.4f pu)", e.IA, wantA, vLV)
	}
	t.Logf("MV %.4f pu, sekunder %.4f pu, pelanggan %.4f pu (%.1f V), trafo %.1f%%, susut %.3f kW",
		vMV, res.Trafos[0].VSecPU, vLV, res.Nodes[3].KV*1000, res.Trafos[0].LoadingPct, res.Summary.LossKW)
}

// Beban lebih: SR panjang dengan beban besar harus terdeteksi sebagai tegangan rendah & beban lebih.
func TestPowerFlowFlagsViolations(t *testing.T) {
	tree := &pfTree{head: 1,
		ids: []int64{1, 2, 3}, parent: []int32{-1, 0, 1}, edge: []int64{0, 10, 11},
		edgeType: []string{"", "sutm", "skutr"}, lengthM: []float32{0, 1000, 1500},
		loadVA: []float64{0, 0, 250000}, sink: []bool{false, false, true},
		nodeType: []string{"kubikel_20kv", "gd", "pelanggan_tr"}, customers: 1}
	res := solve(tree, pfTypes(), testParams(), PFOverrides{}, false)
	s := res.Summary
	if s.Status != "critical" || s.UnderV == 0 || s.Overload == 0 || s.TrafoOverload == 0 {
		t.Fatalf("pelanggaran tidak terdeteksi: %+v", s)
	}
}
