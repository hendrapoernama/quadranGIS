package gis

import (
	"errors"
	"math"
	"sort"
)

// =====================================================================
// Simulasi what-if: menghitung status nyala/padam untuk serangkaian manuver hipotetis
// TANPA mengubah jaringan. Agar cepat pada jutaan node, perhitungan dibatasi pada
// "wilayah" = penyulang objek yang dimanuver + penyulang tetangganya lewat tie
// (sampai 2 lapis) + area gardu induk bila objek berada di sisi sumber. Node di luar
// wilayah memakai status saat ini sebagai pemasok batas.
// =====================================================================

// SimAction adalah satu langkah manuver hipotetis.
type SimAction struct {
	TargetKind string `json:"target_kind"` // node | edge
	TargetID   int64  `json:"target_id"`
	Action     string `json:"action"` // open | close
	WayEdge    int64  `json:"way_edge_id,omitempty"`
	Note       string `json:"note,omitempty"`
}

// SimParams adalah parameter cek beban penyulang.
type SimParams struct {
	CapacityVA float64 `json:"capacity_va"` // kapasitas penyulang (VA)
	LoadFactor float64 `json:"load_factor"` // beban = daya kontrak x faktor ini
	// kalibrasi dari data beban SCADA (opsional): faktor beban & kapasitas per kepala penyulang
	Scale map[int64]float64 `json:"-"`
	Caps  map[int64]float64 `json:"-"`
}

// lf: faktor beban penyulang (kalibrasi SCADA bila ada).
func (p SimParams) lf(head int64) float64 {
	if v, ok := p.Scale[head]; ok && v > 0 {
		return v
	}
	return p.LoadFactor
}

// capOf: kapasitas penyulang (rating kubikel bila ada).
func (p SimParams) capOf(head int64) float64 {
	if v, ok := p.Caps[head]; ok && v > 0 {
		return v
	}
	return p.CapacityVA
}

// SimFeederLoad adalah beban satu penyulang pemasok setelah suatu langkah.
type SimFeederLoad struct {
	Head       int64   `json:"head"`
	LoadVA     float64 `json:"load_va"` // beban (sudah dikali faktor beban)
	CapacityVA float64 `json:"capacity_va"`
	Pct        float64 `json:"pct"`
	Customers  int     `json:"customers"`
}

// SimWarning adalah peringatan simulasi (kode + parameter untuk teks di klien).
type SimWarning struct {
	Code    string  `json:"code"` // parallel | overload | high_load | no_change | not_found | not_switch_way | source_side
	Feeders []int64 `json:"feeders,omitempty"`
	Pct     float64 `json:"pct,omitempty"`
}

// SimStep adalah hasil satu langkah (kumulatif sampai langkah itu).
type SimStep struct {
	Seq           int             `json:"seq"`
	Action        SimAction       `json:"action"`
	TypeCode      string          `json:"type_code"`
	Valid         bool            `json:"valid"`
	CustomersOff  int             `json:"customers_off"`  // pelanggan padam di wilayah setelah langkah
	CustomersDiff int             `json:"customers_diff"` // + = bertambah padam, - = pulih (dibanding langkah sebelumnya)
	LoadOffVA     float64         `json:"load_off_va"`
	Feeders       []SimFeederLoad `json:"feeders"`
	Warnings      []SimWarning    `json:"warnings"`
}

// SimResult adalah hasil simulasi seluruh langkah.
type SimResult struct {
	RegionNodes       int             `json:"region_nodes"`
	BaseCustomersOff  int             `json:"base_customers_off"`
	CustomersOffAfter int             `json:"customers_off_after"`
	CustomersRestored int             `json:"customers_restored"` // padam sekarang → nyala
	CustomersNewOff   int             `json:"customers_new_off"`  // nyala sekarang → padam
	LoadRestoredVA    float64         `json:"load_restored_va"`   // daya kontrak
	LoadNewOffVA      float64         `json:"load_new_off_va"`    // daya kontrak
	Steps             []SimStep       `json:"steps"`
	NodesOn           []int64         `json:"nodes_on"`  // padam sekarang → nyala (dibatasi)
	NodesOff          []int64         `json:"nodes_off"` // nyala sekarang → padam (dibatasi)
	EdgesOn           []int64         `json:"edges_on"`
	EdgesOff          []int64         `json:"edges_off"`
	StillOffEdges     []int64         `json:"still_off_edges"` // tetap padam (dibatasi)
	BaseFeeders       []SimFeederLoad `json:"base_feeders"`
}

