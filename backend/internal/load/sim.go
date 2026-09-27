package load

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"log"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

// Simulator membangkitkan data SCADA/AMR sintetis yang realistis (bentuk kurva per jenis beban, hari
// kerja/libur, musim, pertumbuhan tahunan) dengan neraca energi konsisten antar-tingkat:
//
//	trafo GI = Σ penyulang × (1 + susut GI);  penyulang = Σ gardu + susut distribusi (tetap + non-teknis + I²R)
//
// beserta anomali sisipan (telemetri & meter) untuk menguji deteksi.
// Mode: isi riwayat langsung ke database, atau kirim live per 30 menit lewat Kafka.
type Simulator struct {
	repo     *Repo
	det      *Detector
	settings func() Settings
	brokers  []string
	topic    func() string
	enabled  func() bool
	// FeederEnergized: status penyulang saat ini dari graf (padam → beban nol)
	FeederEnergized func(head int64) bool
	// AfterBackfill dipanggil setelah pengisian riwayat (mis. pemeriksaan harian)
	AfterBackfill func(ctx context.Context, from, to time.Time)

	mu        sync.Mutex
	writer    *kafka.Writer
	lastSlot  time.Time
	published int64
	running   bool
	progress  map[string]any
}

// NewSimulator membuat simulator.
func NewSimulator(repo *Repo, det *Detector, settings func() Settings, brokers []string, topic func() string, enabled func() bool) *Simulator {
	return &Simulator{repo: repo, det: det, settings: settings, brokers: brokers, topic: topic, enabled: enabled, progress: map[string]any{}}
}

