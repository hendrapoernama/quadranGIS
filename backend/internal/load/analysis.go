package load

import (
	"math"
	"sort"
	"time"
)

// ForecastPoint adalah prakiraan satu slot.
type ForecastPoint struct {
	TS time.Time `json:"ts"`
	P  float64   `json:"p"` // MW
	Lo float64   `json:"lo"`
	Hi float64   `json:"hi"`
}

// ForecastInfo menjelaskan kualitas & parameter prakiraan.
type ForecastInfo struct {
	Method     string     `json:"method"`
	Trend      float64    `json:"trend"`     // faktor tren mingguan yang dipakai
	MAPE       float64    `json:"mape"`      // uji mundur 7 hari terakhir (%)
	PeakMW     float64    `json:"peak_mw"`   // puncak prakiraan (MW)
	PeakTS     *time.Time `json:"peak_ts"`   // waktu puncak prakiraan
	PeakUtil   float64    `json:"peak_util"` // % terhadap kapasitas
	HistoryDay int        `json:"history_days"`
}

type slotKey struct{ dt, slot int }

// forecastDay memprakirakan 48 slot hari `day` dari riwayat sebelum hari itu (rata-rata berbobot
// 4 hari sejenis terakhir per slot × faktor tren), dengan pita 10–90% dari sebaran sampel.
func forecastDay(hist map[int64]float64, day time.Time, holidays map[string]bool, trend float64) []ForecastPoint {
	out := make([]ForecastPoint, 0, 48)
	dt := DayType(day, holidays)
	for slot := 0; slot < 48; slot++ {
		ts := day.Add(time.Duration(slot) * 30 * time.Minute)
		vals, ws := []float64{}, []float64{}
		for back := 1; back <= 35 && len(vals) < 4; back++ {
			t := ts.AddDate(0, 0, -back)
			if DayType(t, holidays) != dt {
				continue
			}
			if v, ok := hist[t.Unix()]; ok && v > 0 {
				vals = append(vals, v)
				ws = append(ws, float64(5-len(vals)))
			}
		}
		if len(vals) == 0 {
			out = append(out, ForecastPoint{TS: ts})
			continue
		}
		sum, wsum := 0.0, 0.0
		for i, v := range vals {
			sum += v * ws[i]
			wsum += ws[i]
		}
		mean := sum / wsum * trend
		lo, hi := mean, mean
		for _, v := range vals {
			r := v * trend
			lo = math.Min(lo, r)
			hi = math.Max(hi, r)
		}
		spread := math.Max((hi-lo)/2, mean*0.03)
		out = append(out, ForecastPoint{TS: ts, P: mean, Lo: math.Max(0, mean-spread*1.28), Hi: mean + spread*1.28})
	}
	return out
}

// Forecast memprakirakan `days` hari mulai `start` (awal hari WIB) dari deret riwayat.
func Forecast(series []SeriesPoint, start time.Time, days int, holidays map[string]bool, capMW float64) ([]ForecastPoint, ForecastInfo) {
	hist := make(map[int64]float64, len(series)) // kunci detik Unix: bebas zona waktu
	for _, s := range series {
		hist[s.TS.Unix()] = s.P
	}
	info := ForecastInfo{Method: "profil hari sejenis berbobot (4 hari) × tren mingguan"}
	// tren: rata-rata 7 hari terakhir / 7 hari sebelumnya (dibatasi ±10%)
	avg := func(a, b time.Time) float64 {
		s, n := 0.0, 0
		for u, v := range hist {
			if t := time.Unix(u, 0); !t.Before(a) && t.Before(b) && v > 0 {
				s += v
				n++
			}
		}
		if n == 0 {
			return 0
		}
		return s / float64(n)
	}
	a1 := avg(start.AddDate(0, 0, -7), start)
	a0 := avg(start.AddDate(0, 0, -14), start.AddDate(0, 0, -7))
	info.Trend = 1
	if a0 > 0 && a1 > 0 {
		info.Trend = math.Sqrt(math.Max(0.9, math.Min(1.1, a1/a0)))
	}
	if len(series) > 0 {
		info.HistoryDay = int(series[len(series)-1].TS.Sub(series[0].TS).Hours()/24) + 1
	}
	// uji mundur: prakirakan 7 hari terakhir satu per satu
	errSum, errN := 0.0, 0
	for back := 1; back <= 7; back++ {
		d := start.AddDate(0, 0, -back)
		for _, f := range forecastDay(hist, d, holidays, 1) {
			if act, ok := hist[f.TS.Unix()]; ok && act > 0 && f.P > 0 {
				errSum += math.Abs(f.P-act) / act
				errN++
			}
		}
	}
	if errN > 0 {
		info.MAPE = math.Round(errSum/float64(errN)*1000) / 10
	}
	out := []ForecastPoint{}
	for d := 0; d < days; d++ {
		day := start.AddDate(0, 0, d)
		fs := forecastDay(hist, day, holidays, info.Trend)
		for _, f := range fs {
			hist[f.TS.Unix()] = f.P // hari berikutnya boleh memakai prakiraan sebelumnya
		}
		out = append(out, fs...)
	}
	for i := range out {
		if out[i].P > info.PeakMW {
			info.PeakMW = out[i].P
			t := out[i].TS
			info.PeakTS = &t
		}
	}
	if capMW > 0 {
		info.PeakUtil = math.Round(info.PeakMW/capMW*1000) / 10
	}
	return out, info
}

