package api

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"sync"
	"time"

	"quadrangis/internal/gis"
	"quadrangis/internal/load"
)

// ------------------------------------------------------------------ alokasi beban penyulang ke pelanggan
//
// monitoring.load_basis = alokasi_penyulang: beban pelanggan padam tidak lagi dihitung dari daya kontrak saja, tetapi
//
//	beban pelanggan = daya kontrak pelanggan ÷ Σ daya kontrak pelanggan penyulang × beban penyulang
//
// Beban penyulang diambil sebelum padam (beban terukur turun saat penyulang padam): sampel 30 menit terakhir yang
// lengkap sebelum waktu acuan (maks. monitoring.load_alloc_max_age_min menit), lalu profil dasar slot itu (median
// 28 hari). Tanpa data ukur: estimasi daya kontrak × faktor beban (reliability.load_factor), daya aktif × cos φ.
// Penyebut = pelanggan beroperasi yang disuplai penyulang itu saat ini (gis.Graph.FeederContractVA). Alokasi kejadian
// padam dibekukan di ringkasannya (beban_alokasi) saat padam dimulai dan menjadi dasar ENS.

const (
	allocMeasured = "terukur"
	allocProfile  = "profil"
	allocEstimate = "estimasi"
)

// feederRef adalah beban penyulang acuan (semu & aktif).
type feederRef struct {
	VA, W  float64
	Source string
	TS     *time.Time
}

// feederAlloc adalah alokasi beban satu penyulang.
type feederAlloc struct {
	ID         int64      `json:"id"`
	Code       string     `json:"code,omitempty"`
	ContractVA float64    `json:"kontrak_va"`   // daya kontrak pelanggan terdampak
	TotalVA    float64    `json:"total_va"`     // Σ daya kontrak pelanggan beroperasi penyulang (penyebut)
	FeederVA   float64    `json:"penyulang_va"` // beban penyulang acuan (semu); 0 = estimasi
	FeederW    float64    `json:"penyulang_w"`  // beban penyulang acuan (aktif)
	FactorS    float64    `json:"faktor_s"`     // beban semu per VA kontrak
	FactorP    float64    `json:"faktor_p"`     // daya aktif per VA kontrak
	Source     string     `json:"sumber"`       // terukur | profil | estimasi
	TS         *time.Time `json:"ts,omitempty"` // awal periode 30 menit data ukur
	VA         float64    `json:"va"`
	W          float64    `json:"w"`
}

// loadAlloc adalah beban padam teralokasi.
type loadAlloc struct {
	At         time.Time      `json:"at"`
	ContractVA float64        `json:"kontrak_va"`
	VA         float64        `json:"va"`
	W          float64        `json:"w"`
	Sources    map[string]int `json:"sumber"` // jumlah penyulang per sumber
	Feeders    []feederAlloc  `json:"penyulang"`
}

// clampFactor membatasi faktor beban (data ukur tidak wajar, mis. pelanggan penyulang belum lengkap di GIS).
func clampFactor(x float64) float64 { return math.Max(0.05, math.Min(3, x)) }

