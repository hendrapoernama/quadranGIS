package gis

import (
	"container/heap"
	"context"
	"log"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------
// pewarnaan per penyulang
//
//   - normal: keanggotaan menurut posisi normal switch (nodeRec.feeder, dari computeGroups),
//     disimpan di kolom feeder_id gis_nodes / gis_edges dan hanya ditulis bila berubah;
//   - aktual: penyulang yang menyuplai saat ini, mengikuti manuver (mis. seksi yang dilimpahkan
//     lewat tie point). Hanya yang BERBEDA dari keanggotaan normal yang disimpan (map live / liveE
//     dan tabel *_feeder_live), sehingga memori & penulisan tetap kecil.
// ---------------------------------------------------------------------

// FeederPaletteSize adalah jumlah warna palet penyulang (harus sama dengan palet di frontend).
const FeederPaletteSize = 12

// feederSimilar: pasangan indeks palet yang mirip secara visual (urutan FEEDER_PALETTE di frontend:
// biru, oranye, ungu, teal, merah muda, kuning tua, biru langit, cokelat, hijau muda, magenta, indigo,
// cyan). Penyulang bertetangga sebaiknya juga tidak mendapat warna yang mirip.
var feederSimilar = [][2]int{{0, 10}, {0, 6}, {6, 11}, {3, 11}, {1, 5}, {1, 7}, {5, 7}, {4, 9}, {2, 9}, {2, 10}}

// IDFeeder adalah pasangan id objek & id kepala penyulang (0 = di luar penyulang).
type IDFeeder struct{ ID, Feeder int64 }

// LiveDiff adalah perubahan override penyulang aktual; nilai -1 berarti override dihapus.
type LiveDiff struct {
	Nodes map[int64]int64
	Edges map[int64]int64
}

// Empty menandakan tidak ada perubahan.
func (d LiveDiff) Empty() bool { return len(d.Nodes) == 0 && len(d.Edges) == 0 }

func newLiveDiff() LiveDiff { return LiveDiff{Nodes: map[int64]int64{}, Edges: map[int64]int64{}} }

// FeederChange adalah perubahan penyulang yang perlu disimpan ke DB.
type FeederChange struct {
	Regroup bool       // hasil pengelompokan ulang (warna penyulang ditinjau ulang)
	Nodes   []IDFeeder // keanggotaan normal node yang berubah
	Edges   []IDFeeder // keanggotaan normal saluran yang mungkin berubah (unik per id)
	Live    LiveDiff
	Ties    map[[2]int64]int // pasangan penyulang (a < b) → jumlah saluran penghubung (tie point)
}

// OnFeederChange memasang hook persistensi penyulang. Hook dipanggil selagi lock graf dipegang
// (urutan perubahan terjaga), jadi harus cepat dan tidak memanggil graf kembali.
func (g *Graph) OnFeederChange(fn func(FeederChange)) { g.onFeeder = fn }

// liveOfLocked: penyulang penyuplai saat ini sebuah node (override, atau keanggotaan normal).
func (g *Graph) liveOfLocked(id int64) int64 {
	if f, ok := g.live[id]; ok {
		return f
	}
	return g.nodes[id].feeder
}

// liveFromParentsLocked menghitung penyulang penyuplai node bertegangan dari induknya pada jalur
// terpendek saat ini (tetangga berjarak d-1 yang meneruskan daya). Kepala penyulang menyuplai
// dirinya sendiri. Bila induk berbeda penyulang (operasi paralel lewat tie), keanggotaan normal
// didahulukan agar hasil stabil; selebihnya penyulang ber-id terkecil.
func (g *Graph) liveFromParentsLocked(id int64, liveOf func(int64) int64) int64 {
	if _, head := g.feeders[id]; head {
		return id
	}
	d, ok := g.dist[id]
	if !ok || d == 0 {
		return 0
	}
	normal := g.nodes[id].feeder
	best, found := int64(0), false
	for _, eid := range g.adj[id] {
		e := g.edges[eid]
		if !g.passableLocked(id, eid, e) {
			continue
		}
		p := e.other(id)
		if dp, ok := g.dist[p]; !ok || dp != d-1 || g.nodes[p].open() {
			continue
		}
		f := liveOf(p)
		if f == normal {
			return f
		}
		if !found || f < best {
			best, found = f, true
		}
	}
	return best
}

// edgeFeederLocked: penyulang sebuah saluran dari penyulang kedua ujungnya. Saluran batas (ujung
// beda penyulang, mis. di tie point) ikut ujung yang tidak terbuka ke saluran itu; bila keduanya
// tertutup, ikut ujung yang punya penyulang, lalu ujung asal. live = posisi & penyulang saat ini.
func (g *Graph) edgeFeederLocked(eid int64, e edgeRec, live bool, liveOf func(int64) int64) int64 {
	na, nb := g.nodes[e.from], g.nodes[e.to]
	var fa, fb int64
	var openA, openB bool
	if live {
		fa, fb = liveOf(e.from), liveOf(e.to)
		openA = na.open() || wayOpen(g.openWays, e.from, eid)
		openB = nb.open() || wayOpen(g.openWays, e.to, eid)
	} else {
		fa, fb = na.feeder, nb.feeder
		openA = na.flags&flagNormalOpen != 0 || wayOpen(g.normalOpenWays, e.from, eid)
		openB = nb.flags&flagNormalOpen != 0 || wayOpen(g.normalOpenWays, e.to, eid)
	}
	switch {
	case fa == fb:
		return fa
	case openA && !openB:
		return fb
	case openB && !openA:
		return fa
	case fa == 0:
		return fb
	}
	return fa
}

// setLiveLocked menyimpan override node (hanya bila bertegangan & berbeda dari keanggotaan normal).
func (g *Graph) setLiveLocked(id, f int64, on bool, d LiveDiff) {
	old, had := g.live[id]
	if !on || f == g.nodes[id].feeder {
		if had {
			delete(g.live, id)
			d.Nodes[id] = -1
		}
		return
	}
	if !had || old != f {
		g.live[id] = f
		d.Nodes[id] = f
	}
}

// setLiveEdgeLocked menyelaraskan override saluran dari penyulang aktual kedua ujungnya.
func (g *Graph) setLiveEdgeLocked(eid int64, d LiveDiff) {
	e, ok := g.edges[eid]
	want, need := int64(0), false
	if ok && e.energized {
		if lf := g.edgeFeederLocked(eid, e, true, g.liveOfLocked); lf != g.edgeFeederLocked(eid, e, false, nil) {
			want, need = lf, true
		}
	}
	old, had := g.liveE[eid]
	switch {
	case !need && had:
		delete(g.liveE, eid)
		d.Edges[eid] = -1
	case need && (!had || old != want):
		g.liveE[eid] = want
		d.Edges[eid] = want
	}
}

// updateLiveLocked memperbarui penyulang aktual setelah manuver. Node yang jaraknya berubah (seeds)
// dihitung ulang berurutan menurut jarak, lalu perubahan merambat ke hilir. Harus dengan Lock.
func (g *Graph) updateLiveLocked(seeds []int64) LiveDiff {
	d := newLiveDiff()
	if g.live == nil {
		g.live = map[int64]int64{}
	}
	if g.liveE == nil {
		g.liveE = map[int64]int64{}
	}
	seedSet := make(map[int64]struct{}, len(seeds))
	edges := map[int64]struct{}{}
	h := &distHeap{}
	for _, s := range seeds {
		if _, dup := seedSet[s]; dup {
			continue
		}
		seedSet[s] = struct{}{}
		for _, eid := range g.adj[s] {
			edges[eid] = struct{}{}
		}
		if ds, ok := g.dist[s]; ok {
			heap.Push(h, distItem{ds, s})
		} else {
			g.setLiveLocked(s, 0, false, d) // padam: tidak ada penyuplai
		}
	}
	done := map[int64]struct{}{}
	for h.Len() > 0 {
		it := heap.Pop(h).(distItem)
		if _, ok := done[it.id]; ok {
			continue
		}
		done[it.id] = struct{}{}
		before := g.liveOfLocked(it.id)
		f := g.liveFromParentsLocked(it.id, g.liveOfLocked)
		g.setLiveLocked(it.id, f, true, d)
		if _, seed := seedSet[it.id]; !seed {
			if f == before {
				continue // tidak berubah: hilirnya juga tidak
			}
			for _, eid := range g.adj[it.id] {
				edges[eid] = struct{}{}
			}
		}
		if g.nodes[it.id].open() {
			continue
		}
		for _, eid := range g.adj[it.id] {
			e := g.edges[eid]
			if !g.passableLocked(it.id, eid, e) {
				continue
			}
			c := e.other(it.id)
			if dc, ok := g.dist[c]; ok && dc == it.d+1 {
				if _, ok := done[c]; !ok {
					heap.Push(h, distItem{dc, c})
				}
			}
		}
	}
	for eid := range edges {
		g.setLiveEdgeLocked(eid, d)
	}
	return d
}

// desiredLiveLocked menghitung seluruh override penyulang aktual dari nol: node bertegangan
// diproses berurutan menurut jarak (counting sort). Tidak mengubah graf; cukup dengan RLock.
func (g *Graph) desiredLiveLocked() (map[int64]int64, map[int64]int64) {
	want, wantE := map[int64]int64{}, map[int64]int64{}
	if len(g.dist) == 0 {
		return want, wantE
	}
	maxD := int32(0)
	for _, d := range g.dist {
		if d > maxD {
			maxD = d
		}
	}
	pos := make([]int, maxD+2)
	for _, d := range g.dist {
		pos[d+1]++
	}
	for i := 1; i < len(pos); i++ {
		pos[i] += pos[i-1]
	}
	order := make([]int64, len(g.dist))
	for id, d := range g.dist {
		order[pos[d]] = id
		pos[d]++
	}
	liveOf := func(id int64) int64 {
		if f, ok := want[id]; ok {
			return f
		}
		return g.nodes[id].feeder
	}
	for _, id := range order {
		if f := g.liveFromParentsLocked(id, liveOf); f != g.nodes[id].feeder {
			want[id] = f
		}
	}
	for eid, e := range g.edges {
		if !e.energized {
			continue
		}
		if lf := g.edgeFeederLocked(eid, e, true, liveOf); lf != g.edgeFeederLocked(eid, e, false, nil) {
			wantE[eid] = lf
		}
	}
	return want, wantE
}

// applyLiveLocked mengganti seluruh override dan mengembalikan selisihnya. Harus dengan Lock.
func (g *Graph) applyLiveLocked(want, wantE map[int64]int64) LiveDiff {
	d := newLiveDiff()
	for id, f := range want {
		if old, ok := g.live[id]; !ok || old != f {
			d.Nodes[id] = f
		}
	}
	for id := range g.live {
		if _, ok := want[id]; !ok {
			d.Nodes[id] = -1
		}
	}
	for id, f := range wantE {
		if old, ok := g.liveE[id]; !ok || old != f {
			d.Edges[id] = f
		}
	}
	for id := range g.liveE {
		if _, ok := wantE[id]; !ok {
			d.Edges[id] = -1
		}
	}
	g.live, g.liveE = want, wantE
	g.parCache = nil // penyulang aktual berubah tanpa menaikkan generasi graf
	return d
}

// wantLiveLocked: override aktual yang seharusnya. Semua switch di posisi normal → tidak ada.
func (g *Graph) wantLiveLocked() (map[int64]int64, map[int64]int64) {
	if g.switchesAtNormalLocked() {
		return map[int64]int64{}, map[int64]int64{}
	}
	return g.desiredLiveLocked()
}

// publishFeederChange dipanggil setelah pengelompokan: menyusun keanggotaan node & saluran yang
// berubah, pasangan penyulang bertetangga (tie point), menghitung ulang penyulang aktual, lalu
// meneruskan semuanya ke hook persistensi.
func (g *Graph) publishFeederChange(changed []IDFeeder) {
	start := time.Now()
	for attempt := 0; ; attempt++ {
		g.mu.RLock()
		gen := g.gen
		ch := FeederChange{Regroup: true, Nodes: changed, Ties: map[[2]int64]int{}}
		if len(changed) > len(g.nodes)/4 {
			// perubahan besar (mis. pengisian awal): semua saluran; penulisan DB melewati yang sama
			ch.Edges = make([]IDFeeder, 0, len(g.edges))
			for eid, e := range g.edges {
				ch.Edges = append(ch.Edges, IDFeeder{eid, g.edgeFeederLocked(eid, e, false, nil)})
			}
		} else {
			seen := map[int64]struct{}{}
			for _, c := range changed {
				for _, eid := range g.adj[c.ID] {
					if _, dup := seen[eid]; dup {
						continue
					}
					seen[eid] = struct{}{}
					ch.Edges = append(ch.Edges, IDFeeder{eid, g.edgeFeederLocked(eid, g.edges[eid], false, nil)})
				}
			}
		}
		for _, e := range g.edges {
			a, b := g.nodes[e.from].feeder, g.nodes[e.to].feeder
			if a != 0 && b != 0 && a != b {
				if a > b {
					a, b = b, a
				}
				ch.Ties[[2]int64{a, b}]++
			}
		}
		live := !g.distDirty
		var want, wantE map[int64]int64
		if live {
			want, wantE = g.wantLiveLocked()
		}
		g.mu.RUnlock()

		g.mu.Lock()
		if g.gen != gen && attempt < 2 {
			g.mu.Unlock()
			continue // manuver / edit di tengah perhitungan: ulangi
		}
		if g.gen != gen {
			live = !g.distDirty
			if live {
				want, wantE = g.wantLiveLocked()
			}
		}
		if len(g.dirtyE) > 0 {
			inList := make(map[int64]struct{}, len(ch.Edges))
			for _, x := range ch.Edges {
				inList[x.ID] = struct{}{}
			}
			for eid := range g.dirtyE {
				if e, ok := g.edges[eid]; ok {
					if _, dup := inList[eid]; !dup {
						ch.Edges = append(ch.Edges, IDFeeder{eid, g.edgeFeederLocked(eid, e, false, nil)})
					}
				}
			}
		}
		g.dirtyE = nil
		ch.Live = newLiveDiff()
		if live {
			ch.Live = g.applyLiveLocked(want, wantE)
		}
		if g.onFeeder != nil {
			g.onFeeder(ch)
		}
		nLive, nLiveE := len(g.live), len(g.liveE)
		g.mu.Unlock()
		log.Printf("[graph] penyulang: %d node berubah keanggotaan, %d saluran diperiksa, %d pasangan tie, override aktual %d node / %d saluran (%s)",
			len(changed), len(ch.Edges), len(ch.Ties), nLive, nLiveE, time.Since(start).Round(time.Millisecond))
		return
	}
}

// FeederList mengembalikan seluruh penyulang (kepala, GI, trafo GI), urut id kepala.
func (g *Graph) FeederList() []feederInfo {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]feederInfo, 0, len(g.feeders))
	for _, fi := range g.feeders {
		out = append(out, *fi)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Head < out[j].Head })
	return out
}