// MonthPeak adalah puncak beban satu bulan.
type MonthPeak struct {
	Month  string  `json:"month"` // YYYY-MM
	PeakMW float64 `json:"peak_mw"`
	Util   float64 `json:"util"`
	Proj   bool    `json:"projected"`
}

// ProjectPeaks memproyeksikan puncak bulanan `ahead` bulan ke depan (regresi log-linear) dan
// menghitung pertumbuhan tahunan serta bulan saat kapasitas terlampaui.
func ProjectPeaks(hist []MonthPeak, ahead int, capMW float64) ([]MonthPeak, float64, string) {
	pts := []MonthPeak{}
	for _, h := range hist {
		if h.PeakMW > 0 {
			pts = append(pts, h)
		}
	}
	if len(pts) < 4 {
		return nil, 0, ""
	}
	// abaikan bulan berjalan yang belum lengkap bila jauh lebih rendah
	n := float64(len(pts))
	sx, sy, sxx, sxy := 0.0, 0.0, 0.0, 0.0
	for i, p := range pts {
		x, y := float64(i), math.Log(p.PeakMW)
		sx += x
		sy += y
		sxx += x * x
		sxy += x * y
	}
	b := (n*sxy - sx*sy) / (n*sxx - sx*sx)
	a := (sy - b*sx) / n
	growth := (math.Exp(b*12) - 1) * 100
	last, _ := time.Parse("2006-01", pts[len(pts)-1].Month)
	out := []MonthPeak{}
	reach := ""
	for k := 1; k <= ahead; k++ {
		m := last.AddDate(0, k, 0)
		v := math.Exp(a + b*(n-1+float64(k)))
		mp := MonthPeak{Month: m.Format("2006-01"), PeakMW: v, Proj: true}
		if capMW > 0 {
			mp.Util = v / capMW * 100
			if reach == "" && mp.Util >= 100 {
				reach = mp.Month
			}
		}
		out = append(out, mp)
	}
	return out, math.Round(growth*10) / 10, reach
}

// Profile adalah karakter bentuk beban sebuah titik / kelompok.
type Profile struct {
	Class        string    `json:"class"` // residensial | bisnis | industri | campuran
	PeakHour     float64   `json:"peak_hour"`
	DayEvening   float64   `json:"day_evening_ratio"`
	WeekendRatio float64   `json:"weekend_ratio"`
	LoadFactor   float64   `json:"load_factor"`
	Weekday      []float64 `json:"weekday"` // 48 slot, dinormalisasi terhadap puncak
	Weekend      []float64 `json:"weekend"`
}

