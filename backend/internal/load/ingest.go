package load

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"
)

// Message adalah kontrak pesan SCADA/AMR 30 menit (satu objek atau array objek per pesan Kafka).
//
//	{"point":"KBK-GMB-02","type":"feeder","ts":"2026-09-27T10:30:00+07:00",
//	 "i_r":182,"i_s":175,"i_t":190,"v_r":20.3,"v_s":20.4,"v_t":20.2,
//	 "p_mw":6.1,"q_mvar":1.9,"s_mva":6.39,"pf":0.95,"f_hz":50.01,
//	 "kwh_imp":3050,"kwh_exp":0,"kvarh_imp":950,"kvarh_exp":0,"quality":"good"}
//
// type: feeder | trafo_gi | gd (gardu distribusi). ts = awal periode 30 menit (dibulatkan ke bawah);
// tanpa zona waktu dianggap WIB. v_r/v_s/v_t boleh antarfasa atau fasa-netral (dikenali dari besarnya).
// Energi kWh/kvarh = energi selama periode (mode interval) atau nilai register meter (mode cumulative,
// konfigurasi load.energy_mode atau "energy_mode" pada pesan). Besaran yang tidak ada boleh dikosongkan.
type Message struct {
	Point      string   `json:"point"`
	Type       string   `json:"type"`
	TS         string   `json:"ts"`
	IR         *float64 `json:"i_r"`
	IS         *float64 `json:"i_s"`
	IT         *float64 `json:"i_t"`
	IAvg       *float64 `json:"i_avg"`
	VR         *float64 `json:"v_r"`
	VS         *float64 `json:"v_s"`
	VT         *float64 `json:"v_t"`
	V          *float64 `json:"v_kv"` // tegangan antarfasa rata-rata (opsional bila v_r/v_s/v_t ada)
	P          *float64 `json:"p_mw"`
	Q          *float64 `json:"q_mvar"`
	S          *float64 `json:"s_mva"`
	PF         *float64 `json:"pf"`
	F          *float64 `json:"f_hz"`
	KWhImp     *float64 `json:"kwh_imp"`
	KWhExp     *float64 `json:"kwh_exp"`
	KVarhImp   *float64 `json:"kvarh_imp"`
	KVarhExp   *float64 `json:"kvarh_exp"`
	EnergyMode string   `json:"energy_mode,omitempty"` // interval | cumulative
	Quality    string   `json:"quality"`               // good | estimated | suspect | bad
}

// ParseTS membaca waktu pesan (RFC3339 / tanpa zona = WIB) dan membulatkan ke awal slot 30 menit.
func ParseTS(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	var t time.Time
	var err error
	for _, f := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02T15:04", "2006-01-02 15:04"} {
		if strings.Contains(f, "Z07") {
			t, err = time.Parse(f, s)
		} else {
			t, err = time.ParseInLocation(f, s, Loc)
		}
		if err == nil {
			return t.Truncate(30 * time.Minute), nil
		}
	}
	return time.Time{}, fmt.Errorf("ts tidak valid: %q", s)
}

func fptr(v float64) *float64 { return &v }

func avgOf(vs ...*float64) (float64, int) {
	sum, n := 0.0, 0
	for _, v := range vs {
		if v != nil {
			sum += *v
			n++
		}
	}
	if n == 0 {
		return 0, 0
	}
	return sum / float64(n), n
}

// LineKV mengembalikan tegangan antarfasa (kV) dari tegangan fasa: bila rata-ratanya jauh di bawah
// nominal (< 75%), dianggap fasa-netral lalu dikali √3.
func LineKV(vr, vs, vt *float64, nominal float64) *float64 {
	v, n := avgOf(vr, vs, vt)
	if n == 0 || v <= 0 {
		return nil
	}
	if nominal > 0 && v < nominal*0.75 {
		v *= math.Sqrt(3)
	}
	return fptr(v)
}

