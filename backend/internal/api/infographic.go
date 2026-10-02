package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
)

// ---------------------------------------------------------------------
// Dashboard › Infografis: pemulihan kelistrikan per periode. Satu kejadian induk (parent_id kosong) beserta
// kejadian lanjutannya (sisa padam sesudah pemulihan sebagian) = satu event. Terdampak = isi kejadian induk;
// padam = isi kejadian yang masih aktif; nyala = terdampak − padam.
// ---------------------------------------------------------------------

type infoCount struct {
	Terdampak float64 `json:"terdampak"`
	Padam     float64 `json:"padam"`
	Nyala     float64 `json:"nyala"`
}

func (x *infoCount) add(v float64, root, active bool) {
	if root {
		x.Terdampak += v
	}
	if active {
		x.Padam += v
	}
}

func (x *infoCount) finish() {
	x.Nyala = x.Terdampak - x.Padam
	if x.Nyala < 0 {
		x.Nyala = 0
	}
}

// infoSum: bagian ringkasan kejadian (kolom summary) yang dipakai infografis.
type infoSum struct {
	GI        []gis.CodeName `json:"gi"`
	TrafoGI   []gis.CodeName `json:"trafo_gi"`
	Feeders   []gis.CodeName `json:"penyulang"`
	Zones     []gis.CodeName `json:"zona"`
	GD        int            `json:"gd"`
	Customers int            `json:"pelanggan"`
	ParentGI  []int64        `json:"parent_gi_ids"`
}

type infoEvent struct {
	ID        int64      `json:"id"`
	RootID    int64      `json:"root_id"`
	ParentID  *int64     `json:"parent_id"`
	Kind      string     `json:"kind"`
	Level     string     `json:"level"`
	CauseCode string     `json:"cause_code"`
	CauseType string     `json:"cause_type"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at"`
	Customers int        `json:"customers"`
	LoadMW    float64    `json:"load_mw"`
	Momentary bool       `json:"momentary"`
}

// infoObj: satu objek terdampak dalam satu event (gabungan kejadian induk & lanjutannya).
type infoObj struct {
	EventID   int64      `json:"event_id"`
	ID        int64      `json:"id"`
	Code      string     `json:"code"`
	Name      string     `json:"name"`
	UP3       string     `json:"up3"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at"`
	Minutes   float64    `json:"minutes"`
	Active    bool       `json:"active"`
	// pelanggan
	Type     string  `json:"type,omitempty"`
	Priority string  `json:"priority,omitempty"`
	Address  string  `json:"address,omitempty"`
	GDCode   string  `json:"gd_code,omitempty"`
	Feeder   string  `json:"feeder_code,omitempty"`
	PowerVA  float64 `json:"power_va,omitempty"` // daya pelanggan / kapasitas trafo (VA)
	lng, lat float64
	up3ID    int64
}

type infoUP3 struct {
	ID        int64                `json:"id"`
	Name      string               `json:"name"`
	Customers int                  `json:"customers"`
	GD        infoCount            `json:"gd"`
	Rel       gis.ReliabilityGroup `json:"rel"`
}

var infoPriorities = []string{"VVIP", "VIP", "KTT", "Prioritas"}

// infoRoot: pilihan "No. kejadian" (kejadian induk).
type infoRoot struct {
	ID        int64     `json:"id"`
	Kind      string    `json:"kind"`
	CauseCode string    `json:"cause_code"`
	StartedAt time.Time `json:"started_at"`
	Active    bool      `json:"active"`
}

// infoSel: kejadian pada periode & filter (jenis, nomor kejadian) beserta rantai induknya. Dipakai bersama oleh
// infografis dan log per halaman.
type infoSel struct {
	rc         *relCalc
	period     string
	kind       string
	outageID   int64
	now        time.Time
	idx        map[int64]int // id kejadian → indeks rc.outages
	rootIDs    []int64       // sejajar rc.outages: id kejadian induk paling atas yang ikut termuat
	activeRoot map[int64]bool
	roots      []infoRoot
	sel        []int     // indeks rc.outages yang terpilih
	sums       []infoSum // sejajar sel
	events     []infoEvent
	selIDs     []int64
	rootSel    []int64 // id kejadian induk di dalam sel
	evByID     map[int64]infoEvent
}

func (is *infoSel) isRoot(o gis.OutageRecord) bool {
	if o.ParentID == nil {
		return true
	}
	_, ok := is.idx[*o.ParentID]
	return !ok
}