func hash(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

func unit(h uint64, salt uint64) float64 {
	x := (h ^ (salt * 0x9E3779B97F4A7C15)) * 0xBF58476D1CE4E5B9
	x ^= x >> 31
	return float64(x%1000000) / 1000000
}

type simProfile struct {
	class  int // 0 residensial, 1 bisnis, 2 industri, 3 campuran
	base   float64
	imb    float64
	pf     float64
	lowPF  bool
	capMVA float64
	kv     float64
	// penyulang: susut distribusi = tetap + nt·P + k·P²/Pmampu
	lossNT, lossK float64
	// trafo GI: susut & pemakaian sendiri
	giLoss float64
}

func profileOf(p Point) simProfile {
	h := hash(p.Code)
	c := unit(h, 1)
	pr := simProfile{kv: p.KV, capMVA: p.CapMVA()}
	switch {
	case c < 0.45:
		pr.class = 0
	case c < 0.70:
		pr.class = 1
	case c < 0.85:
		pr.class = 2
	default:
		pr.class = 3
	}
	pr.base = 0.3 + 0.32*unit(h, 2)
	if unit(h, 3) < 0.06 { // sebagian kecil penyulang/trafo mendekati / melewati batas kapasitas
		pr.base = 0.8 + 0.16*unit(h, 4)
	}
	pr.imb = 0.02 + 0.06*unit(h, 5)
	pr.pf = 0.87 + 0.08*unit(h, 6)
	pr.lowPF = unit(h, 7) < 0.03
	pr.lossNT = 0.005 + 0.025*unit(h, 8)
	if unit(h, 9) < 0.06 { // penyulang dengan susut non-teknis tinggi
		pr.lossNT = 0.07 + 0.06*unit(h, 10)
	}
	pr.lossK = 0.03 + 0.04*unit(h, 14)
	pr.giLoss = 0.003 + 0.009*unit(h, 15)
	if pr.kv <= 0 {
		pr.kv = 20
	}
	if pr.capMVA <= 0 {
		pr.capMVA = math.Sqrt(3) * pr.kv * 400 / 1000
	}
	return pr
}

// gauss pada jam melingkar (23.30 bersebelahan dengan 00.00) agar kurva kontinu di tengah malam
func gauss(x, mu, sd float64) float64 {
	d := math.Abs(x - mu)
	if d > 12 {
		d = 24 - d
	}
	return math.Exp(-d * d / (2 * sd * sd))
}

// bentuk kurva harian (≈0..1) per jenis beban
func shape(class int, hour float64, dt int) float64 {
	res := 0.42 + 0.14*gauss(hour, 10.5, 3) + 0.58*gauss(hour, 19.5, 2.3) + 0.2*gauss(hour, 23.5, 2)
	bus := 0.28 + 0.72*(1/(1+math.Exp(-(hour-7.5)*1.6)))*(1/(1+math.Exp((hour-17.5)*1.4))) + 0.16*gauss(hour, 19.5, 2)
	ind := 0.5 + 0.5*(1/(1+math.Exp(-(hour-6.5)*2)))*(1/(1+math.Exp((hour-22)*1.5)))
	var v float64
	switch class {
	case 0:
		v = res
		if dt > 0 {
			v *= 1.05
		}
	case 1:
		v = bus
		if dt == 1 {
			v *= 0.78
		} else if dt == 2 {
			v = 0.28 + (v-0.28)*0.45
		}
	case 2:
		v = ind
		if dt == 1 {
			v *= 0.86
		} else if dt == 2 {
			v *= 0.62
		}
	default:
		v = (res + bus) / 2
		if dt == 2 {
			v *= 0.85
		}
	}
	return math.Min(1.08, v)
}

func season(t time.Time) float64 {
	m := float64(t.In(Loc).Month())
	return 1 + 0.05*math.Sin(2*math.Pi*(m-7)/12)
}

func growth(t time.Time) float64 {
	yrs := t.Sub(time.Date(2026, 1, 1, 0, 0, 0, 0, Loc)).Hours() / (24 * 365)
	return math.Pow(1.05, yrs)
}

// frekuensi sistem pada slot (sama untuk semua titik; sesekali turun)
func sysFreq(ts time.Time) float64 {
	rng := rand.New(rand.NewSource(int64(hash("freq" + ts.UTC().Format(time.RFC3339)))))
	f := 50 + 0.035*rng.NormFloat64()
	dh := hash("freq" + ts.In(Loc).Format("20060102"))
	if unit(dh, 1) < 0.02 && SlotOf(ts) == int(unit(dh, 2)*44)+2 {
		f = 49.35 + 0.1*unit(dh, 3)
	}
	return math.Round(f*1000) / 1000
}

// truth adalah besaran fisik sebenarnya pada slot (sebelum gangguan telemetri).
type truth struct{ p, q float64 }

// ownLoad: beban MVA titik yang berdiri sendiri (penyulang / trafo tanpa penyulang terukur).
func ownLoad(pr simProfile, ts time.Time, st Settings, rng *rand.Rand) float64 {
	hour := float64(SlotOf(ts)) / 2
	return pr.capMVA * pr.base * shape(pr.class, hour, DayType(ts, st.Holidays)) * season(ts) * growth(ts) * (1 + 0.035*rng.NormFloat64())
}

func pfAt(pr simProfile, ts time.Time, rng *rand.Rand) float64 {
	hour := float64(SlotOf(ts)) / 2
	pf := pr.pf + 0.01*rng.NormFloat64()
	if pr.lowPF && (hour < 6 || hour > 22) {
		pf = 0.8 + 0.02*rng.NormFloat64()
	}
	return math.Max(0.5, math.Min(0.999, pf))
}

func r3(v float64) float64 { return math.Round(v*1000) / 1000 }

// emit mengubah besaran fisik menjadi pesan SCADA dengan gangguan telemetri/meter sisipan (deterministik
// per titik-hari). ok=false → sengaja tidak dikirim (data hilang).
func emit(p Point, pr simProfile, ts time.Time, t truth, freq float64, rng *rand.Rand) (Message, bool) {
	l := ts.In(Loc)
	dh := hash(p.Code + l.Format("20060102"))
	slot := SlotOf(ts)
	a := unit(dh, 11)
	if p.Kind == "gd" && unit(dh, 13) > 0.3 { // gardu: gangguan lebih jarang
		a = 1
	}
	start := int(unit(dh, 12) * 40)
	in := func(n int) bool { return slot >= start && slot < start+n }
	P, Q := t.p, t.q
	pf := 1.0
	if s := math.Hypot(P, Q); s > 0 {
		pf = P / s
	}
	imb := [3]float64{pr.imb, -pr.imb / 2, -pr.imb / 2}
	s0 := math.Hypot(P, Q)
	v := pr.kv*(1.012-0.03*s0/pr.capMVA) + 0.0025*pr.kv*rng.NormFloat64()
	stuck := false
	energyErr := 1.0
	// jenis gangguan hari ini dipilih dulu, baru jendela slotnya (satu jenis per titik-hari)
	switch {
	case a < 0.015: // nilai macet: telemetri membeku
		if in(7) {
			stuck = true
			srng := rand.New(rand.NewSource(int64(dh)))
			P = r3(pr.capMVA * 0.5 * pr.pf * (1 + 0.05*srng.NormFloat64()))
			Q = r3(P * math.Tan(math.Acos(pr.pf)))
			v = math.Round(pr.kv*1000) / 1000
		}
	case a < 0.023: // lonjakan telemetri
		if slot == start {
			P, Q = P*1.9, Q*1.9
		}
	case a < 0.033: // hilang
		if in(3) {
			return Message{}, false
		}
	case a < 0.038: // tidak seimbang
		if in(6) {
			imb = [3]float64{0.32, -0.16, -0.16}
		}
	case a < 0.042: // telemetri nol
		if in(2) {
			P, Q = 0, 0
		}
	case p.Kind == "trafo_gi" && a < 0.06: // selisih incoming vs penyulang
		if in(8) {
			P, Q = P*1.3, Q*1.3
		}
	case a < 0.047: // tegangan tinggi
		if in(4) {
			v = pr.kv * 1.065
		}
	case a < 0.052: // meter energi bermasalah (kWh terlalu kecil)
		if in(8) {
			energyErr = 0.6
		}
	}
	s := math.Hypot(P, Q)
	i := s * 1000 / (math.Sqrt(3) * pr.kv)
	ph := [3]float64{}
	for k := 0; k < 3; k++ {
		if stuck {
			ph[k] = math.Round(i*(1+imb[k])*10) / 10
		} else {
			ph[k] = math.Round(i*(1+imb[k]+0.008*rng.NormFloat64())*10) / 10
		}
		if s == 0 {
			ph[k] = 0
		}
	}
	// tegangan fasa: penyulang & trafo antarfasa (kV), gardu fasa-netral (kV)
	vph := v
	if p.Kind == "gd" {
		vph = v / math.Sqrt(3)
	}
	vs := [3]float64{}
	for k := 0; k < 3; k++ {
		vs[k] = math.Round(vph*(1+0.004*rng.NormFloat64())*10000) / 10000
	}
	iavg := math.Round((ph[0]+ph[1]+ph[2])/3*10) / 10
	pmw, qmv, smva := r3(P), r3(Q), r3(s)
	pfv := math.Round(pf*1000) / 1000
	// energi periode dari meter (berdiri sendiri dari telemetri daya): besaran fisik sebenarnya
	kwh := math.Round(math.Max(0, t.p)*500*(1+0.002*rng.NormFloat64())*energyErr*10) / 10
	kvarh := math.Round(math.Max(0, t.q)*500*(1+0.002*rng.NormFloat64())*10) / 10
	zero := 0.0
	m := Message{Point: p.Code, Type: p.Kind, TS: l.Format(time.RFC3339), Quality: "good",
		IR: &ph[0], IS: &ph[1], IT: &ph[2], IAvg: &iavg, VR: &vs[0], VS: &vs[1], VT: &vs[2],
		P: &pmw, Q: &qmv, S: &smva, PF: &pfv, F: &freq, KWhImp: &kwh, KWhExp: &zero, KVarhImp: &kvarh, KVarhExp: &zero}
	return m, true
}

// feederFromGD: beban penyulang dari Σ beban gardu ditambah susut distribusi
// L = tetap + nt·P + k·P²/Pmampu, sehingga P = ΣG + L(P) (diselesaikan sebagai persamaan kuadrat).
func feederFromGD(sumGD, fixed, nt, k, capMW float64) float64 {
	c := sumGD + fixed
	if c <= 0 {
		return 0
	}
	if k <= 0 || capMW <= 0 {
		return c / (1 - nt)
	}
	a := k / capMW
	bq := 1 - nt
	disc := bq*bq - 4*a*c
	if disc < 0 { // beban di luar batas model: pakai pendekatan linear
		return c / (1 - nt - k)
	}
	return (bq - math.Sqrt(disc)) / (2 * a)
}

// slotMessages membangkitkan pesan semua titik untuk satu slot dengan neraca energi konsisten:
//   - gardu bermeter: beban dari kapasitas trafo & bentuk beban masing-masing;
//   - penyulang yang gardunya bermeter: Σ gardu + susut distribusi; penyulang lain: profil sendiri;
//   - trafo GI: Σ penyulang × (1 + susut GI), atau profil sendiri bila tidak ada penyulang terukur.
//
// off = kepala penyulang yang sedang padam (graf, khusus slot live terakhir).
func (sm *Simulator) slotMessages(points []Point, profs map[int]simProfile, ts time.Time, st Settings, outs []OutageWindow, off map[int64]bool) []Message {
	out := make([]Message, 0, len(points))
	freq := sysFreq(ts)
	rngOf := func(p Point) *rand.Rand {
		return rand.New(rand.NewSource(int64(hash(p.Code + ts.UTC().Format(time.RFC3339)))))
	}
	down := func(p Point) bool {
		return outageAt(outs, p, ts) != nil || (p.NodeID != nil && off[*p.NodeID]) || (p.Kind == "gd" && p.FeederID != nil && off[*p.FeederID])
	}
	// 1. gardu bermeter per penyulang
	type gdAcc struct {
		p, q, fixed float64
		n           int
	}
	gdSum := map[int64]*gdAcc{}
	for _, g := range points {
		if g.Kind != "gd" || !g.Active || g.FeederID == nil {
			continue
		}
		pr := profs[g.ID]
		rng := rngOf(g)
		var t truth
		if !down(g) {
			s := ownLoad(pr, ts, st, rng)
			pf := pfAt(pr, ts, rng)
			t = truth{s * pf, s * math.Sqrt(1-pf*pf)}
		}
		a := gdSum[*g.FeederID]
		if a == nil {
			a = &gdAcc{}
			gdSum[*g.FeederID] = a
		}
		a.p += t.p
		a.q += t.q
		a.fixed += pr.capMVA * 0.0025 // rugi inti trafo gardu ≈ 0,25% kapasitas
		a.n++
		if m, ok := emit(g, pr, ts, t, freq, rng); ok {
			out = append(out, m)
		}
	}
	// 2. penyulang
	type acc struct{ p, q float64 }
	trafoAcc := map[int64]*acc{}
	for _, p := range points {
		if p.Kind != "feeder" || !p.Active {
			continue
		}
		pr := profs[p.ID]
		rng := rngOf(p)
		var t truth
		if g := gdSum[ptrVal(p.NodeID)]; g != nil && p.NodeID != nil {
			if g.p > 0 {
				pf := pr.capMVA * st.CapPF
				P := feederFromGD(g.p, g.fixed, pr.lossNT, pr.lossK, pf)
				t = truth{P, g.q*1.02 + (P-g.p)*0.3}
			}
		} else {
			s := ownLoad(pr, ts, st, rng)
			pf := pfAt(pr, ts, rng)
			t = truth{s * pf, s * math.Sqrt(1-pf*pf)}
		}
		if down(p) {
			t = truth{}
		}
		if p.TrafoGIID != nil {
			a := trafoAcc[*p.TrafoGIID]
			if a == nil {
				a = &acc{}
				trafoAcc[*p.TrafoGIID] = a
			}
			a.p += t.p // walau pesan hilang, beban tetap mengalir
			a.q += t.q
		}
		if m, ok := emit(p, pr, ts, t, freq, rng); ok {
			out = append(out, m)
		}
	}
	// 3. trafo GI
	for _, p := range points {
		if p.Kind != "trafo_gi" || !p.Active {
			continue
		}
		pr := profs[p.ID]
		rng := rngOf(p)
		var t truth
		if p.NodeID != nil && trafoAcc[*p.NodeID] != nil {
			a := trafoAcc[*p.NodeID]
			t = truth{a.p * (1 + pr.giLoss), a.q*1.04 + a.p*0.01}
		} else {
			s := ownLoad(pr, ts, st, rng)
			pf := pfAt(pr, ts, rng)
			t = truth{s * pf, s * math.Sqrt(1-pf*pf)}
		}
		if outageAt(outs, p, ts) != nil {
			t = truth{}
		}
		if m, ok := emit(p, pr, ts, t, freq, rng); ok {
			out = append(out, m)
		}
	}
	return out
}

func ptrVal(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// Progress mengembalikan status pengisian riwayat / pengiriman live.
func (sm *Simulator) Progress() map[string]any {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	out := map[string]any{"running": sm.running, "published": sm.published}
	if !sm.lastSlot.IsZero() {
		out["last_slot"] = sm.lastSlot
	}
	for k, v := range sm.progress {
		out[k] = v
	}
	return out
}

func (sm *Simulator) setProgress(k string, v any) {
	sm.mu.Lock()
	sm.progress[k] = v
	sm.mu.Unlock()
}

// Backfill mengisi riwayat [from, to) langsung ke database untuk titik-titik (tanpa Kafka), lalu
// menghitung rekap harian, profil dasar, dan anomali.
func (sm *Simulator) Backfill(ctx context.Context, points []Point, from, to time.Time) error {
	sm.mu.Lock()
	if sm.running {
		sm.mu.Unlock()
		return nil
	}
	sm.running = true
	sm.mu.Unlock()
	defer func() {
		sm.mu.Lock()
		sm.running = false
		sm.mu.Unlock()
	}()
	st := sm.settings()
	profs := map[int]simProfile{}
	for _, p := range points {
		profs[p.ID] = profileOf(p)
	}
	outs, _ := sm.det.Outages(ctx, from, to)
	from, to = from.Truncate(30*time.Minute), to.Truncate(30*time.Minute)
	total := int(to.Sub(from) / (30 * time.Minute))
	byCode := map[string]Point{}
	for _, p := range points {
		byCode[p.Code] = p
	}
	buf := make([]Reading, 0, 25000)
	done := 0
	flush := func() error {
		if len(buf) == 0 {
			return nil
		}
		err := sm.repo.UpsertReadings(ctx, buf)
		buf = buf[:0]
		return err
	}
	for ts := from; ts.Before(to); ts = ts.Add(30 * time.Minute) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		for _, m := range sm.slotMessages(points, profs, ts, st, outs, nil) {
			buf = append(buf, Normalize(m, byCode[m.Point], ts, st))
		}
		if len(buf) >= 20000 {
			if err := flush(); err != nil {
				return err
			}
		}
		done++
		if done%48 == 0 {
			sm.setProgress("backfill", map[string]any{"done": done, "total": total, "phase": "data"})
		}
	}
	if err := flush(); err != nil {
		return err
	}
	ids := make([]int32, 0, len(points))
	for _, p := range points {
		ids = append(ids, int32(p.ID))
	}
	sm.setProgress("backfill", map[string]any{"done": total, "total": total, "phase": "daily"})
	// rekap harian per bulan agar transaksi tidak terlalu besar
	for f := from; f.Before(to); f = f.AddDate(0, 1, 0) {
		t := f.AddDate(0, 1, 0)
		if t.After(to) {
			t = to
		}
		if err := sm.repo.RefreshDaily(ctx, ids, f, t.Add(-time.Minute), st.Warn, st.Over); err != nil {
			return err
		}
	}
	sm.setProgress("backfill", map[string]any{"done": total, "total": total, "phase": "baseline"})
	if err := sm.repo.RefreshBaseline(ctx, to, st.HolidayList()); err != nil {
		return err
	}
	sm.setProgress("backfill", map[string]any{"done": total, "total": total, "phase": "anomaly"})
	for f := from; f.Before(to); f = f.AddDate(0, 0, 7) {
		t := f.AddDate(0, 0, 7)
		if t.After(to) {
			t = to
		}
		if _, err := sm.det.Detect(ctx, points, f, t); err != nil {
			log.Printf("[load] deteksi %s: %v", f.Format("2006-01-02"), err)
		}
	}
	if sm.AfterBackfill != nil {
		sm.AfterBackfill(ctx, from, to)
	}
	sm.setProgress("backfill", map[string]any{"done": total, "total": total, "phase": "done", "at": time.Now()})
	return nil
}

// Run mengirim data live tiap slot 30 menit yang selesai ke Kafka (bila simulator aktif).
// Slot yang tertinggal (sejak data terakhir, maks. 12 jam) ikut dikirim.
func (sm *Simulator) Run(ctx context.Context, points func() []Point) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		if sm.enabled() {
			sm.tick(ctx, points())
		}
		select {
		case <-ctx.Done():
			if sm.writer != nil {
				_ = sm.writer.Close()
			}
			return
		case <-t.C:
		}
	}
}

