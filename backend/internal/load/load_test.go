package load

import (
	"math"
	"strconv"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }

func TestParseTS(t *testing.T) {
	for in, want := range map[string]string{
		"2026-09-27T10:44:00+07:00": "2026-09-27T10:30:00+07:00",
		"2026-09-27T03:30:00Z":      "2026-09-27T10:30:00+07:00",
		"2026-09-27 10:00":          "2026-09-27T10:00:00+07:00",
	} {
		ts, err := ParseTS(in)
		if err != nil || ts.In(Loc).Format(time.RFC3339) != want {
			t.Errorf("%s → %v %v, ingin %s", in, ts.In(Loc), err, want)
		}
	}
	if _, err := ParseTS("kemarin"); err == nil {
		t.Error("harus galat")
	}
}

func TestNormalize(t *testing.T) {
	st := Settings{DefaultPF: 0.9, CapPF: 0.85}
	ra := 400.0
	p := Point{ID: 1, Kind: "feeder", KV: 20, RatingA: &ra}
	// arus fasa + tegangan fasa-netral (dikenali & diubah ke antarfasa)
	vn := 20 / math.Sqrt(3)
	r := Normalize(Message{IR: f(200), IS: f(180), IT: f(220), VR: f(vn), VS: f(vn), VT: f(vn)}, p, time.Now(), st)
	if math.Abs(*r.IAvg-200) > 1e-9 || math.Abs(*r.V-20) > 1e-9 {
		t.Fatalf("i_avg %v v %v", *r.IAvg, *r.V)
	}
	if want := math.Sqrt(3) * 20 * 200 / 1000; math.Abs(*r.S-want) > 1e-9 {
		t.Fatalf("s %v ingin %v", *r.S, want)
	}
	// pembebanan MW: P = S × 0,9 ÷ (√3·20·400/1000 × 0,85)
	capMW := math.Sqrt(3) * 20 * 400 / 1000 * 0.85
	if want := *r.S * 0.9 / capMW * 100; math.Abs(*r.Util-want) > 1e-9 {
		t.Fatalf("util %v ingin %v", *r.Util, want)
	}
	if math.Abs(*r.P-*r.S*0.9) > 1e-9 || math.Abs(*r.PF-0.9) > 1e-9 {
		t.Fatalf("p %v pf %v", *r.P, *r.PF)
	}
	mva := 60.0
	tr := Point{ID: 2, Kind: "trafo_gi", KV: 20, RatingMVA: &mva}
	r = Normalize(Message{P: f(25.5), Q: f(18), Quality: "estimated", KWhImp: f(12700)}, tr, time.Now(), st)
	if math.Abs(*r.S-math.Hypot(25.5, 18)) > 1e-9 || math.Abs(*r.Util-50) > 1e-9 || r.Quality != 1 || *r.KWhImp != 12700 {
		t.Fatalf("trafo s=%v util=%v q=%d", *r.S, *r.Util, r.Quality)
	}
	// gardu 0,4 kV: tegangan fasa 231 V → 0,4 kV antarfasa
	kva := 0.2
	gd := Point{ID: 3, Kind: "gd", KV: 0.4, RatingMVA: &kva}
	r = Normalize(Message{P: f(0.085), VR: f(0.231), VS: f(0.23), VT: f(0.232)}, gd, time.Now(), st)
	if math.Abs(*r.V-0.231*math.Sqrt(3)) > 1e-6 || math.Abs(*r.Util-50) > 1e-9 {
		t.Fatalf("gardu v=%v util=%v", *r.V, *r.Util)
	}
}

func TestCumulativeEnergy(t *testing.T) {
	in := &Ingestor{regs: map[int]Register{}, regDirt: map[int]Register{}}
	t0 := time.Date(2026, 9, 1, 10, 0, 0, 0, Loc)
	r := Reading{PointID: 1, TS: t0, KWhImp: f(1000)}
	in.cumulative(nil, &r)
	if r.KWhImp != nil {
		t.Fatal("register pertama tidak punya selisih")
	}
	r = Reading{PointID: 1, TS: t0.Add(30 * time.Minute), KWhImp: f(1250)}
	in.cumulative(nil, &r)
	if r.KWhImp == nil || *r.KWhImp != 250 {
		t.Fatalf("selisih %v", r.KWhImp)
	}
	r = Reading{PointID: 1, TS: t0.Add(60 * time.Minute), KWhImp: f(10)} // register direset
	in.cumulative(nil, &r)
	if r.KWhImp != nil {
		t.Fatal("reset register harus kosong")
	}
}

