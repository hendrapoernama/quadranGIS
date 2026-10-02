package gis

import "sort"

// ---------------------------------------------------------------------
// posisi normal vs aktual alat switching
//
// Keanggotaan penyulang normal dihitung dari posisi normal switch (atribut "normal", dan untuk LBS multi-arah
// "normal_open_ways"). Menjadikan konfigurasi aktual sebagai normal = menyalin posisi saat ini ke atribut tersebut
// (api/normalpos_handlers.go); pengelompokan normal lalu dihitung ulang.
// ---------------------------------------------------------------------

// NormalDeviation adalah alat switching yang posisinya saat ini berbeda dari posisi normal.
type NormalDeviation struct {
	ID         int64   `json:"id"`
	TypeCode   string  `json:"type_code"`
	Normal     string  `json:"normal"` // open | closed (seluruh alat)
	Actual     string  `json:"actual"`
	MultiWay   bool    `json:"multi_way"`             // LBS multi-arah: arah terbuka dibandingkan juga
	NormalWays []int64 `json:"normal_ways,omitempty"` // saluran yang normalnya terbuka (LBS multi-arah)
	ActualWays []int64 `json:"actual_ways,omitempty"` // saluran yang saat ini terbuka
	Feeder     int64   `json:"feeder"`                // penyulang normal
	LiveFeeder int64   `json:"live_feeder"`           // penyulang penyuplai saat ini (0 = padam / tanpa penyulang)
	Energized  bool    `json:"energized"`
	// alat atau salah satu tetangganya padam: biasanya isolasi pemeliharaan / gangguan (sementara), bukan konfigurasi tetap
	DeadSide bool `json:"dead_side"`
}

func sortedWays(m map[int64]struct{}) []int64 {
	if len(m) == 0 {
		return nil
	}
	out := make([]int64, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func sameWays(a, b map[int64]struct{}) bool {
	if len(a) != len(b) {
		return false
	}
	for id := range a {
		if _, ok := b[id]; !ok {
			return false
		}
	}
	return true
}

func openWord(open bool) string {
	if open {
		return "open"
	}
	return "closed"
}

// NormalDeviations mengembalikan alat switching (beroperasi) yang posisinya berbeda dari posisi normal.
func (g *Graph) NormalDeviations() []NormalDeviation {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := []NormalDeviation{}
	for id, n := range g.nodes {
		if !n.isSwitch() {
			continue
		}
		if _, no := g.nonOp[id]; no {
			continue
		}
		normalOpen, actualOpen := n.flags&flagNormalOpen != 0, n.open()
		tc := g.typeName(n.typ)
		ct, _ := g.types.Get(tc)
		multi := ct.Ways > 2 || len(g.openWays[id]) > 0 || len(g.normalOpenWays[id]) > 0
		waysDiff := multi && !sameWays(g.openWays[id], g.normalOpenWays[id])
		if normalOpen == actualOpen && !waysDiff {
			continue
		}
		d := NormalDeviation{ID: id, TypeCode: tc, Normal: openWord(normalOpen), Actual: openWord(actualOpen), MultiWay: multi,
			Feeder: n.feeder, LiveFeeder: g.liveOfLocked(id), Energized: n.energized(), DeadSide: !n.energized()}
		if multi {
			d.NormalWays, d.ActualWays = sortedWays(g.normalOpenWays[id]), sortedWays(g.openWays[id])
		}
		if !n.energized() {
			d.LiveFeeder = 0
		}
		for _, eid := range g.adj[id] {
			e, ok := g.edges[eid]
			if !ok {
				continue
			}
			if nb, ok := g.nodes[e.other(id)]; ok && !nb.energized() {
				if _, no := g.nonOp[e.other(id)]; !no {
					d.DeadSide = true
					break
				}
			}
		}
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Feeder != out[j].Feeder {
			return out[i].Feeder < out[j].Feeder
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// FeederTransfer adalah objek yang saat ini disuplai penyulang lain dari keanggotaan normalnya.
type FeederTransfer struct {
	From      int64 `json:"from"` // penyulang normal
	To        int64 `json:"to"`   // penyulang penyuplai saat ini
	Nodes     int   `json:"nodes"`
	Customers int   `json:"customers"`
}

// LiveTransfers merangkum objek yang dilimpahkan (penyulang aktual ≠ normal) per pasangan penyulang: perpindahan
// keanggotaan normal bila seluruh posisi switch saat ini dijadikan normal.
func (g *Graph) LiveTransfers() []FeederTransfer {
	g.mu.RLock()
	defer g.mu.RUnlock()
	idx := map[[2]int64]*FeederTransfer{}
	for id, to := range g.live {
		n, ok := g.nodes[id]
		if !ok {
			continue
		}
		k := [2]int64{n.feeder, to}
		t := idx[k]
		if t == nil {
			t = &FeederTransfer{From: n.feeder, To: to}
			idx[k] = t
		}
		t.Nodes++
		if n.sink() {
			t.Customers += g.custLocked(id, n)
		}
	}
	out := make([]FeederTransfer, 0, len(idx))
	for _, t := range idx {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Nodes > out[j].Nodes })
	return out
}