func (sm *Simulator) tick(ctx context.Context, points []Point) {
	if len(points) == 0 || len(sm.brokers) == 0 {
		return
	}
	target := time.Now().Truncate(30 * time.Minute).Add(-30 * time.Minute) // slot terakhir yang sudah lengkap
	sm.mu.Lock()
	last := sm.lastSlot
	sm.mu.Unlock()
	if last.IsZero() {
		for _, p := range points {
			if p.Kind != "gd" && p.LastTS != nil && p.LastTS.After(last) {
				last = *p.LastTS
			}
		}
		if last.IsZero() {
			last = target.Add(-30 * time.Minute)
		}
	}
	if !target.After(last) {
		return
	}
	if target.Sub(last) > 12*time.Hour {
		last = target.Add(-12 * time.Hour)
	}
	if sm.writer == nil {
		sm.writer = &kafka.Writer{Addr: kafka.TCP(sm.brokers...), Topic: sm.topic(), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireOne,
			AllowAutoTopicCreation: true, BatchTimeout: 20 * time.Millisecond, BatchSize: 500, WriteTimeout: 10 * time.Second}
	}
	st := sm.settings()
	profs := map[int]simProfile{}
	for _, p := range points {
		profs[p.ID] = profileOf(p)
	}
	// penyulang yang padam saat ini (graf) → beban nol pada slot terakhir
	off := map[int64]bool{}
	if sm.FeederEnergized != nil {
		for _, p := range points {
			if p.Kind == "feeder" && p.NodeID != nil && !sm.FeederEnergized(*p.NodeID) {
				off[*p.NodeID] = true
			}
		}
	}
	outs, _ := sm.det.Outages(ctx, last, target.Add(30*time.Minute))
	for ts := last.Add(30 * time.Minute); !ts.After(target); ts = ts.Add(30 * time.Minute) {
		var o map[int64]bool
		if ts.Equal(target) {
			o = off
		}
		msgs := sm.slotMessages(points, profs, ts, st, outs, o)
		kms := make([]kafka.Message, 0, len(msgs))
		for _, m := range msgs {
			b, _ := json.Marshal(m)
			kms = append(kms, kafka.Message{Key: []byte(m.Point), Value: b})
		}
		wctx, cancel := context.WithTimeout(ctx, time.Minute)
		err := sm.writer.WriteMessages(wctx, kms...)
		cancel()
		if err != nil {
			log.Printf("[load] simulator kirim %s gagal: %v", ts.Format(time.RFC3339), err)
			return
		}
		sm.mu.Lock()
		sm.lastSlot = ts
		sm.published += int64(len(kms))
		sm.mu.Unlock()
	}
	log.Printf("[load] simulator: slot %s terkirim ke Kafka (%d titik)", target.In(Loc).Format("02/01 15:04"), len(points))
}