var ErrSimEmpty = errors.New("simulasi: tidak ada langkah")

// simState menyimpan posisi hipotetis yang menimpa posisi saat ini.
type simState struct {
	node map[int64]bool
	edge map[int64]bool
	way  map[int64]map[int64]bool
}

func newSimState() *simState {
	return &simState{node: map[int64]bool{}, edge: map[int64]bool{}, way: map[int64]map[int64]bool{}}
}

func (st *simState) clone() *simState {
	c := newSimState()
	for k, v := range st.node {
		c.node[k] = v
	}
	for k, v := range st.edge {
		c.edge[k] = v
	}
	for k, m := range st.way {
		c.way[k] = map[int64]bool{}
		for e, v := range m {
			c.way[k][e] = v
		}
	}
	return c
}

func (g *Graph) simNodeOpen(st *simState, id int64) bool {
	if v, ok := st.node[id]; ok {
		return v
	}
	return g.nodes[id].open()
}

func (g *Graph) simEdgeOpen(st *simState, eid int64) bool {
	if v, ok := st.edge[eid]; ok {
		return v
	}
	return g.edges[eid].open
}

func (g *Graph) simWayOpen(st *simState, node, eid int64) bool {
	if m := st.way[node]; m != nil {
		if v, ok := m[eid]; ok {
			return v
		}
	}
	return wayOpen(g.openWays, node, eid)
}

func (g *Graph) simPassable(st *simState, cur, eid int64) bool {
	e := g.edges[eid]
	return !g.simEdgeOpen(st, eid) && !g.simWayOpen(st, cur, eid) && !g.simWayOpen(st, e.other(cur), eid)
}

// simBlocked: node non-switch yang (disimulasikan) diputus.
func (g *Graph) simBlocked(st *simState, id int64) bool {
	return g.simNodeOpen(st, id) && !g.nodes[id].isSwitch()
}

// regionLocked mengumpulkan wilayah simulasi dari node-node pemicu. Harus dengan RLock.
func (g *Graph) regionLocked(seeds []int64) map[int64]struct{} {
	region := map[int64]struct{}{}
	feeders := map[int64]struct{}{}
	// sisi sumber (feeder = 0: GI, trafo GI, busbar, kubikel incoming): BFS terbatas di area itu
	zq := []int64{}
	for _, id := range seeds {
		n, ok := g.nodes[id]
		if !ok {
			continue
		}
		if n.feeder != 0 {
			feeders[n.feeder] = struct{}{}
			continue
		}
		if _, in := region[id]; !in {
			region[id] = struct{}{}
			zq = append(zq, id)
		}
	}
	for i := 0; i < len(zq) && len(region) < 50000; i++ {
		cur := zq[i]
		for _, eid := range g.adj[cur] {
			nb := g.edges[eid].other(cur)
			nn := g.nodes[nb]
			if nn.feeder != 0 {
				feeders[nn.feeder] = struct{}{}
				continue
			}
			if _, in := region[nb]; in {
				continue
			}
			region[nb] = struct{}{}
			zq = append(zq, nb)
		}
	}
	// anggota penyulang + penyulang tetangga lewat tie (2 lapis)
	done := map[int64]struct{}{}
	for round := 0; round <= 2 && len(feeders) > len(done); round++ {
		next := map[int64]struct{}{}
		for f := range feeders {
			if _, ok := done[f]; ok {
				continue
			}
			done[f] = struct{}{}
			if _, ok := g.nodes[f]; !ok {
				continue
			}
			q := []int64{f}
			region[f] = struct{}{}
			for i := 0; i < len(q) && len(region) < 400000; i++ {
				cur := q[i]
				for _, eid := range g.adj[cur] {
					nb := g.edges[eid].other(cur)
					nn := g.nodes[nb]
					if nn.feeder != f {
						if nn.feeder != 0 {
							if _, known := feeders[nn.feeder]; !known {
								next[nn.feeder] = struct{}{}
							}
						}
						continue
					}
					if _, in := region[nb]; in {
						continue
					}
					region[nb] = struct{}{}
					q = append(q, nb)
				}
			}
		}
		if round < 2 {
			for f := range next {
				feeders[f] = struct{}{}
			}
		}
	}
	return region
}