// LiveFeeder mengembalikan penyulang penyuplai saat ini sebuah node / saluran bila berbeda dari
// keanggotaan normalnya (bagian yang dilimpahkan lewat manuver).
func (g *Graph) LiveFeeder(kind string, id int64) (int64, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	m := g.live
	if kind == "edge" {
		m = g.liveE
	}
	f, ok := m[id]
	return f, ok
}

// LiveCounts: jumlah node & saluran yang penyuplainya saat ini berbeda dari keanggotaan normal.
func (g *Graph) LiveCounts() (int, int) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return len(g.live), len(g.liveE)
}

// ParallelFeeder adalah dua penyulang yang beroperasi paralel (loop tertutup di antara keduanya).
type ParallelFeeder struct {
	A     int64   `json:"a"`
	B     int64   `json:"b"`
	Ties  []int64 `json:"ties"`      // switch normally-open yang kini tertutup di antara keduanya
	Meet  int64   `json:"meet_edge"` // saluran tempat suplai kedua penyulang bertemu
	Meets int     `json:"meets"`     // jumlah titik temu
	// sudah tersambung loop pada posisi normal switch (mis. data tanpa tie normally-open), bukan akibat manuver
	NormalLoop bool `json:"normal_loop"`
}

// ParallelFeeders mendeteksi penyulang yang tersambung paralel: saluran tertutup & bertegangan yang
// kedua ujungnya disuplai penyulang berbeda adalah titik temu suplai dua penyulang dalam satu loop.
// Tie penyebabnya dicari dari switch (atau arah LBS) normally-open yang kini tertutup dan
// menghubungkan kedua penyulang (menurut keanggotaan normal). Di-cache per generasi graf.
func (g *Graph) ParallelFeeders() []ParallelFeeder {
	g.mu.RLock()
	defer g.mu.RUnlock()
	g.parMu.Lock()
	defer g.parMu.Unlock()
	if g.parCache != nil && g.parGen == g.gen && g.parGroups.Equal(g.groupsAt) {
		return g.parCache
	}
	pairs := map[[2]int64]*ParallelFeeder{}
	normalLoops := map[[2]int64]bool{}
	for eid, e := range g.edges {
		if e.open {
			continue
		}
		// saluran yang menempel kepala penyulang (busbar antar-kubikel di GI) bukan titik temu: jalur lewat
		// penyulang lain ke sana selalu jauh lebih panjang dari satu langkah
		if _, h := g.feeders[e.from]; h {
			continue
		}
		if _, h := g.feeders[e.to]; h {
			continue
		}
		na, nb := g.nodes[e.from], g.nodes[e.to]
		// loop pada posisi normal switch: keanggotaan normal kedua ujung berbeda tanpa pemisah normally-open
		if na.flags&flagNormalOpen == 0 && nb.flags&flagNormalOpen == 0 && !wayOpen(g.normalOpenWays, e.from, eid) && !wayOpen(g.normalOpenWays, e.to, eid) {
			if a, b := na.feeder, nb.feeder; a != 0 && b != 0 && a != b {
				if a > b {
					a, b = b, a
				}
				normalLoops[[2]int64{a, b}] = true
			}
		}
		if !e.energized || na.open() || nb.open() || !g.passableLocked(e.from, eid, e) {
			continue // padam, atau switch terbuka: batas antar-penyulang, bukan loop
		}
		fa, fb := g.liveOfLocked(e.from), g.liveOfLocked(e.to)
		if fa == 0 || fb == 0 || fa == fb {
			continue
		}
		if fa > fb {
			fa, fb = fb, fa
		}
		k := [2]int64{fa, fb}
		p := pairs[k]
		if p == nil {
			p = &ParallelFeeder{A: fa, B: fb, Ties: []int64{}, Meet: eid}
			pairs[k] = p
		}
		p.Meets++
		if eid < p.Meet {
			p.Meet = eid // deterministik
		}
	}
	out := make([]ParallelFeeder, 0, len(pairs))
	if len(pairs) > 0 {
		// tie: switch normally-open kini tertutup (seluruhnya atau salah satu arah) yang ujung-ujungnya
		// termasuk kedua penyulang
		addTie := func(sw int64, feeders map[int64]bool) {
			for k, p := range pairs {
				if feeders[k[0]] && feeders[k[1]] {
					p.Ties = append(p.Ties, sw)
				}
			}
		}
		for id, n := range g.nodes {
			if !n.isSwitch() || !n.energized() {
				continue
			}
			wholeTie := n.flags&flagNormalOpen != 0 && !n.open()
			var wayTies []int64
			for eid := range g.normalOpenWays[id] {
				if !wayOpen(g.openWays, id, eid) {
					wayTies = append(wayTies, eid)
				}
			}
			if !wholeTie && len(wayTies) == 0 {
				continue
			}
			feeders := map[int64]bool{n.feeder: true, g.liveOfLocked(id): true}
			if wholeTie {
				for _, eid := range g.adj[id] {
					o := g.edges[eid].other(id)
					feeders[g.nodes[o].feeder] = true
					feeders[g.liveOfLocked(o)] = true
				}
			}
			for _, eid := range wayTies {
				o := g.edges[eid].other(id)
				feeders[g.nodes[o].feeder] = true
				feeders[g.liveOfLocked(o)] = true
			}
			addTie(id, feeders)
		}
		for k, p := range pairs {
			sort.Slice(p.Ties, func(i, j int) bool { return p.Ties[i] < p.Ties[j] })
			p.NormalLoop = normalLoops[k] && len(p.Ties) == 0
			out = append(out, *p)
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].A != out[j].A {
				return out[i].A < out[j].A
			}
			return out[i].B < out[j].B
		})
	}
	g.parCache, g.parGen, g.parGroups = out, g.gen, g.groupsAt
	return out
}

