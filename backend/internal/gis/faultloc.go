package gis

import (
	"errors"
	"math"
	"math/cmplx"
	"sort"
	"strings"
)

// =====================================================================
// Estimasi lokasi gangguan dari arus gangguan relai (distance-to-fault).
//
// Dari alat yang trip (PMT / recloser / kubikel), arus gangguan hitungan di setiap titik jaringan TM
// hilirnya dibandingkan dengan arus yang terbaca relai. Model hubung singkat simetris (IEC 60909
// disederhanakan, tanpa arus beban):
//   3 fasa     : I = V_f / |Z1s + Z1l + Rf|
//   fasa-fasa  : I = √3·V_f / |2(Z1s + Z1l) + Rf|
//   fasa-tanah : I = 3·V_f / |2(Z1s + Z1l) + (Z0s + Z0l) + 3(R_NGR + Rf)|
// dengan Z1s dari daya hubung singkat busbar GI, Z1l impedansi saluran (per tipe / per saluran),
// Z0l = k0·Z1l. Karena arus turun menurut jarak, titik yang cocok dicari di setiap cabang; jaringan
// bercabang bisa memberi beberapa kandidat.
// =====================================================================

// FaultLocParams adalah masukan estimasi lokasi gangguan.
type FaultLocParams struct {
	DeviceID  int64   `json:"device_id"`
	FaultType string  `json:"fault_type"` // auto | 3ph | 2ph | 1ph
	CurrentA  float64 `json:"current_a"`  // arus gangguan terbaca (A)
	Ia        float64 `json:"ia"`
	Ib        float64 `json:"ib"`
	Ic        float64 `json:"ic"`
	In        float64 `json:"in"`         // arus residu / netral (3·I0)
	SourceMVA float64 `json:"source_mva"` // daya hubung singkat 3 fasa di busbar TM GI
	SourceXR  float64 `json:"source_xr"`
	KV        float64 `json:"kv"`        // tegangan nominal fasa-fasa (kV)
	NGROhm    float64 `json:"ngr_ohm"`   // tahanan pentanahan netral trafo GI
	FaultOhm  float64 `json:"fault_ohm"` // tahanan gangguan
	Z0Ratio   float64 `json:"z0_ratio"`  // Z0 saluran ÷ Z1 saluran
	TolPct    float64 `json:"tol_pct"`   // toleransi pencocokan arus (%)
}

// FaultCandidate adalah satu titik dugaan gangguan.
type FaultCandidate struct {
	EdgeID    int64   `json:"edge_id"`
	Frac      float64 `json:"frac"` // posisi sepanjang geometri saluran (0 = titik awal geometri)
	DistanceM float64 `json:"distance_m"`
	ICalcA    float64 `json:"i_calc_a"`
	FromNode  int64   `json:"from_node"` // ujung hulu (arah dari alat)
	ToNode    int64   `json:"to_node"`
	Zone      int64   `json:"zone_id,omitempty"`
	GD        int64   `json:"gd_id,omitempty"`
	BandMinM  float64 `json:"band_min_m"` // rentang jarak dengan arus dalam toleransi pada cabang ini
	BandMaxM  float64 `json:"band_max_m"`
}

// FaultLocResult adalah hasil estimasi.
type FaultLocResult struct {
	DeviceID    int64            `json:"device_id"`
	FaultType   string           `json:"fault_type"`
	AutoType    bool             `json:"auto_type"`
	MeasuredA   float64          `json:"measured_a"`
	IMaxA       float64          `json:"i_max_a"` // arus gangguan hitungan tepat di alat
	IMinA       float64          `json:"i_min_a"` // arus gangguan hitungan terkecil (ujung terjauh)
	FarthestM   float64          `json:"farthest_m"`
	Candidates  []FaultCandidate `json:"candidates"`
	BandEdges   []int64          `json:"band_edges"`
	Nodes       int              `json:"nodes"`
	Warnings    []string         `json:"warnings"`
	Params      FaultLocParams   `json:"params"`
	Z1SourceOhm [2]float64       `json:"z1_source_ohm"` // R, X
}

// Galat estimasi lokasi gangguan.
var (
	ErrFaultCurrent = errors.New("fault current required")
	ErrFaultDevice  = errors.New("device not found")
)

// Normalize melengkapi & membatasi parameter.
func (p *FaultLocParams) Normalize() {
	def := func(v, d float64) float64 {
		if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return d
		}
		return v
	}
	p.SourceMVA = def(p.SourceMVA, 500)
	p.SourceXR = def(p.SourceXR, 10)
	p.KV = def(p.KV, 20)
	p.Z0Ratio = def(p.Z0Ratio, 3)
	p.TolPct = math.Min(def(p.TolPct, 10), 50)
	if p.NGROhm < 0 {
		p.NGROhm = 0
	}
	if p.FaultOhm < 0 {
		p.FaultOhm = 0
	}
	p.FaultType = strings.ToLower(strings.TrimSpace(p.FaultType))
}

