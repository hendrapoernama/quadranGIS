package gis

import (
	"context"
	"sort"
)

// TrafoStatus adalah rekap satu trafo distribusi beserta jurusan & pelanggan di hilirnya (Pusat Operasi › tab
// Trafo Distribusi). Kode, nama, kapasitas, dan kode induk diisi pemanggil.
type TrafoStatus struct {
	ID           int64   `json:"id"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	GD           int64   `json:"gd_id"`
	GDCode       string  `json:"gd_code"`
	Feeder       int64   `json:"feeder_id"`
	FeederCode   string  `json:"feeder_code"`
	GI           int64   `json:"gi_id"`
	GICode       string  `json:"gi_code"`
	State        string  `json:"state"` // on | partial | off
	Energized    bool    `json:"energized"`
	Routes       int     `json:"jurusan"`
	Customers    int     `json:"pelanggan"`
	CustomersOff int     `json:"pelanggan_off"`
	LoadVA       float64 `json:"beban_va"`
	LoadOffVA    float64 `json:"beban_off_va"`
	CapacityKVA  float64 `json:"kapasitas_kva"`
}

// TrafoStatuses mengembalikan rekap seluruh trafo distribusi yang beroperasi (rencana / tidak operasi / non aktif /
// bongkar dikecualikan, sama dengan widget rekap). Pemetaan trafo → jurusan → pelanggan memakai indeks hirarki aset
// (sama dengan Data Aset); nyala/padam pelanggan dibaca langsung dari graf sehingga selalu terkini.
// Keadaan: padam = trafo tidak bertegangan; sebagian = trafo bertegangan tetapi ada pelanggan di hilirnya padam.
func (g *Graph) TrafoStatuses() []TrafoStatus {
	x := g.assetIdx()
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]TrafoStatus, 0, len(x.tds))
	for _, id := range x.tds {
		if _, skip := g.nonOp[id]; skip {
			continue
		}
		n, ok := g.nodes[id]
		if !ok {
			continue
		}
		t := TrafoStatus{ID: id, GD: n.gd, Feeder: n.feeder, Energized: n.energized(), Routes: len(x.tdRoute[id])}
		if fi, ok := g.feeders[n.feeder]; ok {
			t.GI = fi.GI
		}
		for _, r := range x.tdRoute[id] {
			for _, s := range x.routeSink[r] {
				sn := g.nodes[s]
				c := g.custLocked(s, sn)
				t.Customers += c
				t.LoadVA += float64(sn.loadVA)
				if !sn.energized() {
					t.CustomersOff += c
					t.LoadOffVA += float64(sn.loadVA)
				}
			}
		}
		switch {
		case !t.Energized:
			t.State = "off"
		case t.CustomersOff > 0:
			t.State = "partial"
		default:
			t.State = "on"
		}
		out = append(out, t)
	}
	return out
}

// SortTrafoStatuses mengurutkan yang bermasalah di atas: padam, lalu sebagian (terbanyak pelanggan padam), lalu nyala.
func SortTrafoStatuses(list []TrafoStatus) {
	rank := map[string]int{"off": 0, "partial": 1, "on": 2}
	sort.SliceStable(list, func(i, j int) bool {
		if rank[list[i].State] != rank[list[j].State] {
			return rank[list[i].State] < rank[list[j].State]
		}
		if list[i].CustomersOff != list[j].CustomersOff {
			return list[i].CustomersOff > list[j].CustomersOff
		}
		return list[i].ID < list[j].ID
	})
}

// NodeKVA mengembalikan kapasitas (atribut daya_kva / kapasitas_kva) node-node yang mempunyainya.
func (p *Power) NodeKVA(ctx context.Context, ids []int64) (map[int64]float64, error) {
	out := map[int64]float64{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := p.pool.Query(ctx, `SELECT id, COALESCE(qgis_num(properties->>'daya_kva'), qgis_num(properties->>'kapasitas_kva'))
		FROM gis_nodes WHERE id = ANY($1::bigint[]) AND (properties ? 'daya_kva' OR properties ? 'kapasitas_kva')`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var kva *float64
		if err := rows.Scan(&id, &kva); err != nil {
			return nil, err
		}
		if kva != nil {
			out[id] = *kva
		}
	}
	return out, rows.Err()
}