func TestBalance(t *testing.T) {
	en := map[int]map[string]DayEnergy{
		1: {"2026-09-01": {100, 48}, "2026-09-02": {100, 48}},
		2: {"2026-09-01": {40, 48}, "2026-09-02": {40, 48}},
		3: {"2026-09-01": {50, 48}}, // hari kedua tanpa data
	}
	b := Balance{Kind: "feeder", In: 1, Outs: map[int]float64{2: 400, 3: 500}, Total: 1000, NOut: 3}
	res := b.Evaluate(en, []string{"2026-09-01", "2026-09-02"}, 80, true)
	// hari 1: cakupan 90% → keluar 90/0,9 = 100 → susut 0; hari 2: cakupan 40% < 80% → tidak dihitung
	if res.Valid != 1 || math.Abs(res.EOut-100) > 1e-9 || math.Abs(res.Pct) > 1e-9 || res.Status != "estimasi" {
		t.Fatalf("%+v", res)
	}
	sum := Sum([]BalanceResult{res, {EIn: 50, EOut: 45, Valid: 1, Coverage: 100, Days: 2, Daily: []BalanceDay{{Day: "2026-09-02", EIn: 50, EOut: 45, Valid: true}}}})
	if math.Abs(sum.Pct-5/150.0*100) > 1e-9 || len(sum.Daily) != 2 {
		t.Fatalf("sum %+v", sum)
	}
}

func TestFitLosses(t *testing.T) {
	ps, ls := []float64{}, []float64{}
	for i := 0; i < 200; i++ {
		p := 2 + 6*float64(i%48)/47
		ps = append(ps, p)
		ls = append(ls, 0.05+0.02*p+0.004*p*p)
	}
	fit := FitLosses(ps, ls)
	if math.Abs(fit.A-0.05) > 1e-6 || math.Abs(fit.B-0.02) > 1e-6 || math.Abs(fit.C-0.004) > 1e-6 || fit.R2 < 0.999 {
		t.Fatalf("%+v", fit)
	}
}

func TestIntervalsMerge(t *testing.T) {
	base := time.Date(2026, 9, 1, 0, 0, 0, 0, Loc)
	hs := []hit{}
	for _, k := range []int{0, 1, 2, 5, 6} {
		sev := "warning"
		if k == 1 {
			sev = "serious"
		}
		hs = append(hs, hit{ts: base.Add(time.Duration(k) * 30 * time.Minute), sev: sev, value: float64(90 + k)})
	}
	iv := intervals(hs, "overload")
	if len(iv) != 2 || iv[0].slots != 3 || iv[0].sev != "serious" || iv[1].slots != 2 {
		t.Fatalf("interval %+v", iv)
	}
}

func synth(days int, start time.Time, peak float64) []SeriesPoint {
	out := []SeriesPoint{}
	for d := 0; d < days; d++ {
		for s := 0; s < 48; s++ {
			ts := start.AddDate(0, 0, d).Add(time.Duration(s) * 30 * time.Minute)
			h := float64(s) / 2
			v := peak * (0.45 + 0.55*math.Exp(-(h-19.5)*(h-19.5)/8))
			if ts.Weekday() == time.Sunday {
				v *= 0.9
			}
			out = append(out, SeriesPoint{TS: ts.UTC(), P: v}) // seperti dari database (UTC)
		}
	}
	return out
}