// ---------------------------------------------------------------------
// warna penyulang
// ---------------------------------------------------------------------

// AssignFeederColors memberi indeks warna 0..k-1 ke setiap penyulang secara greedy: penyulang dengan
// total bobot ketetanggaan terbesar lebih dulu, memilih warna dengan total bobot tetangga berwarna
// sama terkecil (lalu warna yang paling jarang dipakai). Warna sebelumnya dipertahankan bila
// hampir sama baiknya, sehingga warna stabil antar-perhitungan. w: pasangan (a < b) → bobot.
func AssignFeederColors(ids []int64, prev map[int64]int, w map[[2]int64]float64, k int) map[int64]int {
	nb := map[int64]map[int64]float64{}
	add := func(a, b int64, x float64) {
		m := nb[a]
		if m == nil {
			m = map[int64]float64{}
			nb[a] = m
		}
		m[b] += x
	}
	total := map[int64]float64{}
	for p, x := range w {
		add(p[0], p[1], x)
		add(p[1], p[0], x)
		total[p[0]] += x
		total[p[1]] += x
	}
	order := append([]int64{}, ids...)
	sort.Slice(order, func(i, j int) bool {
		if total[order[i]] != total[order[j]] {
			return total[order[i]] > total[order[j]]
		}
		return order[i] < order[j]
	})
	similar := make([][]int, k)
	if k == FeederPaletteSize {
		for _, p := range feederSimilar {
			similar[p[0]] = append(similar[p[0]], p[1])
			similar[p[1]] = append(similar[p[1]], p[0])
		}
	}
	out := make(map[int64]int, len(ids))
	used := make([]int, k)
	cost := make([]float64, k)
	for _, id := range order {
		for c := range cost {
			cost[c] = 0
		}
		for o, x := range nb[id] {
			if c, ok := out[o]; ok {
				cost[c] += x
				for _, s := range similar[c] {
					cost[s] += 0.4 * x // warna mirip: separuh lebih ringan dari warna sama
				}
			}
		}
		best := 0
		for c := 1; c < k; c++ {
			if cost[c] < cost[best] || (cost[c] == cost[best] && used[c] < used[best]) {
				best = c
			}
		}
		if p, ok := prev[id]; ok && p >= 0 && p < k && cost[p] <= cost[best]+1 {
			best = p
		}
		out[id] = best
		used[best]++
	}
	return out
}