// infoSelect memuat kejadian periode lalu menyaring menurut jenis (kind) & nomor kejadian induk (outage).
func (s *Server) infoSelect(c *gin.Context) (*infoSel, error) {
	from, to, period := reliabilityPeriod(c)
	rc, err := s.loadRel(c.Request.Context(), from, to)
	if err != nil {
		return nil, err
	}
	is := &infoSel{rc: rc, period: period, now: time.Now(), kind: strings.ToUpper(strings.TrimSpace(c.Query("kind"))),
		idx: make(map[int64]int, len(rc.outages)), rootIDs: make([]int64, len(rc.outages)), activeRoot: map[int64]bool{},
		roots: []infoRoot{}, evByID: map[int64]infoEvent{}}
	is.outageID, _ = strconv.ParseInt(c.Query("outage"), 10, 64)
	for i, o := range rc.outages {
		is.idx[o.ID] = i
	}
	for i, o := range rc.outages {
		cur := o
		for guard := 0; cur.ParentID != nil && guard < 64; guard++ {
			j, ok := is.idx[*cur.ParentID]
			if !ok {
				break
			}
			cur = rc.outages[j]
		}
		is.rootIDs[i] = cur.ID
		if o.EndedAt == nil {
			is.activeRoot[cur.ID] = true
		}
	}
	for i, o := range rc.outages {
		ro := rc.outages[is.idx[is.rootIDs[i]]]
		if is.kind != "" && strings.ToUpper(ro.Kind) != is.kind {
			continue
		}
		if is.isRoot(o) {
			is.roots = append(is.roots, infoRoot{ID: o.ID, Kind: o.Kind, CauseCode: o.CauseNodeCode, StartedAt: o.StartedAt})
		}
		if is.outageID != 0 && is.rootIDs[i] != is.outageID {
			continue
		}
		is.sel = append(is.sel, i)
	}
	for i := range is.roots {
		is.roots[i].Active = is.activeRoot[is.roots[i].ID]
	}
	sort.Slice(is.roots, func(i, j int) bool { return is.roots[i].StartedAt.After(is.roots[j].StartedAt) })
	is.sums = make([]infoSum, len(is.sel))
	for k, i := range is.sel {
		o := rc.outages[i]
		_ = json.Unmarshal(o.Summary, &is.sums[k])
		is.selIDs = append(is.selIDs, o.ID)
		if is.isRoot(o) {
			is.rootSel = append(is.rootSel, o.ID)
		}
		e := infoEvent{ID: o.ID, RootID: is.rootIDs[i], ParentID: o.ParentID, Kind: o.Kind, Level: o.Level, CauseCode: o.CauseNodeCode,
			CauseType: o.CauseNodeType, StartedAt: o.StartedAt, EndedAt: o.EndedAt, Customers: is.sums[k].Customers, LoadMW: o.LoadKW / 1000, Momentary: o.Momentary}
		is.events = append(is.events, e)
		is.evByID[o.ID] = e
	}
	return is, nil
}

// merge menggabungkan baris (kejadian, objek) per event induk: mulai = paling awal, aktif bila ada kejadian aktif yang
// memuatnya, nyala = selesai kejadian terakhir yang memuatnya. Yang masih padam di atas, lalu terbaru.
func (is *infoSel) merge(rows []infoObj, up3Name func(int64) string) []infoObj {
	type key struct{ ev, id int64 }
	m := map[key]*infoObj{}
	order := []key{}
	for _, r := range rows {
		e, ok := is.evByID[r.EventID]
		if !ok {
			continue
		}
		k := key{e.RootID, r.ID}
		x := m[k]
		if x == nil {
			cp := r
			cp.EventID = e.RootID
			cp.StartedAt = e.StartedAt
			m[k] = &cp
			order = append(order, k)
			x = &cp
		}
		if e.StartedAt.Before(x.StartedAt) {
			x.StartedAt = e.StartedAt
		}
		if e.EndedAt == nil {
			x.Active = true
		} else if x.EndedAt == nil || e.EndedAt.After(*x.EndedAt) {
			t := *e.EndedAt
			x.EndedAt = &t
		}
	}
	out := make([]infoObj, 0, len(order))
	for _, k := range order {
		x := m[k]
		if x.Active {
			x.EndedAt = nil
		}
		end := is.now
		if x.EndedAt != nil {
			end = *x.EndedAt
		}
		x.Minutes = end.Sub(x.StartedAt).Minutes()
		x.UP3 = up3Name(x.up3ID)
		out = append(out, *x)
	}
	// urutan tetap (penting untuk halaman): masih padam dulu, terbaru, lalu kejadian, kode, id
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Active != b.Active {
			return a.Active
		}
		if !a.StartedAt.Equal(b.StartedAt) {
			return a.StartedAt.After(b.StartedAt)
		}
		if a.EventID != b.EventID {
			return a.EventID > b.EventID
		}
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		return a.ID < b.ID
	})
	return out
}

var infoLogLevels = []string{"gi", "trafo_gi", "penyulang", "zona", "gd", "trafo", "pelanggan"}

var infoLogWhere = map[string]string{
	"gd":        `n.type_code = 'gd'`,
	"trafo":     `n.type_code = 'trafo_distribusi'`,
	"pelanggan": `n.type_code LIKE 'pelanggan%'`,
}

// infoLog: baris log satu level (digabung per event & diurutkan), opsional disaring kata kunci (kode / nama / IDPEL).
// limit membatasi baris mentah node terdampak (0 = semua); truncated = ada baris yang tidak terbaca.
func (s *Server) infoLog(ctx context.Context, is *infoSel, level, q string, up3Name func(int64) string, limit int) ([]infoObj, bool, error) {
	if where, ok := infoLogWhere[level]; ok {
		// UP3 (uji poligon per baris) hanya dihitung untuk gardu: dipakai rekap gardu per UP3; trafo & pelanggan diisi per halaman
		rows, err := s.infoAffected(ctx, is.selIDs, where, q, limit, level == "gd")
		if err != nil {
			return nil, false, err
		}
		return is.merge(rows, up3Name), limit > 0 && len(rows) >= limit, nil
	}
	ql := strings.ToLower(q)
	rows := []infoObj{}
	ids := map[int64]bool{}
	for k, i := range is.sel {
		o := is.rc.outages[i]
		var list []gis.CodeName
		switch level {
		case "gi":
			list = is.sums[k].GI
		case "trafo_gi":
			list = is.sums[k].TrafoGI
		case "penyulang":
			list = is.sums[k].Feeders
		case "zona":
			list = is.sums[k].Zones
		}
		for _, x := range list {
			if ql != "" && !strings.Contains(strings.ToLower(x.Code+" "+x.Name), ql) {
				continue
			}
			rows = append(rows, infoObj{EventID: o.ID, ID: x.ID, Code: x.Code, Name: x.Name})
			ids[x.ID] = true
		}
	}
	pos, err := s.infoNodePos(ctx, keys(ids))
	if err != nil {
		return nil, false, err
	}
	for i := range rows {
		p := pos[rows[i].ID]
		rows[i].up3ID, rows[i].lng, rows[i].lat = p.up3, p.lng, p.lat
	}
	return is.merge(rows, up3Name), false, nil
}

