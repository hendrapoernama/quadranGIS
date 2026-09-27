package gis

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/repo"
)

// Unit adalah unit organisasi pengelola aset (master data).
type Unit struct {
	ID           int       `json:"id"`
	Code         string    `json:"code"`
	Name         string    `json:"name"`
	Kind         string    `json:"kind"` // PUSAT | REGION | UID | UP2B | UP3 | UP2D | ULP
	ParentID     *int      `json:"parent_id"`
	Address      string    `json:"address"`
	Lng          *float64  `json:"lng"`
	Lat          *float64  `json:"lat"`
	Phone        string    `json:"phone"`
	Email        string    `json:"email"`
	BoundaryName string    `json:"boundary_name"`
	Active       bool      `json:"active"`
	UpdatedAt    time.Time `json:"updated_at"`
	UpdatedBy    string    `json:"updated_by"`
	// diisi saat daftar
	Level    int            `json:"level"`
	Path     []string       `json:"path,omitempty"` // nama leluhur dari atas
	Assets   map[string]int `json:"assets,omitempty"`
	Children int            `json:"children"`
}

// UnitLevel adalah tingkat jenjang tiap jenis unit (UP2B setara UID, UP2D setara UP3).
var UnitLevel = map[string]int{"PUSAT": 0, "REGION": 1, "UID": 2, "UP2B": 2, "UP3": 3, "UP2D": 3, "ULP": 4}

// unitParentKinds: jenis induk yang sah untuk tiap jenis unit.
var unitParentKinds = map[string][]string{
	"PUSAT":  nil,
	"REGION": {"PUSAT"},
	"UID":    {"REGION"},
	"UP2B":   {"REGION"},
	"UP3":    {"UID"},
	"UP2D":   {"UID"},
	"ULP":    {"UP3"},
}

// AssetUnitLevel: jenis aset yang dikelola unit & jenjang pengelola bawaannya saat penetapan otomatis.
var AssetUnitLevel = map[string]string{
	"gi": "UP3", "trafo_gi": "UP3", "power_grid": "UP3", "kubikel_20kv": "UP3", "gh": "UP3", "recloser": "UP3",
	"lbs_2way": "ULP", "lbs_3way": "ULP", "gd": "ULP", "trafo_distribusi": "ULP", "rak_tr": "ULP",
	"switch_jurusan_tr": "ULP", "tiang_tm": "ULP", "tiang_tr": "ULP", "pelanggan_tm": "ULP", "pelanggan_tt": "UP3",
}

// Units adalah layanan master data unit.
type Units struct {
	pool *pgxpool.Pool
	cfg  *repo.Configs

	mu    sync.RWMutex
	cache map[int]Unit
	at    time.Time
}

// NewUnits membuat layanan unit.
func NewUnits(pool *pgxpool.Pool, cfg *repo.Configs) *Units { return &Units{pool: pool, cfg: cfg} }

const unitCols = `id, code, name, kind, parent_id, address, lng, lat, phone, email, boundary_name, active, updated_at, updated_by`

func scanUnit(row pgx.Row) (Unit, error) {
	var u Unit
	err := row.Scan(&u.ID, &u.Code, &u.Name, &u.Kind, &u.ParentID, &u.Address, &u.Lng, &u.Lat, &u.Phone, &u.Email, &u.BoundaryName, &u.Active, &u.UpdatedAt, &u.UpdatedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrNotFound
	}
	u.Level = UnitLevel[u.Kind]
	return u, err
}

// All mengembalikan semua unit (disimpan 1 menit).
func (s *Units) All(ctx context.Context) (map[int]Unit, error) {
	s.mu.RLock()
	if s.cache != nil && time.Since(s.at) < time.Minute {
		c := s.cache
		s.mu.RUnlock()
		return c, nil
	}
	s.mu.RUnlock()
	rows, err := s.pool.Query(ctx, `SELECT `+unitCols+` FROM org_units`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]Unit{}
	for rows.Next() {
		u, err := scanUnit(rows)
		if err != nil {
			return nil, err
		}
		out[u.ID] = u
	}
	s.mu.Lock()
	s.cache, s.at = out, time.Now()
	s.mu.Unlock()
	return out, rows.Err()
}

