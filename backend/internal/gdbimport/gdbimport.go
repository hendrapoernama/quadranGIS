// Package gdbimport mengimpor jaringan dari Esri File Geodatabase PLN (geometric network ESRI, ZIP)
// ke tabel jaringan QuadranGIS secara bertahap:
//  1. layer dimuat ke skema staging dengan ogr2ogr (PGDump → psql), build_staging.sql memetakan tipe/atribut,
//     memotong garis di simpul, dan membangun jaringan hasil di staging (belum ditulis);
//  2. diff_staging.sql membandingkannya per objek dengan batch yang sudah ada (pratinjau: baru, berubah, dihapus,
//     konflik dengan editan lokal) — job menunggu keputusan pengguna (status review);
//  3. apply_staging.sql menerapkan perbedaan per objek: id objek yang sudah ada tetap sehingga rujukan aman.
//
// Semua objek hasil impor memiliki properties.import = tag; identitas & baseline per objek di gdb_import_objects.
// Impor ditulis langsung (tidak melalui paket perubahan / alur persetujuan).
package gdbimport

import (
	"archive/zip"
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed build_staging.sql
var buildSQL string

//go:embed diff_staging.sql
var diffSQL string

//go:embed apply_staging.sql
var applySQL string

// Layers adalah layer GDB yang dibaca (nama tabel staging = huruf kecil).
var Layers = []string{"JTM", "MVCABLE", "JTR", "LVCABLE", "SR", "BUSBAR_LINE", "GD", "BLOKGARDU", "TRAFO", "TRAFO_GI", "GI",
	"MVCELL", "SWITCH", "PHBTR", "PELANGGAN", "TIANG", "JOINTING", "JaringanListrik_Net_Junctions"}

// MaxZipBytes membatasi ukuran berkas ZIP yang diunggah; MaxUnzipBytes ukuran setelah diekstrak.
const (
	MaxZipBytes   = 1 << 30
	MaxUnzipBytes = 4 << 30
)

var tagRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`)

// ValidTag: huruf, angka, titik, garis bawah, tanda hubung; maks. 40 karakter.
func ValidTag(t string) bool { return tagRe.MatchString(t) }

// Sentinel error untuk handler.
var (
	ErrBusy       = errors.New("gdbimport: impor lain sedang berjalan atau menunggu tinjauan")
	ErrNotFound   = errors.New("gdbimport: batch tidak ditemukan")
	ErrBadArchive = errors.New("gdbimport: berkas bukan ZIP berisi folder .gdb")
	ErrNoReview   = errors.New("gdbimport: tidak ada impor yang menunggu tinjauan")
)

// Options adalah pilihan impor.
type Options struct {
	AssignUnits bool `json:"assign_units"` // tetapkan unit pemilik aset batch (yang belum punya unit) dari lokasi
	KeepStaging bool `json:"keep_staging"` // simpan skema staging (untuk analisis / impor ulang)
}

// ApplyOptions adalah keputusan pengguna saat menerapkan pratinjau.
type ApplyOptions struct {
	Conflict string `json:"conflict"` // keep (pertahankan data QuadranGIS) | gdb (pakai data GDB)
	Deletes  bool   `json:"deletes"`  // hapus objek yang tidak ada lagi di GDB
}

// Step adalah satu tahap job.
type Step struct {
	Key     string `json:"key"`
	Status  string `json:"status"` // pending | running | done | failed | skipped
	Detail  string `json:"detail,omitempty"`
	Millis  int64  `json:"ms,omitempty"`
	started time.Time
}

// Job adalah status impor yang sedang / terakhir berjalan.
type Job struct {
	ID        int64          `json:"id"`
	Tag       string         `json:"tag"`
	FileName  string         `json:"file_name"`
	Status    string         `json:"status"` // running | review | done | failed | cancelled
	Steps     []*Step        `json:"steps"`
	Options   Options        `json:"options"`
	Summary   map[string]any `json:"summary,omitempty"`
	Preview   *Preview       `json:"preview,omitempty"`
	Error     string         `json:"error,omitempty"`
	StartedAt time.Time      `json:"started_at"`
	EndedAt   *time.Time     `json:"finished_at,omitempty"`
}

// Hooks dipanggil setelah data ditulis.
type Hooks struct {
	AssignUnits func(ctx context.Context, tag string) (int, error) // jumlah aset yang ditetapkan
	Reload      func(ctx context.Context) error                    // muat ulang graf topologi
}

// Manager menjalankan satu job impor pada satu waktu.
type Manager struct {
	pool  *pgxpool.Pool
	dbURL string
	hooks Hooks

	mu      sync.Mutex
	job     *Job
	summary map[string]any // ringkasan tahap bangun (dipakai lagi saat diterapkan)
}

// New membuat Manager; dbURL dipakai psql untuk memuat staging. Job yang terputus karena backend dimulai ulang
// (berjalan / menunggu tinjauan) ditandai gagal dan skema staging-nya dihapus.
func New(pool *pgxpool.Pool, dbURL string, hooks Hooks) *Manager {
	m := &Manager{pool: pool, dbURL: dbURL, hooks: hooks}
	go m.recoverStale()
	return m
}

func (m *Manager) recoverStale() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// ZIP unggahan & folder kerja job yang terputus (belum ada job baru saat server baru hidup)
	if old, err := filepath.Glob(filepath.Join(os.TempDir(), "gdbimp-*")); err == nil {
		for _, p := range old {
			_ = os.RemoveAll(p)
		}
	}
	rows, err := m.pool.Query(ctx, `UPDATE gdb_imports SET status = 'failed', error = 'dihentikan: backend dimulai ulang', finished_at = now()
		WHERE status IN ('running', 'review') RETURNING tag, options`)
	if err != nil {
		return
	}
	type stale struct {
		tag string
		opt Options
	}
	var list []stale
	for rows.Next() {
		var s stale
		if rows.Scan(&s.tag, &s.opt) == nil {
			list = append(list, s)
		}
	}
	rows.Close()
	for _, s := range list {
		if !s.opt.KeepStaging {
			_, _ = m.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+StagingSchema(s.tag)+` CASCADE`)
		}
		log.Printf("[gdb-import] job %s terputus (backend dimulai ulang)", s.tag)
	}
}

// Current mengembalikan salinan job yang sedang / terakhir berjalan (nil bila belum ada).
func (m *Manager) Current() *Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.job == nil {
		return nil
	}
	j := *m.job
	j.Steps = make([]*Step, len(m.job.Steps))
	for i, s := range m.job.Steps {
		c := *s
		if c.Status == "running" {
			c.Millis = time.Since(s.started).Milliseconds()
		}
		j.Steps[i] = &c
	}
	return &j
}

// Running: ada job yang sedang berjalan.
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.job != nil && m.job.Status == "running"
}

// Busy: ada job yang berjalan atau menunggu tinjauan (impor / hapus lain ditolak).
func (m *Manager) Busy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.job != nil && (m.job.Status == "running" || m.job.Status == "review")
}

func (m *Manager) step(key string) *Step {
	for _, s := range m.job.Steps {
		if s.Key == key {
			return s
		}
	}
	return nil
}

func (m *Manager) begin(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.step(key); s != nil {
		s.Status, s.started = "running", time.Now()
	}
}

func (m *Manager) end(key, status, detail string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.step(key); s != nil {
		s.Status, s.Detail = status, detail
		if !s.started.IsZero() {
			s.Millis = time.Since(s.started).Milliseconds()
		}
	}
}

func (m *Manager) progress(key, detail string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.step(key); s != nil {
		s.Detail = detail
	}
}

// finish menutup job (done | failed | cancelled): tahap yang belum berjalan ditandai dilewati.
func (m *Manager) finish(status, errMsg string) (id int64, tag string, opt Options) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.job.Steps {
		if s.Status == "pending" {
			s.Status = "skipped"
		}
	}
	now := time.Now()
	m.job.Status, m.job.Error, m.job.EndedAt = status, errMsg, &now
	return m.job.ID, m.job.Tag, m.job.Options
}

// fail menandai tahap & job gagal; skema staging dihapus kecuali diminta disimpan.
func (m *Manager) fail(key string, err error) {
	m.end(key, "failed", err.Error())
	id, tag, opt := m.finish("failed", err.Error())
	if !opt.KeepStaging {
		_, _ = m.pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+StagingSchema(tag)+` CASCADE`)
	}
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, id, err.Error())
}

// Start memulai impor dari berkas ZIP (sudah disimpan di disk; dihapus setelah selesai). Job berhenti di status
// review setelah perbandingan; lanjutkan dengan Apply atau Cancel.
func (m *Manager) Start(zipPath, fileName string, size int64, tag, actor string, opt Options) (*Job, error) {
	m.mu.Lock()
	if m.job != nil && (m.job.Status == "running" || m.job.Status == "review") {
		m.mu.Unlock()
		return nil, ErrBusy
	}
	keys := []string{"extract", "stage", "map", "diff", "apply", "units", "cleanup", "reload"}
	j := &Job{Tag: tag, FileName: fileName, Status: "running", Options: opt, StartedAt: time.Now()}
	for _, k := range keys {
		j.Steps = append(j.Steps, &Step{Key: k, Status: "pending"})
	}
	m.job, m.summary = j, nil
	m.mu.Unlock()

	var id int64
	err := m.pool.QueryRow(context.Background(), `INSERT INTO gdb_imports (tag, file_name, file_bytes, options, created_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`, tag, fileName, size, opt, actor).Scan(&id)
	if err != nil {
		m.mu.Lock()
		m.job = nil
		m.mu.Unlock()
		return nil, err
	}
	m.mu.Lock()
	j.ID = id
	m.mu.Unlock()
	go m.run(zipPath, tag, id)
	return m.Current(), nil
}

// psqlVars adalah variabel psql untuk skrip staging.
func psqlVars(schema, tag string, since time.Time, ap ApplyOptions) []string {
	del := "0"
	if ap.Deletes {
		del = "1"
	}
	conflict := "keep"
	if ap.Conflict == "gdb" {
		conflict = "gdb"
	}
	return []string{"-v", "src=" + schema, "-v", "tag=" + tag, "-v", "since=" + since.UTC().Format(time.RFC3339Nano),
		"-v", "conflict=" + conflict, "-v", "deletes=" + del}
}

// inTx membungkus skrip dalam satu transaksi.
func inTx(sql ...string) string {
	return "BEGIN;\n" + strings.Join(sql, "\n") + "\nCOMMIT;\n"
}

// lastApplied: waktu batch terakhir diterapkan (patokan editan lokal untuk batch tanpa baseline).
func (m *Manager) lastApplied(ctx context.Context, tag string, exceptID int64) time.Time {
	var t *time.Time
	_ = m.pool.QueryRow(ctx, `SELECT max(finished_at) FROM gdb_imports WHERE tag = $1 AND id <> $2 AND status IN ('done', 'replaced')`, tag, exceptID).Scan(&t)
	if t == nil {
		return time.Unix(0, 0)
	}
	return *t
}

func (m *Manager) run(zipPath, tag string, id int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	work, _ := os.MkdirTemp("", "gdbimp-")
	schema := StagingSchema(tag)
	defer func() {
		_ = os.Remove(zipPath)
		_ = os.RemoveAll(work)
	}()
	summary := map[string]any{"schema": schema}

	// 1. ekstrak ZIP
	m.begin("extract")
	gdb, err := extractGDB(zipPath, work)
	if err != nil {
		m.fail("extract", err)
		return
	}
	_ = os.Remove(zipPath)
	have, err := listLayers(ctx, gdb)
	if err != nil {
		m.fail("extract", err)
		return
	}
	var missing []string
	for _, l := range Layers {
		if !have[strings.ToLower(l)] {
			missing = append(missing, l)
		}
	}
	if len(missing) > 0 {
		m.fail("extract", fmt.Errorf("layer wajib tidak ada di GDB: %s", strings.Join(missing, ", ")))
		return
	}
	m.end("extract", "done", filepath.Base(gdb))

	// 2. muat layer ke skema staging
	m.begin("stage")
	if _, err := m.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE; CREATE SCHEMA `+schema); err != nil {
		m.fail("stage", err)
		return
	}
	for i, l := range Layers {
		m.progress("stage", fmt.Sprintf("%d/%d %s", i+1, len(Layers), l))
		if err := m.stageLayer(ctx, gdb, l, schema); err != nil {
			m.fail("stage", fmt.Errorf("%s: %w", l, err))
			return
		}
	}
	_ = os.RemoveAll(work)
	counts := map[string]int64{}
	for _, l := range Layers {
		var n int64
		_ = m.pool.QueryRow(ctx, `SELECT count(*) FROM `+schema+`.`+strings.ToLower(l)).Scan(&n)
		counts[strings.ToLower(l)] = n
	}
	summary["source"] = counts
	for _, l := range Layers {
		if _, err := m.pool.Exec(ctx, `ANALYZE `+schema+`.`+strings.ToLower(l)); err != nil {
			m.fail("stage", err)
			return
		}
	}
	m.end("stage", "done", fmt.Sprintf("%d layer", len(Layers)))

	// 3. pemetaan → jaringan hasil di staging
	m.begin("map")
	if out, err := m.psql(ctx, strings.NewReader(buildSQL), "-v", "src="+schema, "-v", "tag="+tag); err != nil {
		m.fail("map", fmt.Errorf("%v: %s", err, lastLines(out, 6)))
		return
	}
	var feed, paired, cuts, syn int64
	_ = m.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM `+schema+`.imp_feed), (SELECT count(*) FROM `+schema+`.imp_feed_sw),
		(SELECT count(*) FROM `+schema+`.imp_cut), (SELECT count(*) FROM `+schema+`.imp_syn)`).Scan(&feed, &paired, &cuts, &syn)
	summary["gi_feeder_gaps"], summary["gi_feeder_paired"], summary["line_cuts"], summary["synthetic_links"] = feed, paired, cuts, syn
	nodes, edges, err := m.stagedCounts(ctx, schema)
	if err != nil {
		m.fail("map", err)
		return
	}
	summary["nodes"], summary["edges"] = nodes, edges
	m.end("map", "done", "")

	// 4. bandingkan dengan batch yang sudah ada → menunggu keputusan pengguna
	m.begin("diff")
	since := m.lastApplied(ctx, tag, id)
	if out, err := m.psql(ctx, strings.NewReader(inTx(diffSQL)), psqlVars(schema, tag, since, ApplyOptions{})...); err != nil {
		m.fail("diff", fmt.Errorf("%v: %s", err, lastLines(out, 6)))
		return
	}
	pv, err := m.preview(ctx, schema, tag, since)
	if err != nil {
		m.fail("diff", err)
		return
	}
	m.end("diff", "done", fmt.Sprintf("%d", pv.Changes()))

	m.mu.Lock()
	m.job.Status, m.job.Summary, m.job.Preview, m.summary = "review", summary, pv, summary
	m.mu.Unlock()
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status = 'review', summary = $2, preview = $3 WHERE id = $1`, id, summary, pv)
}