// allocate membagi beban penyulang ke daya kontrak terdampak per penyulang. byFeeder: daya kontrak terdampak per
// penyulang (kunci 0 = tanpa penyulang); base: Σ daya kontrak pelanggan beroperasi per penyulang; refs: beban
// penyulang acuan; lf & pf: faktor beban & cos φ untuk estimasi.
func allocate(byFeeder, base map[int64]float64, refs map[int64]feederRef, lf, pf float64, at time.Time) *loadAlloc {
	a := &loadAlloc{At: at, Sources: map[string]int{}, Feeders: []feederAlloc{}}
	ids := make([]int64, 0, len(byFeeder))
	for id, cv := range byFeeder {
		if cv > 0 {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		f := feederAlloc{ID: id, ContractVA: byFeeder[id], TotalVA: base[id], Source: allocEstimate, FactorS: lf, FactorP: lf * pf}
		if r, ok := refs[id]; ok && id != 0 && f.TotalVA > 0 && r.VA > 0 && r.W > 0 {
			f.FeederVA, f.FeederW, f.Source, f.TS = r.VA, r.W, r.Source, r.TS
			f.FactorS, f.FactorP = clampFactor(r.VA/f.TotalVA), clampFactor(r.W/f.TotalVA)
		}
		f.VA, f.W = f.ContractVA*f.FactorS, f.ContractVA*f.FactorP
		a.ContractVA += f.ContractVA
		a.VA += f.VA
		a.W += f.W
		a.Sources[f.Source]++
		a.Feeders = append(a.Feeders, f)
	}
	return a
}

// loadBasis: kontrak | alokasi_penyulang.
func (s *Server) loadBasis() string {
	if s.d.Configs.Str("monitoring.load_basis", "kontrak") == gis.LoadBasisAlloc {
		return gis.LoadBasisAlloc
	}
	return "kontrak"
}

// feederRefs mengembalikan beban acuan penyulang (kepala penyulang → beban) sebelum waktu at.
func (s *Server) feederRefs(ctx context.Context, heads []int64, at time.Time) map[int64]feederRef {
	out := map[int64]feederRef{}
	if s.d.Load == nil || len(heads) == 0 {
		return out
	}
	pts, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		return out
	}
	want := map[int64]bool{}
	for _, h := range heads {
		want[h] = true
	}
	headOf := map[int]int64{}
	ids := []int32{}
	for _, p := range pts {
		if p.Kind == "feeder" && p.Active && p.NodeID != nil && want[*p.NodeID] {
			headOf[p.ID] = *p.NodeID
			ids = append(ids, int32(p.ID))
		}
	}
	if len(ids) == 0 {
		return out
	}
	st := s.loadSettings()
	pf := st.DefaultPF
	if pf <= 0 || pf > 1 {
		pf = 0.9
	}
	maxAge := time.Duration(max(30, s.d.Configs.Int("monitoring.load_alloc_max_age_min", 120))) * time.Minute
	// periode 30 menit yang sudah lengkap sebelum at (ts = awal periode)
	rows, err := s.d.Load.Repo.Pool().Query(ctx, `SELECT DISTINCT ON (point_id) point_id, ts, s_mva, p_mw FROM load_30m
		WHERE point_id = ANY($1) AND ts >= $2 AND ts <= $3 AND quality < 2 AND (coalesce(s_mva, 0) > 0 OR coalesce(abs(p_mw), 0) > 0)
		ORDER BY point_id, ts DESC`, ids, at.Add(-maxAge), at.Add(-30*time.Minute))
	if err == nil {
		for rows.Next() {
			var pid int
			var ts time.Time
			var sMVA, pMW *float64
			if rows.Scan(&pid, &ts, &sMVA, &pMW) != nil {
				continue
			}
			var va, w float64
			if sMVA != nil && *sMVA > 0 {
				va = *sMVA * 1e6
			}
			if pMW != nil && math.Abs(*pMW) > 0 {
				w = math.Abs(*pMW) * 1e6
			}
			if va == 0 {
				va = w / pf
			}
			if w == 0 {
				w = va * pf
			}
			t := ts
			out[headOf[pid]] = feederRef{VA: va, W: w, Source: allocMeasured, TS: &t}
		}
		rows.Close()
	}
	// profil dasar (median 28 hari per jenis hari & slot 30 menit) untuk penyulang tanpa sampel terbaru
	missing := []int32{}
	for _, id := range ids {
		if _, ok := out[headOf[int(id)]]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		if bl, err := s.d.Load.Repo.Baselines(ctx, missing); err == nil {
			l := at.In(load.Loc)
			key := load.DayType(at, st.Holidays)*48 + l.Hour()*2 + l.Minute()/30
			for pid, m := range bl {
				if b, ok := m[key]; ok && b.Median > 0 {
					w := b.Median * 1e6
					out[headOf[pid]] = feederRef{VA: w / pf, W: w, Source: allocProfile}
				}
			}
		}
	}
	return out
}

// allocateLoad menghitung alokasi beban untuk daya kontrak terdampak per penyulang pada waktu at (awal padam).
func (s *Server) allocateLoad(ctx context.Context, byFeeder map[int64]float64, at time.Time) *loadAlloc {
	if len(byFeeder) == 0 {
		return nil
	}
	heads := make([]int64, 0, len(byFeeder))
	for h := range byFeeder {
		if h != 0 {
			heads = append(heads, h)
		}
	}
	rp := s.reliabilityParams()
	a := allocate(byFeeder, s.d.Graph.FeederContractVA(), s.feederRefs(ctx, heads, at), rp.LoadFactor, rp.PowerFactor, at)
	if codes, err := s.d.Power.NodeCodes(ctx, heads); err == nil {
		for i := range a.Feeders {
			a.Feeders[i].Code = codes[a.Feeders[i].ID].Code
		}
	}
	return a
}