func (s *Units) invalidate() {
	s.mu.Lock()
	s.cache = nil
	s.mu.Unlock()
}

// Ancestors mengembalikan rantai unit dari dirinya sampai puncak.
func Ancestors(all map[int]Unit, id int) []Unit {
	out := []Unit{}
	seen := map[int]bool{}
	for cur, ok := all[id]; ok && !seen[cur.ID]; {
		seen[cur.ID] = true
		out = append(out, cur)
		if cur.ParentID == nil {
			break
		}
		cur, ok = all[*cur.ParentID]
	}
	return out
}

// UnitNames mengembalikan nama UID, UP3 (atau UP2D), dan ULP dari rantai unit.
func UnitNames(all map[int]Unit, id int) (uid, up3, ulp string) {
	for _, u := range Ancestors(all, id) {
		label := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(u.Name, u.Kind+" "), "UP3 "), "ULP "))
		switch u.Kind {
		case "UID", "UP2B":
			if uid == "" {
				uid = label
			}
		case "UP3", "UP2D":
			if up3 == "" {
				up3 = label
			}
		case "ULP":
			if ulp == "" {
				ulp = label
			}
		}
	}
	return
}

// List mengembalikan unit terurut jenjang + jumlah aset yang dimiliki (per jenis).
func (s *Units) List(ctx context.Context) ([]Unit, error) {
	s.invalidate()
	all, err := s.All(ctx)
	if err != nil {
		return nil, err
	}
	assets := map[int]map[string]int{}
	rows, err := s.pool.Query(ctx, `SELECT unit_id, type_code, count(*) FROM gis_nodes WHERE unit_id IS NOT NULL GROUP BY 1, 2`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, n int
		var tc string
		if rows.Scan(&id, &tc, &n) == nil {
			if assets[id] == nil {
				assets[id] = map[string]int{}
			}
			assets[id][tc] = n
		}
	}
	rows.Close()
	children := map[int]int{}
	for _, u := range all {
		if u.ParentID != nil {
			children[*u.ParentID]++
		}
	}
	out := make([]Unit, 0, len(all))
	for _, u := range all {
		chain := Ancestors(all, u.ID)
		for i := len(chain) - 1; i >= 1; i-- {
			u.Path = append(u.Path, chain[i].Name)
		}
		u.Assets = assets[u.ID]
		u.Children = children[u.ID]
		out = append(out, u)
	}
	// urut pohon: jalur lengkap
	key := func(u Unit) string { return strings.Join(append(append([]string{}, u.Path...), u.Name), "\x00") }
	sortUnits(out, key)
	return out, nil
}

