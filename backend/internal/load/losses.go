package load

import (
	"context"
	"math"
	"sort"
	"time"
)

// Analisa susut (losses) dengan neraca energi antar-tingkat pengukuran:
//
//	trafo GI (incoming) ─► Σ penyulang (outgoing)          = susut GI (bus 20 kV, pemakaian sendiri, beda meter)
//	penyulang (outgoing) ─► Σ gardu distribusi (meter/AMR) = susut distribusi (JTM + trafo gardu)
//
// Energi harian dari meter kWh (atau integrasi MW bila meter kosong), dikoreksi slot hilang. Bila tidak
// semua anggota sisi keluar bermeter, energi keluar diperkirakan dari cakupan (bobot anggota yang terukur).

// DayEnergy adalah energi netto harian sebuah titik.
type DayEnergy struct {
	E       float64 // MWh impor − ekspor, dikoreksi slot hilang
	Samples int
}

// MinDaySamples: jumlah slot minimum agar energi harian dianggap sah (≥ 40 dari 48).
const MinDaySamples = 40

// DailyEnergy memuat energi harian titik-titik (nil = semua) pada [from, to): map[titik][YYYY-MM-DD].
func (r *Repo) DailyEnergy(ctx context.Context, points []int32, from, to time.Time) (map[int]map[string]DayEnergy, error) {
	rows, err := r.pool.Query(ctx, `SELECT point_id, to_char(day, 'YYYY-MM-DD'), COALESCE(energy_mwh, 0) - COALESCE(energy_exp_mwh, 0), samples
		FROM load_daily WHERE day >= ($1 AT TIME ZONE 'Asia/Jakarta')::date AND day < ($2 AT TIME ZONE 'Asia/Jakarta')::date
		AND ($3::int[] IS NULL OR point_id = ANY($3))`, from, to, nilIfEmpty(points))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]map[string]DayEnergy{}
	for rows.Next() {
		var pid, n int
		var day string
		var e float64
		if rows.Scan(&pid, &day, &e, &n) != nil {
			continue
		}
		if n > 0 && n < 48 {
			e = e * 48 / float64(n)
		}
		m := out[pid]
		if m == nil {
			m = map[string]DayEnergy{}
			out[pid] = m
		}
		m[day] = DayEnergy{E: e, Samples: n}
	}
	return out, rows.Err()
}

// Balance adalah satu neraca energi: satu titik masuk dan anggota sisi keluar berbobot.
type Balance struct {
	Kind  string          `json:"kind"` // feeder (distribusi) | trafo_gi
	In    int             `json:"in"`
	Outs  map[int]float64 `json:"-"`         // titik keluar bermeter → bobot (kVA gardu / MW mampu penyulang)
	Total float64         `json:"-"`         // bobot seluruh anggota (termasuk yang tanpa meter)
	NOut  int             `json:"n_members"` // jumlah anggota menurut GIS
}

// BalanceDay adalah neraca satu hari.
type BalanceDay struct {
	Day      string  `json:"day"`
	EIn      float64 `json:"e_in"`
	EOut     float64 `json:"e_out"`
	Loss     float64 `json:"loss"`
	Pct      float64 `json:"pct"`
	Coverage float64 `json:"coverage"`
	Valid    bool    `json:"valid"`
}

// BalanceResult adalah neraca pada satu periode.
type BalanceResult struct {
	EIn      float64      `json:"e_in"`
	EOut     float64      `json:"e_out"` // termasuk perkiraan anggota tanpa meter
	EOutMeas float64      `json:"e_out_measured"`
	Loss     float64      `json:"loss"`
	Pct      float64      `json:"pct"`
	Coverage float64      `json:"coverage"` // rata-rata cakupan hari sah (%)
	Days     int          `json:"days"`
	Valid    int          `json:"valid_days"`
	Metered  int          `json:"metered"`
	Members  int          `json:"members"`
	Included int          `json:"included,omitempty"` // (hasil Sum) jumlah neraca yang punya hari sah
	Status   string       `json:"status"`             // ok | estimasi | cakupan_kurang | tanpa_data
	Daily    []BalanceDay `json:"daily,omitempty"`
}

// Evaluate menghitung neraca untuk hari-hari `days`; minCov = cakupan minimum (%) agar hari dihitung.
func (b Balance) Evaluate(en map[int]map[string]DayEnergy, days []string, minCov float64, withDaily bool) BalanceResult {
	res := BalanceResult{Members: b.NOut, Metered: len(b.Outs)}
	covSum := 0.0
	for _, d := range days {
		res.Days++
		in, ok := en[b.In][d]
		bd := BalanceDay{Day: d}
		if ok && in.Samples >= MinDaySamples {
			bd.EIn = in.E
			w, eo := 0.0, 0.0
			for id, wt := range b.Outs {
				if x, ok := en[id][d]; ok && x.Samples >= MinDaySamples {
					w += wt
					eo += x.E
				}
			}
			if b.Total > 0 {
				bd.Coverage = math.Min(100, w/b.Total*100)
			}
			if bd.Coverage >= minCov && w > 0 && bd.EIn > 0 {
				bd.Valid = true
				res.EOutMeas += eo
				bd.EOut = eo / (bd.Coverage / 100)
				bd.Loss = bd.EIn - bd.EOut
				bd.Pct = bd.Loss / bd.EIn * 100
				res.EIn += bd.EIn
				res.EOut += bd.EOut
				res.Valid++
				covSum += bd.Coverage
			}
		}
		if withDaily {
			res.Daily = append(res.Daily, bd)
		}
	}
	switch {
	case res.Valid == 0 && len(b.Outs) == 0:
		res.Status = "tanpa_data"
	case res.Valid == 0:
		res.Status = "cakupan_kurang"
	default:
		res.Coverage = covSum / float64(res.Valid)
		res.Loss = res.EIn - res.EOut
		res.Pct = res.Loss / res.EIn * 100
		res.Status = "ok"
		if res.Coverage < 99.5 {
			res.Status = "estimasi"
		}
	}
	return res
}

