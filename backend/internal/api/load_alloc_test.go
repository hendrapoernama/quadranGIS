package api

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"quadrangis/internal/gis"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6*math.Max(1, math.Abs(b)) }

func TestAllocate(t *testing.T) {
	at := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	ts := at.Add(-30 * time.Minute)
	// penyulang 10: kontrak pelanggan 2 MVA, beban terukur 1,5 MVA / 1,35 MW; pelanggan padam 400 kVA
	// penyulang 20: tanpa data ukur → estimasi (faktor beban 0,6, cos φ 0,85)
	// tanpa penyulang: 100 kVA → estimasi
	byFeeder := map[int64]float64{10: 400_000, 20: 300_000, 0: 100_000}
	base := map[int64]float64{10: 2_000_000, 20: 1_000_000}
	refs := map[int64]feederRef{10: {VA: 1_500_000, W: 1_350_000, Source: allocMeasured, TS: &ts}}
	a := allocate(byFeeder, base, refs, 0.6, 0.85, at)
	if len(a.Feeders) != 3 || a.Feeders[0].ID != 0 || a.Feeders[2].ID != 20 {
		t.Fatalf("penyulang = %+v", a.Feeders)
	}
	f10 := a.Feeders[1]
	// beban pelanggan = 400 kVA ÷ 2 MVA × 1,5 MVA = 300 kVA; daya aktif 400 ÷ 2000 × 1350 = 270 kW
	if f10.Source != allocMeasured || !near(f10.VA, 300_000) || !near(f10.W, 270_000) || !near(f10.FactorS, 0.75) {
		t.Fatalf("penyulang terukur = %+v", f10)
	}
	if f20 := a.Feeders[2]; f20.Source != allocEstimate || !near(f20.VA, 180_000) || !near(f20.W, 153_000) {
		t.Fatalf("penyulang estimasi = %+v", f20)
	}
	if !near(a.ContractVA, 800_000) || !near(a.VA, 300_000+180_000+60_000) || a.Sources[allocMeasured] != 1 || a.Sources[allocEstimate] != 2 {
		t.Fatalf("total = %+v", a)
	}
	// faktor tidak wajar dibatasi (beban terukur jauh melebihi daya kontrak di GIS)
	a = allocate(map[int64]float64{10: 100}, map[int64]float64{10: 1000}, map[int64]feederRef{10: {VA: 1e6, W: 9e5, Source: allocProfile}}, 0.6, 0.85, at)
	if f := a.Feeders[0]; f.FactorS != 3 || f.Source != allocProfile {
		t.Fatalf("batas faktor = %+v", f)
	}
}

func TestApplyReliabilityLoadBasis(t *testing.T) {
	start := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	end := start.Add(2 * time.Hour)
	sum, _ := json.Marshal(map[string]any{"pelanggan": 10, "beban_va": 1_000_000, "beban_alokasi": map[string]any{"w": 450_000}})
	rp := gis.ReliabilityParams{TariffRpPerKWh: 1000, LoadFactor: 0.6, PowerFactor: 0.85, SustainedMinutes: 5}

	o := gis.OutageRecord{StartedAt: start, EndedAt: &end, Summary: sum}
	gis.ApplyReliability(&o, time.Time{}, time.Time{}, rp)
	if o.ENSBasis != "kontrak" || !near(o.ENSkWh, 1000*0.6*0.85*2) {
		t.Fatalf("kontrak: %s %v", o.ENSBasis, o.ENSkWh)
	}
	rp.LoadBasis = gis.LoadBasisAlloc
	gis.ApplyReliability(&o, time.Time{}, time.Time{}, rp)
	if o.ENSBasis != "alokasi" || !near(o.ENSkWh, 450*2) || !near(o.ENSRp, 900_000) {
		t.Fatalf("alokasi: %s %v %v", o.ENSBasis, o.ENSkWh, o.ENSRp)
	}
	// kejadian lama tanpa alokasi tetap memakai daya kontrak
	old, _ := json.Marshal(map[string]any{"pelanggan": 10, "beban_va": 1_000_000})
	o = gis.OutageRecord{StartedAt: start, EndedAt: &end, Summary: old}
	gis.ApplyReliability(&o, time.Time{}, time.Time{}, rp)
	if o.ENSBasis != "kontrak" {
		t.Fatalf("tanpa alokasi: %s", o.ENSBasis)
	}
}