// feederWeights menyusun bobot ketetanggaan penyulang: tersambung lewat tie point (paling kuat),
// satu GI / satu trafo GI (keluar berdampingan dari gardu induk), dan berbagi sel grid ±550 m.
func feederWeights(list []feederInfo, ties map[[2]int64]int, cells map[[2]int32][]int64) map[[2]int64]float64 {
	w := map[[2]int64]float64{}
	add := func(a, b int64, x float64) {
		if a == b {
			return
		}
		if a > b {
			a, b = b, a
		}
		w[[2]int64{a, b}] += x
	}
	for p, n := range ties {
		add(p[0], p[1], math.Min(50*float64(n), 100))
	}
	byGI := map[int64][]feederInfo{}
	for _, f := range list {
		if f.GI != 0 {
			byGI[f.GI] = append(byGI[f.GI], f)
		}
	}
	for _, fs := range byGI {
		for i := range fs {
			for j := i + 1; j < len(fs); j++ {
				x := 10.0
				if fs[i].TrafoGI != 0 && fs[i].TrafoGI == fs[j].TrafoGI {
					x += 10
				}
				add(fs[i].Head, fs[j].Head, x)
			}
		}
	}
	shared := map[[2]int64]int{}
	for _, fs := range cells {
		for i := range fs {
			for j := i + 1; j < len(fs); j++ {
				a, b := fs[i], fs[j]
				if a > b {
					a, b = b, a
				}
				shared[[2]int64{a, b}]++
			}
		}
	}
	for p, n := range shared {
		add(p[0], p[1], math.Min(float64(n), 20))
	}
	return w
}

