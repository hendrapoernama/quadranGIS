package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"quadrangis/internal/gis"
	"quadrangis/internal/load"
	"quadrangis/internal/push"
	"quadrangis/internal/stream"
)

// LoadStack adalah komponen pembebanan (SCADA 30 menit) yang berjalan di latar.
type LoadStack struct {
	Repo *load.Repo
	Ing  *load.Ingestor
	Det  *load.Detector
	Sim  *load.Simulator

	mu        sync.Mutex
	calib     calibration
	calibAt   time.Time
	lastSync  time.Time
	lastPub   time.Time
	bootstrap map[string]any
	gdKVA     map[int64]float64
	gdKVAAt   time.Time
	topo      *lossTopo
	topoAt    time.Time
}

type calibration struct {
	scale map[int64]float64
	caps  map[int64]float64
	rows  []calibRow
}

type calibRow struct {
	PointID    int     `json:"point_id"`
	Code       string  `json:"code"`
	Head       int64   `json:"head_id"`
	PeakMVA    float64 `json:"peak_mva"`
	ContractVA float64 `json:"contract_va"`
	Factor     float64 `json:"factor"`
	CapMVA     float64 `json:"cap_mva"`
}

func (s *Server) loadSettings() load.Settings {
	c := s.d.Configs
	st := load.Settings{
		DefaultPF: c.Float("load.default_pf", 0.9), CapPF: c.Float("load.cap_pf", 0.85), Warn: c.Float("load.warn_pct", 80), Over: c.Float("load.over_pct", 100),
		Imbalance: c.Float("load.imbalance_pct", 20), MinPF: c.Float("load.min_pf", 0.85), VHigh: c.Float("load.v_high_pct", 5),
		VLow: c.Float("load.v_low_pct", 10), Spike: c.Float("load.spike_pct", 50), Mismatch: c.Float("load.mismatch_pct", 15),
		FNominal: c.Float("load.f_nominal", 50), FDev: c.Float("load.f_dev", 0.5), EnergyDev: c.Float("load.energy_dev_pct", 10),
		LossHigh: c.Float("load.losses_high_pct", 12), LossGI: c.Float("load.losses_gi_pct", 3), LossCoverage: c.Float("load.losses_min_coverage", 90),
		EnergyMode: strings.ToLower(c.Str("load.energy_mode", "interval")),
		Holidays:   map[string]bool{}, DefaultUID: c.Str("load.default_uid", "JAKARTA RAYA"),
	}
	if st.CapPF <= 0 || st.CapPF > 1 {
		st.CapPF = 0.85
	}
	for _, d := range strings.Split(c.Str("load.holidays", ""), ",") {
		if d = strings.TrimSpace(d); d != "" {
			st.Holidays[d] = true
		}
	}
	return st
}

// StartLoad menyiapkan & menjalankan pembebanan: konsumer Kafka, simulator, dan pekerjaan terjadwal.
func StartLoad(ctx context.Context, d *Deps) {
	s := &Server{d: d}
	repo := load.NewRepo(d.Pool)
	det := load.NewDetector(repo, s.loadSettings)
	ls := &LoadStack{Repo: repo, Det: det, bootstrap: map[string]any{}}
	ls.Ing = load.NewIngestor(repo, s.loadSettings, func(ctx context.Context, pts []int32, from, to time.Time) {
		s.afterIngest(ctx, pts, from, to)
	})
	ls.Sim = load.NewSimulator(repo, det, s.loadSettings, d.Cfg.KafkaBrokers,
		func() string { return d.Configs.Str("load.kafka_topic", "scada.load.30m") },
		func() bool { return d.Cfg.KafkaEnabled && d.Configs.Bool("load.simulator", true) })
	ls.Sim.FeederEnergized = func(head int64) bool {
		// graf belum dimuat / objek tidak dikenal: anggap menyala (jangan kirim beban nol palsu)
		info := d.Graph.NodeInfo(head)
		return !d.Graph.Ready() || !info.InGraph || info.Energized
	}
	ls.Sim.AfterBackfill = func(ctx context.Context, from, to time.Time) {
		pts, _ := repo.Points(ctx)
		if _, err := det.DetectDaily(ctx, pts, from, to, s.maneuverRefs(ctx, from, to)); err != nil {
			log.Printf("[load] deteksi harian: %v", err)
		}
		s.detectLosses(ctx, from, to)
	}
	ls.Ing.Register = s.registerPoint
	det.OnNew = func(ctx context.Context, as []load.Anomaly) { s.notifyLoad(as) }
	d.Load = ls

	go ls.Ing.Run(ctx)
	if d.Cfg.KafkaEnabled {
		topic := d.Configs.Str("load.kafka_topic", "scada.load.30m")
		go stream.Consume(ctx, d.Cfg.KafkaBrokers, topic, d.Configs.Str("load.kafka_group", "quadrangis-load"), func(ctx context.Context, m stream.Message) error {
			return ls.Ing.Handle(ctx, m.Value)
		})
	}
	go ls.Sim.Run(ctx, func() []load.Point {
		ps, _ := repo.Points(ctx)
		return ps
	})
	go s.loadJobs(ctx)
}

