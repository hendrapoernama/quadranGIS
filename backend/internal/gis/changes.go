package gis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/i18n"
	"quadrangis/internal/models"
	"quadrangis/internal/repo"
)

// Alur persetujuan editing jaringan:
//
//	draf (penyusun) → diajukan → disetujui (supervisor) → dirilis ke jaringan aktif (manajer)
//	                     ↘ ditolak (kembali ke penyusun untuk diperbaiki / diajukan ulang)
//
// Selama belum dirilis, perubahan disimpan sebagai operasi tertunda (gis_change_items) dan jaringan aktif —
// tile, graf, trace, operasi — tidak berubah. Saat rilis, operasi diputar ulang berurutan lewat editor
// bertopologi yang sama (snap, sambung, pisah garis otomatis). Objek baru yang belum dirilis memakai id negatif
// (−id item) agar bisa dipilih & diubah di editor.

// Changeset adalah satu paket perubahan.
type Changeset struct {
	ID            int64          `json:"id"`
	Title         string         `json:"title"`
	Description   string         `json:"description"`
	Status        string         `json:"status"`
	Source        string         `json:"source"`
	CreatedBy     *string        `json:"created_by"`
	CreatedByName string         `json:"created_by_name"`
	SubmittedAt   *time.Time     `json:"submitted_at"`
	SubmittedBy   string         `json:"submitted_by"`
	ReviewedAt    *time.Time     `json:"reviewed_at"`
	ReviewedBy    string         `json:"reviewed_by"`
	ReviewNote    string         `json:"review_note"`
	ReleasedAt    *time.Time     `json:"released_at"`
	ReleasedBy    string         `json:"released_by"`
	ReleaseNote   string         `json:"release_note"`
	Applied       int            `json:"applied"`
	Failed        int            `json:"failed"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
	Counts        map[string]int `json:"counts"` // per operasi (tertunda)
	Items         int            `json:"items"`
}

// ChangeItem adalah satu operasi tertunda.
type ChangeItem struct {
	ID              int64           `json:"id"`
	ChangesetID     int64           `json:"changeset_id"`
	Seq             int             `json:"seq"`
	Op              string          `json:"op"` // create | update | delete | split | merge
	Kind            string          `json:"kind"`
	TargetID        *int64          `json:"target_id"`
	TypeCode        string          `json:"type_code"`
	Code            string          `json:"code"`
	Name            string          `json:"name"`
	Body            json.RawMessage `json:"body"`
	Before          json.RawMessage `json:"before,omitempty"`
	TargetUpdatedAt *time.Time      `json:"target_updated_at"`
	Status          string          `json:"status"`
	ResultID        *int64          `json:"result_id"`
	Error           string          `json:"error"`
	CreatedByName   string          `json:"created_by_name"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
	Changes         []string        `json:"changes,omitempty"` // ringkasan (atribut, geometri, ...)
}

// ChangeLog adalah jejak audit paket.
type ChangeLog struct {
	Action   string    `json:"action"`
	Username string    `json:"username"`
	FullName string    `json:"full_name"`
	Role     string    `json:"role"`
	Note     string    `json:"note"`
	At       time.Time `json:"at"`
}

// Person adalah identitas pelaku (untuk jejak audit).
type Person struct {
	UserID   string
	Username string
	FullName string
	Role     string
	Lang     i18n.Lang
}

func (p Person) actor() Actor {
	uid := p.UserID
	return Actor{UserID: &uid, Username: p.Username, Lang: p.Lang}
}

// Changes adalah layanan paket perubahan.
type Changes struct {
	pool *pgxpool.Pool
	cfg  *repo.Configs
	f    *Features
}

// NewChanges membuat layanan paket perubahan.
func NewChanges(pool *pgxpool.Pool, cfg *repo.Configs, f *Features) *Changes {
	return &Changes{pool: pool, cfg: cfg, f: f}
}

// Enabled: editing lewat persetujuan aktif.
func (c *Changes) Enabled() bool { return c.cfg.Bool("gis.approval_enabled", true) }

func cerr(kind error, lang i18n.Lang, id, en string, args ...any) error {
	msg := id
	if lang == i18n.EN {
		msg = en
	}
	return &Error{kind: kind, msg: fmt.Sprintf(msg, args...)}
}

// decodeInput membaca masukan editor; geometri "null" berarti tidak diubah.
func decodeInput(raw []byte, in *FeatureInput) error {
	if err := json.Unmarshal(raw, in); err != nil {
		return err
	}
	if g := strings.TrimSpace(string(in.Geometry)); g == "null" || g == "" {
		in.Geometry = nil
	}
	return nil
}

var wib = func() *time.Location {
	if tz, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		return tz
	}
	return time.FixedZone("WIB", 7*3600)
}()

// Editable: paket boleh diubah penyusunnya.
func Editable(status string) bool { return status == "draft" || status == "rejected" }

const csCols = `c.id, c.title, c.description, c.status, c.source, c.created_by::text, c.created_by_name, c.submitted_at, c.submitted_by,
	c.reviewed_at, c.reviewed_by, c.review_note, c.released_at, c.released_by, c.release_note, c.applied, c.failed, c.created_at, c.updated_at`

