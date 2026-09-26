package gis

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/cmplx"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/repo"
)

// Aliran daya (power flow) jaringan distribusi radial dengan metode backward/forward sweep.
//
// Model: satu fase ekuivalen seimbang dalam per-unit (Sbase 1 MVA). Setiap penyulang dihitung
// dari kepala penyulang (kubikel outgoing, sumber tegangan tetap) ke hilir mengikuti pohon
// jaringan yang sedang bertegangan. Saluran memakai R+jX per km menurut tipe (dapat di-override
// per saluran), perubahan level tegangan MV->LV di trafo distribusi (atau gardu bila tidak ada
// node trafo) memakai impedansi trafo dari kapasitas kVA. Beban = daya kontrak pelanggan x faktor
// beban, cos phi tetap, model daya konstan.

const pfSbaseMVA = 1.0

// LineParam adalah parameter penghantar per km.
type LineParam struct {
	R        float64 `json:"r"`        // ohm/km
	X        float64 `json:"x"`        // ohm/km
	Ampacity float64 `json:"ampacity"` // A (kuat hantar arus), 0 = tidak dinilai
}

// DefaultLineParams adalah nilai tipikal penghantar PLN (dapat diubah lewat konfigurasi).
var DefaultLineParams = map[string]LineParam{
	"sktm":   {R: 0.125, X: 0.097, Ampacity: 400},   // XLPE 3x240 mm2 Al
	"sutm":   {R: 0.2162, X: 0.3305, Ampacity: 425}, // AAAC 150 mm2
	"skutr":  {R: 0.443, X: 0.100, Ampacity: 196},   // LVTC 3x70+50 mm2
	"sktr":   {R: 0.268, X: 0.080, Ampacity: 206},   // NYFGbY 4x70 mm2
	"sr":     {R: 3.08, X: 0.100, Ampacity: 54},     // NFA2X 2x10 mm2
	"busbar": {R: 0, X: 0, Ampacity: 2000},
}

// PFParams adalah parameter perhitungan.
type PFParams struct {
	SourcePU        float64              `json:"source_pu"`         // tegangan kirim di kepala penyulang (pu)
	LoadFactor      float64              `json:"load_factor"`       // beban = daya kontrak x faktor ini
	PowerFactor     float64              `json:"power_factor"`      // cos phi beban
	VMinPU          float64              `json:"v_min_pu"`          // batas bawah tegangan
	VMaxPU          float64              `json:"v_max_pu"`          // batas atas tegangan
	TrafoZPct       float64              `json:"trafo_z_pct"`       // impedansi trafo distribusi (%)
	TrafoXR         float64              `json:"trafo_xr"`          // rasio X/R trafo
	DefaultTrafoKVA float64              `json:"default_trafo_kva"` // kapasitas trafo bila tidak ada data
	MaxIter         int                  `json:"max_iter"`
	Tol             float64              `json:"tol"`
	Lines           map[string]LineParam `json:"lines"`
}

// PFParamsFromConfig membaca parameter dari konfigurasi aplikasi (group powerflow).
func PFParamsFromConfig(cfg *repo.Configs) PFParams {
	p := PFParams{
		SourcePU:        cfg.Float("powerflow.source_pu", 1.0),
		LoadFactor:      cfg.Float("powerflow.load_factor", 0.6),
		PowerFactor:     cfg.Float("powerflow.power_factor", 0.85),
		VMinPU:          cfg.Float("powerflow.v_min_pu", 0.90),
		VMaxPU:          cfg.Float("powerflow.v_max_pu", 1.05),
		TrafoZPct:       cfg.Float("powerflow.trafo_z_pct", 4),
		TrafoXR:         cfg.Float("powerflow.trafo_xr", 3),
		DefaultTrafoKVA: cfg.Float("powerflow.default_trafo_kva", 200),
		MaxIter:         cfg.Int("powerflow.max_iter", 30),
		Tol:             cfg.Float("powerflow.tol", 1e-6),
		Lines:           map[string]LineParam{},
	}
	for k, v := range DefaultLineParams {
		p.Lines[k] = v
	}
	if raw := strings.TrimSpace(cfg.Str("powerflow.line_params", "")); raw != "" {
		var custom map[string]LineParam
		if json.Unmarshal([]byte(raw), &custom) == nil {
			for k, v := range custom {
				p.Lines[k] = v
			}
		}
	}
	return p
}

