package gis

import (
	"errors"
	"sort"
)

// =====================================================================
// FLISR (Fault Location, Isolation & Service Restoration), mode penasihat:
// dari lokasi gangguan (dipilih operator atau kandidat seksi), sistem menyusun
// urutan manuver: isolasi seksi terganggu, pulihkan hulu (tutup alat yang trip),
// dan pulihkan hilir lewat tie normally-open dengan cek kapasitas penyulang
// pendukung. Hasilnya berupa rencana manuver yang disimulasikan, belum dieksekusi.
// =====================================================================

var (
	ErrFlisrSource   = errors.New("gangguan di sisi sumber / gardu induk: di luar cakupan FLISR penyulang")
	ErrFlisrNoSwitch = errors.New("tidak ada alat switching untuk mengisolasi seksi ini")
)

// FlisrTie adalah kandidat tie untuk memulihkan satu pulau hilir.
type FlisrTie struct {
	SwitchID   int64   `json:"switch_id"`
	WayEdge    int64   `json:"way_edge_id,omitempty"`
	Supporting int64   `json:"supporting"` // kepala penyulang pendukung
	LoadBefore float64 `json:"load_before_va"`
	LoadAfter  float64 `json:"load_after_va"`
	CapacityVA float64 `json:"capacity_va"`
	PctAfter   float64 `json:"pct_after"`
}

// FlisrIsland adalah bagian hilir seksi terganggu yang bisa dipulihkan dari penyulang lain.
type FlisrIsland struct {
	Boundary     int64      `json:"boundary"` // switch batas hilir seksi terganggu
	Customers    int        `json:"customers"`
	LoadVA       float64    `json:"load_va"` // daya kontrak
	Nodes        int        `json:"nodes"`
	Tie          *FlisrTie  `json:"tie"`
	Alternatives []FlisrTie `json:"alternatives"`
	Reason       string     `json:"reason,omitempty"` // no_tie | over_capacity | energized
}

// FlisrResult adalah hasil analisis FLISR.
type FlisrResult struct {
	FaultKind        string        `json:"fault_kind"`
	FaultID          int64         `json:"fault_id"`
	SectionNodes     []int64       `json:"section_nodes"` // dibatasi
	SectionEdges     []int64       `json:"section_edges"`
	SectionCustomers int           `json:"section_customers"`
	SectionLengthM   float64       `json:"section_length_m"`
	Upstream         int64         `json:"upstream"` // switch isolasi hulu
	Tripped          int64         `json:"tripped"`  // alat yang trip (ditutup kembali), 0 = tidak ada
	Downstream       []int64       `json:"downstream"`
	Islands          []FlisrIsland `json:"islands"`
	Actions          []SimAction   `json:"actions"`
	Sim              *SimResult    `json:"sim"`
	Warnings         []string      `json:"warnings"`
}

// upstreamPathLocked: jalur topologi normal dari node ke sumber.
func (g *Graph) upstreamPathLocked(ndist map[int64]int32, from int64) []int64 {
	path := []int64{from}
	cur := from
	for guard := 0; guard < 100000; guard++ {
		d0, ok := ndist[cur]
		if !ok || d0 == 0 {
			break
		}
		next := int64(0)
		for _, eid := range g.adj[cur] {
			if wayOpen(g.normalOpenWays, cur, eid) {
				continue
			}
			nb := g.edges[eid].other(cur)
			if wayOpen(g.normalOpenWays, nb, eid) {
				continue
			}
			if dn, ok := ndist[nb]; ok && dn == d0-1 && !(g.nodes[nb].flags&flagNormalOpen != 0 && dn != 0) {
				if next == 0 || nb < next {
					next = nb
				}
			}
		}
		if next == 0 {
			break
		}
		path = append(path, next)
		cur = next
	}
	return path
}