// simEnergizeLocked menghitung node yang bertegangan di wilayah untuk keadaan st.
// Mengembalikan node → label penyulang pemasok (kepala penyulang terakhir yang dilalui).
func (g *Graph) simEnergizeLocked(region map[int64]struct{}, st *simState) map[int64]int64 {
	on := make(map[int64]int64, len(region))
	queue := make([]int64, 0, 1024)
	labelFor := func(id, inherited int64) int64 {
		if _, head := g.feeders[id]; head {
			return id
		}
		return inherited
	}
	for id := range region {
		n := g.nodes[id]
		if g.simBlocked(st, id) {
			continue
		}
		if n.source() && !g.simNodeOpen(st, id) {
			on[id] = labelFor(id, id) // tanpa kepala penyulang: label = sumber
			queue = append(queue, id)
			continue
		}
		for _, eid := range g.adj[id] {
			v := g.edges[eid].other(id)
			if _, in := region[v]; in {
				continue
			}
			vn := g.nodes[v]
			if !vn.energized() || g.simNodeOpen(st, v) || !g.simPassable(st, v, eid) {
				continue
			}
			lab := vn.feeder
			if _, head := g.feeders[v]; head || lab == 0 {
				lab = v // pemasok di sisi GI / tanpa penyulang: label = node pemasok
			}
			if _, seen := on[id]; !seen {
				on[id] = labelFor(id, lab)
				queue = append(queue, id)
			}
			break
		}
	}
	for i := 0; i < len(queue); i++ {
		cur := queue[i]
		if g.simNodeOpen(st, cur) && !g.nodes[cur].source() {
			continue // switch terbuka: bertegangan tetapi tidak meneruskan
		}
		for _, eid := range g.adj[cur] {
			if !g.simPassable(st, cur, eid) {
				continue
			}
			nb := g.edges[eid].other(cur)
			if _, in := region[nb]; !in {
				continue
			}
			if _, seen := on[nb]; seen {
				continue
			}
			if g.simBlocked(st, nb) {
				continue
			}
			on[nb] = labelFor(nb, on[cur])
			queue = append(queue, nb)
		}
	}
	return on
}

// simLoads menghitung beban per penyulang pemasok dan pelanggan padam di wilayah.
func (g *Graph) simLoads(region map[int64]struct{}, on map[int64]int64, p SimParams) (map[int64]*SimFeederLoad, int, float64) {
	loads := map[int64]*SimFeederLoad{}
	off := 0
	offVA := 0.0
	for id := range region {
		n := g.nodes[id]
		if !n.sink() {
			continue
		}
		lab, ok := on[id]
		if !ok {
			off += g.custLocked(id, n)
			offVA += float64(n.loadVA)
			continue
		}
		if lab == 0 {
			continue
		}
		l := loads[lab]
		if l == nil {
			l = &SimFeederLoad{Head: lab, CapacityVA: p.capOf(lab)}
			loads[lab] = l
		}
		l.LoadVA += float64(n.loadVA) * p.lf(lab)
		l.Customers++
	}
	for _, l := range loads {
		if l.CapacityVA > 0 {
			l.Pct = math.Round(l.LoadVA/l.CapacityVA*1000) / 10
		}
	}
	return loads, off, offVA
}