// Days mengembalikan daftar tanggal WIB (YYYY-MM-DD) pada [from, to).
func Days(from, to time.Time) []string {
	out := []string{}
	for d := from.In(Loc); d.Before(to); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

// Sum menjumlahkan beberapa neraca (hari sah masing-masing) menjadi satu, termasuk deret harian.
func Sum(rs []BalanceResult) BalanceResult {
	out := BalanceResult{}
	daily := map[string]*BalanceDay{}
	covW := 0.0
	for _, r := range rs {
		out.Members += r.Members
		out.Metered += r.Metered
		if r.Valid == 0 {
			continue
		}
		out.EIn += r.EIn
		out.EOut += r.EOut
		out.EOutMeas += r.EOutMeas
		out.Included++
		if r.Days > out.Days {
			out.Days = r.Days
		}
		covW += r.Coverage * r.EIn
		for _, d := range r.Daily {
			if !d.Valid {
				continue
			}
			x := daily[d.Day]
			if x == nil {
				x = &BalanceDay{Day: d.Day, Valid: true}
				daily[d.Day] = x
			}
			x.EIn += d.EIn
			x.EOut += d.EOut
		}
	}
	out.Valid = len(daily)
	if out.EIn > 0 {
		out.Loss = out.EIn - out.EOut
		out.Pct = out.Loss / out.EIn * 100
		out.Coverage = covW / out.EIn
		out.Status = "ok"
		if out.Coverage < 99.5 {
			out.Status = "estimasi"
		}
	} else {
		out.Status = "cakupan_kurang"
	}
	for _, x := range daily {
		x.Loss = x.EIn - x.EOut
		if x.EIn > 0 {
			x.Pct = x.Loss / x.EIn * 100
		}
		out.Daily = append(out.Daily, *x)
	}
	sort.Slice(out.Daily, func(i, j int) bool { return out.Daily[i].Day < out.Daily[j].Day })
	return out
}

// LossFit adalah dekomposisi susut per slot: L = a + b·P + c·P² (MW).
//   - a: komponen tetap (rugi inti/besi trafo gardu, beban tetap tak terukur)
//   - b·P: komponen sebanding beban (indikasi susut non-teknis / kesalahan pengukuran)
//   - c·P²: komponen kuadrat beban (rugi tembaga & penghantar — susut teknis variabel)
type LossFit struct {
	A      float64 `json:"a"`
	B      float64 `json:"b"`
	C      float64 `json:"c"`
	R2     float64 `json:"r2"`
	N      int     `json:"n"`
	EFixed float64 `json:"e_fixed"`  // MWh periode
	ELin   float64 `json:"e_linear"` // MWh periode
	EQuad  float64 `json:"e_quad"`   // MWh periode
}

// FitLosses mencocokkan L = a + bP + cP² dengan kuadrat terkecil (slot 30 menit), lalu memecah energi susut periode.
func FitLosses(p, l []float64) LossFit {
	n := len(p)
	fit := LossFit{N: n}
	if n < 12 {
		return fit
	}
	// persamaan normal 3×3
	var s [5]float64 // Σ P^k, k = 0..4
	var t [3]float64 // Σ L·P^k, k = 0..2
	for i := range p {
		pk := 1.0
		for k := 0; k < 5; k++ {
			s[k] += pk
			if k < 3 {
				t[k] += l[i] * pk
			}
			pk *= p[i]
		}
	}
	m := [3][4]float64{{s[0], s[1], s[2], t[0]}, {s[1], s[2], s[3], t[1]}, {s[2], s[3], s[4], t[2]}}
	for c := 0; c < 3; c++ {
		piv := c
		for r := c + 1; r < 3; r++ {
			if math.Abs(m[r][c]) > math.Abs(m[piv][c]) {
				piv = r
			}
		}
		m[c], m[piv] = m[piv], m[c]
		if math.Abs(m[c][c]) < 1e-12 {
			return fit
		}
		for r := 0; r < 3; r++ {
			if r == c {
				continue
			}
			f := m[r][c] / m[c][c]
			for k := c; k < 4; k++ {
				m[r][k] -= f * m[c][k]
			}
		}
	}
	fit.A, fit.B, fit.C = m[0][3]/m[0][0], m[1][3]/m[1][1], m[2][3]/m[2][2]
	mean := t[0] / s[0]
	ssTot, ssRes := 0.0, 0.0
	for i := range p {
		pred := fit.A + fit.B*p[i] + fit.C*p[i]*p[i]
		ssRes += (l[i] - pred) * (l[i] - pred)
		ssTot += (l[i] - mean) * (l[i] - mean)
		fit.EFixed += fit.A * 0.5
		fit.ELin += fit.B * p[i] * 0.5
		fit.EQuad += fit.C * p[i] * p[i] * 0.5
	}
	if ssTot > 0 {
		fit.R2 = math.Round((1-ssRes/ssTot)*1000) / 1000
	}
	return fit
}