// Classify mengelompokkan bentuk beban dari deret 28 hari terakhir.
func Classify(series []SeriesPoint, holidays map[string]bool) Profile {
	sum := map[slotKey]float64{}
	cnt := map[slotKey]int{}
	for _, s := range series {
		if s.P <= 0 {
			continue
		}
		dt := DayType(s.TS, holidays)
		if dt == 1 {
			dt = 2
		}
		k := slotKey{dt, SlotOf(s.TS)}
		sum[k] += s.P
		cnt[k]++
	}
	pr := Profile{Weekday: make([]float64, 48), Weekend: make([]float64, 48)}
	peak, peakSlot := 0.0, 0
	wdAvg, weAvg := 0.0, 0.0
	for slot := 0; slot < 48; slot++ {
		if c := cnt[slotKey{0, slot}]; c > 0 {
			pr.Weekday[slot] = sum[slotKey{0, slot}] / float64(c)
		}
		if c := cnt[slotKey{2, slot}]; c > 0 {
			pr.Weekend[slot] = sum[slotKey{2, slot}] / float64(c)
		}
		if pr.Weekday[slot] > peak {
			peak, peakSlot = pr.Weekday[slot], slot
		}
		wdAvg += pr.Weekday[slot] / 48
		weAvg += pr.Weekend[slot] / 48
	}
	if peak <= 0 {
		pr.Class = "-"
		return pr
	}
	mean := func(a []float64, h0, h1 int) float64 {
		s := 0.0
		for i := h0 * 2; i < h1*2; i++ {
			s += a[i]
		}
		return s / float64((h1-h0)*2)
	}
	pr.PeakHour = float64(peakSlot) / 2
	ev := mean(pr.Weekday, 18, 22)
	if ev > 0 {
		pr.DayEvening = math.Round(mean(pr.Weekday, 9, 16)/ev*100) / 100
	}
	if wdAvg > 0 {
		pr.WeekendRatio = math.Round(weAvg/wdAvg*100) / 100
	}
	pr.LoadFactor = math.Round(wdAvg/peak*100) / 100
	for i := range pr.Weekday {
		pr.Weekday[i] = math.Round(pr.Weekday[i]/peak*1000) / 1000
		pr.Weekend[i] = math.Round(pr.Weekend[i]/peak*1000) / 1000
	}
	switch {
	case pr.LoadFactor >= 0.72 && pr.WeekendRatio < 0.82 && pr.DayEvening >= 0.95:
		pr.Class = "industri"
	case pr.PeakHour >= 8 && pr.PeakHour < 17 && pr.WeekendRatio < 0.85:
		pr.Class = "bisnis"
	case (pr.PeakHour >= 17 || pr.PeakHour < 1) && pr.DayEvening < 0.85:
		pr.Class = "residensial"
	default:
		pr.Class = "campuran"
	}
	return pr
}

// Health adalah indeks kesehatan (risiko pembebanan) trafo GI / penyulang.
type Health struct {
	Score     float64            `json:"score"` // 0–100 (tinggi = baik)
	Category  string             `json:"category"`
	Penalties map[string]float64 `json:"penalties"`
}

// HealthIndex menghitung indeks dari pembebanan 12 bulan, umur, dan anomali.
func HealthIndex(peakUtil, hours80, hours100, ageYears float64, anomalies int) Health {
	pen := map[string]float64{
		"peak_util": math.Min(35, math.Max(0, peakUtil-60)*0.8),
		"hours_80":  math.Min(25, hours80/40),
		"hours_100": math.Min(20, hours100/4),
		"age":       math.Min(15, math.Max(0, ageYears-10)*0.75),
		"anomalies": math.Min(5, float64(anomalies)*0.25),
	}
	score := 100.0
	for k, v := range pen {
		pen[k] = math.Round(v*10) / 10
		score -= v
	}
	score = math.Max(0, math.Round(score*10)/10)
	cat := "baik"
	switch {
	case score < 40:
		cat = "kritis"
	case score < 60:
		cat = "perhatian"
	case score < 80:
		cat = "cukup"
	}
	return Health{Score: score, Category: cat, Penalties: pen}
}

// DurationCurve mengurutkan beban dari terbesar (kurva lama beban) dan meringkas ke n titik.
func DurationCurve(series []SeriesPoint, n int) []float64 {
	vals := make([]float64, 0, len(series))
	for _, s := range series {
		vals = append(vals, s.P)
	}
	sort.Sort(sort.Reverse(sort.Float64Slice(vals)))
	if len(vals) <= n || n <= 0 {
		return vals
	}
	out := make([]float64, n)
	for i := 0; i < n; i++ {
		out[i] = vals[i*(len(vals)-1)/(n-1)]
	}
	return out
}