// Apply menerapkan pratinjau yang sedang ditinjau (dibandingkan ulang tepat sebelum diterapkan, satu transaksi).
func (m *Manager) Apply(ap ApplyOptions) (*Job, error) {
	m.mu.Lock()
	if m.job == nil || m.job.Status != "review" {
		m.mu.Unlock()
		return nil, ErrNoReview
	}
	m.job.Status = "running"
	id, tag := m.job.ID, m.job.Tag
	m.mu.Unlock()
	go m.apply(id, tag, ap)
	return m.Current(), nil
}

func (m *Manager) apply(id int64, tag string, ap ApplyOptions) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	schema := StagingSchema(tag)
	// salinan: ringkasan tahap bangun sedang dibaca handler status (job.Summary)
	summary := map[string]any{}
	m.mu.Lock()
	for k, v := range m.summary {
		summary[k] = v
	}
	opt := m.job.Options
	m.mu.Unlock()

	// 5. terapkan per objek
	m.begin("apply")
	since := m.lastApplied(ctx, tag, id)
	if out, err := m.psql(ctx, strings.NewReader(inTx(diffSQL, applySQL)), psqlVars(schema, tag, since, ap)...); err != nil {
		m.fail("apply", fmt.Errorf("%v: %s", err, lastLines(out, 6)))
		return
	}
	res, err := m.applied(ctx, schema)
	if err != nil {
		m.fail("apply", err)
		return
	}
	res["options"] = ap
	summary["applied"] = res
	if nodes, edges, err := m.batchCounts(ctx, tag); err == nil {
		summary["nodes"], summary["edges"] = nodes, edges
	}
	m.end("apply", "done", "")

	// 6. unit pemilik (hanya aset yang belum punya unit)
	if opt.AssignUnits && m.hooks.AssignUnits != nil {
		m.begin("units")
		n, err := m.hooks.AssignUnits(ctx, tag)
		if err != nil {
			m.fail("units", err)
			return
		}
		summary["units_assigned"] = n
		m.end("units", "done", fmt.Sprint(n))
	} else {
		m.end("units", "skipped", "")
	}

	// 7. staging
	m.begin("cleanup")
	if opt.KeepStaging {
		m.end("cleanup", "skipped", schema)
	} else {
		if _, err := m.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			m.fail("cleanup", err)
			return
		}
		delete(summary, "schema")
		m.end("cleanup", "done", "")
	}

	// 8. topologi
	m.begin("reload")
	if m.hooks.Reload != nil {
		if err := m.hooks.Reload(ctx); err != nil {
			m.fail("reload", err)
			return
		}
	}
	m.end("reload", "done", "")

	m.mu.Lock()
	m.job.Summary = summary
	m.mu.Unlock()
	m.finish("done", "")
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status = 'done', summary = $2, finished_at = now() WHERE id = $1`, id, summary)
	// versi batch sebelumnya dengan tag sama sudah diperbarui oleh impor ini
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status = 'replaced' WHERE tag = $1 AND id <> $2 AND status IN ('done', 'failed', 'cancelled')`, tag, id)
}