// faultSectionLocked: seksi (dibatasi alat switching) yang memuat elemen gangguan.
func (g *Graph) faultSectionLocked(faultKind string, faultID int64) (section map[int64]struct{}, edges []int64, bounds []int64, err error) {
	section = map[int64]struct{}{}
	bset := map[int64]struct{}{}
	queue := []int64{}
	visitStart := func(id int64, asInterior bool) {
		n, ok := g.nodes[id]
		if !ok {
			return
		}
		if n.isSwitch() && !asInterior {
			bset[id] = struct{}{}
			return
		}
		if _, in := section[id]; !in {
			section[id] = struct{}{}
			queue = append(queue, id)
		}
	}
	edgeSet := map[int64]struct{}{}
	if faultKind == "edge" {
		e, ok := g.edges[faultID]
		if !ok {
			return nil, nil, nil, ErrNotFound
		}
		edgeSet[faultID] = struct{}{}
		visitStart(e.from, false)
		visitStart(e.to, false)
	} else {
		if _, ok := g.nodes[faultID]; !ok {
			return nil, nil, nil, ErrNotFound
		}
		visitStart(faultID, true)
	}
	for i := 0; i < len(queue) && len(section) < 200000; i++ {
		cur := queue[i]
		if g.nodes[cur].source() {
			return nil, nil, nil, ErrFlisrSource
		}
		if g.nodes[cur].isSwitch() && cur != faultID {
			continue
		}
		for _, eid := range g.adj[cur] {
			edgeSet[eid] = struct{}{}
			nb := g.edges[eid].other(cur)
			if _, in := section[nb]; in {
				continue
			}
			if _, in := bset[nb]; in {
				continue
			}
			nn := g.nodes[nb]
			if nn.source() {
				return nil, nil, nil, ErrFlisrSource
			}
			if nn.isSwitch() {
				bset[nb] = struct{}{}
				continue
			}
			section[nb] = struct{}{}
			queue = append(queue, nb)
		}
	}
	for e := range edgeSet {
		edges = append(edges, e)
	}
	for b := range bset {
		bounds = append(bounds, b)
	}
	sort.Slice(bounds, func(i, j int) bool { return bounds[i] < bounds[j] })
	return section, edges, bounds, nil
}