// afterIngest: rekap harian, deteksi anomali, dan siaran realtime untuk data yang baru masuk.
func (s *Server) afterIngest(ctx context.Context, pts []int32, from, to time.Time) {
	ls := s.d.Load
	st := s.loadSettings()
	if err := ls.Repo.RefreshDaily(ctx, pts, from, to.Add(-time.Minute), st.Warn, st.Over); err != nil {
		log.Printf("[load] rekap harian: %v", err)
	}
	all, err := ls.Repo.Points(ctx)
	if err != nil {
		return
	}
	want := map[int32]bool{}
	for _, p := range pts {
		want[p] = true
	}
	sel := []load.Point{}
	for _, p := range all {
		if want[int32(p.ID)] {
			sel = append(sel, p)
		}
	}
	if _, err := ls.Det.Detect(ctx, sel, from, to); err != nil {
		log.Printf("[load] deteksi anomali: %v", err)
	}
	ls.mu.Lock()
	pub := time.Since(ls.lastPub) > 10*time.Second
	if pub {
		ls.lastPub = time.Now()
	}
	ls.mu.Unlock()
	if pub {
		data, _ := json.Marshal(map[string]any{"points": len(pts), "from": from, "to": to})
		s.d.Hub.Publish(stream.Event{Type: "load.data", At: time.Now(), Data: data})
	}
}

// notifyLoad: notifikasi push & siaran untuk anomali serius (beban lebih, beban nol, data hilang).
func (s *Server) notifyLoad(as []load.Anomaly) {
	for _, a := range as {
		data, _ := json.Marshal(a)
		s.d.Hub.Publish(stream.Event{Type: "load.anomaly", ID: a.ID, At: time.Now(), Data: data})
		var title, body string
		switch a.Kind {
		case "overload":
			title = "Beban lebih " + a.PointCode
			if a.Value != nil {
				body = fmt.Sprintf("%.0f%% dari kapasitas sejak %s", *a.Value, a.Start.In(load.Loc).Format("02/01 15:04"))
			}
		case "zero_load":
			title = "Beban nol tanpa kejadian padam: " + a.PointCode
			body = "Periksa telemetri SCADA atau kemungkinan padam yang belum tercatat."
		case "missing":
			if a.PointKind == "gd" {
				continue // gardu (AMR) terlalu banyak untuk notifikasi per titik
			}
			title = "Data SCADA terhenti: " + a.PointCode
			body = "Tidak ada data sejak " + a.Start.In(load.Loc).Format("02/01 15:04")
		default:
			continue
		}
		urg := "normal"
		if a.Severity == "critical" {
			urg = "high"
		}
		s.notify("load", push.Message{Title: title, Body: body, URL: "/load?tab=anomalies", Tag: fmt.Sprintf("load-%s-%d", a.Kind, a.PointID)}, urg)
	}
}

