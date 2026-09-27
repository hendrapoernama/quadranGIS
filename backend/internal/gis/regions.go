package gis

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

// OutsideRegionID adalah kunci kelompok pelanggan di luar seluruh poligon ULP.
const OutsideRegionID int64 = 0

// Region adalah satu wilayah UP3 / ULP beserta pelanggan yang dilayaninya.
type Region struct {
	ID           int64   `json:"id"`
	Level        string  `json:"level"` // up3 | ulp | outside
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Parent       string  `json:"parent"` // nama UP3 untuk ULP
	ParentID     int64   `json:"parent_id,omitempty"`
	Customers    int     `json:"customers"`
	CustomersOff int     `json:"customers_off"`
	AreaKM2      float64 `json:"area_km2"`
}

type regionCache struct {
	mu   sync.Mutex
	at   time.Time
	list []Region // tanpa CustomersOff
}

var regCache regionCache

// InvalidateRegions membuang cache jumlah pelanggan per wilayah (mis. sesudah data berubah besar).
func (b *Boundaries) InvalidateRegions() {
	regCache.mu.Lock()
	regCache.list = nil
	regCache.mu.Unlock()
}

// Regions mengembalikan daftar UP3 & ULP dengan jumlah pelanggan dilayani (cache 10 menit) dan
// jumlah pelanggan padam saat ini. totalCustomers dipakai untuk kelompok "di luar wilayah".
func (b *Boundaries) Regions(ctx context.Context, totalCustomers int) ([]Region, error) {
	regCache.mu.Lock()
	defer regCache.mu.Unlock()
	if regCache.list == nil || time.Since(regCache.at) > 10*time.Minute {
		rows, err := b.pool.Query(ctx, `SELECT b.id, b.level, b.code, b.name, b.parent, ST_Area(b.geom::geography) / 1e6,
			CASE WHEN b.level = 'ulp' THEN (SELECT count(*) FROM gis_nodes n WHERE n.type_code LIKE 'pelanggan%' AND ST_Intersects(b.geom, n.geom)) ELSE 0 END
			FROM gis_boundaries b ORDER BY b.level DESC, b.parent, b.name`)
		if err != nil {
			return nil, err
		}
		list := []Region{}
		for rows.Next() {
			var r Region
			if err := rows.Scan(&r.ID, &r.Level, &r.Code, &r.Name, &r.Parent, &r.AreaKM2, &r.Customers); err != nil {
				rows.Close()
				return nil, err
			}
			list = append(list, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		// jumlah UP3 = jumlah ULP-nya
		up3 := map[string]int{}
		for i := range list {
			if list[i].Level == "up3" {
				up3[list[i].Name] = i
			}
		}
		for i := range list {
			if list[i].Level == "ulp" {
				if j, ok := up3[list[i].Parent]; ok {
					list[i].ParentID = list[j].ID
					list[j].Customers += list[i].Customers
				}
			}
		}
		regCache.list, regCache.at = list, time.Now()
	}
	out := make([]Region, len(regCache.list), len(regCache.list)+1)
	copy(out, regCache.list)

	// padam saat ini per ULP (indeks parsial gis_nodes_off_idx)
	off := map[int64]int{}
	totalOff := 0
	rows, err := b.pool.Query(ctx, `SELECT COALESCE(b.id, 0), count(*) FROM gis_nodes n
		LEFT JOIN gis_boundaries b ON b.level = 'ulp' AND ST_Intersects(b.geom, n.geom)
		WHERE NOT n.energized AND n.type_code LIKE 'pelanggan%' GROUP BY 1`)
	if err == nil {
		for rows.Next() {
			var id int64
			var n int
			if rows.Scan(&id, &n) == nil {
				off[id] += n
				totalOff += n
			}
		}
		rows.Close()
	}
	inside := 0
	byID := map[int64]int{}
	for i := range out {
		byID[out[i].ID] = i
	}
	for i := range out {
		if out[i].Level == "ulp" {
			out[i].CustomersOff = off[out[i].ID]
			inside += out[i].Customers
			if j, ok := byID[out[i].ParentID]; ok && out[i].ParentID != 0 {
				out[j].CustomersOff += out[i].CustomersOff
			}
		}
	}
	outside := totalCustomers - inside
	if outside < 0 {
		outside = 0
	}
	out = append(out, Region{ID: OutsideRegionID, Level: "outside", Name: "", Customers: outside, CustomersOff: off[OutsideRegionID]})
	return out, nil
}

// RegionPart mengembalikan porsi kejadian untuk satu ULP (atau kelompok di luar wilayah bila
// id = OutsideRegionID): pelanggan terdampak, pelanggan·menit, dan ENS dibagi sebanding pelanggan.
// Harus dipanggil sesudah ApplyReliability. ok=false bila wilayah tidak terdampak.
func RegionPart(o OutageRecord, id int64) (OutageRecord, bool) {
	if o.Customers <= 0 {
		return o, false
	}
	n := 0
	if id == OutsideRegionID {
		n = o.Customers
		for _, v := range o.Regions {
			n -= v
		}
	} else {
		n = o.Regions[strconv.FormatInt(id, 10)]
	}
	if n <= 0 {
		return o, false
	}
	if n > o.Customers {
		n = o.Customers
	}
	share := float64(n) / float64(o.Customers)
	o.Customers = n
	o.CustomerMinutes *= share
	o.ENSkWh *= share
	o.ENSRp *= share
	return o, true
}

// RegionIDs mengembalikan id ULP yang terdampak sebuah kejadian (+ OutsideRegionID bila ada sisa).
func RegionIDs(o OutageRecord) []int64 {
	ids := make([]int64, 0, len(o.Regions)+1)
	sum := 0
	for k, v := range o.Regions {
		if id, err := strconv.ParseInt(k, 10, 64); err == nil && v > 0 {
			ids = append(ids, id)
			sum += v
		}
	}
	if o.Customers > sum {
		ids = append(ids, OutsideRegionID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