func sortedLoads(m map[int64]*SimFeederLoad, only map[int64]struct{}) []SimFeederLoad {
	out := []SimFeederLoad{}
	for h, l := range m {
		if only != nil {
			if _, ok := only[h]; !ok {
				continue
			}
		}
		out = append(out, *l)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pct != out[j].Pct {
			return out[i].Pct > out[j].Pct
		}
		return out[i].Head < out[j].Head
	})
	return out
}

// applySimAction menerapkan satu langkah ke keadaan simulasi; mengembalikan tipe objek dan
// apakah valid. Harus dengan RLock.
func (g *Graph) applySimAction(st *simState, a SimAction) (string, []SimWarning) {
	open := a.Action == "open"
	if a.TargetKind == "edge" {
		e, ok := g.edges[a.TargetID]
		if !ok {
			return "", []SimWarning{{Code: "not_found"}}
		}
		if g.simEdgeOpen(st, a.TargetID) == open {
			st.edge[a.TargetID] = open
			return g.typeNames[e.typ], []SimWarning{{Code: "no_change"}}
		}
		st.edge[a.TargetID] = open
		return g.typeNames[e.typ], nil
	}
	n, ok := g.nodes[a.TargetID]
	if !ok {
		return "", []SimWarning{{Code: "not_found"}}
	}
	typ := g.typeNames[n.typ]
	if a.WayEdge != 0 {
		if !n.isSwitch() {
			return typ, []SimWarning{{Code: "not_switch_way"}}
		}
		if st.way[a.TargetID] == nil {
			st.way[a.TargetID] = map[int64]bool{}
		}
		was := g.simWayOpen(st, a.TargetID, a.WayEdge)
		st.way[a.TargetID][a.WayEdge] = open
		if was == open {
			return typ, []SimWarning{{Code: "no_change"}}
		}
		return typ, nil
	}
	was := g.simNodeOpen(st, a.TargetID)
	st.node[a.TargetID] = open
	if was == open {
		return typ, []SimWarning{{Code: "no_change"}}
	}
	return typ, nil
}