// Normalize membatasi parameter ke rentang yang masuk akal.
func (p *PFParams) Normalize() {
	clamp := func(v, lo, hi, def float64) float64 {
		if v <= 0 || math.IsNaN(v) {
			return def
		}
		return math.Max(lo, math.Min(hi, v))
	}
	p.SourcePU = clamp(p.SourcePU, 0.8, 1.2, 1.0)
	p.LoadFactor = clamp(p.LoadFactor, 0.01, 2.0, 0.6)
	p.PowerFactor = clamp(p.PowerFactor, 0.5, 1.0, 0.85)
	p.VMinPU = clamp(p.VMinPU, 0.5, 1.0, 0.9)
	p.VMaxPU = clamp(p.VMaxPU, 1.0, 1.5, 1.05)
	p.TrafoZPct = clamp(p.TrafoZPct, 0.5, 20, 4)
	p.TrafoXR = clamp(p.TrafoXR, 0.1, 20, 3)
	p.DefaultTrafoKVA = clamp(p.DefaultTrafoKVA, 10, 5000, 200)
	if p.MaxIter <= 0 || p.MaxIter > 200 {
		p.MaxIter = 30
	}
	if p.Tol <= 0 {
		p.Tol = 1e-6
	}
}

// PFOverrides adalah data per objek yang menggantikan nilai bawaan.
type PFOverrides struct {
	Lines    map[int64]LineParam // per edge; kolom 0 = pakai bawaan tipe
	TrafoKVA map[int64]float64   // per node trafo distribusi / gardu
}

// pfTree adalah salinan pohon satu penyulang (diambil di bawah read lock, dihitung tanpa lock).
type pfTree struct {
	head      int64
	ids       []int64
	parent    []int32 // indeks induk (-1 untuk akar)
	edge      []int64 // edge dari induk ke node ini
	edgeType  []string
	lengthM   []float32
	loadVA    []float64
	sink      []bool
	nodeType  []string
	meshSkip  int
	customers int
}

// ErrFeederNotEnergized: kepala penyulang tidak bertegangan / tidak ada di graf.
var ErrFeederNotEnergized = errors.New("feeder head not energized")

// ErrNotFeederHead: node bukan kepala penyulang (kubikel outgoing).
var ErrNotFeederHead = errors.New("not a feeder head")