// ---------------------------------------------------------------------
// persistensi
// ---------------------------------------------------------------------

func loadLiveFeeders(ctx context.Context, pool *pgxpool.Pool) (map[int64]int64, map[int64]int64, error) {
	read := func(table string) (map[int64]int64, error) {
		m := map[int64]int64{}
		rows, err := pool.Query(ctx, `SELECT id, feeder_id FROM `+table)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id, f int64
			if err := rows.Scan(&id, &f); err != nil {
				return nil, err
			}
			m[id] = f
		}
		return m, rows.Err()
	}
	n, err := read("gis_node_feeder_live")
	if err != nil {
		return nil, nil, err
	}
	e, err := read("gis_edge_feeder_live")
	if err != nil {
		return nil, nil, err
	}
	return n, e, nil
}

// ApplyFeederMembership menyimpan keanggotaan penyulang normal: saluran lebih dulu, lalu node
// (bila terputus di tengah, node yang belum tersimpan dibandingkan ulang saat graf dimuat dan
// saluran di sekitarnya ikut ditulis ulang). Baris yang nilainya sama dilewati.
func (p *Power) ApplyFeederMembership(ctx context.Context, nodes, edges []IDFeeder) error {
	write := func(table string, list []IDFeeder) error {
		if len(list) == 0 {
			return nil
		}
		sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
		const chunk = 20000
		ids := make([]int64, 0, chunk)
		fs := make([]int64, 0, chunk)
		var written int64
		start := time.Now()
		for i := 0; i < len(list); i += chunk {
			j := min(i+chunk, len(list))
			ids, fs = ids[:0], fs[:0]
			for _, x := range list[i:j] {
				ids = append(ids, x.ID)
				fs = append(fs, x.Feeder)
			}
			tag, err := p.pool.Exec(ctx, `UPDATE `+table+` t SET feeder_id = NULLIF(v.f, 0)
				FROM unnest($1::bigint[], $2::bigint[]) AS v(id, f)
				WHERE t.id = v.id AND t.feeder_id IS DISTINCT FROM NULLIF(v.f, 0)`, ids, fs)
			if err != nil {
				return err
			}
			written += tag.RowsAffected()
			if len(list) > 200000 && (i/chunk)%25 == 24 {
				log.Printf("[feeder] %s: %d/%d baris diperiksa, %d ditulis", table, j, len(list), written)
			}
		}
		if written > 0 {
			log.Printf("[feeder] keanggotaan penyulang %s: %d baris ditulis (%s)", table, written, time.Since(start).Round(time.Millisecond))
		}
		return nil
	}
	if err := write("gis_edges", edges); err != nil {
		return err
	}
	return write("gis_nodes", nodes)
}