// infoFillParents: kode gardu & penyulang induk (trafo / pelanggan).
func (s *Server) infoFillParents(ctx context.Context, l []infoObj) {
	if len(l) == 0 {
		return
	}
	ids := make([]int64, len(l))
	for i := range l {
		ids[i] = l[i].ID
	}
	gd, feeder := s.d.Graph.SinkGroups(ids)
	codes, _ := s.d.Power.NodeCodes(ctx, append(append([]int64{}, gd...), feeder...))
	for i := range l {
		l[i].GDCode = codes[gd[i]].Code
		l[i].Feeder = codes[feeder[i]].Code
	}
}

// infoUP3Names: nama poligon UP3 per id (gis_boundaries).
func (s *Server) infoUP3Names(ctx context.Context) (map[int64]string, error) {
	rows, err := s.d.Pool.Query(ctx, `SELECT id, name FROM gis_boundaries WHERE level = 'up3'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var n string
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// infoCountAffected: jumlah (event induk, node) terdampak — isi kejadian induk sudah mencakup kejadian lanjutannya.
func (s *Server) infoCountAffected(ctx context.Context, rootIDs []int64, where string) (int, error) {
	if len(rootIDs) == 0 {
		return 0, nil
	}
	var n int
	err := s.d.Pool.QueryRow(ctx, `SELECT count(*) FROM outages o CROSS JOIN LATERAL unnest(o.affected_nodes) AS a(nid)
		JOIN gis_nodes n ON n.id = a.nid WHERE o.id = ANY($1::bigint[]) AND NOT `+gis.SQLNonOperating+` AND `+where, rootIDs).Scan(&n)
	return n, err
}

// GET /api/exec/infographic/log?from=&to=&kind=&outage=&level=&q=&page=&size= — log event terdampak per halaman.
func (s *Server) execInfographicLog(c *gin.Context) {
	ctx := c.Request.Context()
	level := c.Query("level")
	known := false
	for _, l := range infoLogLevels {
		known = known || l == level
	}
	if !known {
		fail(c, http.StatusBadRequest, pick(c, "Level log tidak dikenal.", "Unknown log level."))
		return
	}
	is, err := s.infoSelect(c)
	if err != nil {
		handleErr(c, err)
		return
	}
	names, err := s.infoUP3Names(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	list, truncated, err := s.infoLog(ctx, is, level, strings.TrimSpace(c.Query("q")), func(id int64) string { return names[id] }, 50000)
	if err != nil {
		handleErr(c, err)
		return
	}
	items, page, pages, size := infoPage(c, list)
	if level == "trafo" || level == "pelanggan" {
		s.infoFillPage(ctx, items, names)
	}
	ok(c, gin.H{"items": items, "total": len(list), "page": page, "pages": pages, "size": size, "truncated": truncated})
}

// GET /api/exec/infographic/customers?from=&to=&kind=&outage=&q=&page=&size= — detail pelanggan terdampak per halaman:
// prioritas (VVIP, VIP, KTT, Prioritas) lalu TM lalu lainnya; dalam tiap kelompok yang masih padam lebih dulu.
func (s *Server) execInfographicCustomers(c *gin.Context) {
	ctx := c.Request.Context()
	is, err := s.infoSelect(c)
	if err != nil {
		handleErr(c, err)
		return
	}
	names, err := s.infoUP3Names(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	const limit = 50000
	rows, err := s.infoAffected(ctx, is.selIDs, infoLogWhere["pelanggan"], strings.TrimSpace(c.Query("q")), limit, false)
	if err != nil {
		handleErr(c, err)
		return
	}
	list := is.merge(rows, func(id int64) string { return names[id] })
	for i := range list {
		list[i].Priority = priorityOf(list[i].Priority, list[i].Type)
	}
	sortCustomers(list)
	items, page, pages, size := infoPage(c, list)
	s.infoFillPage(ctx, items, names)
	ok(c, gin.H{"items": items, "total": len(list), "page": page, "pages": pages, "size": size, "truncated": len(rows) >= limit})
}

// GET /api/exec/infographic/object?from=&to=&kind=&outage=&id= — info objek di peta kejadian (popup): identitas, induk,
// UP3, daya / kapasitas, dan riwayat padam–nyala di dalam kejadian terpilih (seperti baris log event terdampak).
func (s *Server) execInfographicObject(c *gin.Context) {
	ctx := c.Request.Context()
	id, err := strconv.ParseInt(c.Query("id"), 10, 64)
	if err != nil || id <= 0 {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	is, err := s.infoSelect(c)
	if err != nil {
		handleErr(c, err)
		return
	}
	names, err := s.infoUP3Names(ctx)
	if err != nil {
		handleErr(c, err)
		return
	}
	var o struct {
		code, name, typ, address string
		gi                       string
		power                    float64
		energized                bool
		up3                      int64
	}
	err = s.d.Pool.QueryRow(ctx, `SELECT n.code, n.name, n.type_code, COALESCE(n.properties->>'alamat', ''),
		COALESCE(qgis_num(n.properties->>'daya_va'), qgis_num(n.properties->>'daya_kva') * 1000, qgis_num(n.properties->>'daya_mva') * 1000000, 0),
		n.energized, `+infoUP3SQL+`,
		-- trafo GI: gardu induk tempatnya (GI terdekat ≤ 500 m), karena sebagian trafo GI hasil impor tanpa kode
		CASE WHEN n.type_code = 'trafo_gi' THEN COALESCE((SELECT NULLIF(g.code, '') FROM gis_nodes g WHERE g.type_code = 'gi'
			AND ST_DWithin(g.geom::geography, n.geom::geography, 500) ORDER BY g.geom <-> n.geom LIMIT 1), '') ELSE '' END
		FROM gis_nodes n WHERE n.id = $1`, id).Scan(&o.code, &o.name, &o.typ, &o.address, &o.power, &o.energized, &o.up3, &o.gi)
	if err != nil {
		handleErr(c, err)
		return
	}
	// kejadian terpilih yang memuat objek → digabung per event induk (mulai, nyala, durasi, status)
	rows, err := s.d.Pool.Query(ctx, `SELECT id FROM outages WHERE id = ANY($1::bigint[]) AND $2 = ANY(affected_nodes)`, is.selIDs, id)
	if err != nil {
		handleErr(c, err)
		return
	}
	oids, err := collectIDs64(rows)
	if err != nil {
		handleErr(c, err)
		return
	}
	objRows := make([]infoObj, 0, len(oids))
	for _, oid := range oids {
		objRows = append(objRows, infoObj{EventID: oid, ID: id, Code: o.code, Name: o.name})
	}
	type ev struct {
		EventID   int64      `json:"event_id"`
		Kind      string     `json:"kind"`
		StartedAt time.Time  `json:"started_at"`
		EndedAt   *time.Time `json:"ended_at"`
		Minutes   float64    `json:"minutes"`
		Active    bool       `json:"active"`
	}
	evs := []ev{}
	for _, x := range is.merge(objRows, func(int64) string { return "" }) {
		evs = append(evs, ev{EventID: x.EventID, Kind: is.evByID[x.EventID].Kind, StartedAt: x.StartedAt, EndedAt: x.EndedAt, Minutes: x.Minutes, Active: x.Active})
	}
	gd, feeder := s.d.Graph.SinkGroups([]int64{id})
	codes, _ := s.d.Power.NodeCodes(ctx, []int64{gd[0], feeder[0]})
	typeName := o.typ
	if ct, ok := s.d.Types.Get(o.typ); ok {
		typeName = ct.Name
		if middleware.GetLang(c) == "en" && ct.NameEN != "" {
			typeName = ct.NameEN
		}
	}
	gdCode := codes[gd[0]].Code
	if gd[0] == id {
		gdCode = ""
	}
	ok(c, gin.H{"id": id, "code": o.code, "name": o.name, "type_code": o.typ, "type_name": typeName, "address": o.address, "power_va": o.power,
		"energized": o.energized, "up3": names[o.up3], "gi_code": o.gi, "gd_code": gdCode, "feeder_code": codes[feeder[0]].Code, "events": evs})
}

func collectIDs64(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}) ([]int64, error) {
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// infoPage memotong daftar menurut page & size (5–100, bawaan 10); page dibatasi ke halaman terakhir.
func infoPage(c *gin.Context, list []infoObj) (items []infoObj, page, pages, size int) {
	size = queryInt(c, "size", 10)
	if size < 5 || size > 100 {
		size = 10
	}
	total := len(list)
	pages = max(1, (total+size-1)/size)
	page = min(max(1, queryInt(c, "page", 1)), pages)
	return list[min((page-1)*size, total):min(page*size, total)], page, pages, size
}

// infoFillPage melengkapi baris satu halaman: gardu & penyulang induk serta UP3 (uji poligon hanya untuk baris ini).
func (s *Server) infoFillPage(ctx context.Context, items []infoObj, names map[int64]string) {
	s.infoFillParents(ctx, items)
	ids := make([]int64, len(items))
	for i := range items {
		ids[i] = items[i].ID
	}
	if pos, err := s.infoNodePos(ctx, ids); err == nil {
		for i := range items {
			items[i].UP3 = names[pos[items[i].ID].up3]
		}
	}
}

// sortCustomers: prioritas (urutan infoPriorities) → TM → lainnya; lalu masih padam, terbaru, kejadian, kode, id.
func sortCustomers(l []infoObj) {
	rank := func(o infoObj) int {
		for i, p := range infoPriorities {
			if o.Priority == p {
				return i
			}
		}
		if o.Type == "pelanggan_tm" {
			return len(infoPriorities)
		}
		return len(infoPriorities) + 1
	}
	sort.SliceStable(l, func(i, j int) bool {
		a, b := l[i], l[j]
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra < rb
		}
		if a.Active != b.Active {
			return a.Active
		}
		if !a.StartedAt.Equal(b.StartedAt) {
			return a.StartedAt.After(b.StartedAt)
		}
		if a.EventID != b.EventID {
			return a.EventID > b.EventID
		}
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		return a.ID < b.ID
	})
}

// GET /api/exec/infographic?from=&to=&kind=&outage=
func (s *Server) execInfographic(c *gin.Context) {
	ctx := c.Request.Context()
	is, err := s.infoSelect(c)
	if err != nil {
		handleErr(c, err)
		return
	}
	rc, idx, sel, sums, events, selIDs, activeRoot, now := is.rc, is.idx, is.sel, is.sums, is.events, is.selIDs, is.activeRoot, is.now
	if events == nil {
		events = []infoEvent{} // periode tanpa kejadian: kirim [] (bukan null) agar halaman tidak galat
	}
	period, from, to, kind, outageID, roots := is.period, rc.from, rc.to, is.kind, is.outageID, is.roots

	// angka per level
	kinds := map[string]int{}
	levels := map[string]*infoCount{}
	for _, k := range []string{"beban", "gi", "trafo_gi", "penyulang", "zona", "gd", "pelanggan"} {
		levels[k] = &infoCount{}
	}
	rel := gis.ReliabilityGroup{}
	sub := &relCalc{from: rc.from, to: rc.to, rp: rc.rp, served: rc.served}
	causeIDs := map[int64]bool{}
	for k, i := range sel {
		o := rc.outages[i]
		sm := sums[k]
		rt, active := is.isRoot(o), o.EndedAt == nil
		if rt {
			kinds[o.Kind]++
		}
		levels["beban"].add(o.LoadKW/1000, rt, active)
		levels["gi"].add(float64(len(sm.GI)), rt, active)
		levels["trafo_gi"].add(float64(len(sm.TrafoGI)), rt, active)
		levels["penyulang"].add(float64(len(sm.Feeders)), rt, active)
		levels["zona"].add(float64(len(sm.Zones)), rt, active)
		levels["gd"].add(float64(sm.GD), rt, active)
		levels["pelanggan"].add(float64(sm.Customers), rt, active)
		rel.Add(o)
		sub.outages = append(sub.outages, o)
		sub.sums = append(sub.sums, rc.sums[i])
		if o.CauseKind != "edge" {
			causeIDs[o.CauseNodeID] = true
		}
	}
	rel.Finish(rc.served)
	for _, x := range levels {
		x.finish()
	}

	// wilayah UP3 (batas wilayah) + keandalan per UP3
	regs, err := s.regionReliability(ctx, sub)
	if err != nil {
		handleErr(c, err)
		return
	}
	up3 := []*infoUP3{}
	up3By := map[int64]*infoUP3{}
	for _, r := range regs {
		if r.Level != "up3" {
			continue
		}
		u := &infoUP3{ID: r.ID, Name: r.Name, Customers: r.Customers, Rel: r.Rel}
		up3 = append(up3, u)
		up3By[r.ID] = u
	}
	sort.Slice(up3, func(i, j int) bool { return up3[i].Name < up3[j].Name })
	up3Name := func(id int64) string {
		if u := up3By[id]; u != nil {
			return u.Name
		}
		return ""
	}
	merge := func(rows []infoObj) []infoObj { return is.merge(rows, up3Name) }

	// titik penyebab: lokasi & UP3
	pos, err := s.infoNodePos(ctx, keys(causeIDs))
	if err != nil {
		handleErr(c, err)
		return
	}
	// pelanggan prioritas (atribut) & TT di dalam kejadian terpilih: kartu Prioritas Pelanggan
	custRows, err := s.infoAffected(ctx, selIDs, `n.type_code LIKE 'pelanggan%' AND (n.type_code = 'pelanggan_tt' OR COALESCE(n.properties->>'prioritas', '') <> '')`, "", 0, false)
	if err != nil {
		handleErr(c, err)
		return
	}

	// jumlah baris log per level (isi log dimuat per halaman lewat /api/exec/infographic/log)
	logTotals := map[string]int{}
	var gds, tgis []infoObj
	for _, lv := range []string{"gi", "trafo_gi", "penyulang", "zona", "gd", "trafo"} {
		l, _, err := s.infoLog(ctx, is, lv, "", up3Name, 0)
		if err != nil {
			handleErr(c, err)
			return
		}
		logTotals[lv] = len(l)
		switch lv {
		case "gd":
			gds = l
		case "trafo_gi":
			tgis = l
		}
	}
	if logTotals["pelanggan"], err = s.infoCountAffected(ctx, is.rootSel, infoLogWhere["pelanggan"]); err != nil {
		handleErr(c, err)
		return
	}

	// gardu per UP3 & titik peta
	type mapPt struct {
		ID     int64   `json:"id"`
		Code   string  `json:"code"`
		Name   string  `json:"name,omitempty"`
		Lng    float64 `json:"lng"`
		Lat    float64 `json:"lat"`
		Active bool    `json:"active"`
		Kind   string  `json:"kind,omitempty"`
		Event  int64   `json:"event_id,omitempty"`
		Target string  `json:"target_kind,omitempty"` // edge: penyebab berupa saluran
	}
	gdPts := []mapPt{}
	seenGD := map[int64]bool{}
	for _, g := range gds {
		if u := up3By[g.up3ID]; u != nil {
			u.GD.Terdampak++
			if g.Active {
				u.GD.Padam++
			}
		}
		if !seenGD[g.ID] && len(gdPts) < 3000 {
			seenGD[g.ID] = true
			gdPts = append(gdPts, mapPt{ID: g.ID, Code: g.Code, Name: g.Name, Lng: g.lng, Lat: g.lat, Active: g.Active})
		}
	}
	for _, u := range up3 {
		u.GD.finish()
	}
	// trafo GI terdampak (padam = masih ada kejadian aktif yang memuatnya)
	tgiPts := []mapPt{}
	seenTGI := map[int64]bool{}
	for _, x := range tgis {
		if !seenTGI[x.ID] {
			seenTGI[x.ID] = true
			tgiPts = append(tgiPts, mapPt{ID: x.ID, Code: x.Code, Lng: x.lng, Lat: x.lat, Active: x.Active})
		}
	}
	causes := []mapPt{}
	edgeCause := []int64{}
	for _, e := range events {
		if e.ParentID != nil {
			continue
		}
		o := rc.outages[idx[e.ID]]
		if o.CauseKind == "edge" {
			edgeCause = append(edgeCause, o.CauseNodeID)
			continue
		}
		if p, ok := pos[o.CauseNodeID]; ok {
			causes = append(causes, mapPt{ID: o.CauseNodeID, Code: o.CauseNodeCode, Lng: p.lng, Lat: p.lat, Active: activeRoot[e.ID], Kind: e.Kind, Event: e.ID})
		}
	}
	if len(edgeCause) > 0 {
		ep, _ := s.infoEdgePos(ctx, edgeCause)
		for _, e := range events {
			o := rc.outages[idx[e.ID]]
			if e.ParentID != nil || o.CauseKind != "edge" {
				continue
			}
			if p, ok := ep[o.CauseNodeID]; ok {
				causes = append(causes, mapPt{ID: o.CauseNodeID, Code: o.CauseNodeCode, Lng: p.lng, Lat: p.lat, Active: activeRoot[e.ID], Kind: e.Kind, Event: e.ID, Target: "edge"})
			}
		}
	}

	// gardu induk: padam (kejadian aktif), pulih (pernah padam di kejadian terpilih), induk (menyuplai penyulang
	// terdampak), lain (konteks)
	giRole := map[int64]string{}
	setRole := func(id int64, role string) {
		rank := map[string]int{"padam": 3, "pulih": 2, "induk": 1}
		if rank[role] > rank[giRole[id]] {
			giRole[id] = role
		}
	}
	for k, i := range sel {
		o := rc.outages[i]
		for _, g := range sums[k].GI {
			if o.EndedAt == nil {
				setRole(g.ID, "padam")
			} else {
				setRole(g.ID, "pulih")
			}
		}
		for _, g := range sums[k].ParentGI {
			setRole(g, "induk")
		}
	}
	giPts, err := s.infoGIs(ctx, giRole)
	if err != nil {
		handleErr(c, err)
		return
	}

	// jaringan yang sedang padam (JTM / JTR / SR & pelanggan) dari kejadian terpilih yang masih aktif
	activeIDs := []int64{}
	for _, e := range events {
		if e.EndedAt == nil {
			activeIDs = append(activeIDs, e.ID)
		}
	}
	offNet, err := s.infoOffNetwork(ctx, activeIDs)
	if err != nil {
		handleErr(c, err)
		return
	}

	// kartu pelanggan prioritas
	custs := merge(custRows)
	prio := map[string]*infoCount{}
	for _, p := range infoPriorities {
		prio[p] = &infoCount{}
	}
	for i := range custs {
		cat := priorityOf(custs[i].Priority, custs[i].Type)
		custs[i].Priority = cat
		if x := prio[cat]; x != nil {
			x.add(1, true, custs[i].Active)
		}
	}
	for _, x := range prio {
		x.finish()
	}

	ok(c, gin.H{
		"period": period, "from": from, "to": to, "at": now, "kind": kind, "outage": outageID,
		"org": s.infoOrg(ctx), "roots": roots, "kinds": kinds, "levels": levels, "rel": rel, "events": events,
		"priority": prio, "up3": up3, "log_totals": logTotals,
		"customers_total": levels["pelanggan"].Terdampak,
		"map":             gin.H{"gd": gdPts, "tgi": tgiPts, "causes": causes, "gi": giPts, "lines": offNet.Lines, "customers": offNet.Customers, "trafo": offNet.Trafo, "truncated": offNet.Truncated, "zoom": offNet.Zoom, "label_zoom": offNet.LabelZoom},
		"pending_regions": countPending(sub),
	})
}

func keys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// GET /api/exec/infographic/version — penanda perubahan yang murah untuk muat ulang "saat ada perubahan": berubah bila
// ada kejadian padam baru / berakhir / wilayahnya selesai dihitung, atau jaringan berubah (manuver, editing, impor →
// versi tile naik).
func (s *Server) execInfographicVersion(c *gin.Context) {
	ctx := c.Request.Context()
	var n, maxID, active, pending int64
	var lastEnd float64
	err := s.d.Pool.QueryRow(ctx, `SELECT count(*), COALESCE(max(id), 0), count(*) FILTER (WHERE ended_at IS NULL),
		COALESCE(extract(epoch FROM max(ended_at)), 0)::float8, count(*) FILTER (WHERE regions IS NULL) FROM outages`).Scan(&n, &maxID, &active, &lastEnd, &pending)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"version": strings.Join([]string{
		strconv.FormatInt(s.d.Tiles.Version(ctx), 10), strconv.FormatInt(n, 10), strconv.FormatInt(maxID, 10),
		strconv.FormatInt(active, 10), strconv.FormatFloat(lastEnd, 'f', 3, 64), strconv.FormatInt(pending, 10),
	}, ".")})
}

func countPending(rc *relCalc) int {
	n := 0
	for _, o := range rc.outages {
		if o.Regions == nil {
			n++
		}
	}
	return n
}

// priorityOf: kategori prioritas pelanggan (atribut "prioritas"; pelanggan TT = KTT walau atribut kosong).
func priorityOf(attr, typ string) string {
	a := strings.TrimSpace(attr)
	for _, p := range infoPriorities {
		if strings.EqualFold(a, p) {
			return p
		}
	}
	if typ == "pelanggan_tt" {
		return "KTT"
	}
	return ""
}

type infoPos struct {
	lng, lat float64
	up3      int64
}

const infoUP3SQL = `COALESCE((SELECT b.id FROM gis_boundaries b WHERE b.level = 'up3' AND ST_Intersects(b.geom, n.geom) LIMIT 1), 0)`

// infoNodePos: lokasi & UP3 (poligon batas wilayah) node-node.
func (s *Server) infoNodePos(ctx context.Context, ids []int64) (map[int64]infoPos, error) {
	out := map[int64]infoPos{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.d.Pool.Query(ctx, `SELECT n.id, ST_X(ST_PointOnSurface(n.geom)), ST_Y(ST_PointOnSurface(n.geom)), `+infoUP3SQL+`
		FROM gis_nodes n WHERE n.id = ANY($1::bigint[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var p infoPos
		if err := rows.Scan(&id, &p.lng, &p.lat, &p.up3); err != nil {
			return nil, err
		}
		out[id] = p
	}
	return out, rows.Err()
}

// infoEdgePos: titik tengah saluran penyebab kejadian.
func (s *Server) infoEdgePos(ctx context.Context, ids []int64) (map[int64]infoPos, error) {
	out := map[int64]infoPos{}
	rows, err := s.d.Pool.Query(ctx, `SELECT e.id, ST_X(ST_LineInterpolatePoint(e.geom, 0.5)), ST_Y(ST_LineInterpolatePoint(e.geom, 0.5))
		FROM gis_edges e WHERE e.id = ANY($1::bigint[]) AND GeometryType(e.geom) = 'LINESTRING'`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var p infoPos
		if err := rows.Scan(&id, &p.lng, &p.lat); err != nil {
			return nil, err
		}
		out[id] = p
	}
	return out, rows.Err()
}

// infoAffected: node terdampak (filter tipe) di dalam kejadian-kejadian terpilih, per (kejadian, node). limit 0 = semua.
// q (opsional) menyaring kode / nama / IDPEL.
// withUP3 = false melewati uji poligon UP3 per baris (lebih cepat untuk ribuan pelanggan; diisi per halaman log).
func (s *Server) infoAffected(ctx context.Context, outageIDs []int64, where, q string, limit int, withUP3 bool) ([]infoObj, error) {
	up3SQL := "0"
	if withUP3 {
		up3SQL = infoUP3SQL
	}
	if len(outageIDs) == 0 {
		return nil, nil
	}
	sql := `SELECT o.id, n.id, n.type_code, n.code, n.name, COALESCE(n.properties->>'alamat', ''), COALESCE(n.properties->>'prioritas', ''),
		COALESCE(qgis_num(n.properties->>'daya_va'), qgis_num(n.properties->>'daya_kva') * 1000, qgis_num(n.properties->>'daya_mva') * 1000000, 0),
		ST_X(ST_PointOnSurface(n.geom)), ST_Y(ST_PointOnSurface(n.geom)), ` + up3SQL + `
		FROM outages o CROSS JOIN LATERAL unnest(o.affected_nodes) AS a(nid)
		JOIN gis_nodes n ON n.id = a.nid
		WHERE o.id = ANY($1::bigint[]) AND NOT ` + gis.SQLNonOperating + ` AND ` + where
	args := []any{outageIDs}
	if kw := strings.TrimSpace(q); kw != "" {
		args = append(args, "%"+strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(kw)+"%")
		n := strconv.Itoa(len(args))
		sql += ` AND (n.code ILIKE $` + n + ` OR n.name ILIKE $` + n + ` OR n.properties->>'idpel' ILIKE $` + n + `)`
	}
	if limit > 0 {
		// kejadian aktif lebih dulu agar yang masih padam tidak terpotong batas
		args = append(args, limit)
		sql += ` ORDER BY o.ended_at IS NULL DESC, o.started_at DESC LIMIT $` + strconv.Itoa(len(args))
	}
	rows, err := s.d.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []infoObj{}
	for rows.Next() {
		var x infoObj
		if err := rows.Scan(&x.EventID, &x.ID, &x.Type, &x.Code, &x.Name, &x.Address, &x.Priority, &x.PowerVA, &x.lng, &x.lat, &x.up3ID); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// GET /api/exec/org — nama UID & UP2D untuk kepala halaman Dashboard (Infografis, Keandalan & Operasi).
func (s *Server) execOrg(c *gin.Context) {
	ok(c, s.infoOrg(c.Request.Context()))
}

// infoOrg: nama unit induk untuk kepala infografis (UID & UP2D).
func (s *Server) infoOrg(ctx context.Context) gin.H {
	out := gin.H{"uid": "", "up2d": ""}
	rows, err := s.d.Pool.Query(ctx, `SELECT kind, name FROM org_units WHERE active AND kind IN ('UID', 'UP2D') ORDER BY id`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k, n string
		if rows.Scan(&k, &n) == nil {
			if key := strings.ToLower(k); out[key] == "" {
				out[key] = n
			}
		}
	}
	return out
}

// infoOffNet: saluran JTM / JTR / SR dan pelanggan yang sedang padam di dalam kejadian aktif terpilih.
type infoOffNet struct {
	Lines     infoFC   `json:"lines"`
	Customers []infoPt `json:"customers"`
	Trafo     []infoPt `json:"trafo"` // trafo distribusi padam
	Truncated bool     `json:"truncated"`
	// zoom minimum tampil (Pengaturan Layer) per kelas saluran (jtm / jtr / sr), per tipe pelanggan, dan trafo_distribusi
	Zoom map[string]int `json:"zoom"`
	// zoom minimum label (Pengaturan Layer, label_zoom) per tipe pelanggan
	LabelZoom map[string]int `json:"label_zoom"`
}

type infoFC struct {
	Type     string        `json:"type"`
	Features []infoFeature `json:"features"`
}

type infoFeature struct {
	Type       string          `json:"type"`
	ID         int64           `json:"id"`
	Geometry   json.RawMessage `json:"geometry"`
	Properties map[string]any  `json:"properties"`
}

type infoPt struct {
	ID   int64   `json:"id"`
	Code string  `json:"code"`
	Name string  `json:"name,omitempty"`
	Type string  `json:"type_code"`
	Lng  float64 `json:"lng"`
	Lat  float64 `json:"lat"`
}

const infoOffLimit = 30000

func (s *Server) infoOffNetwork(ctx context.Context, outageIDs []int64) (infoOffNet, error) {
	out := infoOffNet{Lines: infoFC{Type: "FeatureCollection", Features: []infoFeature{}}, Customers: []infoPt{}, Trafo: []infoPt{}, Zoom: map[string]int{}, LabelZoom: map[string]int{}}
	zr, err := s.d.Pool.Query(ctx, `SELECT CASE WHEN code LIKE 'pelanggan%' OR code = 'trafo_distribusi' THEN code WHEN voltage_kv >= 1 THEN 'jtm' WHEN code = 'sr' THEN 'sr' ELSE 'jtr' END, min(min_zoom)
		FROM component_types WHERE code LIKE 'pelanggan%' OR code = 'trafo_distribusi' OR (geom_kind = 'line' AND category = 'jaringan') GROUP BY 1`)
	if err != nil {
		return out, err
	}
	for zr.Next() {
		var k string
		var z int
		if zr.Scan(&k, &z) == nil {
			out.Zoom[k] = z
		}
	}
	zr.Close()
	if lr, err := s.d.Pool.Query(ctx, `SELECT code, label_zoom FROM component_types WHERE code LIKE 'pelanggan%'`); err == nil {
		for lr.Next() {
			var k string
			var z int
			if lr.Scan(&k, &z) == nil {
				out.LabelZoom[k] = z
			}
		}
		lr.Close()
	}
	if len(outageIDs) == 0 {
		return out, nil
	}
	// saluran padam yang menyentuh node terdampak (termasuk ruas pertama di hilir alat yang dibuka)
	rows, err := s.d.Pool.Query(ctx, `WITH a AS (SELECT DISTINCT unnest(affected_nodes) AS id FROM outages WHERE id = ANY($1::bigint[]) AND ended_at IS NULL)
		SELECT e.id, e.code, CASE WHEN ct.voltage_kv >= 1 THEN 'jtm' WHEN e.type_code = 'sr' THEN 'sr' ELSE 'jtr' END, ST_AsGeoJSON(e.geom, 6)
		FROM gis_edges e JOIN component_types ct ON ct.code = e.type_code AND ct.category = 'jaringan'
		WHERE NOT e.energized AND (e.from_node_id IN (SELECT id FROM a) OR e.to_node_id IN (SELECT id FROM a))
		LIMIT $2`, outageIDs, infoOffLimit+1)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var f infoFeature
		var code, cls, geom string
		if err := rows.Scan(&f.ID, &code, &cls, &geom); err != nil {
			rows.Close()
			return out, err
		}
		if len(out.Lines.Features) >= infoOffLimit {
			out.Truncated = true
			continue
		}
		f.Type, f.Geometry, f.Properties = "Feature", json.RawMessage(geom), map[string]any{"id": f.ID, "code": code, "cls": cls}
		out.Lines.Features = append(out.Lines.Features, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.d.Pool.Query(ctx, `WITH a AS (SELECT DISTINCT unnest(affected_nodes) AS id FROM outages WHERE id = ANY($1::bigint[]) AND ended_at IS NULL)
		SELECT n.id, n.code, n.name, n.type_code, ST_X(n.geom), ST_Y(n.geom) FROM gis_nodes n
		WHERE n.id IN (SELECT id FROM a) AND (n.type_code LIKE 'pelanggan%' OR n.type_code = 'trafo_distribusi') AND NOT n.energized AND NOT `+gis.SQLNonOperating+`
		ORDER BY n.type_code = 'trafo_distribusi' DESC LIMIT $2`, outageIDs, infoOffLimit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var x infoPt
		if err := rows.Scan(&x.ID, &x.Code, &x.Name, &x.Type, &x.Lng, &x.Lat); err != nil {
			return out, err
		}
		dst := &out.Customers
		if x.Type == "trafo_distribusi" {
			dst = &out.Trafo
		}
		if len(*dst) >= infoOffLimit {
			out.Truncated = true
			continue
		}
		*dst = append(*dst, x)
	}
	return out, rows.Err()
}

type infoGI struct {
	ID        int64   `json:"id"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Lng       float64 `json:"lng"`
	Lat       float64 `json:"lat"`
	Energized bool    `json:"energized"`
	Role      string  `json:"role"` // padam | pulih | induk | lain
}

// infoGIs: seluruh gardu induk yang beroperasi beserta perannya terhadap kejadian terpilih.
func (s *Server) infoGIs(ctx context.Context, role map[int64]string) ([]infoGI, error) {
	rows, err := s.d.Pool.Query(ctx, `SELECT n.id, n.code, n.name, ST_X(ST_PointOnSurface(n.geom)), ST_Y(ST_PointOnSurface(n.geom)), n.energized
		FROM gis_nodes n WHERE n.type_code = 'gi' AND NOT `+gis.SQLNonOperating+` ORDER BY n.id LIMIT 2000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []infoGI{}
	for rows.Next() {
		var g infoGI
		if err := rows.Scan(&g.ID, &g.Code, &g.Name, &g.Lng, &g.Lat, &g.Energized); err != nil {
			return nil, err
		}
		g.Role = role[g.ID]
		if g.Role == "" {
			g.Role = "lain"
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