func TestForecastAndClassify(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, Loc)
	ser := synth(35, start, 10)
	fs, info := Forecast(ser, start.AddDate(0, 0, 35), 1, map[string]bool{}, 12)
	if len(fs) != 48 || info.PeakMW < 9 || info.PeakMW > 11 || info.MAPE > 2 {
		t.Fatalf("prakiraan puncak %.2f mape %.2f n %d", info.PeakMW, info.MAPE, len(fs))
	}
	if info.PeakTS == nil || info.PeakTS.In(Loc).Hour() != 19 {
		t.Fatalf("jam puncak %v", info.PeakTS)
	}
	pr := Classify(ser[len(ser)-28*48:], map[string]bool{})
	if pr.Class != "residensial" || pr.PeakHour < 19 || pr.PeakHour > 20 {
		t.Fatalf("klasifikasi %+v", pr)
	}
}

func TestProjectPeaks(t *testing.T) {
	hist := []MonthPeak{}
	v := 40.0
	for m := 1; m <= 12; m++ {
		hist = append(hist, MonthPeak{Month: time.Date(2025, time.Month(m), 1, 0, 0, 0, 0, time.UTC).Format("2006-01"), PeakMW: v})
		v *= 1.01
	}
	proj, growth, reach := ProjectPeaks(hist, 24, 50)
	if len(proj) != 24 || math.Abs(growth-12.7) > 0.3 {
		t.Fatalf("pertumbuhan %.2f", growth)
	}
	if reach == "" {
		t.Fatal("harus ada bulan melampaui kapasitas")
	}
}

func TestHealthIndex(t *testing.T) {
	if h := HealthIndex(50, 0, 0, 5, 0); h.Score != 100 || h.Category != "baik" {
		t.Fatalf("%+v", h)
	}
	if h := HealthIndex(115, 900, 120, 30, 20); h.Category != "kritis" {
		t.Fatalf("%+v", h)
	}
}

func TestSimBalance(t *testing.T) {
	head, trafo := int64(100), int64(200)
	ra, mva, kva := 400.0, 60.0, 0.2
	pts := []Point{
		{ID: 1, Code: "F1", Kind: "feeder", NodeID: &head, TrafoGIID: &trafo, RatingA: &ra, KV: 20, Active: true},
		{ID: 2, Code: "T1", Kind: "trafo_gi", NodeID: &trafo, RatingMVA: &mva, KV: 20, Active: true},
	}
	for i := 0; i < 40; i++ {
		n := int64(1000 + i)
		pts = append(pts, Point{ID: 10 + i, Code: "GD" + strconv.Itoa(i), Kind: "gd", NodeID: &n, FeederID: &head, RatingMVA: &kva, KV: 0.4, Active: true})
	}
	profs := map[int]simProfile{}
	for _, p := range pts {
		profs[p.ID] = profileOf(p)
	}
	st := Settings{CapPF: 0.85, DefaultPF: 0.9}
	sm := &Simulator{}
	ts := time.Date(2026, 9, 1, 19, 30, 0, 0, Loc)
	sumGD, fP, tP, gdMax := 0.0, 0.0, 0.0, 0.0
	for _, m := range sm.slotMessages(pts, profs, ts, st, nil, nil) {
		switch m.Type {
		case "gd":
			sumGD += *m.KWhImp / 500
			var p Point
			for _, q := range pts {
				if q.Code == m.Point {
					p = q
				}
			}
			gdMax = math.Max(gdMax, *Normalize(m, p, ts, st).Util)
		case "feeder":
			fP = *m.KWhImp / 500
		case "trafo_gi":
			tP = *m.KWhImp / 500
		}
	}
	if sumGD <= 0 || fP <= sumGD || tP <= fP {
		t.Fatalf("neraca: gardu %.3f penyulang %.3f trafo %.3f", sumGD, fP, tP)
	}
	if loss := (fP - sumGD) / fP * 100; loss < 0.5 || loss > 25 {
		t.Fatalf("susut %.1f%%", loss)
	}
	if gdMax > 200 {
		t.Fatalf("pembebanan gardu tidak wajar %.0f%%", gdMax)
	}
	if P := feederFromGD(5, 0.05, 0.02, 0.05, 11); math.Abs(P-(5+0.05+0.02*P+0.05*P*P/11)) > 1e-9 {
		t.Fatalf("feederFromGD %v", P)
	}
}