// Normalize menurunkan besaran turunan (I rata-rata, tegangan antarfasa, P/Q/S, pf, % pembebanan MW) dari pesan untuk titik p.
func Normalize(m Message, p Point, ts time.Time, st Settings) Reading {
	r := Reading{PointID: p.ID, TS: ts, IR: m.IR, IS: m.IS, IT: m.IT, IAvg: m.IAvg, VR: m.VR, VS: m.VS, VT: m.VT, V: m.V,
		P: m.P, Q: m.Q, S: m.S, PF: m.PF, F: m.F, KWhImp: m.KWhImp, KWhExp: m.KWhExp, KVarhImp: m.KVarhImp, KVarhExp: m.KVarhExp}
	if r.IAvg == nil {
		if v, n := avgOf(m.IR, m.IS, m.IT); n > 0 {
			r.IAvg = fptr(v)
		}
	}
	kv := p.KV
	if kv <= 0 {
		kv = 20
	}
	if r.V == nil {
		r.V = LineKV(m.VR, m.VS, m.VT, kv)
	}
	vLine := kv
	if r.V != nil && *r.V > 0 {
		vLine = *r.V
	}
	defPF := st.DefaultPF
	if m.PF != nil && *m.PF > 0 {
		defPF = math.Abs(*m.PF)
	}
	if r.S == nil {
		switch {
		case m.P != nil && m.Q != nil:
			r.S = fptr(math.Hypot(*m.P, *m.Q))
		case r.IAvg != nil:
			r.S = fptr(math.Sqrt(3) * vLine * *r.IAvg / 1000)
		case m.P != nil:
			r.S = fptr(math.Abs(*m.P) / defPF)
		}
	}
	if r.P == nil && r.S != nil {
		r.P = fptr(*r.S * defPF)
	}
	if r.Q == nil && r.P != nil && r.S != nil && *r.S >= math.Abs(*r.P) {
		r.Q = fptr(math.Sqrt(*r.S**r.S - *r.P**r.P))
	}
	if r.PF == nil && r.P != nil && r.S != nil && *r.S > 0 {
		r.PF = fptr(math.Min(1, math.Abs(*r.P) / *r.S))
	}
	// % pembebanan berbasis MW: |P| ÷ daya mampu (rating MVA × faktor daya kapasitas)
	if c := p.CapMW(st.CapPF); c > 0 && r.P != nil {
		r.Util = fptr(math.Abs(*r.P) / c * 100)
	}
	switch strings.ToLower(m.Quality) {
	case "estimated", "estimasi":
		r.Quality = 1
	case "suspect", "bad", "invalid":
		r.Quality = 2
	}
	return r
}

// Ingestor menerima pesan Kafka, memetakan titik, menyimpan per batch, lalu memicu rekap & deteksi anomali.
type Ingestor struct {
	repo     *Repo
	settings func() Settings
	after    func(ctx context.Context, pts []int32, from, to time.Time)
	// Register: pendaftaran otomatis kode yang belum dikenal (nil / ok=false → dicatat sebagai belum dipetakan)
	Register func(ctx context.Context, code, kind string) (Point, bool)

	mu      sync.Mutex
	points  map[string]Point
	loaded  time.Time
	buf     []Reading
	regs    map[int]Register // register meter terakhir (mode kumulatif)
	regDirt map[int]Register
	stats   struct {
		messages, readings, unmapped, invalid, registered int64
		lastAt                                            time.Time
	}
}

// Settings adalah ambang & parameter pembebanan (dibaca dari konfigurasi aplikasi).
type Settings struct {
	DefaultPF, CapPF, Warn, Over, Imbalance, MinPF, VHigh, VLow, Spike, Mismatch float64
	FNominal, FDev, EnergyDev                                                    float64
	LossHigh, LossGI, LossCoverage                                               float64
	EnergyMode                                                                   string
	Holidays                                                                     map[string]bool
	DefaultUID                                                                   string
}

// HolidayList mengembalikan daftar tanggal libur.
func (s Settings) HolidayList() []string {
	out := make([]string, 0, len(s.Holidays))
	for d := range s.Holidays {
		out = append(out, d)
	}
	return out
}

// NewIngestor membuat penerima data; after dipanggil setelah tiap batch tersimpan.
func NewIngestor(repo *Repo, settings func() Settings, after func(ctx context.Context, pts []int32, from, to time.Time)) *Ingestor {
	return &Ingestor{repo: repo, settings: settings, after: after, regDirt: map[int]Register{}}
}

// InvalidatePoints memaksa muat ulang daftar titik (sesudah pemetaan berubah).
func (in *Ingestor) InvalidatePoints() {
	in.mu.Lock()
	in.points = nil
	in.mu.Unlock()
}

func (in *Ingestor) pointMap(ctx context.Context) map[string]Point {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.points == nil || time.Since(in.loaded) > time.Minute {
		if ps, err := in.repo.Points(ctx); err == nil {
			m := make(map[string]Point, len(ps))
			for _, p := range ps {
				if p.Active {
					m[strings.ToUpper(p.Code)] = p
				}
			}
			in.points, in.loaded = m, time.Now()
		}
	}
	return in.points
}

// cumulative: energi periode = register sekarang − register slot sebelumnya (tepat 30 menit sebelumnya
// dan tidak menurun); selain itu kosong (register direset / data bolong).
func (in *Ingestor) cumulative(ctx context.Context, r *Reading) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.regs == nil {
		in.regs = map[int]Register{}
		if g, err := in.repo.Registers(ctx); err == nil {
			in.regs = g
		}
	}
	cur := Register{TS: r.TS, KWhImp: r.KWhImp, KWhExp: r.KWhExp, KVarhImp: r.KVarhImp, KVarhExp: r.KVarhExp}
	prev, ok := in.regs[r.PointID]
	delta := func(c, p *float64) *float64 {
		if !ok || c == nil || p == nil || !prev.TS.Equal(r.TS.Add(-30*time.Minute)) || *c < *p {
			return nil
		}
		return fptr(*c - *p)
	}
	r.KWhImp, r.KWhExp = delta(cur.KWhImp, prev.KWhImp), delta(cur.KWhExp, prev.KWhExp)
	r.KVarhImp, r.KVarhExp = delta(cur.KVarhImp, prev.KVarhImp), delta(cur.KVarhExp, prev.KVarhExp)
	if !ok || !cur.TS.Before(prev.TS) {
		in.regs[r.PointID] = cur
		in.regDirt[r.PointID] = cur
	}
}