// DetectFaultType menebak jenis gangguan dari arus per fasa & residu; mengembalikan jenis dan arus acuan.
func DetectFaultType(ia, ib, ic, in float64) (string, float64) {
	ph := []float64{ia, ib, ic}
	sort.Float64s(ph)
	mx := ph[2]
	switch {
	case mx <= 0 && in > 0:
		return "1ph", in
	case in > 0 && in >= 0.3*mx:
		return "1ph", math.Max(in, 0) // gangguan tanah: arus gangguan = 3·I0
	case mx > 0 && ph[1] >= 0.5*mx && ph[0] < 0.3*mx:
		return "2ph", mx
	}
	return "3ph", mx
}

// faultCurrent menghitung arus gangguan (A) untuk impedansi saluran kumulatif z1l / z0l (ohm).
func (p FaultLocParams) faultCurrent(kind string, z1s, z0s, z1l, z0l complex128) float64 {
	vf := p.KV * 1000 / math.Sqrt(3)
	rf := complex(p.FaultOhm, 0)
	switch kind {
	case "2ph":
		return math.Sqrt(3) * vf / cmplx.Abs(2*(z1s+z1l)+rf)
	case "1ph":
		return 3 * vf / cmplx.Abs(2*(z1s+z1l)+(z0s+z0l)+3*complex(p.NGROhm+p.FaultOhm, 0))
	}
	return vf / cmplx.Abs(z1s+z1l+rf)
}

