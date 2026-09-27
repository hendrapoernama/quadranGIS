package gis

import "testing"

func TestRegionPartSplitsByCustomers(t *testing.T) {
	o := OutageRecord{Customers: 100, CustomerMinutes: 6000, ENSkWh: 50, ENSRp: 1000, Regions: map[string]int{"7": 60, "9": 30}}
	a, ok := RegionPart(o, 7)
	if !ok || a.Customers != 60 || a.CustomerMinutes != 3600 || a.ENSRp != 600 {
		t.Fatalf("ULP 7: %+v", a)
	}
	out, ok := RegionPart(o, OutsideRegionID)
	if !ok || out.Customers != 10 || out.CustomerMinutes != 600 {
		t.Fatalf("di luar wilayah: %+v", out)
	}
	if _, ok := RegionPart(o, 8); ok {
		t.Fatal("ULP tanpa pelanggan terdampak tidak boleh ikut")
	}
	ids := RegionIDs(o)
	if len(ids) != 3 || ids[0] != OutsideRegionID {
		t.Fatalf("RegionIDs: %v", ids)
	}
	// jumlah porsi = total kejadian
	sum := 0.0
	for _, id := range ids {
		p, _ := RegionPart(o, id)
		sum += p.CustomerMinutes
	}
	if sum != o.CustomerMinutes {
		t.Fatalf("total porsi %.1f != %.1f", sum, o.CustomerMinutes)
	}
}