// ApplyLiveFeeders menyimpan perubahan override penyulang aktual.
func (p *Power) ApplyLiveFeeders(ctx context.Context, d LiveDiff) error {
	for _, t := range []struct {
		table string
		m     map[int64]int64
	}{{"gis_node_feeder_live", d.Nodes}, {"gis_edge_feeder_live", d.Edges}} {
		if len(t.m) == 0 {
			continue
		}
		var del, ids, fs []int64
		for id, f := range t.m {
			if f < 0 {
				del = append(del, id)
			} else {
				ids = append(ids, id)
				fs = append(fs, f)
			}
		}
		if len(del) > 0 {
			if _, err := p.pool.Exec(ctx, `DELETE FROM `+t.table+` WHERE id = ANY($1::bigint[])`, del); err != nil {
				return err
			}
		}
		if len(ids) > 0 {
			if _, err := p.pool.Exec(ctx, `INSERT INTO `+t.table+` (id, feeder_id) SELECT * FROM unnest($1::bigint[], $2::bigint[])
				ON CONFLICT (id) DO UPDATE SET feeder_id = EXCLUDED.feeder_id`, ids, fs); err != nil {
				return err
			}
		}
	}
	return nil
}

// FeederColors mengembalikan indeks warna tersimpan per kepala penyulang.
func (p *Power) FeederColors(ctx context.Context) (map[int64]int, error) {
	out := map[int64]int{}
	rows, err := p.pool.Query(ctx, `SELECT head_id, color FROM feeder_colors`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c int16
		if err := rows.Scan(&id, &c); err != nil {
			return nil, err
		}
		out[id] = int(c)
	}
	return out, rows.Err()
}