// Cancel membatalkan pratinjau yang sedang ditinjau (jaringan tidak berubah).
func (m *Manager) Cancel() (*Job, error) {
	m.mu.Lock()
	if m.job == nil || m.job.Status != "review" {
		m.mu.Unlock()
		return nil, ErrNoReview
	}
	m.mu.Unlock()
	id, tag, opt := m.finish("cancelled", "")
	if !opt.KeepStaging {
		_, _ = m.pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+StagingSchema(tag)+` CASCADE`)
	}
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status = 'cancelled', finished_at = now() WHERE id = $1`, id)
	return m.Current(), nil
}

// ---------------------------------------------------------------- pratinjau

// Preview merangkum hasil perbandingan GDB baru dengan batch yang sudah ada.
type Preview struct {
	Nodes      map[string]int64 `json:"nodes"`   // aksi → jumlah (insert | update | delete | conflict | local | same)
	Edges      map[string]int64 `json:"edges"`   // idem untuk saluran
	Reasons    map[string]int64 `json:"reasons"` // alasan konflik / lokal
	Fields     map[string]int64 `json:"fields"`  // objek berubah / konflik per bagian: geometry | footprint | type | code | name | props
	Attrs      []KeyCount       `json:"attrs"`   // atribut GDB yang paling sering berubah
	ByType     []TypeDiff       `json:"by_type"`
	Refs       map[string]int64 `json:"refs"`        // sumber rujukan → objek usulan hapus yang dirujuk
	RefObjects int64            `json:"ref_objects"` // objek usulan hapus yang punya rujukan
	Overlap    []TagCount       `json:"overlap"`     // batch lain yang memakai GlobalID yang sama
	Existing   int64            `json:"existing"`    // objek batch saat ini
	Baseline   bool             `json:"baseline"`    // batch sudah punya catatan identitas (impor bertahap sebelumnya)
	Since      *time.Time       `json:"since,omitempty"`
}

// TypeDiff adalah jumlah per aksi untuk satu tipe komponen.
type TypeDiff struct {
	Kind     string `json:"kind"`
	Type     string `json:"type"`
	Insert   int64  `json:"insert"`
	Update   int64  `json:"update"`
	Delete   int64  `json:"delete"`
	Conflict int64  `json:"conflict"`
	Local    int64  `json:"local"`
	Same     int64  `json:"same"`
}

// TagCount adalah jumlah objek per tag batch.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int64  `json:"count"`
}

// KeyCount adalah jumlah objek per nama atribut.
type KeyCount struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

// Changes: jumlah objek yang akan / bisa berubah (selain sama & lokal).
func (p *Preview) Changes() int64 {
	var n int64
	for _, mp := range []map[string]int64{p.Nodes, p.Edges} {
		n += mp["insert"] + mp["update"] + mp["delete"] + mp["conflict"]
	}
	return n
}

const diffUnion = `SELECT 'node' kind, key, action, reason, type_code, old_type, code, name, cur_id, lng, lat, changes, refs FROM %[1]s.imp_diff_node
	UNION ALL SELECT 'edge', key, action, reason, type_code, old_type, code, name, cur_id, lng, lat, changes, 0 FROM %[1]s.imp_diff_edge`

func (m *Manager) preview(ctx context.Context, schema, tag string, since time.Time) (*Preview, error) {
	p := &Preview{Nodes: map[string]int64{}, Edges: map[string]int64{}, Reasons: map[string]int64{}, Refs: map[string]int64{},
		Fields: map[string]int64{}, Attrs: []KeyCount{}, ByType: []TypeDiff{}, Overlap: []TagCount{}}
	if since.Unix() > 0 {
		p.Since = &since
	}
	rows, err := m.pool.Query(ctx, `SELECT kind, type_code, action, count(*) FROM (`+fmt.Sprintf(diffUnion, schema)+`) x GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2`)
	if err != nil {
		return nil, err
	}
	byType := map[string]*TypeDiff{}
	var order []string
	for rows.Next() {
		var kind, typ, action string
		var n int64
		if err := rows.Scan(&kind, &typ, &action, &n); err != nil {
			rows.Close()
			return nil, err
		}
		if kind == "node" {
			p.Nodes[action] += n
		} else {
			p.Edges[action] += n
		}
		k := kind + "/" + typ
		t := byType[k]
		if t == nil {
			t = &TypeDiff{Kind: kind, Type: typ}
			byType[k] = t
			order = append(order, k)
		}
		switch action {
		case "insert":
			t.Insert += n
		case "update":
			t.Update += n
		case "delete":
			t.Delete += n
		case "conflict":
			t.Conflict += n
		case "local":
			t.Local += n
		case "same":
			t.Same += n
		}
	}
	rows.Close()
	for _, k := range order {
		p.ByType = append(p.ByType, *byType[k])
	}

	rows, err = m.pool.Query(ctx, `SELECT reason, count(*) FROM (`+fmt.Sprintf(diffUnion, schema)+`) x WHERE reason <> '' GROUP BY 1`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r string
		var n int64
		if rows.Scan(&r, &n) == nil {
			p.Reasons[r] = n
		}
	}
	rows.Close()

	// bagian yang berubah (berubah di GDB & konflik)
	var geom, fp, typ, code, name, props int64
	if err := m.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE changes ? 'move_m'), count(*) FILTER (WHERE changes ? 'footprint'),
		count(*) FILTER (WHERE changes ? 'type'), count(*) FILTER (WHERE changes ? 'code'), count(*) FILTER (WHERE changes ? 'name'),
		count(*) FILTER (WHERE changes ? 'props')
		FROM (`+fmt.Sprintf(diffUnion, schema)+`) x WHERE action IN ('update', 'conflict')`).Scan(&geom, &fp, &typ, &code, &name, &props); err != nil {
		return nil, err
	}
	for k, v := range map[string]int64{"geometry": geom, "footprint": fp, "type": typ, "code": code, "name": name, "props": props} {
		if v > 0 {
			p.Fields[k] = v
		}
	}
	rows, err = m.pool.Query(ctx, `SELECT k, count(*) FROM (`+fmt.Sprintf(diffUnion, schema)+`) x, jsonb_object_keys(x.changes->'props') k
		WHERE action IN ('update', 'conflict') AND changes ? 'props' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var kc KeyCount
		if rows.Scan(&kc.Key, &kc.Count) == nil {
			p.Attrs = append(p.Attrs, kc)
		}
	}
	rows.Close()

	rows, err = m.pool.Query(ctx, `SELECT r.src, count(DISTINCT r.id) FROM `+schema+`.imp_refs r
		JOIN `+schema+`.imp_diff_node d ON d.cur_id = r.id AND d.action = 'delete' GROUP BY 1`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s string
		var n int64
		if rows.Scan(&s, &n) == nil {
			p.Refs[s] = n
		}
	}
	rows.Close()
	_ = m.pool.QueryRow(ctx, `SELECT count(*) FROM `+schema+`.imp_diff_node WHERE action = 'delete' AND refs > 0`).Scan(&p.RefObjects)

	rows, err = m.pool.Query(ctx, `SELECT tag, n FROM `+schema+`.imp_overlap ORDER BY n DESC`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var t TagCount
		if rows.Scan(&t.Tag, &t.Count) == nil {
			p.Overlap = append(p.Overlap, t)
		}
	}
	rows.Close()

	_ = m.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM `+schema+`.cur_node) + (SELECT count(*) FROM `+schema+`.cur_edge)`).Scan(&p.Existing)
	_ = m.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM gdb_import_objects WHERE tag = $1)`, tag).Scan(&p.Baseline)
	return p, nil
}

// applied merangkum keputusan akhir yang diterapkan dan perbesaran denah gardu.
func (m *Manager) applied(ctx context.Context, schema string) (map[string]any, error) {
	res := map[string]any{}
	for _, kind := range []string{"node", "edge"} {
		mp := map[string]int64{}
		rows, err := m.pool.Query(ctx, `SELECT final, count(*) FROM `+schema+`.imp_diff_`+kind+` GROUP BY 1`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var f string
			var n int64
			if rows.Scan(&f, &n) == nil {
				mp[f] = n
			}
		}
		rows.Close()
		res[kind+"s"] = mp
	}
	var restored, gardu, nodes, edges int64
	if err := m.pool.QueryRow(ctx, `SELECT restored, gardu, nodes, edges FROM `+schema+`.imp_layout`).Scan(&restored, &gardu, &nodes, &edges); err == nil {
		res["layout"] = map[string]int64{"restored": restored, "gardu": gardu, "nodes": nodes, "edges": edges}
	}
	return res, nil
}

// Change adalah satu baris daftar perbedaan.
type Change struct {
	Kind    string          `json:"kind"` // node | edge
	Key     string          `json:"key"`
	Action  string          `json:"action"`
	Reason  string          `json:"reason,omitempty"`
	Type    string          `json:"type"`
	OldType string          `json:"old_type,omitempty"`
	Code    string          `json:"code"`
	Name    string          `json:"name"`
	ID      *int64          `json:"id,omitempty"` // id objek QuadranGIS (kosong = belum ada)
	Lng     float64         `json:"lng"`
	Lat     float64         `json:"lat"`
	Changes json.RawMessage `json:"changes,omitempty"`
	Refs    int             `json:"refs,omitempty"`
}

// ChangeFilter menyaring daftar perbedaan.
type ChangeFilter struct {
	Action, Kind, Type, Q string
	Offset, Limit         int
}

// Changes mengembalikan daftar perbedaan pratinjau yang sedang ditinjau (tanpa "sama" kecuali diminta).
func (m *Manager) Changes(ctx context.Context, f ChangeFilter) ([]Change, int64, error) {
	m.mu.Lock()
	if m.job == nil || m.job.Status != "review" {
		m.mu.Unlock()
		return nil, 0, ErrNoReview
	}
	schema := StagingSchema(m.job.Tag)
	m.mu.Unlock()
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	q := strings.TrimSpace(f.Q)
	rows, err := m.pool.Query(ctx, `SELECT kind, key, action, reason, type_code, coalesce(old_type, ''), code, name, cur_id,
		coalesce(lng, 0), coalesce(lat, 0), changes, refs, count(*) OVER ()
		FROM (`+fmt.Sprintf(diffUnion, schema)+`) x
		WHERE (CASE WHEN $1 = '' THEN action <> 'same' ELSE action = $1 END)
		  AND ($2 = '' OR kind = $2) AND ($3 = '' OR type_code = $3)
		  AND ($4 = '' OR code ILIKE '%' || $4 || '%' OR name ILIKE '%' || $4 || '%')
		ORDER BY CASE action WHEN 'conflict' THEN 0 WHEN 'delete' THEN 1 WHEN 'update' THEN 2 WHEN 'insert' THEN 3 WHEN 'local' THEN 4 ELSE 5 END,
		  kind DESC, type_code, code, key
		OFFSET $5 LIMIT $6`, f.Action, f.Kind, f.Type, q, f.Offset, f.Limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Change{}
	var total int64
	for rows.Next() {
		var c Change
		var ch []byte
		if err := rows.Scan(&c.Kind, &c.Key, &c.Action, &c.Reason, &c.Type, &c.OldType, &c.Code, &c.Name, &c.ID, &c.Lng, &c.Lat, &ch, &c.Refs, &total); err != nil {
			return nil, 0, err
		}
		if len(ch) > 0 {
			c.Changes = ch
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

// StagingSchema adalah nama skema staging untuk tag (stg_<tag huruf kecil>).
func StagingSchema(tag string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(tag) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	return "stg_" + b.String()
}

// extractGDB mengekstrak ZIP ke dir dan mengembalikan folder .gdb pertama.
func extractGDB(zipPath, dir string) (string, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", ErrBadArchive
	}
	defer zr.Close()
	var total int64
	gdb := ""
	root, _ := filepath.Abs(dir)
	for _, f := range zr.File {
		name := filepath.Clean(filepath.FromSlash(f.Name))
		dst := filepath.Join(root, name)
		if !strings.HasPrefix(dst, root+string(os.PathSeparator)) {
			return "", fmt.Errorf("%w: path tidak aman %q", ErrBadArchive, f.Name)
		}
		// folder .gdb = elemen path yang berakhiran .gdb
		parts := strings.Split(filepath.ToSlash(name), "/")
		for i, p := range parts {
			if strings.HasSuffix(strings.ToLower(p), ".gdb") && (i < len(parts)-1 || f.FileInfo().IsDir()) && gdb == "" {
				gdb = filepath.Join(root, filepath.FromSlash(strings.Join(parts[:i+1], "/")))
			}
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return "", err
			}
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > MaxUnzipBytes {
			return "", fmt.Errorf("%w: isi ZIP melebihi %d GB", ErrBadArchive, MaxUnzipBytes>>30)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", err
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		w, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return "", err
		}
		_, err = io.Copy(w, io.LimitReader(rc, MaxUnzipBytes))
		rc.Close()
		w.Close()
		if err != nil {
			return "", err
		}
	}
	if gdb == "" {
		return "", ErrBadArchive
	}
	return gdb, nil
}

// listLayers membaca nama layer GDB (huruf kecil) dengan ogrinfo.
func listLayers(ctx context.Context, gdb string) (map[string]bool, error) {
	out, err := exec.CommandContext(ctx, "ogrinfo", "-ro", "-q", gdb).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ogrinfo: %v: %s", err, lastLines(string(out), 3))
	}
	have := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		// "1: JTM (Multi Line String)"
		line := strings.TrimSpace(sc.Text())
		if i := strings.Index(line, ": "); i > 0 {
			name := line[i+2:]
			if j := strings.Index(name, " ("); j > 0 {
				name = name[:j]
			}
			have[strings.ToLower(strings.TrimSpace(name))] = true
		}
	}
	return have, nil
}

// stageLayer: ogr2ogr PGDump ke stdout → psql.
func (m *Manager) stageLayer(ctx context.Context, gdb, layer, schema string) error {
	og := exec.CommandContext(ctx, "ogr2ogr", "-f", "PGDump", "/vsistdout/", gdb, layer,
		"-lco", "SCHEMA="+schema, "-lco", "CREATE_SCHEMA=OFF", "-nln", strings.ToLower(layer),
		"-t_srs", "EPSG:4326", "-dim", "XY", "-nlt", "CONVERT_TO_LINEAR", "-nlt", "PROMOTE_TO_MULTI",
		"-lco", "GEOMETRY_NAME=geom", "-lco", "FID=fid", "-lco", "SRID=4326")
	pipe, err := og.StdoutPipe()
	if err != nil {
		return err
	}
	var ogErr strings.Builder
	og.Stderr = &limitedWriter{w: &ogErr, n: 4096}
	if err := og.Start(); err != nil {
		return fmt.Errorf("ogr2ogr: %w", err)
	}
	out, perr := m.psql(ctx, pipe, "-q")
	werr := og.Wait()
	if perr != nil {
		return fmt.Errorf("psql: %v: %s", perr, lastLines(out, 4))
	}
	if werr != nil {
		return fmt.Errorf("ogr2ogr: %v: %s", werr, lastLines(ogErr.String(), 4))
	}
	return nil
}

// psql menjalankan skrip dari stdin (ON_ERROR_STOP) dan mengembalikan keluaran (dipangkas).
func (m *Manager) psql(ctx context.Context, stdin io.Reader, args ...string) (string, error) {
	a := append([]string{"-X", "-v", "ON_ERROR_STOP=1", "-d", m.dbURL}, args...)
	a = append(a, "-f", "-")
	cmd := exec.CommandContext(ctx, "psql", a...)
	cmd.Stdin = stdin
	var out strings.Builder
	lw := &limitedWriter{w: &out, n: 64 << 10}
	cmd.Stdout, cmd.Stderr = lw, lw
	err := cmd.Run()
	return out.String(), err
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		_, _ = l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// ---------------------------------------------------------------- daftar & hapus batch

// TypeCount adalah jumlah per tipe komponen dalam batch.
type TypeCount struct {
	Type  string  `json:"type"`
	Count int64   `json:"count"`
	Km    float64 `json:"km,omitempty"`
}

// stagedCounts: jumlah per tipe jaringan hasil pemetaan (staging).
func (m *Manager) stagedCounts(ctx context.Context, schema string) ([]TypeCount, []TypeCount, error) {
	return m.typeCounts(ctx, `SELECT type_code, count(*) FROM `+schema+`.imp_out_node GROUP BY 1 ORDER BY 2 DESC`,
		`SELECT type_code, count(*), round(sum(length_m)::numeric / 1000, 1)::float8 FROM `+schema+`.imp_out_edge GROUP BY 1 ORDER BY 2 DESC`)
}

func (m *Manager) batchCounts(ctx context.Context, tag string) ([]TypeCount, []TypeCount, error) {
	return m.typeCounts(ctx, `SELECT type_code, count(*) FROM gis_nodes WHERE properties ? 'import' AND properties->>'import' = $1 GROUP BY 1 ORDER BY 2 DESC`,
		`SELECT type_code, count(*), round(sum(length_m)::numeric / 1000, 1)::float8 FROM gis_edges
		WHERE properties ? 'import' AND properties->>'import' = $1 GROUP BY 1 ORDER BY 2 DESC`, tag)
}

func (m *Manager) typeCounts(ctx context.Context, nodeSQL, edgeSQL string, args ...any) ([]TypeCount, []TypeCount, error) {
	var nodes, edges []TypeCount
	rows, err := m.pool.Query(ctx, nodeSQL, args...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var t TypeCount
		if rows.Scan(&t.Type, &t.Count) == nil {
			nodes = append(nodes, t)
		}
	}
	rows.Close()
	rows, err = m.pool.Query(ctx, edgeSQL, args...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var t TypeCount
		if rows.Scan(&t.Type, &t.Count, &t.Km) == nil {
			edges = append(edges, t)
		}
	}
	rows.Close()
	return nodes, edges, nil
}

// Batch adalah satu batch impor (riwayat terakhir per tag + jumlah objek saat ini).
type Batch struct {
	ID         int64          `json:"id"`
	Tag        string         `json:"tag"`
	FileName   string         `json:"file_name"`
	FileBytes  int64          `json:"file_bytes"`
	Status     string         `json:"status"` // running | review | done | failed | cancelled | replaced | deleted
	Error      string         `json:"error,omitempty"`
	Summary    map[string]any `json:"summary"`
	CreatedBy  string         `json:"created_by"`
	StartedAt  time.Time      `json:"started_at"`
	FinishedAt *time.Time     `json:"finished_at"`
	Nodes      int64          `json:"nodes"`
	Edges      int64          `json:"edges"`
	Customers  int64          `json:"customers"`
	Staging    bool           `json:"staging"` // skema staging masih ada
}

// List mengembalikan riwayat impor (terbaru dulu).
func (m *Manager) List(ctx context.Context) ([]Batch, error) {
	rows, err := m.pool.Query(ctx, `SELECT g.id, g.tag, g.file_name, g.file_bytes, g.status, g.error, g.summary, g.created_by, g.started_at, g.finished_at,
		coalesce(n.nodes, 0), coalesce(n.cust, 0), coalesce(e.edges, 0),
		EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'stg_' || regexp_replace(lower(g.tag), '[^a-z0-9]', '_', 'g'))
		FROM gdb_imports g
		LEFT JOIN LATERAL (SELECT count(*) nodes, count(*) FILTER (WHERE type_code LIKE 'pelanggan%') cust FROM gis_nodes
			WHERE properties ? 'import' AND properties->>'import' = g.tag) n ON g.status = 'done'
		LEFT JOIN LATERAL (SELECT count(*) edges FROM gis_edges WHERE properties ? 'import' AND properties->>'import' = g.tag) e ON g.status = 'done'
		ORDER BY g.started_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Batch{}
	for rows.Next() {
		var b Batch
		if err := rows.Scan(&b.ID, &b.Tag, &b.FileName, &b.FileBytes, &b.Status, &b.Error, &b.Summary, &b.CreatedBy, &b.StartedAt, &b.FinishedAt,
			&b.Nodes, &b.Customers, &b.Edges, &b.Staging); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// DeleteResult merangkum penghapusan batch.
type DeleteResult struct {
	Nodes        int64 `json:"nodes"`
	Edges        int64 `json:"edges"`
	ForeignEdges int64 `json:"foreign_edges"` // garis di luar batch yang tersambung ke node batch (ikut terhapus)
	Applied      bool  `json:"applied"`
}

// Delete menghapus semua objek batch (apply=false: hanya menghitung). Skema staging ikut dihapus.
func (m *Manager) Delete(ctx context.Context, tag string, apply bool) (*DeleteResult, error) {
	if m.Busy() {
		return nil, ErrBusy
	}
	r := &DeleteResult{Applied: apply}
	err := m.pool.QueryRow(ctx, `WITH n AS (SELECT id FROM gis_nodes WHERE properties ? 'import' AND properties->>'import' = $1)
		SELECT (SELECT count(*) FROM n),
		       (SELECT count(*) FROM gis_edges WHERE properties ? 'import' AND properties->>'import' = $1),
		       (SELECT count(*) FROM gis_edges e WHERE NOT (e.properties ? 'import' AND e.properties->>'import' = $1)
		          AND (e.from_node_id IN (SELECT id FROM n) OR e.to_node_id IN (SELECT id FROM n)))`, tag).Scan(&r.Nodes, &r.Edges, &r.ForeignEdges)
	if err != nil {
		return nil, err
	}
	var known bool
	_ = m.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM gdb_imports WHERE tag = $1)`, tag).Scan(&known)
	if r.Nodes == 0 && r.Edges == 0 && !known {
		return nil, ErrNotFound
	}
	if !apply {
		return r, nil
	}
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	for _, q := range []string{
		`DELETE FROM gis_edges WHERE properties ? 'import' AND properties->>'import' = $1`,
		`DELETE FROM gis_nodes WHERE properties ? 'import' AND properties->>'import' = $1`,
		`DELETE FROM gis_layout_backup WHERE tag = $1`,
		`DELETE FROM gdb_import_objects WHERE tag = $1`,
		`UPDATE gdb_imports SET status = 'deleted' WHERE tag = $1`,
	} {
		if _, err := tx.Exec(ctx, q, tag); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `DROP SCHEMA IF EXISTS `+StagingSchema(tag)+` CASCADE`); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if m.hooks.Reload != nil {
		go func() { _ = m.hooks.Reload(context.Background()) }()
	}
	return r, nil
}