// Handle memproses satu pesan Kafka (objek atau array).
func (in *Ingestor) Handle(ctx context.Context, value []byte) error {
	var msgs []Message
	v := strings.TrimSpace(string(value))
	if strings.HasPrefix(v, "[") {
		if err := json.Unmarshal(value, &msgs); err != nil {
			in.count(0, 0, 1)
			return err
		}
	} else {
		var m Message
		if err := json.Unmarshal(value, &m); err != nil {
			in.count(0, 0, 1)
			return err
		}
		msgs = []Message{m}
	}
	pts := in.pointMap(ctx)
	st := in.settings()
	rs := make([]Reading, 0, len(msgs))
	unmapped, registered := 0, 0
	for _, m := range msgs {
		code := strings.TrimSpace(m.Point)
		p, ok := pts[strings.ToUpper(code)]
		if !ok && in.Register != nil && code != "" {
			if np, ok2 := in.Register(ctx, code, m.Type); ok2 {
				p, ok = np, true
				registered++
				in.mu.Lock()
				if in.points != nil {
					in.points[strings.ToUpper(code)] = np
				}
				in.mu.Unlock()
			}
		}
		if !ok {
			unmapped++
			raw, _ := json.Marshal(m)
			in.repo.Unmapped(ctx, code, m.Type, raw)
			continue
		}
		ts, err := ParseTS(m.TS)
		if err != nil || ts.After(time.Now().Add(time.Hour)) {
			in.count(0, 0, 1)
			continue
		}
		r := Normalize(m, p, ts, st)
		mode := strings.ToLower(m.EnergyMode)
		if mode == "" {
			mode = st.EnergyMode
		}
		if mode == "cumulative" {
			in.cumulative(ctx, &r)
		}
		rs = append(rs, r)
	}
	in.mu.Lock()
	in.buf = append(in.buf, rs...)
	in.stats.messages += int64(len(msgs))
	in.stats.unmapped += int64(unmapped)
	in.stats.registered += int64(registered)
	in.stats.lastAt = time.Now()
	full := len(in.buf) >= 5000
	in.mu.Unlock()
	if full {
		in.Flush(ctx)
	}
	return nil
}

func (in *Ingestor) count(msg, rd, invalid int64) {
	in.mu.Lock()
	in.stats.messages += msg
	in.stats.readings += rd
	in.stats.invalid += invalid
	in.mu.Unlock()
}

// Flush menyimpan isi buffer.
func (in *Ingestor) Flush(ctx context.Context) {
	in.mu.Lock()
	buf := in.buf
	in.buf = nil
	regs := in.regDirt
	in.regDirt = map[int]Register{}
	in.mu.Unlock()
	if len(regs) > 0 {
		if err := in.repo.SaveRegisters(ctx, regs); err != nil {
			log.Printf("[load] simpan register meter: %v", err)
		}
	}
	if len(buf) == 0 {
		return
	}
	if err := in.repo.UpsertReadings(ctx, buf); err != nil {
		log.Printf("[load] simpan %d data gagal: %v", len(buf), err)
		return
	}
	in.count(0, int64(len(buf)), 0)
	seen := map[int32]bool{}
	pts := []int32{}
	from, to := buf[0].TS, buf[0].TS
	for _, r := range buf {
		if !seen[int32(r.PointID)] {
			seen[int32(r.PointID)] = true
			pts = append(pts, int32(r.PointID))
		}
		if r.TS.Before(from) {
			from = r.TS
		}
		if r.TS.After(to) {
			to = r.TS
		}
	}
	if in.after != nil {
		in.after(ctx, pts, from, to.Add(30*time.Minute))
	}
}

// Run mengosongkan buffer berkala (dipanggil sebagai goroutine).
func (in *Ingestor) Run(ctx context.Context) {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			in.Flush(context.Background())
			return
		case <-t.C:
			in.Flush(ctx)
		}
	}
}

// Stats mengembalikan statistik penerimaan.
func (in *Ingestor) Stats() map[string]any {
	in.mu.Lock()
	defer in.mu.Unlock()
	return map[string]any{"messages": in.stats.messages, "readings": in.stats.readings, "unmapped": in.stats.unmapped,
		"invalid": in.stats.invalid, "registered": in.stats.registered, "last_at": in.stats.lastAt, "buffer": len(in.buf)}
}