// SaveFeederColors mengganti tabel warna penyulang (penyulang yang sudah tidak ada dihapus).
func (p *Power) SaveFeederColors(ctx context.Context, m map[int64]int) error {
	ids := make([]int64, 0, len(m))
	cs := make([]int16, 0, len(m))
	for id, c := range m {
		ids = append(ids, id)
		cs = append(cs, int16(c))
	}
	if _, err := p.pool.Exec(ctx, `DELETE FROM feeder_colors WHERE NOT (head_id = ANY($1::bigint[]))`, ids); err != nil {
		return err
	}
	_, err := p.pool.Exec(ctx, `INSERT INTO feeder_colors (head_id, color) SELECT * FROM unnest($1::bigint[], $2::smallint[])
		ON CONFLICT (head_id) DO UPDATE SET color = EXCLUDED.color, updated_at = now() WHERE feeder_colors.color <> EXCLUDED.color`, ids, cs)
	return err
}

// FeederCells mengembalikan penyulang per sel grid ±550 m (dari titik node anggotanya).
func (p *Power) FeederCells(ctx context.Context) (map[[2]int32][]int64, error) {
	out := map[[2]int32][]int64{}
	rows, err := p.pool.Query(ctx, `SELECT floor(ST_X(geom) * 200)::int, floor(ST_Y(geom) * 200)::int, feeder_id
		FROM gis_nodes WHERE feeder_id IS NOT NULL GROUP BY 1, 2, 3`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var x, y int32
		var f int64
		if err := rows.Scan(&x, &y, &f); err != nil {
			return nil, err
		}
		k := [2]int32{x, y}
		out[k] = append(out[k], f)
	}
	return out, rows.Err()
}