// FLISR menganalisis gangguan pada elemen (node / saluran) dan menyusun rencana manuver.
func (g *Graph) FLISR(faultKind string, faultID int64, p SimParams, limit int) (*FlisrResult, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.loading || len(g.nodes) == 0 {
		return nil, ErrGraphLoading
	}
	ndist, _ := g.normalDistLocked()
	section, secEdges, bounds, err := g.faultSectionLocked(faultKind, faultID)
	if err != nil {
		return nil, err
	}
	res := &FlisrResult{FaultKind: faultKind, FaultID: faultID, Warnings: []string{}, Islands: []FlisrIsland{}, Downstream: []int64{}}
	// penyulang asal seksi gangguan (untuk faktor beban terkalibrasi)
	faultHead := int64(0)
	for id := range section {
		for _, h := range g.upstreamPathLocked(ndist, id) {
			if _, ok := g.feeders[h]; ok {
				faultHead = h
				break
			}
		}
		break
	}
	for id := range section {
		n := g.nodes[id]
		if n.sink() {
			res.SectionCustomers += g.custLocked(id, n)
		}
		if len(res.SectionNodes) < 3000 {
			res.SectionNodes = append(res.SectionNodes, id)
		}
	}
	for _, eid := range secEdges {
		e := g.edges[eid]
		_, a := section[e.from]
		_, b := section[e.to]
		if a || b || eid == faultID {
			res.SectionLengthM += float64(e.lengthM)
			if len(res.SectionEdges) < 3000 {
				res.SectionEdges = append(res.SectionEdges, eid)
			}
		}
	}
	if len(bounds) == 0 {
		return nil, ErrFlisrNoSwitch
	}
	// hulu = batas dengan jarak normal terkecil
	up := int64(0)
	for _, b := range bounds {
		if d, ok := ndist[b]; ok && (up == 0 || d < ndist[up]) {
			up = b
		}
	}
	if up == 0 {
		up = bounds[0]
	}
	res.Upstream = up
	actions := []SimAction{}
	st := newSimState()
	add := func(a SimAction) {
		actions = append(actions, a)
		g.applySimAction(st, a)
	}
	// 1) isolasi: buka batas hulu & hilir yang masih tertutup
	if !g.nodes[up].open() {
		add(SimAction{TargetKind: "node", TargetID: up, Action: "open", Note: "isolasi hulu"})
	}
	for _, b := range bounds {
		if b == up {
			continue
		}
		res.Downstream = append(res.Downstream, b)
		if !g.nodes[b].open() {
			add(SimAction{TargetKind: "node", TargetID: b, Action: "open", Note: "isolasi hilir"})
		}
	}
	// 2) pulihkan hulu: tutup alat yang trip (switch terbuka pertama di jalur hulu, selain batas hulu)
	path := g.upstreamPathLocked(ndist, up)
	for _, id := range path[1:] {
		n := g.nodes[id]
		if n.isSwitch() && n.open() && n.flags&flagNormalOpen == 0 {
			res.Tripped = id
			add(SimAction{TargetKind: "node", TargetID: id, Action: "close", Note: "pulihkan hulu"})
			break
		}
	}
	// 3) pulihkan hilir lewat tie
	seeds := append([]int64{}, bounds...)
	seeds = append(seeds, path...)
	for id := range section {
		seeds = append(seeds, id)
		break
	}
	region := g.regionLocked(seeds)
	on := g.simEnergizeLocked(region, st)
	loads, _, _ := g.simLoads(region, on, p)
	extra := map[int64]float64{} // beban tambahan per penyulang pendukung dari pulau yang sudah dipilih
	for _, b := range res.Downstream {
		isl := FlisrIsland{Boundary: b, Alternatives: []FlisrTie{}}
		// sisi luar batas: tetangga yang tidak di seksi terganggu
		start := int64(0)
		for _, eid := range g.adj[b] {
			nb := g.edges[eid].other(b)
			if _, in := section[nb]; !in {
				start = nb
				break
			}
		}
		if start == 0 {
			continue
		}
		if _, isOn := on[start]; isOn {
			isl.Reason = "energized" // sudah dipasok penyulang lain (mis. tie normally-open)
			res.Islands = append(res.Islands, isl)
			continue
		}
		seen := map[int64]struct{}{start: {}, b: {}}
		for id := range section {
			seen[id] = struct{}{}
		}
		q := []int64{start}
		cands := map[string]FlisrTie{}
		for i := 0; i < len(q) && i < 300000; i++ {
			cur := q[i]
			cn := g.nodes[cur]
			if cn.sink() {
				isl.Customers += g.custLocked(cur, cn)
				isl.LoadVA += float64(cn.loadVA)
			}
			isl.Nodes++
			curOpen := g.simNodeOpen(st, cur) && cur != start
			for _, eid := range g.adj[cur] {
				nb := g.edges[eid].other(cur)
				if _, s := seen[nb]; s {
					continue
				}
				wayCur := g.simWayOpen(st, cur, eid)
				wayNb := g.simWayOpen(st, nb, eid)
				nbOpenSwitch := g.nodes[nb].isSwitch() && g.simNodeOpen(st, nb)
				if lab, nbOn := on[nb]; nbOn && lab != 0 {
					// sisi lain bertegangan: kandidat tie = switch/arah terbuka di antaranya
					switch {
					case nbOpenSwitch:
						cands[key2(nb, 0)] = FlisrTie{SwitchID: nb, Supporting: lab}
					case curOpen && cn.isSwitch():
						cands[key2(cur, 0)] = FlisrTie{SwitchID: cur, Supporting: lab}
					case wayCur:
						cands[key2(cur, eid)] = FlisrTie{SwitchID: cur, WayEdge: eid, Supporting: lab}
					case wayNb:
						cands[key2(nb, eid)] = FlisrTie{SwitchID: nb, WayEdge: eid, Supporting: lab}
					}
					continue
				}
				if curOpen || nbOpenSwitch || g.simEdgeOpen(st, eid) || wayCur || wayNb {
					continue // switch terbuka yang sisi seberangnya juga padam: bukan tie
				}
				if g.simBlocked(st, nb) {
					continue
				}
				seen[nb] = struct{}{}
				q = append(q, nb)
				if nn := g.nodes[nb]; nn.isSwitch() && g.simNodeOpen(st, nb) {
					// switch terbuka di dalam pulau: periksa sisi seberangnya pada iterasi berikut
					continue
				}
			}
		}
		islandLoad := isl.LoadVA * p.lf(faultHead)
		for _, c := range cands {
			base := 0.0
			if l := loads[c.Supporting]; l != nil {
				base = l.LoadVA
			}
			base += extra[c.Supporting]
			c.LoadBefore = base
			c.LoadAfter = base + islandLoad
			c.CapacityVA = p.capOf(c.Supporting)
			if c.CapacityVA > 0 {
				c.PctAfter = float64(int(c.LoadAfter/c.CapacityVA*1000)) / 10
			}
			isl.Alternatives = append(isl.Alternatives, c)
		}
		sort.Slice(isl.Alternatives, func(i, j int) bool { return isl.Alternatives[i].PctAfter < isl.Alternatives[j].PctAfter })
		switch {
		case isl.Customers == 0 && isl.Nodes <= 1:
			continue
		case len(isl.Alternatives) == 0:
			isl.Reason = "no_tie"
		case isl.Alternatives[0].PctAfter > 100:
			isl.Reason = "over_capacity"
		default:
			best := isl.Alternatives[0]
			isl.Tie = &best
			extra[best.Supporting] += islandLoad
			note := "pulihkan hilir lewat tie"
			if best.WayEdge != 0 {
				add(SimAction{TargetKind: "node", TargetID: best.SwitchID, WayEdge: best.WayEdge, Action: "close", Note: note})
			} else {
				add(SimAction{TargetKind: "node", TargetID: best.SwitchID, Action: "close", Note: note})
			}
		}
		if len(isl.Alternatives) > 4 {
			isl.Alternatives = isl.Alternatives[:4]
		}
		res.Islands = append(res.Islands, isl)
	}
	res.Actions = actions
	if len(actions) == 0 {
		res.Warnings = append(res.Warnings, "already_isolated")
		return res, nil
	}
	sim, err := g.simulateLocked(actions, newSimState(), p, limit)
	if err != nil {
		return nil, err
	}
	res.Sim = sim
	return res, nil
}