func scanCS(row pgx.Row) (Changeset, error) {
	var s Changeset
	err := row.Scan(&s.ID, &s.Title, &s.Description, &s.Status, &s.Source, &s.CreatedBy, &s.CreatedByName, &s.SubmittedAt, &s.SubmittedBy,
		&s.ReviewedAt, &s.ReviewedBy, &s.ReviewNote, &s.ReleasedAt, &s.ReleasedBy, &s.ReleaseNote, &s.Applied, &s.Failed, &s.CreatedAt, &s.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, ErrNotFound
	}
	return s, err
}

// Get mengambil paket beserta jumlah item per operasi.
func (c *Changes) Get(ctx context.Context, id int64) (Changeset, error) {
	s, err := scanCS(c.pool.QueryRow(ctx, `SELECT `+csCols+` FROM gis_changesets c WHERE c.id=$1`, id))
	if err != nil {
		return s, err
	}
	s.Counts = map[string]int{}
	rows, err := c.pool.Query(ctx, `SELECT op, count(*) FROM gis_change_items WHERE changeset_id=$1 GROUP BY op`, id)
	if err == nil {
		for rows.Next() {
			var op string
			var n int
			if rows.Scan(&op, &n) == nil {
				s.Counts[op] = n
				s.Items += n
			}
		}
		rows.Close()
	}
	return s, nil
}