// PointOf mengembalikan koordinat node dan titik tengah saluran (untuk penanda peta).
func (p *Power) PointOf(ctx context.Context, nodeIDs, edgeIDs []int64) (map[int64][2]float64, map[int64][2]float64, error) {
	nodes, edges := map[int64][2]float64{}, map[int64][2]float64{}
	for _, q := range []struct {
		sql string
		ids []int64
		out map[int64][2]float64
	}{
		{`SELECT id, ST_X(geom), ST_Y(geom) FROM gis_nodes WHERE id = ANY($1::bigint[])`, nodeIDs, nodes},
		{`SELECT id, ST_X(pt), ST_Y(pt) FROM (SELECT id, ST_LineInterpolatePoint(geom, 0.5) AS pt FROM gis_edges WHERE id = ANY($1::bigint[])) x`, edgeIDs, edges},
	} {
		if len(q.ids) == 0 {
			continue
		}
		rows, err := p.pool.Query(ctx, q.sql, q.ids)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var id int64
			var x, y float64
			if err := rows.Scan(&id, &x, &y); err != nil {
				rows.Close()
				return nil, nil, err
			}
			q.out[id] = [2]float64{x, y}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	return nodes, edges, nil
}

// FeederExtent mengembalikan batas [minx,miny,maxx,maxy] saluran anggota penyulang (normal, plus
// saluran yang saat ini dilimpahkan ke penyulang itu bila live).
func (p *Power) FeederExtent(ctx context.Context, head int64, live bool) ([4]float64, bool, error) {
	var b [4]*float64
	err := p.pool.QueryRow(ctx, `SELECT ST_XMin(x), ST_YMin(x), ST_XMax(x), ST_YMax(x) FROM (SELECT ST_Extent(geom) AS x FROM (
		SELECT geom FROM gis_edges WHERE feeder_id = $1
		UNION ALL SELECT e.geom FROM gis_edge_feeder_live l JOIN gis_edges e ON e.id = l.id WHERE $2 AND l.feeder_id = $1
		UNION ALL SELECT geom FROM gis_nodes WHERE id = $1) g) s`, head, live).Scan(&b[0], &b[1], &b[2], &b[3])
	if err != nil {
		return [4]float64{}, false, err
	}
	if b[0] == nil {
		return [4]float64{}, false, nil
	}
	return [4]float64{*b[0], *b[1], *b[2], *b[3]}, true, nil
}

// ---------------------------------------------------------------------
// penulis latar belakang
// ---------------------------------------------------------------------

// FeederSync menyimpan perubahan penyulang ke DB berurutan di latar belakang (pengisian awal bisa
// jutaan baris) dan meninjau ulang warna penyulang setelah pengelompokan ulang.
type FeederSync struct {
	power     *Power
	graph     *Graph
	onApplied func(regroup bool)

	mu     sync.Mutex
	queue  []FeederChange
	wake   chan struct{}
	colors bool // warna sudah ditinjau sejak backend berjalan
}

// NewFeederSync membuat penulis. onApplied dipanggil setelah antrean tersimpan (mis. naikkan versi
// tile & siarkan event).
func NewFeederSync(p *Power, g *Graph, onApplied func(regroup bool)) *FeederSync {
	return &FeederSync{power: p, graph: g, onApplied: onApplied, wake: make(chan struct{}, 1)}
}

// Enqueue memasukkan perubahan ke antrean (cepat; aman dipanggil selagi lock graf dipegang).
func (s *FeederSync) Enqueue(c FeederChange) {
	s.mu.Lock()
	s.queue = append(s.queue, c)
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run memproses antrean sampai ctx selesai.
func (s *FeederSync) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		}
		regroup, did := false, false
		for {
			s.mu.Lock()
			if len(s.queue) == 0 {
				s.mu.Unlock()
				break
			}
			c := s.queue[0]
			s.queue[0] = FeederChange{}
			s.queue = s.queue[1:]
			s.mu.Unlock()
			s.apply(ctx, c)
			regroup = regroup || c.Regroup
			did = true
		}
		if did && s.onApplied != nil {
			s.onApplied(regroup)
		}
	}
}

func (s *FeederSync) apply(ctx context.Context, c FeederChange) {
	pctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	if err := s.power.ApplyFeederMembership(pctx, c.Nodes, c.Edges); err != nil {
		log.Printf("[feeder] simpan keanggotaan penyulang gagal: %v", err)
	}
	if err := s.power.ApplyLiveFeeders(pctx, c.Live); err != nil {
		log.Printf("[feeder] simpan penyulang aktual gagal: %v", err)
	}
	if c.Regroup {
		if err := s.refreshColors(pctx, c); err != nil {
			log.Printf("[feeder] hitung warna penyulang gagal: %v", err)
		}
	}
}

// refreshColors meninjau warna penyulang bila perlu: pertama kali sejak start, ada penyulang
// tanpa warna / yang sudah hilang, atau keanggotaan berubah cukup banyak.
func (s *FeederSync) refreshColors(ctx context.Context, c FeederChange) error {
	list := s.graph.FeederList()
	prev, err := s.power.FeederColors(ctx)
	if err != nil {
		return err
	}
	need := !s.colors || len(c.Nodes) > 1000 || len(prev) != len(list)
	for _, f := range list {
		if _, ok := prev[f.Head]; !ok {
			need = true
			break
		}
	}
	if !need {
		return nil
	}
	start := time.Now()
	cells, err := s.power.FeederCells(ctx)
	if err != nil {
		return err
	}
	ids := make([]int64, 0, len(list))
	for _, f := range list {
		ids = append(ids, f.Head)
	}
	colors := AssignFeederColors(ids, prev, feederWeights(list, c.Ties, cells), FeederPaletteSize)
	if err := s.power.SaveFeederColors(ctx, colors); err != nil {
		return err
	}
	s.colors = true
	changed := 0
	for id, col := range colors {
		if p, ok := prev[id]; !ok || p != col {
			changed++
		}
	}
	log.Printf("[feeder] warna %d penyulang ditinjau, %d berubah (%s)", len(colors), changed, time.Since(start).Round(time.Millisecond))
	return nil
}