// FaultLocate mengestimasi lokasi gangguan di hilir alat berdasarkan arus gangguan relai.
// lines: parameter penghantar per tipe; ov: parameter khusus per saluran (R/X 0 = pakai tipe).
func (g *Graph) FaultLocate(p FaultLocParams, lines map[string]LineParam, ov map[int64]LineParam) (*FaultLocResult, error) {
	p.Normalize()
	res := &FaultLocResult{DeviceID: p.DeviceID, Candidates: []FaultCandidate{}, BandEdges: []int64{}, Warnings: []string{}}
	switch p.FaultType {
	case "3ph", "2ph", "1ph":
		if p.CurrentA <= 0 {
			if p.Ia > 0 || p.Ib > 0 || p.Ic > 0 || p.In > 0 {
				_, p.CurrentA = DetectFaultType(p.Ia, p.Ib, p.Ic, p.In)
				if p.FaultType == "1ph" && p.In > 0 {
					p.CurrentA = p.In
				}
			}
		}
	default:
		if p.Ia > 0 || p.Ib > 0 || p.Ic > 0 || p.In > 0 {
			p.FaultType, p.CurrentA = DetectFaultType(p.Ia, p.Ib, p.Ic, p.In)
			res.AutoType = true
		} else {
			p.FaultType = "3ph"
			res.Warnings = append(res.Warnings, "type_assumed")
		}
	}
	if p.CurrentA <= 0 {
		return nil, ErrFaultCurrent
	}
	res.FaultType, res.MeasuredA, res.Params = p.FaultType, p.CurrentA, p

	// impedansi sumber (ohm) dari daya hubung singkat busbar TM
	zmag := p.KV * p.KV / p.SourceMVA
	rs := zmag / math.Sqrt(1+p.SourceXR*p.SourceXR)
	z1s := complex(rs, rs*p.SourceXR)
	z0s := z1s
	res.Z1SourceOhm = [2]float64{real(z1s), imag(z1s)}

	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.loading {
		return nil, ErrGraphLoading
	}
	if _, ok := g.nodes[p.DeviceID]; !ok {
		return nil, ErrFaultDevice
	}
	ndist, _ := g.normalDistLocked()
	// penelusuran dibatasi pada penyulang alat (tidak menyeberang ke penyulang lain lewat gardu hubung)
	feed := g.nodes[p.DeviceID].feeder
	lvLine := make([]bool, len(g.typeNames))
	for i, name := range g.typeNames {
		ct, _ := g.types.Get(name)
		lvLine[i] = ct.GeomKind == "line" && ct.VoltageKV > 0 && ct.VoltageKV < 1
	}
	cur := func(z1, z0 complex128) float64 { return p.faultCurrent(p.FaultType, z1s, z0s, z1, z0) }
	tol := p.TolPct / 100
	lo, hi := p.CurrentA*(1-tol), p.CurrentA*(1+tol)
	res.IMaxA = cur(0, 0)
	res.IMinA = res.IMaxA

	type st struct {
		id     int64
		z1, z0 complex128
		dist   float64
	}
	seen := map[int64]bool{p.DeviceID: true}
	q := []st{{id: p.DeviceID}}
	// rentang toleransi per cabang dicatat pada kandidat yang ditemukan di cabang tersebut
	for i := 0; i < len(q) && i < 500000; i++ {
		c := q[i]
		res.Nodes++
		ic := cur(c.z1, c.z0)
		if ic < res.IMinA {
			res.IMinA = ic
		}
		if c.dist > res.FarthestM {
			res.FarthestM = c.dist
		}
		cn := g.nodes[c.id]
		// alat terbuka posisi normal (tie) membatasi penyulang
		if c.id != p.DeviceID && cn.isSwitch() && cn.flags&flagNormalOpen != 0 {
			continue
		}
		dc, ok := ndist[c.id]
		if !ok {
			continue
		}
		for _, eid := range g.adj[c.id] {
			e := g.edges[eid]
			nb := e.other(c.id)
			if seen[nb] || lvLine[e.typ] {
				continue
			}
			if feed != 0 && g.nodes[nb].feeder != feed {
				continue
			}
			if dn, ok := ndist[nb]; !ok || dn <= dc {
				continue
			}
			lp, has := ov[eid]
			if !has || (lp.R == 0 && lp.X == 0) {
				lp = lines[g.typeNames[e.typ]]
			}
			km := float64(e.lengthM) / 1000
			ze := complex(lp.R*km, lp.X*km)
			z1v, z0v := c.z1+ze, c.z0+ze*complex(p.Z0Ratio, 0)
			iu, iv := ic, cur(z1v, z0v)
			distV := c.dist + float64(e.lengthM)
			// saluran dengan arus dalam toleransi
			if math.Max(iu, iv) >= lo && math.Min(iu, iv) <= hi && e.lengthM > 0 {
				res.BandEdges = append(res.BandEdges, eid)
			}
			// titik tepat: arus hitungan melewati arus terukur di sepanjang saluran
			if iu >= p.CurrentA && iv <= p.CurrentA && e.lengthM > 0 {
				a, b := 0.0, 1.0
				for k := 0; k < 40; k++ {
					m := (a + b) / 2
					if cur(c.z1+ze*complex(m, 0), c.z0+ze*complex(m*p.Z0Ratio, 0)) > p.CurrentA {
						a = m
					} else {
						b = m
					}
				}
				f := (a + b) / 2
				geo := f
				if e.from != c.id {
					geo = 1 - f
				}
				// rentang toleransi pada cabang ini (perkiraan linier terhadap jarak di sekitar titik)
				d := c.dist + f*float64(e.lengthM)
				slope := (iu - iv) / math.Max(float64(e.lengthM), 1) // A per meter
				band := 0.0
				if slope > 0 {
					band = tol * p.CurrentA / slope
				}
				nv := g.nodes[nb]
				res.Candidates = append(res.Candidates, FaultCandidate{EdgeID: eid, Frac: geo, DistanceM: d, ICalcA: p.CurrentA,
					FromNode: c.id, ToNode: nb, Zone: nv.zone, GD: nv.gd, BandMinM: math.Max(0, d-band), BandMaxM: d + band})
			}
			seen[nb] = true
			q = append(q, st{id: nb, z1: z1v, z0: z0v, dist: distV})
		}
	}
	switch {
	case p.CurrentA > res.IMaxA*(1+tol):
		res.Warnings = append(res.Warnings, "above_max")
	case p.CurrentA < res.IMinA*(1-tol) && len(res.Candidates) == 0:
		res.Warnings = append(res.Warnings, "below_min")
	case len(res.Candidates) == 0 && p.CurrentA >= res.IMaxA:
		res.Warnings = append(res.Warnings, "at_device")
	}
	if len(res.Candidates) > 1 {
		res.Warnings = append(res.Warnings, "multiple")
	}
	// arus hampir tidak berubah menurut jarak (mis. gangguan tanah dibatasi NGR besar): jarak kurang andal
	if res.IMaxA > 0 && (res.IMaxA-res.IMinA)/res.IMaxA < 2*tol {
		res.Warnings = append(res.Warnings, "low_sensitivity")
	}
	sort.Slice(res.Candidates, func(i, j int) bool { return res.Candidates[i].DistanceM < res.Candidates[j].DistanceM })
	if len(res.Candidates) > 50 {
		res.Candidates = res.Candidates[:50]
	}
	return res, nil
}