// ------------------------------------------------------------------ rekap realtime

// realtimeAlloc adalah rekap beban seluruh jaringan & beban padam saat ini menurut alokasi beban penyulang.
type realtimeAlloc struct {
	At      time.Time      `json:"at"`
	TotalVA float64        `json:"total_va"`
	TotalW  float64        `json:"total_w"`
	OffVA   float64        `json:"off_va"`
	OffW    float64        `json:"off_w"`
	Sources map[string]int `json:"sumber"`     // penyulang ber-pelanggan padam per sumber faktor
	Frozen  int            `json:"dibekukan"`  // di antaranya memakai faktor kejadian padam aktif (dibekukan saat padam)
	Feeders int            `json:"penyulang"`  // penyulang ber-pelanggan padam
	Total   map[string]int `json:"sumber_all"` // seluruh penyulang per sumber faktor
}

var rtAlloc struct {
	sync.Mutex
	v  *realtimeAlloc
	at time.Time
}

// realtimeLoadAlloc: faktor per penyulang dari kejadian padam aktif (dibekukan saat padam dimulai; yang paling awal),
// selain itu beban acuan saat ini (sampel terbaru / profil) atau estimasi. Disimpan 30 detik.
func (s *Server) realtimeLoadAlloc(ctx context.Context) *realtimeAlloc {
	rtAlloc.Lock()
	defer rtAlloc.Unlock()
	if rtAlloc.v != nil && time.Since(rtAlloc.at) < 30*time.Second {
		return rtAlloc.v
	}
	now := time.Now()
	sum, feeders := s.d.Graph.PowerSummary()
	base := s.d.Graph.FeederContractVA()
	frozen := map[int64]feederAlloc{}
	if active, err := s.d.Power.ListOutages(ctx, true, 500); err == nil {
		sort.Slice(active, func(i, j int) bool { return active[i].StartedAt.Before(active[j].StartedAt) })
		for _, o := range active {
			var x struct {
				Alloc *loadAlloc `json:"beban_alokasi"`
			}
			if json.Unmarshal(o.Summary, &x) != nil || x.Alloc == nil {
				continue
			}
			for _, f := range x.Alloc.Feeders {
				if _, ok := frozen[f.ID]; !ok && f.ID != 0 {
					frozen[f.ID] = f
				}
			}
		}
	}
	heads := make([]int64, 0, len(base))
	for h := range base {
		if h != 0 {
			heads = append(heads, h)
		}
	}
	refs := s.feederRefs(ctx, heads, now)
	rp := s.reliabilityParams()
	type fac struct {
		s, p   float64
		source string
		frozen bool
	}
	factor := func(h int64) fac {
		if f, ok := frozen[h]; ok {
			return fac{f.FactorS, f.FactorP, f.Source, true}
		}
		if r, ok := refs[h]; ok && h != 0 && base[h] > 0 && r.VA > 0 && r.W > 0 {
			return fac{clampFactor(r.VA / base[h]), clampFactor(r.W / base[h]), r.Source, false}
		}
		return fac{rp.LoadFactor, rp.LoadFactor * rp.PowerFactor, allocEstimate, false}
	}
	ra := &realtimeAlloc{At: now, Sources: map[string]int{}, Total: map[string]int{}}
	for h, va := range base {
		f := factor(h)
		ra.TotalVA += va * f.s
		ra.TotalW += va * f.p
		if h != 0 {
			ra.Total[f.source]++
		}
	}
	// bagian padam ikut penyulang normal (sama dengan FeederStatus); sisanya pelanggan tanpa penyulang
	var offFeeder float64
	for _, fs := range feeders {
		if fs.LoadOffVA <= 0 {
			continue
		}
		f := factor(fs.Head)
		offFeeder += fs.LoadOffVA
		ra.OffVA += fs.LoadOffVA * f.s
		ra.OffW += fs.LoadOffVA * f.p
		ra.Feeders++
		ra.Sources[f.source]++
		if f.frozen {
			ra.Frozen++
		}
	}
	if rest := sum.LoadOffVA - offFeeder; rest > 0 {
		f := factor(0)
		ra.OffVA += rest * f.s
		ra.OffW += rest * f.p
	}
	rtAlloc.v, rtAlloc.at = ra, now
	return ra
}