// parallelLabels: label pemasok berbeda di kedua sisi elemen yang akan ditutup (paralel penyulang).
func (g *Graph) parallelLabels(st *simState, on map[int64]int64, a SimAction) []int64 {
	if a.Action != "close" {
		return nil
	}
	labels := map[int64]struct{}{}
	add := func(id int64) {
		if lab, ok := on[id]; ok && lab != 0 {
			labels[lab] = struct{}{}
		}
	}
	switch {
	case a.TargetKind == "edge":
		e := g.edges[a.TargetID]
		add(e.from)
		add(e.to)
	case a.WayEdge != 0:
		e := g.edges[a.WayEdge]
		for _, eid := range g.adj[a.TargetID] {
			if eid != a.WayEdge && g.simPassable(st, a.TargetID, eid) {
				add(g.edges[eid].other(a.TargetID))
			}
		}
		add(e.other(a.TargetID))
	default:
		for _, eid := range g.adj[a.TargetID] {
			if g.simPassable(st, a.TargetID, eid) {
				add(g.edges[eid].other(a.TargetID))
			}
		}
	}
	if len(labels) < 2 {
		return nil
	}
	out := make([]int64, 0, len(labels))
	for l := range labels {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Simulate menjalankan simulasi what-if untuk urutan langkah.
func (g *Graph) Simulate(actions []SimAction, p SimParams, limit int) (*SimResult, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.loading || len(g.nodes) == 0 {
		return nil, ErrGraphLoading
	}
	return g.simulateLocked(actions, newSimState(), p, limit)
}

func (g *Graph) simulateLocked(actions []SimAction, base *simState, p SimParams, limit int) (*SimResult, error) {
	if len(actions) == 0 {
		return nil, ErrSimEmpty
	}
	if limit <= 0 {
		limit = 5000
	}
	seeds := []int64{}
	for _, a := range actions {
		if a.TargetKind == "edge" {
			if e, ok := g.edges[a.TargetID]; ok {
				seeds = append(seeds, e.from, e.to)
			}
		} else {
			seeds = append(seeds, a.TargetID)
		}
	}
	region := g.regionLocked(seeds)
	st := base.clone()
	on0 := g.simEnergizeLocked(region, st)
	loads0, off0, _ := g.simLoads(region, on0, p)
	res := &SimResult{RegionNodes: len(region), BaseCustomersOff: off0, Steps: []SimStep{}, BaseFeeders: sortedLoads(loads0, nil)}
	prevOn := on0
	prevOff := off0
	for i, a := range actions {
		par := g.parallelLabels(st, prevOn, a)
		typ, warns := g.applySimAction(st, a)
		on := g.simEnergizeLocked(region, st)
		loads, off, offVA := g.simLoads(region, on, p)
		step := SimStep{Seq: i + 1, Action: a, TypeCode: typ, Valid: true, CustomersOff: off, CustomersDiff: off - prevOff, LoadOffVA: offVA, Warnings: []SimWarning{}}
		for _, w := range warns {
			if w.Code == "not_found" || w.Code == "not_switch_way" {
				step.Valid = false
			}
			step.Warnings = append(step.Warnings, w)
		}
		if len(par) > 0 {
			step.Warnings = append(step.Warnings, SimWarning{Code: "parallel", Feeders: par})
		}
		// penyulang yang terpengaruh langkah ini: label yang berubah + pemasok baru
		touched := map[int64]struct{}{}
		for id, lab := range on {
			if prev, ok := prevOn[id]; !ok || prev != lab {
				touched[lab] = struct{}{}
				if ok {
					touched[prev] = struct{}{}
				}
			}
		}
		for id, prev := range prevOn {
			if _, ok := on[id]; !ok {
				touched[prev] = struct{}{}
			}
		}
		delete(touched, 0)
		step.Feeders = sortedLoads(loads, touched)
		for _, l := range step.Feeders {
			switch {
			case l.Pct > 100:
				step.Warnings = append(step.Warnings, SimWarning{Code: "overload", Feeders: []int64{l.Head}, Pct: l.Pct})
			case l.Pct >= 80:
				step.Warnings = append(step.Warnings, SimWarning{Code: "high_load", Feeders: []int64{l.Head}, Pct: l.Pct})
			}
		}
		res.Steps = append(res.Steps, step)
		prevOn, prevOff = on, off
	}
	// selisih akhir terhadap kondisi saat ini
	res.CustomersOffAfter = prevOff
	for id := range region {
		n := g.nodes[id]
		_, nowOn := prevOn[id]
		switch {
		case nowOn && !n.energized():
			if n.sink() {
				res.CustomersRestored += g.custLocked(id, n)
				res.LoadRestoredVA += float64(n.loadVA)
			}
			if len(res.NodesOn) < limit {
				res.NodesOn = append(res.NodesOn, id)
			}
		case !nowOn && n.energized():
			if n.sink() {
				res.CustomersNewOff += g.custLocked(id, n)
				res.LoadNewOffVA += float64(n.loadVA)
			}
			if len(res.NodesOff) < limit {
				res.NodesOff = append(res.NodesOff, id)
			}
		}
	}
	seenE := map[int64]struct{}{}
	for id := range region {
		for _, eid := range g.adj[id] {
			if _, dup := seenE[eid]; dup {
				continue
			}
			seenE[eid] = struct{}{}
			e := g.edges[eid]
			isOn := func(x int64) bool {
				if _, in := region[x]; in {
					_, ok := prevOn[x]
					return ok
				}
				return g.nodes[x].energized()
			}
			eon := isOn(e.from) && isOn(e.to) && !g.simEdgeOpen(st, eid)
			switch {
			case eon && !e.energized && len(res.EdgesOn) < limit:
				res.EdgesOn = append(res.EdgesOn, eid)
			case !eon && e.energized && len(res.EdgesOff) < limit:
				res.EdgesOff = append(res.EdgesOff, eid)
			case !eon && !e.energized && len(res.StillOffEdges) < limit:
				res.StillOffEdges = append(res.StillOffEdges, eid)
			}
		}
	}
	return res, nil
}