// maneuverRefs: manuver & kejadian padam dalam rentang, dipetakan ke kepala penyulang (penjelas pergeseran level).
func (s *Server) maneuverRefs(ctx context.Context, from, to time.Time) []load.ManeuverRef {
	out := []load.ManeuverRef{}
	rows, err := s.d.Pool.Query(ctx, `SELECT m.id, m.created_at, m.action, m.kind, m.node_code, m.node_id,
		COALESCE(o.summary->'penyulang_ids', m.affected->'penyulang_ids', '[]'::jsonb)
		FROM maneuvers m LEFT JOIN outages o ON o.id = m.outage_id
		WHERE m.created_at >= $1 - interval '1 day' AND m.created_at < $2 + interval '1 day'`, from, to)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var r load.ManeuverRef
		var node int64
		var hj []byte
		if rows.Scan(&r.ID, &r.At, &r.Action, &r.Kind, &r.Code, &node, &hj) != nil {
			continue
		}
		heads := []int64{}
		_ = json.Unmarshal(hj, &heads)
		if f := s.d.Graph.NodeInfo(node).Feeder; f != 0 {
			heads = append(heads, f)
		}
		r.Action = strings.ToUpper(r.Action)
		for _, h := range heads {
			x := r
			x.Head = h
			out = append(out, x)
		}
	}
	return out
}

// ------------------------------------------------------------------ pemetaan & hierarki