// FeederHeads mengembalikan id seluruh kepala penyulang.
func (g *Graph) FeederHeads() []int64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]int64, 0, len(g.feeders))
	for h := range g.feeders {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// feederTree membangun pohon radial penyulang dari kondisi jaringan saat ini: mengikuti arah
// aliran (jarak sumber bertambah) melalui elemen tertutup. Sambungan yang membentuk loop
// (jaringan mesh) dilewati dan dihitung sebagai meshSkip.
func (g *Graph) feederTree(head int64) (*pfTree, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	hn, ok := g.nodes[head]
	if !ok {
		return nil, ErrNotFound
	}
	if _, isHead := g.feeders[head]; !isHead {
		return nil, ErrNotFeederHead
	}
	busbar, hasBusbar := g.typeIndex["busbar"]
	if _, reached := g.dist[head]; !reached || hn.open() {
		return nil, ErrFeederNotEnergized
	}
	t := &pfTree{head: head}
	index := map[int64]int32{}
	add := func(id int64, parent int32, eid int64, etype string, length float32) {
		n := g.nodes[id]
		index[id] = int32(len(t.ids))
		t.ids = append(t.ids, id)
		t.parent = append(t.parent, parent)
		t.edge = append(t.edge, eid)
		t.edgeType = append(t.edgeType, etype)
		t.lengthM = append(t.lengthM, length)
		t.nodeType = append(t.nodeType, g.typeName(n.typ))
		t.sink = append(t.sink, n.sink())
		if n.sink() {
			t.loadVA = append(t.loadVA, float64(n.loadVA))
			t.customers++
		} else {
			t.loadVA = append(t.loadVA, 0)
		}
	}
	add(head, -1, 0, "", 0)
	seenEdge := map[int64]struct{}{}
	for qi := 0; qi < len(t.ids); qi++ {
		cur := t.ids[qi]
		cn := g.nodes[cur]
		if cur != head && cn.open() {
			continue // switch terbuka: tidak meneruskan daya
		}
		d := g.dist[cur]
		for _, eid := range g.adj[cur] {
			if _, seen := seenEdge[eid]; seen {
				continue
			}
			seenEdge[eid] = struct{}{}
			e := g.edges[eid]
			if !g.passableLocked(cur, eid, e) {
				continue
			}
			if hasBusbar && e.typ == busbar {
				continue // busbar GI menghubungkan kubikel-kubikel: bukan bagian penyulang
			}
			nb := e.other(cur)
			if _, otherHead := g.feeders[nb]; otherHead {
				continue // kepala penyulang lain
			}
			nd, ok := g.dist[nb]
			if !ok {
				continue
			}
			if _, visited := index[nb]; visited {
				if nd >= d {
					t.meshSkip++ // loop: sambungan ke node yang sudah punya jalur
				}
				continue
			}
			if nd != d+1 {
				if nd > d {
					t.meshSkip++
				}
				continue // bukan arah hilir
			}
			add(nb, int32(qi), eid, g.typeName(e.typ), e.lengthM)
		}
	}
	return t, nil
}

// PFNode, PFEdge, PFTrafo adalah hasil per objek.
type PFNode struct {
	ID  int64   `json:"id"`
	VPU float64 `json:"v_pu"`
	KV  float64 `json:"v_kv"`
	LV  bool    `json:"lv"`
}

type PFEdge struct {
	ID         int64   `json:"id"`
	IA         float64 `json:"i_a"`
	Ampacity   float64 `json:"ampacity"`
	LoadingPct float64 `json:"loading_pct"`
	LossKW     float64 `json:"loss_kw"`
	LV         bool    `json:"lv"`
	VEndPU     float64 `json:"v_end_pu"` // tegangan di ujung hilir saluran
}

type PFTrafo struct {
	ID         int64   `json:"id"`
	RatedKVA   float64 `json:"rated_kva"`
	SKVA       float64 `json:"s_kva"`
	LoadingPct float64 `json:"loading_pct"`
	VSecPU     float64 `json:"v_sec_pu"`
	LossKW     float64 `json:"loss_kw"`
	Assumed    bool    `json:"assumed"` // kapasitas memakai nilai bawaan
}

// PFSummary adalah ringkasan satu penyulang.
type PFSummary struct {
	Head          int64   `json:"head_id"`
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	GI            int64   `json:"gi_id"`
	GICode        string  `json:"gi_code"`
	Status        string  `json:"status"` // ok | warning | critical | error
	Error         string  `json:"error,omitempty"`
	Nodes         int     `json:"nodes"`
	Customers     int     `json:"customers"`
	LoadKW        float64 `json:"load_kw"`
	LoadKVAr      float64 `json:"load_kvar"`
	SendKW        float64 `json:"send_kw"`
	SendKVAr      float64 `json:"send_kvar"`
	HeadCurrentA  float64 `json:"head_current_a"`
	LossKW        float64 `json:"loss_kw"`
	LossPct       float64 `json:"loss_pct"`
	VMinPU        float64 `json:"v_min_pu"`
	VMinNode      int64   `json:"v_min_node"`
	VMinMVPU      float64 `json:"v_min_mv_pu"`
	VMaxPU        float64 `json:"v_max_pu"`
	IMaxPct       float64 `json:"i_max_pct"`
	IMaxEdge      int64   `json:"i_max_edge"`
	TrafoMaxPct   float64 `json:"trafo_max_pct"`
	TrafoMaxNode  int64   `json:"trafo_max_node"`
	UnderV        int     `json:"under_v"`
	OverV         int     `json:"over_v"`
	Overload      int     `json:"overload"`
	TrafoOverload int     `json:"trafo_overload"`
	Iterations    int     `json:"iterations"`
	Converged     bool    `json:"converged"`
	MeshSkipped   int     `json:"mesh_skipped"`
	DurationMS    float64 `json:"duration_ms"`
}

// PFResult adalah hasil lengkap satu penyulang.
type PFResult struct {
	Summary PFSummary `json:"summary"`
	Nodes   []PFNode  `json:"nodes"`
	Edges   []PFEdge  `json:"edges"`
	Trafos  []PFTrafo `json:"trafos"`
}

func baseKV(types *Types, typeCode string) float64 {
	if ct, ok := types.Get(typeCode); ok && ct.VoltageKV >= 1 {
		return ct.VoltageKV
	}
	return 0.4
}

// solve menjalankan backward/forward sweep pada pohon penyulang.
func solve(t *pfTree, types *Types, p PFParams, ov PFOverrides, detail bool) PFResult {
	start := time.Now()
	n := len(t.ids)
	res := PFResult{Summary: PFSummary{Head: t.head, Nodes: n, Customers: t.customers, MeshSkipped: t.meshSkip, VMinPU: math.Inf(1), VMinMVPU: math.Inf(1)}}

	z := make([]complex128, n)   // impedansi edge dari induk (pu)
	lv := make([]bool, n)        // node / edge masuk berada di sisi TR
	kv := make([]float64, n)     // tegangan dasar node
	amp := make([]float64, n)    // KHA edge masuk
	rEdge := make([]float64, n)  // R edge (pu) untuk susut
	trans := make([]bool, n)     // node tempat MV->LV (trafo)
	ztr := make([]complex128, n) // impedansi trafo (pu) di node transisi
	trKVA := make([]float64, n)  // kapasitas trafo
	trAssumed := make([]bool, n) // kapasitas bawaan
	s := make([]complex128, n)   // beban (pu)
	kv[0] = baseKV(types, "sktm")
	if ct, ok := types.Get(t.nodeType[0]); ok && ct.VoltageKV >= 1 {
		kv[0] = ct.VoltageKV
	}
	sinPhi := math.Sqrt(1 - p.PowerFactor*p.PowerFactor)
	for i := 1; i < n; i++ {
		et := t.edgeType[i]
		kv[i] = baseKV(types, et)
		lv[i] = kv[i] < 1
		lp, ok := p.Lines[et]
		if !ok {
			lp = LineParam{} // tipe tanpa parameter: dianggap tanpa impedansi
		}
		if o, ok := ov.Lines[t.edge[i]]; ok {
			if o.R > 0 {
				lp.R = o.R
			}
			if o.X > 0 {
				lp.X = o.X
			}
			if o.Ampacity > 0 {
				lp.Ampacity = o.Ampacity
			}
		}
		zbase := kv[i] * kv[i] / pfSbaseMVA
		km := float64(t.lengthM[i]) / 1000
		z[i] = complex(lp.R*km/zbase, lp.X*km/zbase)
		rEdge[i] = real(z[i])
		amp[i] = lp.Ampacity
		par := t.parent[i]
		if lv[i] && !lv[par] && !trans[par] {
			trans[par] = true
			kva, found := ov.TrafoKVA[t.ids[par]]
			if !found || kva <= 0 {
				kva, trAssumed[par] = p.DefaultTrafoKVA, true
			}
			trKVA[par] = kva
			zpu := p.TrafoZPct / 100 * (pfSbaseMVA * 1000 / kva)
			r := zpu / math.Sqrt(1+p.TrafoXR*p.TrafoXR)
			ztr[par] = complex(r, r*p.TrafoXR)
		}
		if t.sink[i] && t.loadVA[i] > 0 {
			smva := t.loadVA[i] * p.LoadFactor / 1e6
			s[i] = complex(smva*p.PowerFactor/pfSbaseMVA, smva*sinPhi/pfSbaseMVA)
		}
	}
	if t.sink[0] && t.loadVA[0] > 0 {
		smva := t.loadVA[0] * p.LoadFactor / 1e6
		s[0] = complex(smva*p.PowerFactor, smva*sinPhi)
	}

	vs := complex(p.SourcePU, 0)
	v := make([]complex128, n)
	vsec := make([]complex128, n)
	ib := make([]complex128, n)
	isec := make([]complex128, n)
	for i := range v {
		v[i] = vs
		vsec[i] = vs
	}
	iter := 0
	converged := false
	for iter = 1; iter <= p.MaxIter; iter++ {
		// backward: arus beban lalu akumulasi ke hulu
		for i := 0; i < n; i++ {
			if s[i] != 0 && v[i] != 0 {
				ib[i] = cmplx.Conj(s[i] / v[i])
			} else {
				ib[i] = 0
			}
			isec[i] = 0
		}
		for i := n - 1; i > 0; i-- {
			par := t.parent[i]
			ib[par] += ib[i]
			if lv[i] && trans[par] {
				isec[par] += ib[i]
			}
		}
		// forward: jatuh tegangan dari sumber ke hilir
		maxDiff := 0.0
		v[0] = vs
		if trans[0] {
			vsec[0] = v[0] - isec[0]*ztr[0]
		}
		for i := 1; i < n; i++ {
			par := t.parent[i]
			src := v[par]
			if lv[i] && trans[par] {
				src = vsec[par]
			}
			nv := src - ib[i]*z[i]
			if d := cmplx.Abs(nv - v[i]); d > maxDiff {
				maxDiff = d
			}
			v[i] = nv
			if trans[i] {
				vsec[i] = v[i] - isec[i]*ztr[i]
			}
		}
		if maxDiff < p.Tol {
			converged = true
			break
		}
	}
	if iter > p.MaxIter {
		iter = p.MaxIter
	}
	sm := &res.Summary
	sm.Iterations, sm.Converged = iter, converged

	// hasil
	var loadP, loadQ, loss float64
	for i := 0; i < n; i++ {
		loadP += real(s[i])
		loadQ += imag(s[i])
		vm := cmplx.Abs(v[i])
		if vm < sm.VMinPU {
			sm.VMinPU, sm.VMinNode = vm, t.ids[i]
		}
		if !lv[i] && vm < sm.VMinMVPU {
			sm.VMinMVPU = vm
		}
		if vm > sm.VMaxPU {
			sm.VMaxPU = vm
		}
		if vm < p.VMinPU {
			sm.UnderV++
		}
		if vm > p.VMaxPU+1e-9 {
			sm.OverV++
		}
		if detail {
			res.Nodes = append(res.Nodes, PFNode{ID: t.ids[i], VPU: round(vm, 5), KV: round(vm*kv[i], 4), LV: lv[i]})
		}
		if i > 0 {
			ia := cmplx.Abs(ib[i]) * pfSbaseMVA * 1000 / (math.Sqrt(3) * kv[i])
			el := cmplx.Abs(ib[i]) * cmplx.Abs(ib[i]) * rEdge[i] * pfSbaseMVA * 1000
			loss += el
			pct := 0.0
			if amp[i] > 0 {
				pct = ia / amp[i] * 100
				if pct > sm.IMaxPct {
					sm.IMaxPct, sm.IMaxEdge = pct, t.edge[i]
				}
				if pct > 100 {
					sm.Overload++
				}
			}
			if detail {
				res.Edges = append(res.Edges, PFEdge{ID: t.edge[i], IA: round(ia, 2), Ampacity: amp[i], LoadingPct: round(pct, 1), LossKW: round(el, 4), LV: lv[i], VEndPU: round(vm, 5)})
			}
		}
		if trans[i] {
			sk := cmplx.Abs(vsec[i]*cmplx.Conj(isec[i])) * pfSbaseMVA * 1000
			tl := cmplx.Abs(isec[i]) * cmplx.Abs(isec[i]) * real(ztr[i]) * pfSbaseMVA * 1000
			loss += tl
			pct := sk / trKVA[i] * 100
			if pct > sm.TrafoMaxPct {
				sm.TrafoMaxPct, sm.TrafoMaxNode = pct, t.ids[i]
			}
			if pct > 100 {
				sm.TrafoOverload++
			}
			if vs := cmplx.Abs(vsec[i]); vs < sm.VMinPU {
				sm.VMinPU, sm.VMinNode = vs, t.ids[i]
			}
			if detail {
				res.Trafos = append(res.Trafos, PFTrafo{ID: t.ids[i], RatedKVA: trKVA[i], SKVA: round(sk, 2), LoadingPct: round(pct, 1),
					VSecPU: round(cmplx.Abs(vsec[i]), 5), LossKW: round(tl, 4), Assumed: trAssumed[i]})
			}
		}
	}
	send := v[0] * cmplx.Conj(ib[0])
	sm.LoadKW = round(loadP*pfSbaseMVA*1000, 2)
	sm.LoadKVAr = round(loadQ*pfSbaseMVA*1000, 2)
	sm.SendKW = round(real(send)*pfSbaseMVA*1000, 2)
	sm.SendKVAr = round(imag(send)*pfSbaseMVA*1000, 2)
	sm.HeadCurrentA = round(cmplx.Abs(ib[0])*pfSbaseMVA*1000/(math.Sqrt(3)*kv[0]), 2)
	sm.LossKW = round(loss, 3)
	if sm.SendKW > 0 {
		sm.LossPct = round(loss/sm.SendKW*100, 3)
	}
	if math.IsInf(sm.VMinPU, 1) {
		sm.VMinPU = p.SourcePU
	}
	if math.IsInf(sm.VMinMVPU, 1) {
		sm.VMinMVPU = p.SourcePU
	}
	sm.VMinPU, sm.VMaxPU, sm.VMinMVPU = round(sm.VMinPU, 5), round(sm.VMaxPU, 5), round(sm.VMinMVPU, 5)
	sm.IMaxPct, sm.TrafoMaxPct = round(sm.IMaxPct, 1), round(sm.TrafoMaxPct, 1)
	switch {
	case !converged:
		sm.Status = "critical"
	case sm.UnderV > 0 || sm.OverV > 0 || sm.Overload > 0 || sm.TrafoOverload > 0:
		sm.Status = "critical"
	case sm.VMinPU < p.VMinPU+0.05 || sm.IMaxPct >= 60 || sm.TrafoMaxPct >= 60:
		// sama dengan pita warna peta: tegangan <= 5% di atas batas bawah atau pembebanan >= 60%
		sm.Status = "warning"
	default:
		sm.Status = "ok"
	}
	sm.DurationMS = round(float64(time.Since(start).Microseconds())/1000, 3)
	return res
}

func round(v float64, digits int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	f := math.Pow(10, float64(digits))
	return math.Round(v*f) / f
}

// ---------------------------------------------------------------------
// layanan
// ---------------------------------------------------------------------

// PowerFlow menjalankan perhitungan aliran daya dan menyimpan hasil hitung semua penyulang terakhir.
type PowerFlow struct {
	pool  *pgxpool.Pool
	graph *Graph
	types *Types
	cfg   *repo.Configs

	ovMu sync.Mutex
	ov   *PFOverrides
	ovAt time.Time

	runMu   sync.Mutex // satu hitung-semua pada satu waktu
	lastMu  sync.RWMutex
	last    []PFSummary
	lastAt  time.Time
	lastPar PFParams
	lastMS  float64
}

// NewPowerFlow membuat layanan aliran daya.
func NewPowerFlow(pool *pgxpool.Pool, graph *Graph, types *Types, cfg *repo.Configs) *PowerFlow {
	return &PowerFlow{pool: pool, graph: graph, types: types, cfg: cfg}
}

// Params mengembalikan parameter bawaan dari konfigurasi.
func (pf *PowerFlow) Params() PFParams {
	p := PFParamsFromConfig(pf.cfg)
	p.Normalize()
	return p
}

// overrides memuat parameter khusus per saluran dan kapasitas trafo (cache 60 detik).
func (pf *PowerFlow) overrides(ctx context.Context) (PFOverrides, error) {
	pf.ovMu.Lock()
	defer pf.ovMu.Unlock()
	if pf.ov != nil && time.Since(pf.ovAt) < time.Minute {
		return *pf.ov, nil
	}
	ov := PFOverrides{Lines: map[int64]LineParam{}, TrafoKVA: map[int64]float64{}}
	rows, err := pf.pool.Query(ctx, `SELECT id, COALESCE(qgis_num(properties->>'r_ohm_km'),0), COALESCE(qgis_num(properties->>'x_ohm_km'),0),
			COALESCE(qgis_num(properties->>'kha_a'),0)
		FROM gis_edges WHERE properties ?| array['r_ohm_km','x_ohm_km','kha_a']`)
	if err != nil {
		return ov, err
	}
	for rows.Next() {
		var id int64
		var lp LineParam
		if err := rows.Scan(&id, &lp.R, &lp.X, &lp.Ampacity); err != nil {
			rows.Close()
			return ov, err
		}
		ov.Lines[id] = lp
	}
	rows.Close()
	rows, err = pf.pool.Query(ctx, `SELECT id, qgis_num(properties->>'daya_kva') FROM gis_nodes
		WHERE type_code IN ('trafo_distribusi','gd') AND properties ? 'daya_kva'`)
	if err != nil {
		return ov, err
	}
	for rows.Next() {
		var id int64
		var kva *float64
		if err := rows.Scan(&id, &kva); err != nil {
			rows.Close()
			return ov, err
		}
		if kva != nil && *kva > 0 {
			ov.TrafoKVA[id] = *kva
		}
	}
	rows.Close()
	pf.ov, pf.ovAt = &ov, time.Now()
	return ov, nil
}

// InvalidateOverrides memaksa pemuatan ulang data khusus (setelah atribut diubah).
func (pf *PowerFlow) InvalidateOverrides() {
	pf.ovMu.Lock()
	pf.ov = nil
	pf.ovMu.Unlock()
}

// Feeder menghitung satu penyulang secara lengkap (per node / edge / trafo).
func (pf *PowerFlow) Feeder(ctx context.Context, head int64, p PFParams) (PFResult, error) {
	p.Normalize()
	ov, err := pf.overrides(ctx)
	if err != nil {
		return PFResult{}, err
	}
	t, err := pf.graph.feederTree(head)
	if err != nil {
		return PFResult{}, err
	}
	res := solve(t, pf.types, p, ov, true)
	if fi, ok := pf.graph.FeederOf(head); ok {
		res.Summary.GI = fi.GI
	}
	return res, nil
}

// RunAll menghitung seluruh penyulang (paralel) dan menyimpan ringkasannya.
func (pf *PowerFlow) RunAll(ctx context.Context, p PFParams) ([]PFSummary, float64, error) {
	pf.runMu.Lock()
	defer pf.runMu.Unlock()
	p.Normalize()
	start := time.Now()
	ov, err := pf.overrides(ctx)
	if err != nil {
		return nil, 0, err
	}
	heads := pf.graph.FeederHeads()
	out := make([]PFSummary, len(heads))
	workers := runtime.NumCPU()
	if workers > 4 {
		workers = 4
	}
	if workers < 1 {
		workers = 1
	}
	var wg sync.WaitGroup
	next := make(chan int)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				h := heads[i]
				t, err := pf.graph.feederTree(h)
				if err != nil {
					out[i] = PFSummary{Head: h, Status: "error", Error: err.Error()}
				} else {
					out[i] = solve(t, pf.types, p, ov, false).Summary
				}
				if fi, ok := pf.graph.FeederOf(h); ok {
					out[i].GI = fi.GI
				}
			}
		}()
	}
	for i := range heads {
		if ctx.Err() != nil {
			break
		}
		next <- i
	}
	close(next)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	ms := float64(time.Since(start).Milliseconds())
	pf.lastMu.Lock()
	pf.last, pf.lastAt, pf.lastPar, pf.lastMS = out, time.Now(), p, ms
	pf.lastMu.Unlock()
	return out, ms, nil
}