func key2(a, b int64) string {
	return itoa(a) + ":" + itoa(b)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [24]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// FaultSection adalah kandidat seksi gangguan di area padam.
type FaultSection struct {
	ID         int64   `json:"id"`    // node perwakilan (dipakai sebagai lokasi gangguan)
	Entry      int64   `json:"entry"` // switch tempat masuk seksi dari hulu (0 = langsung dari alat penyebab)
	Depth      int     `json:"depth"`
	Nodes      int     `json:"nodes"`
	Customers  int     `json:"customers"`
	LengthM    float64 `json:"length_m"`
	Boundaries []int64 `json:"boundaries"`
	NodeIDs    []int64 `json:"-"`
}

// OutageSections membagi area padam di hilir alat penyebab menjadi seksi-seksi (dibatasi switch)
// sebagai kandidat lokasi gangguan, urut dari hulu.
func (g *Graph) OutageSections(causeKind string, causeID int64, max int) ([]FaultSection, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.loading {
		return nil, ErrGraphLoading
	}
	starts := []int64{}
	if causeKind == "edge" {
		e, ok := g.edges[causeID]
		if !ok {
			return nil, ErrNotFound
		}
		starts = append(starts, e.from, e.to)
	} else {
		if _, ok := g.nodes[causeID]; !ok {
			return nil, ErrNotFound
		}
		starts = append(starts, causeID)
	}
	visited := map[int64]struct{}{}
	type seed struct {
		id    int64
		depth int
		entry int64
	}
	var queue []seed
	for _, s := range starts {
		visited[s] = struct{}{}
		for _, eid := range g.adj[s] {
			nb := g.edges[eid].other(s)
			if !g.nodes[nb].energized() {
				queue = append(queue, seed{nb, 0, 0})
			}
		}
	}
	out := []FaultSection{}
	for qi := 0; qi < len(queue) && len(out) < max; qi++ {
		sd := queue[qi]
		if _, v := visited[sd.id]; v {
			continue
		}
		n := g.nodes[sd.id]
		if n.isSwitch() {
			// lewati switch: lanjutkan ke sisi seberang yang padam
			visited[sd.id] = struct{}{}
			for _, eid := range g.adj[sd.id] {
				nb := g.edges[eid].other(sd.id)
				if _, v := visited[nb]; !v && !g.nodes[nb].energized() {
					queue = append(queue, seed{nb, sd.depth + 1, sd.id})
				}
			}
			continue
		}
		sec := FaultSection{ID: sd.id, Depth: sd.depth, Entry: sd.entry}
		bset := map[int64]struct{}{}
		q := []int64{sd.id}
		visited[sd.id] = struct{}{}
		edges := map[int64]struct{}{}
		for i := 0; i < len(q); i++ {
			cur := q[i]
			cn := g.nodes[cur]
			sec.Nodes++
			if cn.sink() {
				sec.Customers += g.custLocked(cur, cn)
			}
			if len(sec.NodeIDs) < 20000 {
				sec.NodeIDs = append(sec.NodeIDs, cur)
			}
			for _, eid := range g.adj[cur] {
				nb := g.edges[eid].other(cur)
				nn := g.nodes[nb]
				if nn.energized() {
					continue
				}
				if _, dup := edges[eid]; !dup {
					edges[eid] = struct{}{}
					sec.LengthM += float64(g.edges[eid].lengthM)
				}
				if _, v := visited[nb]; v {
					continue
				}
				if nn.isSwitch() {
					if _, b := bset[nb]; !b {
						bset[nb] = struct{}{}
						sec.Boundaries = append(sec.Boundaries, nb)
						queue = append(queue, seed{nb, sd.depth + 1, 0})
					}
					continue
				}
				visited[nb] = struct{}{}
				q = append(q, nb)
			}
		}
		out = append(out, sec)
	}
	return out, nil
}

// ReportSuspect adalah dugaan lokasi gangguan dari sekelompok laporan pelanggan.
type ReportSuspect struct {
	NodeID      int64   `json:"node_id"`
	Level       string  `json:"level"` // pelanggan | jurusan | trafo_gd | gardu_distribusi | zona | penyulang
	Reported    int     `json:"reported"`
	Customers   int     `json:"customers"` // pelanggan di hilir dugaan
	Ratio       float64 `json:"ratio"`
	Energized   bool    `json:"energized"`
	CustomerIDs []int64 `json:"customer_ids"`
}

// SuspectFromCustomers mencari titik bersama terdekat (LCA di topologi normal) dari pelanggan
// yang melapor, lalu naik ke peralatan terdekat sebagai dugaan lokasi gangguan.
func (g *Graph) SuspectFromCustomers(ids []int64) (*ReportSuspect, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.loading {
		return nil, ErrGraphLoading
	}
	ndist, _ := g.normalDistLocked()
	valid := []int64{}
	for _, id := range ids {
		if _, ok := g.nodes[id]; ok {
			valid = append(valid, id)
		}
	}
	if len(valid) == 0 {
		return nil, ErrNotFound
	}
	paths := make([][]int64, len(valid))
	count := map[int64]int{}
	for i, id := range valid {
		paths[i] = g.upstreamPathLocked(ndist, id)
		seen := map[int64]struct{}{}
		for _, n := range paths[i] {
			if _, d := seen[n]; !d {
				seen[n] = struct{}{}
				count[n]++
			}
		}
	}
	lca := valid[0]
	for _, n := range paths[0] {
		if count[n] == len(valid) {
			lca = n
			break
		}
	}
	// naik ke peralatan yang bermakna
	suspect := lca
	if len(valid) > 1 || !g.nodes[lca].sink() {
		for _, n := range g.upstreamPathLocked(ndist, lca) {
			typ := g.typeNames[g.nodes[n].typ]
			if g.nodes[n].isSwitch() || typ == "trafo_distribusi" || typ == "rak_tr" || typ == "gd" {
				suspect = n
				break
			}
		}
	}
	sn := g.nodes[suspect]
	typ := g.typeNames[sn.typ]
	level := "zona"
	switch {
	case sn.sink():
		level = "pelanggan"
	case typ == "switch_jurusan_tr":
		level = "jurusan"
	case typ == "rak_tr" || typ == "trafo_distribusi" || (typ == "fco" && sn.gd != 0):
		level = "trafo_gd"
	case typ == "gd":
		level = "gardu_distribusi"
	default:
		if _, head := g.feeders[suspect]; head {
			level = "penyulang"
		}
	}
	// pelanggan di hilir dugaan (topologi normal, dibatasi)
	total := 0
	if sn.sink() {
		total = g.custLocked(suspect, sn)
	} else {
		d0 := ndist[suspect]
		q := []int64{suspect}
		seen := map[int64]struct{}{suspect: {}}
		for i := 0; i < len(q) && i < 200000; i++ {
			cur := q[i]
			if cn := g.nodes[cur]; cn.sink() {
				total += g.custLocked(cur, cn)
			}
			dc := ndist[cur]
			for _, eid := range g.adj[cur] {
				nb := g.edges[eid].other(cur)
				if _, s := seen[nb]; s {
					continue
				}
				if dn, ok := ndist[nb]; ok && dn == dc+1 && dn > d0 {
					seen[nb] = struct{}{}
					q = append(q, nb)
				}
			}
		}
	}
	r := &ReportSuspect{NodeID: suspect, Level: level, Reported: len(valid), Customers: total, Energized: sn.energized(), CustomerIDs: valid}
	if total > 0 {
		r.Ratio = float64(int(float64(len(valid))/float64(total)*1000)) / 10
	}
	return r, nil
}

// StillOffByIsolator mengelompokkan node yang masih padam menurut switch terbuka terdekat di hulunya
// (topologi normal). Dipakai untuk mencatat sisa padam setelah pemulihan sebagian.
func (g *Graph) StillOffByIsolator(ids []int64) map[int64][]int64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := map[int64][]int64{}
	off := []int64{}
	for _, id := range ids {
		if n, ok := g.nodes[id]; ok && !n.energized() {
			off = append(off, id)
		}
	}
	if len(off) == 0 {
		return out
	}
	ndist, _ := g.normalDistLocked()
	cache := map[int64]int64{}
	for _, id := range off {
		iso := int64(0)
		for _, n := range g.upstreamPathLocked(ndist, id) {
			if v, ok := cache[n]; ok {
				iso = v
				break
			}
			nn := g.nodes[n]
			if n != id && nn.isSwitch() && nn.open() {
				iso = n
				break
			}
			if n != id && !nn.isSwitch() && nn.open() {
				iso = n // objek non-switch yang diputus
				break
			}
		}
		cache[id] = iso
		out[iso] = append(out[iso], id)
	}
	return out
}