// List mengembalikan paket (terbaru dulu). mine = user id penyusun (kosong = semua).
func (c *Changes) List(ctx context.Context, status []string, mine string, limit int) ([]Changeset, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := c.pool.Query(ctx, `SELECT `+csCols+`, COALESCE(x.counts, '{}'::jsonb) FROM gis_changesets c
		LEFT JOIN LATERAL (SELECT jsonb_object_agg(op, n) counts FROM (SELECT op, count(*) n FROM gis_change_items i WHERE i.changeset_id = c.id GROUP BY op) q) x ON true
		WHERE ($1::text[] IS NULL OR c.status = ANY($1)) AND ($2 = '' OR c.created_by::text = $2)
		ORDER BY c.updated_at DESC LIMIT $3`, nilStrings(status), mine, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Changeset{}
	for rows.Next() {
		var s Changeset
		var counts []byte
		if err := rows.Scan(&s.ID, &s.Title, &s.Description, &s.Status, &s.Source, &s.CreatedBy, &s.CreatedByName, &s.SubmittedAt, &s.SubmittedBy,
			&s.ReviewedAt, &s.ReviewedBy, &s.ReviewNote, &s.ReleasedAt, &s.ReleasedBy, &s.ReleaseNote, &s.Applied, &s.Failed, &s.CreatedAt, &s.UpdatedAt, &counts); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(counts, &s.Counts)
		for _, n := range s.Counts {
			s.Items += n
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func nilStrings(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return s
}

// Create membuat paket baru berstatus draf.
func (c *Changes) Create(ctx context.Context, title, desc, source string, p Person) (Changeset, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = fmt.Sprintf("Perubahan %s %s", p.FullNameOr(), time.Now().In(wib).Format("02/01/2006 15:04"))
	}
	var id int64
	if err := c.pool.QueryRow(ctx, `INSERT INTO gis_changesets (title, description, source, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		title, desc, source, p.UserID, p.FullNameOr()).Scan(&id); err != nil {
		return Changeset{}, err
	}
	c.log(ctx, id, "create", p, "")
	return c.Get(ctx, id)
}

// FullNameOr: nama lengkap, atau username bila kosong.
func (p Person) FullNameOr() string {
	if strings.TrimSpace(p.FullName) != "" {
		return p.FullName
	}
	return p.Username
}

func (c *Changes) log(ctx context.Context, id int64, action string, p Person, note string) {
	_, _ = c.pool.Exec(ctx, `INSERT INTO gis_changeset_log (changeset_id, action, username, full_name, role, note) VALUES ($1,$2,$3,$4,$5,$6)`,
		id, action, p.Username, p.FullNameOr(), p.Role, note)
	_, _ = c.pool.Exec(ctx, `UPDATE gis_changesets SET updated_at = now() WHERE id=$1`, id)
}

// Logs mengembalikan jejak audit paket.
func (c *Changes) Logs(ctx context.Context, id int64) ([]ChangeLog, error) {
	rows, err := c.pool.Query(ctx, `SELECT action, username, full_name, role, note, at FROM gis_changeset_log WHERE changeset_id=$1 ORDER BY at, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChangeLog{}
	for rows.Next() {
		var l ChangeLog
		if rows.Scan(&l.Action, &l.Username, &l.FullName, &l.Role, &l.Note, &l.At) == nil {
			out = append(out, l)
		}
	}
	return out, rows.Err()
}

// Update mengubah judul / deskripsi paket (penyusun, selama bisa diubah).
func (c *Changes) Update(ctx context.Context, id int64, title, desc string, p Person) error {
	cs, err := c.ownEditable(ctx, id, p)
	if err != nil {
		return err
	}
	if strings.TrimSpace(title) == "" {
		title = cs.Title
	}
	_, err = c.pool.Exec(ctx, `UPDATE gis_changesets SET title=$2, description=$3, updated_at=now() WHERE id=$1`, id, strings.TrimSpace(title), desc)
	return err
}

func (c *Changes) ownEditable(ctx context.Context, id int64, p Person) (Changeset, error) {
	cs, err := c.Get(ctx, id)
	if err != nil {
		return cs, err
	}
	if cs.CreatedBy == nil || *cs.CreatedBy != p.UserID {
		return cs, cerr(ErrForbidden, p.Lang, "Paket #%d milik %s; hanya penyusunnya yang dapat mengubah.", "Change set #%d belongs to %s; only its author can modify it.", id, cs.CreatedByName)
	}
	if !Editable(cs.Status) {
		return cs, cerr(ErrConflict, p.Lang, "Paket #%d berstatus %s dan tidak dapat diubah.", "Change set #%d is %s and cannot be modified.", id, cs.Status)
	}
	return cs, nil
}

// ActiveDraft mengembalikan paket draf / ditolak terbaru milik pengguna (0 bila tidak ada).
func (c *Changes) ActiveDraft(ctx context.Context, userID string) int64 {
	var id int64
	_ = c.pool.QueryRow(ctx, `SELECT id FROM gis_changesets WHERE created_by::text=$1 AND status IN ('draft','rejected') ORDER BY updated_at DESC LIMIT 1`, userID).Scan(&id)
	return id
}

// Resolve memastikan paket tujuan: id yang diberikan (harus milik & bisa diubah) atau paket draf baru.
func (c *Changes) Resolve(ctx context.Context, id int64, p Person) (Changeset, error) {
	if id > 0 {
		return c.ownEditable(ctx, id, p)
	}
	return c.Create(ctx, "", "", "editor", p)
}

// ------------------------------------------------------------------ item

const itemCols = `id, changeset_id, seq, op, kind, target_id, type_code, code, name, body, before, target_updated_at, status, result_id, error, created_by_name, created_at, updated_at`

func scanItem(row pgx.Row) (ChangeItem, error) {
	var it ChangeItem
	var body, before []byte
	err := row.Scan(&it.ID, &it.ChangesetID, &it.Seq, &it.Op, &it.Kind, &it.TargetID, &it.TypeCode, &it.Code, &it.Name, &body, &before,
		&it.TargetUpdatedAt, &it.Status, &it.ResultID, &it.Error, &it.CreatedByName, &it.CreatedAt, &it.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return it, ErrNotFound
	}
	it.Body = body
	if len(before) > 0 {
		it.Before = before
	}
	it.Changes = summarize(it)
	return it, err
}

func summarize(it ChangeItem) []string {
	if it.Op != "update" {
		return nil
	}
	var in FeatureInput
	decodeInput(it.Body, &in)
	out := []string{}
	if len(in.Geometry) > 0 {
		out = append(out, "geometri")
	}
	if in.TypeCode != "" {
		out = append(out, "jenis")
	}
	if in.Code != nil || in.Name != nil {
		out = append(out, "kode/nama")
	}
	if in.Status != "" {
		out = append(out, "status")
	}
	if in.Properties != nil {
		out = append(out, "atribut")
	}
	if in.UnitID != nil {
		out = append(out, "unit")
	}
	return out
}

// Items mengembalikan item paket berurutan.
func (c *Changes) Items(ctx context.Context, id int64) ([]ChangeItem, error) {
	rows, err := c.pool.Query(ctx, `SELECT `+itemCols+` FROM gis_change_items WHERE changeset_id=$1 ORDER BY seq, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChangeItem{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// Item mengambil satu item.
func (c *Changes) Item(ctx context.Context, id int64) (ChangeItem, error) {
	return scanItem(c.pool.QueryRow(ctx, `SELECT `+itemCols+` FROM gis_change_items WHERE id=$1`, id))
}

// ProposeResult adalah hasil pengusulan perubahan.
type ProposeResult struct {
	Changeset Changeset       `json:"changeset"`
	Item      *ChangeItem     `json:"item,omitempty"`
	Removed   bool            `json:"removed,omitempty"` // item dibatalkan (hapus objek baru yang belum dirilis)
	Feature   *models.Feature `json:"feature,omitempty"`
}

// targetState mengambil salinan objek aktif & waktu ubah terakhirnya.
func (c *Changes) targetState(ctx context.Context, kind string, id int64) (json.RawMessage, time.Time, models.Feature, error) {
	ft, err := c.f.Get(ctx, kind, id)
	if err != nil {
		return nil, time.Time{}, ft, err
	}
	raw, _ := json.Marshal(ft)
	var ts time.Time
	if t, ok := ft.Properties["updated_at"].(time.Time); ok {
		ts = t
	}
	return raw, ts, ft, nil
}

// lockedBy: paket lain yang masih terbuka dan sudah mengusulkan perubahan pada objek yang sama.
func (c *Changes) lockedBy(ctx context.Context, csID int64, kind string, target int64) (int64, string) {
	var id int64
	var by string
	_ = c.pool.QueryRow(ctx, `SELECT c.id, c.created_by_name FROM gis_change_items i JOIN gis_changesets c ON c.id = i.changeset_id
		WHERE i.kind=$1 AND i.target_id=$2 AND i.status='pending' AND c.id <> $3 AND c.status IN ('draft','submitted','approved','rejected') LIMIT 1`,
		kind, target, csID).Scan(&id, &by)
	return id, by
}

func (c *Changes) nextSeq(ctx context.Context, csID int64) int {
	var n int
	_ = c.pool.QueryRow(ctx, `SELECT COALESCE(max(seq), 0) + 1 FROM gis_change_items WHERE changeset_id=$1`, csID).Scan(&n)
	return n
}

// mergeInput menggabungkan usulan baru ke usulan lama (field yang dikirim menimpa).
func mergeInput(old, nw FeatureInput) FeatureInput {
	out := old
	if nw.TypeCode != "" {
		out.TypeCode = nw.TypeCode
	}
	if nw.Code != nil {
		out.Code = nw.Code
	}
	if nw.Name != nil {
		out.Name = nw.Name
	}
	if nw.Status != "" {
		out.Status = nw.Status
	}
	if len(nw.Geometry) > 0 {
		out.Geometry = nw.Geometry
	}
	if nw.Properties != nil {
		out.Properties = nw.Properties
	}
	if nw.UnitID != nil {
		out.UnitID = nw.UnitID
	}
	return out
}

// Propose menyimpan perubahan sebagai operasi tertunda dalam paket.
//   - target < 0: objek baru yang belum dirilis (id item create) → usulan create-nya diubah / dibatalkan;
//   - update berulang pada objek yang sama digabung; hapus menggantikan ubah.
func (c *Changes) Propose(ctx context.Context, csID int64, op, kind string, target int64, body json.RawMessage, p Person) (*ProposeResult, error) {
	lang := p.Lang
	cs, err := c.Resolve(ctx, csID, p)
	if err != nil {
		return nil, err
	}
	res := &ProposeResult{}
	var in FeatureInput
	if op == "create" || op == "update" {
		if err := decodeInput(body, &in); err != nil {
			return nil, errT(ErrBadRequest, lang, "common.bad_payload")
		}
	}
	// --- objek baru yang belum dirilis
	if target < 0 {
		it, err := c.Item(ctx, -target)
		if err != nil || it.ChangesetID != cs.ID || it.Op != "create" {
			return nil, cerr(ErrNotFound, lang, "Objek usulan tidak ditemukan pada paket aktif #%d.", "Proposed object not found in the active change set #%d.", cs.ID)
		}
		switch op {
		case "update":
			var old FeatureInput
			decodeInput(it.Body, &old)
			merged := mergeInput(old, in)
			if err := c.validateCreate(ctx, lang, &merged); err != nil {
				return nil, err
			}
			raw, _ := json.Marshal(merged)
			if _, err := c.pool.Exec(ctx, `UPDATE gis_change_items SET body=$2, type_code=$3, code=$4, name=$5, updated_at=now() WHERE id=$1`,
				it.ID, raw, merged.TypeCode, str(merged.Code), str(merged.Name)); err != nil {
				return nil, err
			}
		case "delete":
			if _, err := c.pool.Exec(ctx, `DELETE FROM gis_change_items WHERE id=$1`, it.ID); err != nil {
				return nil, err
			}
			res.Removed = true
		default:
			return nil, cerr(ErrConflict, lang, "Pisah / gabung garis hanya untuk objek yang sudah aktif; rilis dulu paket ini atau gambar ulang garisnya.",
				"Split / merge only applies to live objects; release this change set first or redraw the line.")
		}
		c.log(ctx, cs.ID, "item", p, fmt.Sprintf("%s objek usulan #%d", op, it.ID))
		if !res.Removed {
			it2, _ := c.Item(ctx, it.ID)
			res.Item = &it2
			if ft, err := c.Virtual(ctx, it2.ID); err == nil {
				res.Feature = &ft
			}
		}
		res.Changeset, _ = c.Get(ctx, cs.ID)
		return res, nil
	}
	// --- objek baru
	if op == "create" {
		if err := c.validateCreate(ctx, lang, &in); err != nil {
			return nil, err
		}
		raw, _ := json.Marshal(in)
		var itemID int64
		if err := c.pool.QueryRow(ctx, `INSERT INTO gis_change_items (changeset_id, seq, op, kind, type_code, code, name, body, created_by_name)
			VALUES ($1,$2,'create',$3,$4,$5,$6,$7,$8) RETURNING id`, cs.ID, c.nextSeq(ctx, cs.ID), in.Kind, in.TypeCode, str(in.Code), str(in.Name), raw, p.FullNameOr()).Scan(&itemID); err != nil {
			return nil, err
		}
		c.log(ctx, cs.ID, "item", p, fmt.Sprintf("tambah %s %s", in.TypeCode, str(in.Code)))
		it, _ := c.Item(ctx, itemID)
		res.Item = &it
		if ft, err := c.Virtual(ctx, itemID); err == nil {
			res.Feature = &ft
		}
		res.Changeset, _ = c.Get(ctx, cs.ID)
		return res, nil
	}
	// --- objek aktif: ubah / hapus / pisah / gabung
	if kind != "node" && kind != "edge" {
		return nil, errT(ErrBadRequest, lang, "gis.kind_invalid")
	}
	before, updAt, cur, err := c.targetState(ctx, kind, target)
	if err != nil {
		return nil, err
	}
	if other, by := c.lockedBy(ctx, cs.ID, kind, target); other > 0 {
		return nil, cerr(ErrConflict, lang, "Objek ini sedang diusulkan berubah di paket #%d (%s). Tunggu paket itu dirilis / ditolak.",
			"This object already has a pending change in change set #%d (%s). Wait until it is released / rejected.", other, by)
	}
	typeCode, _ := cur.Properties["type_code"].(string)
	code, _ := cur.Properties["code"].(string)
	name, _ := cur.Properties["name"].(string)
	// usulan sebelumnya pada objek yang sama di paket ini
	var prevID int64
	var prevOp string
	var prevBody []byte
	_ = c.pool.QueryRow(ctx, `SELECT id, op, body FROM gis_change_items WHERE changeset_id=$1 AND kind=$2 AND target_id=$3 AND status='pending' ORDER BY seq DESC LIMIT 1`,
		cs.ID, kind, target).Scan(&prevID, &prevOp, &prevBody)
	switch op {
	case "update":
		if len(in.Geometry) > 0 {
			if kind == "node" {
				if _, _, _, err := parsePolygonOrPoint(lang, in.Geometry); err != nil {
					return nil, err
				}
			} else if _, err := parseLine(lang, in.Geometry); err != nil {
				return nil, err
			}
		}
		if in.TypeCode != "" {
			want := "point"
			if kind == "edge" {
				want = "line"
			}
			chk := in
			chk.Kind = kind
			if err := c.f.validateType(lang, &chk, want); err != nil {
				return nil, err
			}
		}
		if prevID > 0 && prevOp == "delete" {
			return nil, cerr(ErrConflict, lang, "Objek ini sudah diusulkan untuk dihapus di paket ini.", "This object is already proposed for deletion in this change set.")
		}
		if prevID > 0 && prevOp == "update" {
			var old FeatureInput
			decodeInput(prevBody, &old)
			in = mergeInput(old, in)
			raw, _ := json.Marshal(in)
			if _, err := c.pool.Exec(ctx, `UPDATE gis_change_items SET body=$2, updated_at=now() WHERE id=$1`, prevID, raw); err != nil {
				return nil, err
			}
			c.log(ctx, cs.ID, "item", p, fmt.Sprintf("ubah %s #%d", kind, target))
			it, _ := c.Item(ctx, prevID)
			res.Item = &it
			break
		}
		fallthrough
	default:
		if op == "delete" && prevID > 0 {
			// hapus menggantikan usulan ubah sebelumnya
			if _, err := c.pool.Exec(ctx, `DELETE FROM gis_change_items WHERE id=$1`, prevID); err != nil {
				return nil, err
			}
		} else if prevID > 0 && prevOp == "delete" {
			return nil, cerr(ErrConflict, lang, "Objek ini sudah diusulkan untuk dihapus di paket ini.", "This object is already proposed for deletion in this change set.")
		}
		if op == "update" {
			body, _ = json.Marshal(in)
		}
		if len(body) == 0 {
			body = json.RawMessage(`{}`)
		}
		var itemID int64
		if err := c.pool.QueryRow(ctx, `INSERT INTO gis_change_items (changeset_id, seq, op, kind, target_id, type_code, code, name, body, before, target_updated_at, created_by_name)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
			cs.ID, c.nextSeq(ctx, cs.ID), op, kind, target, typeCode, code, name, []byte(body), []byte(before), updAt, p.FullNameOr()).Scan(&itemID); err != nil {
			return nil, err
		}
		c.log(ctx, cs.ID, "item", p, fmt.Sprintf("%s %s #%d %s", op, kind, target, code))
		it, _ := c.Item(ctx, itemID)
		res.Item = &it
	}
	if ft, err := c.Proposed(ctx, cs.ID, kind, target); err == nil {
		res.Feature = &ft
	}
	res.Changeset, _ = c.Get(ctx, cs.ID)
	return res, nil
}

func (c *Changes) validateCreate(ctx context.Context, lang i18n.Lang, in *FeatureInput) error {
	switch in.Kind {
	case "node":
		if err := c.f.validateType(lang, in, "point"); err != nil {
			return err
		}
		if _, _, _, err := parsePolygonOrPoint(lang, in.Geometry); err != nil {
			return err
		}
	case "edge":
		if err := c.f.validateType(lang, in, "line"); err != nil {
			return err
		}
		if _, err := parseLine(lang, in.Geometry); err != nil {
			return err
		}
	default:
		return errT(ErrBadRequest, lang, "gis.kind_invalid")
	}
	return c.f.checkSSOT(ctx, lang, in.Properties, "", 0)
}

// RemoveItem membatalkan satu item (penyusun, paket masih bisa diubah).
func (c *Changes) RemoveItem(ctx context.Context, csID, itemID int64, p Person) error {
	if _, err := c.ownEditable(ctx, csID, p); err != nil {
		return err
	}
	tag, err := c.pool.Exec(ctx, `DELETE FROM gis_change_items WHERE id=$1 AND changeset_id=$2`, itemID, csID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	c.log(ctx, csID, "item", p, fmt.Sprintf("batal item #%d", itemID))
	return err
}

// Rebase memperbarui salinan objek aktif pada item (setelah konflik: objek berubah oleh paket lain).
func (c *Changes) Rebase(ctx context.Context, csID, itemID int64, p Person) error {
	if _, err := c.ownEditable(ctx, csID, p); err != nil {
		return err
	}
	it, err := c.Item(ctx, itemID)
	if err != nil || it.ChangesetID != csID || it.TargetID == nil {
		return ErrNotFound
	}
	before, updAt, _, err := c.targetState(ctx, it.Kind, *it.TargetID)
	if err != nil {
		return cerr(ErrConflict, p.Lang, "Objek #%d sudah tidak ada di jaringan aktif; batalkan item ini.", "Object #%d no longer exists in the live network; cancel this item.", *it.TargetID)
	}
	_, err = c.pool.Exec(ctx, `UPDATE gis_change_items SET before=$2, target_updated_at=$3, status='pending', error='', updated_at=now() WHERE id=$1`, itemID, []byte(before), updAt)
	c.log(ctx, csID, "item", p, fmt.Sprintf("sinkron item #%d", itemID))
	return err
}

// ------------------------------------------------------------------ pratinjau

// Virtual membentuk fitur GeoJSON dari usulan objek baru (id negatif).
func (c *Changes) Virtual(ctx context.Context, itemID int64) (models.Feature, error) {
	it, err := c.Item(ctx, itemID)
	if err != nil || it.Op != "create" {
		return models.Feature{}, ErrNotFound
	}
	var in FeatureInput
	decodeInput(it.Body, &in)
	geom := in.Geometry
	var ft models.Feature
	ft.Type, ft.ID = "Feature", -it.ID
	if in.Kind == "node" {
		// bangunan (poligon) disajikan sebagai titik pusat + footprint
		if ring, lng, lat, err := parsePolygonOrPoint(i18n.ID, in.Geometry); err == nil {
			geom, _ = json.Marshal(map[string]any{"type": "Point", "coordinates": []float64{lng, lat}})
			ft.Properties = map[string]any{}
			if ring != nil {
				ft.Properties["footprint"] = json.RawMessage(ringToGeoJSON(ring))
			}
		}
	}
	if ft.Properties == nil {
		ft.Properties = map[string]any{}
	}
	ft.Geometry = geom
	props := in.Properties
	if props == nil {
		props = map[string]any{}
	}
	for k, v := range map[string]any{"kind": in.Kind, "type_code": in.TypeCode, "code": str(in.Code), "name": str(in.Name), "status": defStatus(in.Status),
		"properties": props, "created_at": it.CreatedAt, "updated_at": it.UpdatedAt, "energized": false, "unit_id": in.UnitID,
		"pending": map[string]any{"op": "create", "item_id": it.ID, "changeset_id": it.ChangesetID}} {
		ft.Properties[k] = v
	}
	if in.Kind == "edge" {
		if coords, err := parseLine(i18n.ID, in.Geometry); err == nil {
			ft.Properties["length_m"] = math.Round(lineLengthM(coords)*100) / 100
		}
		ft.Properties["from_node_id"], ft.Properties["to_node_id"] = int64(0), int64(0)
	} else {
		ft.Properties["degree"], ft.Properties["open_ways"] = 0, []int64{}
	}
	return ft, nil
}

func defStatus(s string) string {
	if s == "" {
		return "closed"
	}
	return s
}

func lineLengthM(coords [][2]float64) float64 {
	total := 0.0
	for i := 1; i < len(coords); i++ {
		a, b := coords[i-1], coords[i]
		lat := (a[1] + b[1]) / 2 * math.Pi / 180
		dx := (b[0] - a[0]) * 111320 * math.Cos(lat)
		dy := (b[1] - a[1]) * 110540
		total += math.Hypot(dx, dy)
	}
	return total
}

// Proposed mengembalikan objek aktif dengan usulan paket diterapkan (untuk panel atribut di editor).
func (c *Changes) Proposed(ctx context.Context, csID int64, kind string, id int64) (models.Feature, error) {
	ft, err := c.f.Get(ctx, kind, id)
	if err != nil || csID == 0 {
		return ft, err
	}
	var itemID int64
	var op string
	var body []byte
	if err := c.pool.QueryRow(ctx, `SELECT id, op, body FROM gis_change_items WHERE changeset_id=$1 AND kind=$2 AND target_id=$3 AND status='pending' ORDER BY seq DESC LIMIT 1`,
		csID, kind, id).Scan(&itemID, &op, &body); err != nil {
		return ft, nil
	}
	ft.Properties["pending"] = map[string]any{"op": op, "item_id": itemID, "changeset_id": csID}
	if op != "update" {
		return ft, nil
	}
	var in FeatureInput
	decodeInput(body, &in)
	if in.TypeCode != "" {
		ft.Properties["type_code"] = in.TypeCode
	}
	if in.Code != nil {
		ft.Properties["code"] = *in.Code
	}
	if in.Name != nil {
		ft.Properties["name"] = *in.Name
	}
	if in.Status != "" {
		ft.Properties["status"] = in.Status
	}
	if in.Properties != nil {
		ft.Properties["properties"] = in.Properties
	}
	if in.UnitID != nil {
		ft.Properties["unit_id"] = in.UnitID
	}
	if len(in.Geometry) > 0 {
		if kind == "node" {
			if ring, lng, lat, err := parsePolygonOrPoint(i18n.ID, in.Geometry); err == nil {
				ft.Geometry, _ = json.Marshal(map[string]any{"type": "Point", "coordinates": []float64{lng, lat}})
				if ring != nil {
					ft.Properties["footprint"] = json.RawMessage(ringToGeoJSON(ring))
				}
			}
		} else {
			ft.Geometry = in.Geometry
		}
	}
	return ft, nil
}

// GeoJSON membentuk lapisan pratinjau paket: objek baru, geometri usulan, objek dihapus, titik pisah/gabung.
func (c *Changes) GeoJSON(ctx context.Context, csID int64) (models.FeatureCollection, error) {
	fc := models.NewFeatureCollection()
	items, err := c.Items(ctx, csID)
	if err != nil {
		return fc, err
	}
	for _, it := range items {
		props := map[string]any{"op": it.Op, "item_id": it.ID, "kind": it.Kind, "type_code": it.TypeCode, "code": it.Code, "status": it.Status}
		var geom json.RawMessage
		fid := int64(0)
		switch it.Op {
		case "create":
			ft, err := c.Virtual(ctx, it.ID)
			if err != nil {
				continue
			}
			geom, fid = ft.Geometry, -it.ID
			if fp, ok := ft.Properties["footprint"]; ok {
				// bangunan: tampilkan denah
				if raw, ok := fp.(json.RawMessage); ok {
					geom = raw
				}
			}
		case "update", "delete":
			if it.TargetID == nil {
				continue
			}
			fid = *it.TargetID
			var before models.Feature
			_ = json.Unmarshal(it.Before, &before)
			geom = before.Geometry
			if it.Op == "update" {
				var in FeatureInput
				decodeInput(it.Body, &in)
				if len(in.Geometry) > 0 {
					geom = in.Geometry
					if it.Kind == "node" {
						if _, lng, lat, err := parsePolygonOrPoint(i18n.ID, in.Geometry); err == nil {
							geom, _ = json.Marshal(map[string]any{"type": "Point", "coordinates": []float64{lng, lat}})
						}
					}
					props["moved"] = true
				}
			}
		case "split":
			var b struct{ Lng, Lat float64 }
			_ = json.Unmarshal(it.Body, &b)
			geom, _ = json.Marshal(map[string]any{"type": "Point", "coordinates": []float64{b.Lng, b.Lat}})
			if it.TargetID != nil {
				fid = *it.TargetID
			}
		case "merge":
			if it.TargetID == nil {
				continue
			}
			fid = *it.TargetID
			var before models.Feature
			_ = json.Unmarshal(it.Before, &before)
			geom = before.Geometry
		}
		if len(geom) == 0 {
			continue
		}
		props["fid"] = fid
		fc.Features = append(fc.Features, models.Feature{Type: "Feature", ID: it.ID, Geometry: geom, Properties: props})
	}
	return fc, nil
}

// SnapDrafts: titik objek baru (usulan) di sekitar lokasi — agar garis baru bisa disambung ke tiang/gardu usulan.
func (c *Changes) SnapDrafts(ctx context.Context, csID int64, lng, lat, radiusM float64) []SnapResult {
	out := []SnapResult{}
	items, err := c.Items(ctx, csID)
	if err != nil {
		return out
	}
	for _, it := range items {
		if it.Op != "create" || it.Kind != "node" {
			continue
		}
		var in FeatureInput
		decodeInput(it.Body, &in)
		_, x, y, err := parsePolygonOrPoint(i18n.ID, in.Geometry)
		if err != nil {
			continue
		}
		d := lineLengthM([][2]float64{{lng, lat}, {x, y}})
		if d <= radiusM {
			out = append(out, SnapResult{Kind: "node", ID: -it.ID, TypeCode: in.TypeCode, Code: str(in.Code), Lng: x, Lat: y, DistM: d})
		}
	}
	return out
}

// ------------------------------------------------------------------ transisi status

// Submit mengajukan paket untuk disetujui.
func (c *Changes) Submit(ctx context.Context, id int64, note string, p Person) error {
	cs, err := c.ownEditable(ctx, id, p)
	if err != nil {
		return err
	}
	if cs.Items == 0 {
		return cerr(ErrBadRequest, p.Lang, "Paket belum berisi perubahan.", "The change set has no changes yet.")
	}
	if _, err := c.pool.Exec(ctx, `UPDATE gis_changesets SET status='submitted', submitted_at=now(), submitted_by=$2, updated_at=now() WHERE id=$1`, id, p.FullNameOr()); err != nil {
		return err
	}
	c.log(ctx, id, "submit", p, note)
	return nil
}

// Review menyetujui (approve=true) atau menolak paket yang diajukan / sudah disetujui.
func (c *Changes) Review(ctx context.Context, id int64, approve bool, note string, p Person) error {
	cs, err := c.Get(ctx, id)
	if err != nil {
		return err
	}
	if approve && cs.Status != "submitted" {
		return cerr(ErrConflict, p.Lang, "Hanya paket berstatus diajukan yang dapat disetujui (status: %s).", "Only submitted change sets can be approved (status: %s).", cs.Status)
	}
	if !approve && cs.Status != "submitted" && cs.Status != "approved" {
		return cerr(ErrConflict, p.Lang, "Paket berstatus %s tidak dapat ditolak.", "A %s change set cannot be rejected.", cs.Status)
	}
	if approve && cs.CreatedBy != nil && *cs.CreatedBy == p.UserID && !c.cfg.Bool("gis.approval_allow_self", false) {
		return cerr(ErrForbidden, p.Lang, "Penyusun tidak boleh menyetujui paketnya sendiri.", "Authors cannot approve their own change set.")
	}
	if !approve && strings.TrimSpace(note) == "" {
		return cerr(ErrBadRequest, p.Lang, "Alasan penolakan wajib diisi.", "A rejection reason is required.")
	}
	status, action := "approved", "approve"
	if !approve {
		status, action = "rejected", "reject"
	}
	if _, err := c.pool.Exec(ctx, `UPDATE gis_changesets SET status=$2, reviewed_at=now(), reviewed_by=$3, review_note=$4, updated_at=now() WHERE id=$1`,
		id, status, p.FullNameOr(), note); err != nil {
		return err
	}
	c.log(ctx, id, action, p, note)
	return nil
}

// Cancel membatalkan paket (penyusun).
func (c *Changes) Cancel(ctx context.Context, id int64, note string, p Person) error {
	if _, err := c.ownEditable(ctx, id, p); err != nil {
		return err
	}
	if _, err := c.pool.Exec(ctx, `UPDATE gis_changesets SET status='cancelled', updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	c.log(ctx, id, "cancel", p, note)
	return nil
}

// Conflict adalah item yang objek aktifnya berubah / hilang sejak diusulkan.
type Conflict struct {
	ItemID int64  `json:"item_id"`
	Kind   string `json:"kind"`
	Target int64  `json:"target_id"`
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

// Conflicts memeriksa item yang objek aktifnya berubah / terhapus sejak diusulkan.
func (c *Changes) Conflicts(ctx context.Context, id int64, lang i18n.Lang) ([]Conflict, error) {
	items, err := c.Items(ctx, id)
	if err != nil {
		return nil, err
	}
	out := []Conflict{}
	for _, it := range items {
		if it.Status != "pending" || it.TargetID == nil {
			continue
		}
		table := "gis_nodes"
		if it.Kind == "edge" {
			table = "gis_edges"
		}
		var upd time.Time
		err := c.pool.QueryRow(ctx, `SELECT updated_at FROM `+table+` WHERE id=$1`, *it.TargetID).Scan(&upd)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			out = append(out, Conflict{it.ID, it.Kind, *it.TargetID, it.Code, tl(string(lang), "objek sudah tidak ada", "object no longer exists")})
		case err != nil:
			return nil, err
		case it.TargetUpdatedAt != nil && upd.Sub(*it.TargetUpdatedAt).Abs() > time.Millisecond:
			out = append(out, Conflict{it.ID, it.Kind, *it.TargetID, it.Code, tl(string(lang), "objek berubah setelah diusulkan", "object changed after it was proposed")})
		}
	}
	return out, nil
}

// ReleaseResult merangkum penerapan paket ke jaringan aktif.
type ReleaseResult struct {
	Applied int           `json:"applied"`
	Failed  int           `json:"failed"`
	Results []*EditResult `json:"-"`
	Items   []ChangeItem  `json:"items"`
}

// Release menerapkan paket yang disetujui ke jaringan aktif (operasi diputar ulang berurutan).
// Paket dengan konflik ditolak seluruhnya (tidak ada yang diterapkan).
func (c *Changes) Release(ctx context.Context, id int64, note string, p Person) (*ReleaseResult, []Conflict, error) {
	cs, err := c.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if cs.Status != "approved" {
		return nil, nil, cerr(ErrConflict, p.Lang, "Hanya paket yang sudah disetujui yang dapat dirilis (status: %s).", "Only approved change sets can be released (status: %s).", cs.Status)
	}
	conflicts, err := c.Conflicts(ctx, id, p.Lang)
	if err != nil {
		return nil, nil, err
	}
	if len(conflicts) > 0 {
		return nil, conflicts, cerr(ErrConflict, p.Lang, "%d perubahan berkonflik dengan jaringan aktif; tolak paket agar penyusun menyinkronkan item tersebut.",
			"%d changes conflict with the live network; reject the change set so the author can resync those items.", len(conflicts))
	}
	// kunci: hanya satu rilis untuk paket ini
	tag, err := c.pool.Exec(ctx, `UPDATE gis_changesets SET status='released', released_at=now(), released_by=$2, release_note=$3, updated_at=now() WHERE id=$1 AND status='approved'`,
		id, p.FullNameOr(), note)
	if err != nil {
		return nil, nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, nil, cerr(ErrConflict, p.Lang, "Paket sedang / sudah dirilis.", "The change set is being / has been released.")
	}
	items, err := c.Items(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	actor := p.actor()
	res := &ReleaseResult{}
	for _, it := range items {
		if it.Status != "pending" {
			continue
		}
		var er *EditResult
		var err error
		switch it.Op {
		case "create":
			var in FeatureInput
			decodeInput(it.Body, &in)
			er, err = c.f.Create(ctx, in, actor)
		case "update":
			var in FeatureInput
			decodeInput(it.Body, &in)
			er, err = c.f.Update(ctx, it.Kind, *it.TargetID, in, actor)
		case "delete":
			er, err = c.f.Delete(ctx, it.Kind, *it.TargetID, actor)
		case "split":
			var b struct{ Lng, Lat float64 }
			_ = json.Unmarshal(it.Body, &b)
			er, err = c.f.SplitEdge(ctx, *it.TargetID, b.Lng, b.Lat, actor)
		case "merge":
			er, err = c.f.MergeAtJunction(ctx, *it.TargetID, actor)
		}
		if err != nil {
			res.Failed++
			_, _ = c.pool.Exec(ctx, `UPDATE gis_change_items SET status='failed', error=$2, updated_at=now() WHERE id=$1`, it.ID, err.Error())
			continue
		}
		res.Applied++
		res.Results = append(res.Results, er)
		_, _ = c.pool.Exec(ctx, `UPDATE gis_change_items SET status='applied', result_id=$2, error='', updated_at=now() WHERE id=$1`, it.ID, er.ID)
	}
	_, _ = c.pool.Exec(ctx, `UPDATE gis_changesets SET applied=$2, failed=$3 WHERE id=$1`, id, res.Applied, res.Failed)
	msg := note
	if res.Failed > 0 {
		msg = strings.TrimSpace(fmt.Sprintf("%s (diterapkan %d, gagal %d)", note, res.Applied, res.Failed))
	}
	c.log(ctx, id, "release", p, msg)
	res.Items, _ = c.Items(ctx, id)
	return res, nil, nil
}

// PendingCount: jumlah paket menunggu tindakan (diajukan / disetujui).
func (c *Changes) PendingCount(ctx context.Context) (submitted, approved int) {
	_ = c.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='submitted'), count(*) FILTER (WHERE status='approved') FROM gis_changesets`).Scan(&submitted, &approved)
	return
}