// Last mengembalikan hasil hitung semua penyulang terakhir.
func (pf *PowerFlow) Last() ([]PFSummary, time.Time, PFParams, float64) {
	pf.lastMu.RLock()
	defer pf.lastMu.RUnlock()
	return pf.last, pf.lastAt, pf.lastPar, pf.lastMS
}

// PFWorst mengembalikan node bertegangan terendah dan saluran berbeban tertinggi.
func PFWorst(r PFResult, n int) ([]PFNode, []PFEdge) {
	nodes := append([]PFNode{}, r.Nodes...)
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].VPU < nodes[j].VPU })
	if len(nodes) > n {
		nodes = nodes[:n]
	}
	edges := append([]PFEdge{}, r.Edges...)
	sort.Slice(edges, func(i, j int) bool { return edges[i].LoadingPct > edges[j].LoadingPct })
	if len(edges) > n {
		edges = edges[:n]
	}
	return nodes, edges
}

// GeoJSON menyusun fitur ringan (geometri + kode + hasil hitung) untuk pewarnaan peta.
// Trafo membawa pembebanan; node membawa tegangan; edge membawa arus & pembebanan.
func (pf *PowerFlow) GeoJSON(ctx context.Context, r PFResult) (map[string]any, error) {
	nodeIDs := make([]int64, len(r.Nodes))
	vByID := make(map[int64]PFNode, len(r.Nodes))
	for i, n := range r.Nodes {
		nodeIDs[i] = n.ID
		vByID[n.ID] = n
	}
	trByID := make(map[int64]PFTrafo, len(r.Trafos))
	for _, t := range r.Trafos {
		trByID[t.ID] = t
	}
	edgeIDs := make([]int64, len(r.Edges))
	eByID := make(map[int64]PFEdge, len(r.Edges))
	for i, e := range r.Edges {
		edgeIDs[i] = e.ID
		eByID[e.ID] = e
	}
	features := make([]map[string]any, 0, len(nodeIDs)+len(edgeIDs))
	rows, err := pf.pool.Query(ctx, `SELECT id, type_code, code, ST_AsGeoJSON(geom, 7) FROM gis_edges WHERE id = ANY($1::bigint[])`, edgeIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var tc, code, geom string
		if err := rows.Scan(&id, &tc, &code, &geom); err != nil {
			rows.Close()
			return nil, err
		}
		e := eByID[id]
		features = append(features, map[string]any{"type": "Feature", "id": id, "geometry": json.RawMessage(geom),
			"properties": map[string]any{"kind": "edge", "type_code": tc, "code": code, "i_a": e.IA, "ampacity": e.Ampacity, "loading_pct": e.LoadingPct, "loss_kw": e.LossKW, "lv": e.LV, "v_pu": e.VEndPU}})
	}
	rows.Close()
	rows, err = pf.pool.Query(ctx, `SELECT id, type_code, code, ST_AsGeoJSON(geom, 7) FROM gis_nodes WHERE id = ANY($1::bigint[])`, nodeIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var tc, code, geom string
		if err := rows.Scan(&id, &tc, &code, &geom); err != nil {
			rows.Close()
			return nil, err
		}
		n := vByID[id]
		props := map[string]any{"kind": "node", "type_code": tc, "code": code, "v_pu": n.VPU, "v_kv": n.KV, "lv": n.LV}
		if t, ok := trByID[id]; ok {
			props["trafo_loading_pct"], props["trafo_s_kva"], props["trafo_kva"], props["v_sec_pu"] = t.LoadingPct, t.SKVA, t.RatedKVA, t.VSecPU
		}
		features = append(features, map[string]any{"type": "Feature", "id": id, "geometry": json.RawMessage(geom), "properties": props})
	}
	rows.Close()
	return map[string]any{"type": "FeatureCollection", "features": features}, rows.Err()
}