func sortUnits(out []Unit, key func(Unit) string) {
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && key(out[j]) < key(out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
}

// Save menambah / mengubah unit dengan validasi jenjang induk.
func (s *Units) Save(ctx context.Context, u Unit, by string, lang string) (int, error) {
	u.Code = strings.ToUpper(strings.TrimSpace(u.Code))
	u.Name = strings.TrimSpace(u.Name)
	if u.Code == "" || u.Name == "" {
		return 0, &Error{kind: ErrBadRequest, msg: tl(lang, "Kode dan nama unit wajib diisi.", "Unit code and name are required.")}
	}
	if _, ok := UnitLevel[u.Kind]; !ok {
		return 0, &Error{kind: ErrBadRequest, msg: tl(lang, "Jenis unit tidak dikenal.", "Unknown unit type.")}
	}
	if (u.Lng == nil) != (u.Lat == nil) || (u.Lng != nil && (*u.Lng < -180 || *u.Lng > 180 || *u.Lat < -90 || *u.Lat > 90)) {
		return 0, &Error{kind: ErrBadRequest, msg: tl(lang, "Koordinat tidak valid (bujur −180…180, lintang −90…90).", "Invalid coordinates (lng −180…180, lat −90…90).")}
	}
	all, err := s.All(ctx)
	if err != nil {
		return 0, err
	}
	allowed := unitParentKinds[u.Kind]
	if len(allowed) == 0 {
		u.ParentID = nil
	} else {
		if u.ParentID == nil {
			return 0, &Error{kind: ErrBadRequest, msg: tl(lang, fmt.Sprintf("Unit %s wajib memiliki induk (%s).", u.Kind, strings.Join(allowed, "/")),
				fmt.Sprintf("A %s unit needs a parent (%s).", u.Kind, strings.Join(allowed, "/")))}
		}
		p, ok := all[*u.ParentID]
		if !ok {
			return 0, &Error{kind: ErrBadRequest, msg: tl(lang, "Unit induk tidak ditemukan.", "Parent unit not found.")}
		}
		okKind := false
		for _, k := range allowed {
			if p.Kind == k {
				okKind = true
			}
		}
		if !okKind {
			return 0, &Error{kind: ErrBadRequest, msg: tl(lang, fmt.Sprintf("Induk unit %s harus %s, bukan %s.", u.Kind, strings.Join(allowed, "/"), p.Kind),
				fmt.Sprintf("The parent of a %s unit must be %s, not %s.", u.Kind, strings.Join(allowed, "/"), p.Kind))}
		}
		if u.ID != 0 {
			for _, a := range Ancestors(all, p.ID) {
				if a.ID == u.ID {
					return 0, &Error{kind: ErrBadRequest, msg: tl(lang, "Induk tidak boleh berada di bawah unit ini.", "The parent cannot be below this unit.")}
				}
			}
		}
	}
	if u.ID != 0 {
		if cur, ok := all[u.ID]; ok && cur.Kind != u.Kind {
			// jenis berubah: anak yang ada harus tetap sah
			for _, c := range all {
				if c.ParentID != nil && *c.ParentID == u.ID {
					valid := false
					for _, k := range unitParentKinds[c.Kind] {
						if k == u.Kind {
							valid = true
						}
					}
					if !valid {
						return 0, &Error{kind: ErrConflict, msg: tl(lang, fmt.Sprintf("Jenis tidak bisa diubah: unit anak %s (%s) memerlukan induk lain.", c.Name, c.Kind),
							fmt.Sprintf("Type cannot change: child unit %s (%s) requires another parent type.", c.Name, c.Kind))}
					}
				}
			}
		}
	}
	var id int
	if u.ID == 0 {
		err = s.pool.QueryRow(ctx, `INSERT INTO org_units (code, name, kind, parent_id, address, lng, lat, phone, email, boundary_name, active, updated_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
			u.Code, u.Name, u.Kind, u.ParentID, u.Address, u.Lng, u.Lat, u.Phone, u.Email, u.BoundaryName, u.Active, by).Scan(&id)
	} else {
		id = u.ID
		var tag interface{ RowsAffected() int64 }
		tag, err = s.pool.Exec(ctx, `UPDATE org_units SET code=$2, name=$3, kind=$4, parent_id=$5, address=$6, lng=$7, lat=$8, phone=$9, email=$10,
			boundary_name=$11, active=$12, updated_by=$13, updated_at=now() WHERE id=$1`,
			u.ID, u.Code, u.Name, u.Kind, u.ParentID, u.Address, u.Lng, u.Lat, u.Phone, u.Email, u.BoundaryName, u.Active, by)
		if err == nil && tag.RowsAffected() == 0 {
			return 0, ErrNotFound
		}
	}
	if err != nil && strings.Contains(err.Error(), "org_units_code_key") {
		return 0, &Error{kind: ErrConflict, msg: tl(lang, "Kode unit sudah dipakai.", "Unit code already in use.")}
	}
	s.invalidate()
	return id, err
}

// Delete menghapus unit bila tidak punya anak & tidak memiliki aset / titik ukur.
func (s *Units) Delete(ctx context.Context, id int, lang string) error {
	var children, assets int
	_ = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM org_units WHERE parent_id=$1),
		(SELECT count(*) FROM gis_nodes WHERE unit_id=$1) + (SELECT count(*) FROM gis_edges WHERE unit_id=$1)`, id).Scan(&children, &assets)
	if children > 0 {
		return &Error{kind: ErrConflict, msg: tl(lang, fmt.Sprintf("Unit masih memiliki %d unit di bawahnya.", children), fmt.Sprintf("The unit still has %d child units.", children))}
	}
	if assets > 0 {
		return &Error{kind: ErrConflict, msg: tl(lang, fmt.Sprintf("Unit masih memiliki %d aset; pindahkan kepemilikannya dulu.", assets),
			fmt.Sprintf("The unit still owns %d assets; reassign them first.", assets))}
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM org_units WHERE id=$1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.invalidate()
	return err
}

// Owner adalah pemilik efektif sebuah aset.
type Owner struct {
	UnitID   *int   `json:"unit_id"`
	Unit     *Unit  `json:"unit"`
	Auto     bool   `json:"auto"` // true = dari lokasi (belum ditetapkan)
	UID      string `json:"uid"`
	UP3      string `json:"up3"`
	ULP      string `json:"ulp"`
	Boundary string `json:"boundary"`
}

// autoTargets: unit ULP & UP3 per nama poligon batas wilayah.
func (s *Units) autoTargets(all map[int]Unit) (ulpBy map[string]int, up3By map[string]int, def int) {
	ulpBy, up3By = map[string]int{}, map[string]int{}
	for _, u := range all {
		if !u.Active || u.BoundaryName == "" {
			continue
		}
		switch u.Kind {
		case "ULP":
			ulpBy[strings.ToUpper(u.BoundaryName)] = u.ID
		case "UP3":
			up3By[strings.ToUpper(u.BoundaryName)] = u.ID
		}
	}
	defCode := strings.ToUpper(s.cfg.Str("unit.default_code", "UID-JAKARTA-RAYA"))
	for _, u := range all {
		if u.Code == defCode {
			def = u.ID
		}
	}
	return
}

// pickAuto memilih unit bawaan dari ULP terdekat (atau induk UP3-nya bila aset dikelola UP3).
func pickAuto(all map[int]Unit, typeCode, ulpName string, ulpBy map[string]int, def int) int {
	id := ulpBy[strings.ToUpper(ulpName)]
	if id == 0 {
		return def
	}
	if AssetUnitLevel[typeCode] == "UP3" {
		if u := all[id]; u.ParentID != nil {
			return *u.ParentID
		}
	}
	return id
}

// OwnerOf mengembalikan pemilik efektif node / edge (edge: dari node asalnya bila belum ditetapkan).
func (s *Units) OwnerOf(ctx context.Context, kind string, id int64) (Owner, error) {
	all, err := s.All(ctx)
	if err != nil {
		return Owner{}, err
	}
	var unit *int
	var typeCode, ulp string
	maxDeg := s.cfg.Float("unit.auto_max_km", 25) / 111.0
	q := `SELECT n.unit_id, n.type_code, COALESCE((SELECT b.name FROM gis_boundaries b WHERE b.level='ulp' AND ST_DWithin(b.geom, n.geom, $2)
			ORDER BY ST_Distance(b.geom, n.geom) LIMIT 1), '') FROM gis_nodes n WHERE n.id=$1`
	if kind == "edge" {
		q = `SELECT COALESCE(e.unit_id, n.unit_id), n.type_code, COALESCE((SELECT b.name FROM gis_boundaries b WHERE b.level='ulp' AND ST_DWithin(b.geom, n.geom, $2)
			ORDER BY ST_Distance(b.geom, n.geom) LIMIT 1), '') FROM gis_edges e JOIN gis_nodes n ON n.id = e.from_node_id WHERE e.id=$1`
	}
	if err := s.pool.QueryRow(ctx, q, id, maxDeg).Scan(&unit, &typeCode, &ulp); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Owner{}, ErrNotFound
		}
		return Owner{}, err
	}
	o := Owner{UnitID: unit, Boundary: ulp}
	if unit == nil {
		ulpBy, _, def := s.autoTargets(all)
		if a := pickAuto(all, typeCode, ulp, ulpBy, def); a != 0 {
			o.UnitID, o.Auto = &a, true
		}
	}
	if o.UnitID != nil {
		if u, ok := all[*o.UnitID]; ok {
			o.Unit = &u
			o.UID, o.UP3, o.ULP = UnitNames(all, u.ID)
		}
	}
	return o, nil
}

// AutoAssignResult merangkum penetapan kepemilikan otomatis.
type AutoAssignResult struct {
	Applied   bool                      `json:"applied"`
	Total     int                       `json:"total"`
	ByUnit    map[string]map[string]int `json:"by_unit"` // nama unit → jenis → jumlah
	Default   int                       `json:"default"` // di luar semua wilayah → unit bawaan
	Unmatched int                       `json:"unmatched"`
}

// AutoAssign menetapkan unit pemilik aset yang belum punya pemilik (overwrite=true: semua aset) dari lokasinya:
// ULP terdekat (≤ unit.auto_max_km) → ULP atau induk UP3 sesuai jenis aset; di luar semua wilayah → unit bawaan.
func (s *Units) AutoAssign(ctx context.Context, apply, overwrite bool) (*AutoAssignResult, error) {
	all, err := s.All(ctx)
	if err != nil {
		return nil, err
	}
	ulpBy, _, def := s.autoTargets(all)
	types := make([]string, 0, len(AssetUnitLevel))
	for t := range AssetUnitLevel {
		types = append(types, t)
	}
	maxDeg := s.cfg.Float("unit.auto_max_km", 25) / 111.0
	rows, err := s.pool.Query(ctx, `SELECT n.id, n.type_code, COALESCE(b.name, '') FROM gis_nodes n
		LEFT JOIN LATERAL (SELECT name FROM gis_boundaries b WHERE b.level='ulp' AND ST_DWithin(b.geom, n.geom, $2)
			ORDER BY b.geom <-> n.geom LIMIT 1) b ON true
		WHERE n.type_code = ANY($1) AND ($3 OR n.unit_id IS NULL)`, types, maxDeg, overwrite)
	if err != nil {
		return nil, err
	}
	res := &AutoAssignResult{Applied: apply, ByUnit: map[string]map[string]int{}}
	ids, units := []int64{}, []int32{}
	for rows.Next() {
		var id int64
		var tc, ulp string
		if rows.Scan(&id, &tc, &ulp) != nil {
			continue
		}
		res.Total++
		u := pickAuto(all, tc, ulp, ulpBy, def)
		if u == 0 {
			res.Unmatched++
			continue
		}
		if ulp == "" {
			res.Default++
		}
		name := all[u].Name
		if res.ByUnit[name] == nil {
			res.ByUnit[name] = map[string]int{}
		}
		res.ByUnit[name][tc]++
		ids, units = append(ids, id), append(units, int32(u))
	}
	rows.Close()
	if apply && len(ids) > 0 {
		for i := 0; i < len(ids); i += 20000 {
			j := min(i+20000, len(ids))
			if _, err := s.pool.Exec(ctx, `UPDATE gis_nodes n SET unit_id = x.u FROM unnest($1::bigint[], $2::int[]) x(id, u) WHERE n.id = x.id`, ids[i:j], units[i:j]); err != nil {
				return nil, err
			}
		}
	}
	return res, nil
}

// NodeUnits mengembalikan unit pemilik efektif untuk node-node (ditetapkan, atau otomatis dari lokasi).
func (s *Units) NodeUnits(ctx context.Context, ids []int64) (map[int64]int, error) {
	out := map[int64]int{}
	if len(ids) == 0 {
		return out, nil
	}
	all, err := s.All(ctx)
	if err != nil {
		return nil, err
	}
	ulpBy, _, def := s.autoTargets(all)
	maxDeg := s.cfg.Float("unit.auto_max_km", 25) / 111.0
	rows, err := s.pool.Query(ctx, `SELECT n.id, n.type_code, n.unit_id, COALESCE(b.name, '') FROM gis_nodes n
		LEFT JOIN LATERAL (SELECT name FROM gis_boundaries b WHERE n.unit_id IS NULL AND b.level='ulp' AND ST_DWithin(b.geom, n.geom, $2)
			ORDER BY b.geom <-> n.geom LIMIT 1) b ON true
		WHERE n.id = ANY($1)`, ids, maxDeg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var tc, ulp string
		var unit *int
		if rows.Scan(&id, &tc, &unit, &ulp) != nil {
			continue
		}
		if unit != nil {
			out[id] = *unit
		} else if u := pickAuto(all, tc, ulp, ulpBy, def); u != 0 {
			out[id] = u
		}
	}
	return out, rows.Err()
}

// tl memilih teks sesuai bahasa.
func tl(lang, id, en string) string {
	if lang == "en" {
		return en
	}
	return id
}