// autoMapPoints membuat titik untuk seluruh penyulang (kubikel outgoing) & trafo GI di graf.
func (s *Server) autoMapPoints(ctx context.Context) (int, error) {
	if !s.d.Graph.Ready() {
		return 0, gis.ErrGraphLoading
	}
	_, feeders := s.d.Graph.PowerSummary()
	defA := s.d.Configs.Float("ops.feeder_capacity_a", 400)
	kv := s.d.Configs.Float("ops.feeder_kv", 20)
	heads := make([]int64, 0, len(feeders))
	for _, f := range feeders {
		heads = append(heads, f.Head)
	}
	rating := map[int64]float64{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT id, NULLIF(properties->>'arus_nominal_a', '')::float FROM gis_nodes WHERE id = ANY($1)`, heads); err == nil {
		for rows.Next() {
			var id int64
			var a *float64
			if rows.Scan(&id, &a) == nil && a != nil && *a > 0 {
				rating[id] = *a
			}
		}
		rows.Close()
	}
	// kode & nama kubikel (rekap graf tidak selalu membawa kode)
	if names, err := s.d.Power.NodeCodes(ctx, heads); err == nil {
		for i := range feeders {
			if cn, ok := names[feeders[i].Head]; ok {
				if feeders[i].Code == "" {
					feeders[i].Code = cn.Code
				}
				if feeders[i].Name == "" {
					feeders[i].Name = cn.Name
				}
			}
		}
	}
	existing := map[string]bool{}
	if ps, err := s.d.Load.Repo.Points(ctx); err == nil {
		for _, p := range ps {
			existing[p.Code] = true
		}
	}
	n := 0
	for _, f := range feeders {
		if f.Code == "" || existing[f.Code] {
			continue
		}
		a := defA
		if v, ok := rating[f.Head]; ok {
			a = v
		}
		head := f.Head
		if _, err := s.d.Load.Repo.UpsertPoint(ctx, load.Point{Code: f.Code, Kind: "feeder", NodeID: &head, Name: f.Name, RatingA: &a, KV: kv, Active: true}); err != nil {
			return n, err
		}
		n++
	}
	rows, err := s.d.Pool.Query(ctx, `SELECT id, code, name, COALESCE(NULLIF(properties->>'daya_mva', '')::float, 60) FROM gis_nodes WHERE type_code = 'trafo_gi' AND code <> ''`)
	if err != nil {
		return n, err
	}
	type tr struct {
		id         int64
		code, name string
		mva        float64
	}
	trs := []tr{}
	for rows.Next() {
		var t tr
		if rows.Scan(&t.id, &t.code, &t.name, &t.mva) == nil {
			trs = append(trs, t)
		}
	}
	rows.Close()
	for _, t := range trs {
		if existing[t.code] {
			continue
		}
		id, mva := t.id, t.mva
		if _, err := s.d.Load.Repo.UpsertPoint(ctx, load.Point{Code: t.code, Kind: "trafo_gi", NodeID: &id, Name: t.name, RatingMVA: &mva, KV: kv, Active: true}); err != nil {
			return n, err
		}
		n++
	}
	s.d.Load.Ing.InvalidatePoints()
	if err := s.syncHierarchy(ctx); err != nil {
		return n, err
	}
	return n, nil
}

// gdPoint menyiapkan titik gardu distribusi dari objek GIS (kapasitas dari atribut GIS / bawaan).
func (s *Server) gdPoint(ctx context.Context, id int64, code, name string) load.Point {
	kv := s.d.Configs.Float("load.gd_kv", 0.4)
	kva := s.gdKVA(ctx)[id]
	if kva <= 0 {
		kva = s.d.Configs.Float("load.default_gd_kva", 200)
	}
	mva := kva / 1000
	node := id
	p := load.Point{Code: code, Kind: "gd", NodeID: &node, Name: name, RatingMVA: &mva, KV: kv, Active: true}
	if f := s.d.Graph.NodeInfo(id).Feeder; f != 0 {
		p.FeederID = &f
	}
	return p
}

// autoMapGD membuat titik untuk seluruh gardu pada penyulang nyata (bukan simulasi massal) ditambah
// `bulkFeeders` penyulang simulasi massal pertama — gardu bermeter / AMR.
func (s *Server) autoMapGD(ctx context.Context, bulkFeeders int) (int, error) {
	if !s.d.Graph.Ready() {
		return 0, gis.ErrGraphLoading
	}
	ps, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		return 0, err
	}
	existing := map[string]bool{}
	heads := []int64{}
	for _, p := range ps {
		existing[p.Code] = true
		if p.Kind == "feeder" && p.Active && p.NodeID != nil {
			heads = append(heads, *p.NodeID)
		}
	}
	bulk := map[int64]bool{}
	if rows, err := s.d.Pool.Query(ctx, `SELECT id FROM gis_nodes WHERE id = ANY($1) AND properties ? 'bulk'`, heads); err == nil {
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				bulk[id] = true
			}
		}
		rows.Close()
	}
	pick := map[int64]bool{}
	bulkHeads := []int64{}
	for _, h := range heads {
		if bulk[h] {
			bulkHeads = append(bulkHeads, h)
		} else {
			pick[h] = true
		}
	}
	sort.Slice(bulkHeads, func(i, j int) bool { return bulkHeads[i] < bulkHeads[j] })
	for i := 0; i < bulkFeeders && i < len(bulkHeads); i++ {
		pick[bulkHeads[i]] = true
	}
	gds := []gis.GDStatus{}
	ids := []int64{}
	for _, g := range s.d.Graph.GDStatuses() {
		if pick[g.Feeder] {
			gds = append(gds, g)
			ids = append(ids, g.ID)
		}
	}
	names, _ := s.d.Power.NodeCodes(ctx, ids)
	n := 0
	for _, g := range gds {
		code := names[g.ID].Code
		if code == "" || existing[code] {
			continue
		}
		if _, err := s.d.Load.Repo.UpsertPoint(ctx, s.gdPoint(ctx, g.ID, code, names[g.ID].Name)); err != nil {
			return n, err
		}
		existing[code] = true
		n++
	}
	s.d.Load.Ing.InvalidatePoints()
	s.invalidateLossTopo()
	if err := s.syncHierarchy(ctx); err != nil {
		return n, err
	}
	return n, nil
}

func (s *Server) invalidateLossTopo() {
	s.d.Load.mu.Lock()
	s.d.Load.topo = nil
	s.d.Load.mu.Unlock()
}

// registerPoint: pendaftaran otomatis kode baru dari pesan SCADA/AMR bila sama dengan kode objek GIS
// (kubikel penyulang, trafo GI, atau gardu). Hierarki lengkap diisi saat sinkronisasi berikutnya (≤ 30 menit);
// pemasok gardu langsung diambil dari graf.
func (s *Server) registerPoint(ctx context.Context, code, kind string) (load.Point, bool) {
	if !s.d.Configs.Bool("load.auto_register", true) || !s.d.Graph.Ready() {
		return load.Point{}, false
	}
	types := []string{"kubikel_20kv", "trafo_gi", "gd"}
	if t, ok := pointNodeType[kind]; ok {
		types = []string{t}
	}
	var id int64
	var tc, name string
	var props []byte
	if err := s.d.Pool.QueryRow(ctx, `SELECT id, type_code, name, properties FROM gis_nodes WHERE code = $1 AND type_code = ANY($2) LIMIT 1`, code, types).Scan(&id, &tc, &name, &props); err != nil {
		return load.Point{}, false
	}
	var pr map[string]any
	_ = json.Unmarshal(props, &pr)
	var p load.Point
	kv := s.d.Configs.Float("ops.feeder_kv", 20)
	switch tc {
	case "gd":
		p = s.gdPoint(ctx, id, code, name)
	case "trafo_gi":
		mva := 60.0
		if v, ok := pr["daya_mva"].(float64); ok && v > 0 {
			mva = v
		}
		p = load.Point{Code: code, Kind: "trafo_gi", NodeID: &id, Name: name, RatingMVA: &mva, KV: kv, Active: true}
	default:
		a := s.d.Configs.Float("ops.feeder_capacity_a", 400)
		if v, ok := pr["arus_nominal_a"].(float64); ok && v > 0 {
			a = v
		}
		p = load.Point{Code: code, Kind: "feeder", NodeID: &id, Name: name, RatingA: &a, KV: kv, Active: true}
	}
	pid, err := s.d.Load.Repo.UpsertPoint(ctx, p)
	if err != nil {
		return load.Point{}, false
	}
	p.ID = pid
	s.invalidateLossTopo()
	log.Printf("[load] titik baru terdaftar otomatis: %s (%s)", code, p.Kind)
	return p, true
}

// syncHierarchy mengisi GI, trafo GI, UP3, ULP, UID tiap titik dari graf & batas wilayah.
func (s *Server) syncHierarchy(ctx context.Context) error {
	if !s.d.Graph.Ready() {
		return gis.ErrGraphLoading
	}
	ps, err := s.d.Load.Repo.Points(ctx)
	if err != nil {
		return err
	}
	_, feeders := s.d.Graph.PowerSummary()
	byHead := map[int64]gis.FeederStatus{}
	trafoGI := map[int64]int64{}
	for _, f := range feeders {
		byHead[f.Head] = f
		if f.TrafoGI != 0 && f.GI != 0 {
			trafoGI[f.TrafoGI] = f.GI
		}
	}
	hs := make([]load.Hierarchy, 0, len(ps))
	giIDs := []int64{}
	for _, p := range ps {
		h := load.Hierarchy{ID: p.ID}
		if p.NodeID != nil {
			switch p.Kind {
			case "feeder", "gd":
				head := *p.NodeID
				if p.Kind == "gd" {
					head = s.d.Graph.NodeInfo(*p.NodeID).Feeder
					if head == 0 && p.FeederID != nil {
						head = *p.FeederID // gardu sedang padam / tak terhubung: pertahankan pemasok terakhir
					}
				}
				if head != 0 {
					hh := head
					h.FeederID = &hh
				}
				if f, ok := byHead[head]; ok {
					if f.GI != 0 {
						g := f.GI
						h.GIID = &g
					}
					if f.TrafoGI != 0 {
						t := f.TrafoGI
						h.TrafoGIID = &t
					}
				}
			case "trafo_gi":
				t := *p.NodeID
				h.TrafoGIID = &t
				if g, ok := trafoGI[t]; ok {
					h.GIID = &g
				}
			}
		}
		if h.GIID != nil {
			giIDs = append(giIDs, *h.GIID)
		}
		hs = append(hs, h)
	}
	defUID := s.d.Configs.Str("load.default_uid", "JAKARTA RAYA")
	regs, err := s.d.Load.Repo.NodeRegions(ctx, giIDs, defUID)
	if err != nil {
		return err
	}
	// wilayah: dari unit pemilik aset (master data unit; ditetapkan atau otomatis dari lokasi),
	// cadangan: poligon wilayah tempat GI berada
	nodeIDs := []int64{}
	nodeOf := map[int]int64{}
	for _, p := range ps {
		if p.NodeID != nil {
			nodeIDs = append(nodeIDs, *p.NodeID)
			nodeOf[p.ID] = *p.NodeID
		}
	}
	var owner map[int64]int
	var units map[int]gis.Unit
	if s.d.Units != nil {
		owner, _ = s.d.Units.NodeUnits(ctx, nodeIDs)
		units, _ = s.d.Units.All(ctx)
	}
	for i := range hs {
		hs[i].UID = defUID
		if hs[i].GIID != nil {
			if r, ok := regs[*hs[i].GIID]; ok {
				hs[i].UP3, hs[i].ULP, hs[i].UID = r[0], r[1], r[2]
			}
		}
		if u, ok := owner[nodeOf[hs[i].ID]]; ok && units != nil {
			uid, up3, ulp := gis.UnitNames(units, u)
			if uid != "" || up3 != "" || ulp != "" {
				uu := u
				hs[i].UnitID = &uu
				hs[i].UP3, hs[i].ULP = up3, ulp
				if uid != "" {
					hs[i].UID = uid
				}
			}
		}
	}
	if err := s.d.Load.Repo.SetHierarchy(ctx, hs); err != nil {
		return err
	}
	s.d.Load.mu.Lock()
	s.d.Load.lastSync = time.Now()
	s.d.Load.topo = nil
	s.d.Load.mu.Unlock()
	s.d.Load.Ing.InvalidatePoints()
	return nil
}

// ------------------------------------------------------------------ kalibrasi simulasi / FLISR

// loadCalibration: faktor beban & kapasitas per kepala penyulang dari beban ukur 7 hari terakhir.
func (s *Server) loadCalibration(ctx context.Context) calibration {
	ls := s.d.Load
	if ls == nil {
		return calibration{}
	}
	ls.mu.Lock()
	if time.Since(ls.calibAt) < 30*time.Minute && ls.calib.scale != nil {
		c := ls.calib
		ls.mu.Unlock()
		return c
	}
	ls.mu.Unlock()
	c := calibration{scale: map[int64]float64{}, caps: map[int64]float64{}, rows: []calibRow{}}
	ps, err := ls.Repo.Points(ctx)
	if err != nil {
		return c
	}
	now := time.Now()
	stats, _ := ls.Repo.PointStats(ctx, now.AddDate(0, 0, -7), now.AddDate(0, 0, 1), "feeder")
	_, feeders := s.d.Graph.PowerSummary()
	contract := map[int64]float64{}
	for _, f := range feeders {
		contract[f.Head] = f.LoadVA
	}
	for _, p := range ps {
		if p.Kind != "feeder" || p.NodeID == nil || !p.Active {
			continue
		}
		cap := p.CapMVA()
		if cap > 0 {
			c.caps[*p.NodeID] = cap * 1e6
		}
		st := stats[p.ID]
		cv := contract[*p.NodeID]
		row := calibRow{PointID: p.ID, Code: p.Code, Head: *p.NodeID, ContractVA: cv, CapMVA: cap}
		if st != nil && st.PeakMVA > 0 && cv > 0 {
			row.PeakMVA = st.PeakMVA
			row.Factor = math.Max(0.05, math.Min(3, st.PeakMVA*1e6/cv))
			c.scale[*p.NodeID] = row.Factor
		}
		c.rows = append(c.rows, row)
	}
	ls.mu.Lock()
	ls.calib, ls.calibAt = c, time.Now()
	ls.mu.Unlock()
	return c
}

// ------------------------------------------------------------------ pekerjaan terjadwal

func (s *Server) loadJobs(ctx context.Context) {
	ls := s.d.Load
	lastMissing, lastDaily := time.Time{}, ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
		}
		if !s.d.Graph.Ready() {
			continue
		}
		// awal: petakan otomatis & isi riwayat simulasi bila belum ada data
		s.loadBootstrap(ctx)
		ls.mu.Lock()
		needSync := time.Since(ls.lastSync) > 30*time.Minute
		ls.mu.Unlock()
		if needSync {
			if err := s.syncHierarchy(ctx); err != nil {
				log.Printf("[load] sinkron hierarki: %v", err)
			}
		}
		now := time.Now()
		if now.Sub(lastMissing) > 10*time.Minute {
			lastMissing = now
			if ps, err := ls.Repo.Points(ctx); err == nil {
				if _, err := ls.Det.DetectMissingLive(ctx, ps); err != nil {
					log.Printf("[load] cek data hilang: %v", err)
				}
			}
		}
		// harian (≥ 00:40 WIB): profil dasar, deteksi harian kemarin, laporan beban
		l := now.In(load.Loc)
		day := l.Format("2006-01-02")
		if day != lastDaily && (l.Hour() > 0 || l.Minute() >= 40) {
			lastDaily = day
			s.loadDaily(ctx, now)
		}
	}
}

func (s *Server) loadDaily(ctx context.Context, now time.Time) { s.loadDailyForce(ctx, now, false) }

// loadDailyForce: force = susun ulang laporan walau sudah ada (sesudah pengisian riwayat).
func (s *Server) loadDailyForce(ctx context.Context, now time.Time, force bool) {
	ls := s.d.Load
	st := s.loadSettings()
	if err := ls.Repo.RefreshBaseline(ctx, now, st.HolidayList()); err != nil {
		log.Printf("[load] profil dasar: %v", err)
	}
	l := now.In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	if ps, err := ls.Repo.Points(ctx); err == nil {
		if _, err := ls.Det.DetectDaily(ctx, ps, today.AddDate(0, 0, -1), today, s.maneuverRefs(ctx, today.AddDate(0, 0, -1), today)); err != nil {
			log.Printf("[load] deteksi harian: %v", err)
		}
	}
	s.invalidateLossTopo()
	s.detectLosses(ctx, today.AddDate(0, 0, -1), today)
	for _, kind := range []string{"daily", "monthly", "yearly"} {
		// periode lengkap terakhir: periode yang memuat saat sebelum awal periode berjalan
		cur, _ := loadPeriodOf(kind, today)
		from, to := loadPeriodOf(kind, cur.Add(-time.Hour))
		if !to.After(today) && (force || !s.d.Exec.ReportExists(ctx, "load", kind, from)) {
			if _, err := s.generateLoadReport(ctx, kind, from, to, "system"); err != nil {
				log.Printf("[load] laporan %s: %v", kind, err)
			}
		}
	}
}

// loadBootstrap: sekali saat awal — petakan titik & isi riwayat simulasi bila tabel data kosong.
func (s *Server) loadBootstrap(ctx context.Context) {
	ls := s.d.Load
	ls.mu.Lock()
	if ls.bootstrap["done"] == true {
		ls.mu.Unlock()
		return
	}
	ls.bootstrap["done"] = true
	ls.mu.Unlock()
	ps, err := ls.Repo.Points(ctx)
	if err != nil {
		return
	}
	if len(ps) == 0 {
		n, err := s.autoMapPoints(ctx)
		log.Printf("[load] pemetaan otomatis: %d titik (%v)", n, err)
	} else {
		_ = s.syncHierarchy(ctx)
	}
	// simulator: gardu bermeter (AMR) pada penyulang nyata + sebagian penyulang simulasi massal
	hasGD := false
	for _, p := range ps {
		if p.Kind == "gd" {
			hasGD = true
			break
		}
	}
	if !hasGD && s.d.Configs.Bool("load.simulator", true) {
		n, err := s.autoMapGD(ctx, s.d.Configs.Int("load.sim_gd_feeders", 15))
		log.Printf("[load] pemetaan gardu simulasi: %d titik (%v)", n, err)
	}
	// riwayat dianggap belum ada bila tidak ada data lebih tua dari 2 hari (data live dari simulator
	// bisa sudah masuk lebih dulu lewat Kafka)
	var rows int64
	_ = s.d.Pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM load_30m WHERE ts < now() - interval '2 days' LIMIT 1) x`).Scan(&rows)
	if rows > 0 || !s.d.Configs.Bool("load.simulator", true) {
		return
	}
	go func() {
		if err := s.backfillSim(context.Background(), 400, 35); err != nil {
			log.Printf("[load] isi riwayat simulasi: %v", err)
		}
	}()
}

// backfillSim mengisi riwayat simulasi: titik nyata `realDays` hari, titik simulasi massal `bulkDays` hari.
func (s *Server) backfillSim(ctx context.Context, realDays, bulkDays int) error {
	ls := s.d.Load
	ps, err := ls.Repo.Points(ctx)
	if err != nil {
		return err
	}
	bulk := map[int64]bool{}
	ids := []int64{}
	for _, p := range ps {
		if p.NodeID != nil {
			ids = append(ids, *p.NodeID)
		}
	}
	if rows, err := s.d.Pool.Query(ctx, `SELECT id FROM gis_nodes WHERE id = ANY($1) AND properties ? 'bulk'`, ids); err == nil {
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				bulk[id] = true
			}
		}
		rows.Close()
	}
	// gardu mengikuti kelompok penyulang pemasoknya (neraca energi dihitung per slot bersama penyulang)
	feederBulk := map[int64]bool{}
	for _, p := range ps {
		if p.Kind == "feeder" && p.NodeID != nil {
			feederBulk[*p.NodeID] = bulk[*p.NodeID]
		}
	}
	real, mass := []load.Point{}, []load.Point{}
	for _, p := range ps {
		isBulk := p.NodeID != nil && bulk[*p.NodeID]
		if p.Kind == "gd" && p.FeederID != nil {
			isBulk = feederBulk[*p.FeederID]
		}
		if isBulk {
			mass = append(mass, p)
		} else {
			real = append(real, p)
		}
	}
	to := time.Now().Truncate(30 * time.Minute) // eksklusif: slot lengkap terakhir ikut terisi
	start := time.Now()
	for _, grp := range []struct {
		pts  []load.Point
		days int
	}{{real, realDays}, {mass, bulkDays}} {
		if len(grp.pts) == 0 || grp.days <= 0 {
			continue
		}
		from := time.Date(to.In(load.Loc).Year(), to.In(load.Loc).Month(), to.In(load.Loc).Day(), 0, 0, 0, 0, load.Loc).AddDate(0, 0, -grp.days)
		log.Printf("[load] isi riwayat simulasi %d titik, %d hari", len(grp.pts), grp.days)
		if err := ls.Sim.Backfill(ctx, grp.pts, from, to); err != nil {
			return err
		}
	}
	log.Printf("[load] riwayat simulasi selesai (%s)", time.Since(start).Round(time.Second))
	// laporan beban untuk periode lengkap terakhir (disusun ulang dari data baru)
	s.loadDailyForce(ctx, time.Now(), true)
	return nil
}

func loadPeriodOf(kind string, d time.Time) (time.Time, time.Time) {
	l := d.In(load.Loc)
	switch kind {
	case "yearly":
		f := time.Date(l.Year(), 1, 1, 0, 0, 0, 0, load.Loc)
		return f, f.AddDate(1, 0, 0)
	case "monthly":
		f := time.Date(l.Year(), l.Month(), 1, 0, 0, 0, 0, load.Loc)
		return f, f.AddDate(0, 1, 0)
	}
	f := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	return f, f.AddDate(0, 0, 1)
}

func loadReportTitle(kind string, from time.Time) string {
	f := from.In(load.Loc)
	switch kind {
	case "yearly":
		return "Laporan Beban Tahunan " + strconv.Itoa(f.Year())
	case "monthly":
		return fmt.Sprintf("Laporan Beban Bulanan %s %d", monthsID[f.Month()-1], f.Year())
	}
	return fmt.Sprintf("Laporan Beban Harian %d %s %d", f.Day(), monthsID[f.Month()-1], f.Year())
}
