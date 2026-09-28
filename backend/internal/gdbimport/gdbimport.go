// Package gdbimport mengimpor jaringan dari Esri File Geodatabase PLN (geometric network ESRI, ZIP)
// ke tabel jaringan QuadranGIS: layer dimuat ke skema staging dengan ogr2ogr (PGDump → psql), lalu
// import_staging.sql memetakan tipe/atribut, memotong garis di simpul, dan menulis node & edge.
// Semua objek hasil impor memiliki properties.import = tag sehingga batch dapat dihapus / diulang.
// Impor ditulis langsung (tidak melalui paket perubahan / alur persetujuan).
package gdbimport

import (
	"archive/zip"
	"bufio"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed import_staging.sql
var stagingSQL string

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
	ErrBusy       = errors.New("gdbimport: impor lain sedang berjalan")
	ErrNotFound   = errors.New("gdbimport: batch tidak ditemukan")
	ErrBadArchive = errors.New("gdbimport: berkas bukan ZIP berisi folder .gdb")
)

// Options adalah pilihan impor.
type Options struct {
	AssignUnits bool `json:"assign_units"` // tetapkan unit pemilik aset batch dari lokasi
	KeepStaging bool `json:"keep_staging"` // simpan skema staging (untuk analisis / impor ulang)
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
	Status    string         `json:"status"` // running | done | failed
	Steps     []*Step        `json:"steps"`
	Summary   map[string]any `json:"summary,omitempty"`
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

	mu  sync.Mutex
	job *Job
}

// New membuat Manager; dbURL dipakai psql untuk memuat staging.
func New(pool *pgxpool.Pool, dbURL string, hooks Hooks) *Manager {
	return &Manager{pool: pool, dbURL: dbURL, hooks: hooks}
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

// Start memulai impor dari berkas ZIP (sudah disimpan di disk; dihapus setelah selesai).
func (m *Manager) Start(zipPath, fileName string, size int64, tag, actor string, opt Options) (*Job, error) {
	m.mu.Lock()
	if m.job != nil && m.job.Status == "running" {
		m.mu.Unlock()
		return nil, ErrBusy
	}
	keys := []string{"extract", "stage", "map", "units", "cleanup", "reload"}
	j := &Job{Tag: tag, FileName: fileName, Status: "running", StartedAt: time.Now()}
	for _, k := range keys {
		j.Steps = append(j.Steps, &Step{Key: k, Status: "pending"})
	}
	m.job = j
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
	go m.run(zipPath, tag, opt)
	return m.Current(), nil
}

func (m *Manager) run(zipPath, tag string, opt Options) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	work, _ := os.MkdirTemp("", "gdbimp-")
	schema := StagingSchema(tag)
	defer func() {
		_ = os.Remove(zipPath)
		_ = os.RemoveAll(work)
	}()

	summary := map[string]any{"schema": schema}
	fail := func(key string, err error) {
		m.end(key, "failed", err.Error())
		m.mu.Lock()
		for _, s := range m.job.Steps {
			if s.Status == "pending" {
				s.Status = "skipped"
			}
		}
		now := time.Now()
		m.job.Status, m.job.Error, m.job.EndedAt = "failed", err.Error(), &now
		id := m.job.ID
		m.mu.Unlock()
		if !opt.KeepStaging {
			_, _ = m.pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`)
		}
		_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status='failed', error=$2, finished_at=now() WHERE id=$1`, id, err.Error())
	}

	// 1. ekstrak ZIP
	m.begin("extract")
	gdb, err := extractGDB(zipPath, work)
	if err != nil {
		fail("extract", err)
		return
	}
	_ = os.Remove(zipPath)
	have, err := listLayers(ctx, gdb)
	if err != nil {
		fail("extract", err)
		return
	}
	var missing []string
	for _, l := range Layers {
		if !have[strings.ToLower(l)] {
			missing = append(missing, l)
		}
	}
	if len(missing) > 0 {
		fail("extract", fmt.Errorf("layer wajib tidak ada di GDB: %s", strings.Join(missing, ", ")))
		return
	}
	m.end("extract", "done", filepath.Base(gdb))

	// 2. muat layer ke skema staging
	m.begin("stage")
	if _, err := m.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE; CREATE SCHEMA `+schema); err != nil {
		fail("stage", err)
		return
	}
	for i, l := range Layers {
		m.progress("stage", fmt.Sprintf("%d/%d %s", i+1, len(Layers), l))
		if err := m.stageLayer(ctx, gdb, l, schema); err != nil {
			fail("stage", fmt.Errorf("%s: %w", l, err))
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
			fail("stage", err)
			return
		}
	}
	m.end("stage", "done", fmt.Sprintf("%d layer", len(Layers)))

	// 3. pemetaan & penulisan jaringan (satu transaksi, lewat psql)
	m.begin("map")
	out, err := m.psql(ctx, strings.NewReader(stagingSQL), "-v", "src="+schema, "-v", "tag="+tag)
	if err != nil {
		fail("map", fmt.Errorf("%v: %s", err, lastLines(out, 6)))
		return
	}
	var feed, paired, cuts, syn int64
	_ = m.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM `+schema+`.imp_feed), (SELECT count(*) FROM `+schema+`.imp_feed_sw),
		(SELECT count(*) FROM `+schema+`.imp_cut), (SELECT count(*) FROM `+schema+`.imp_syn)`).Scan(&feed, &paired, &cuts, &syn)
	summary["gi_feeder_gaps"], summary["gi_feeder_paired"], summary["line_cuts"], summary["synthetic_links"] = feed, paired, cuts, syn
	nodes, edges, err := m.batchCounts(ctx, tag)
	if err != nil {
		fail("map", err)
		return
	}
	summary["nodes"], summary["edges"] = nodes, edges
	m.end("map", "done", "")

	// 4. unit pemilik
	if opt.AssignUnits && m.hooks.AssignUnits != nil {
		m.begin("units")
		n, err := m.hooks.AssignUnits(ctx, tag)
		if err != nil {
			fail("units", err)
			return
		}
		summary["units_assigned"] = n
		m.end("units", "done", fmt.Sprint(n))
	} else {
		m.end("units", "skipped", "")
	}

	// 5. staging
	m.begin("cleanup")
	if opt.KeepStaging {
		m.end("cleanup", "skipped", schema)
	} else {
		if _, err := m.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			fail("cleanup", err)
			return
		}
		delete(summary, "schema")
		m.end("cleanup", "done", "")
	}

	// 6. topologi
	m.begin("reload")
	if m.hooks.Reload != nil {
		if err := m.hooks.Reload(ctx); err != nil {
			fail("reload", err)
			return
		}
	}
	m.end("reload", "done", "")

	m.mu.Lock()
	now := time.Now()
	m.job.Status, m.job.Summary, m.job.EndedAt = "done", summary, &now
	id := m.job.ID
	m.mu.Unlock()
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status='done', summary=$2, finished_at=now() WHERE id=$1`, id, summary)
	// batch lama dengan tag sama sudah digantikan oleh impor ini
	_, _ = m.pool.Exec(context.Background(), `UPDATE gdb_imports SET status='replaced' WHERE tag=$1 AND id<>$2 AND status IN ('done', 'failed')`, tag, id)
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

func (m *Manager) batchCounts(ctx context.Context, tag string) ([]TypeCount, []TypeCount, error) {
	var nodes, edges []TypeCount
	rows, err := m.pool.Query(ctx, `SELECT type_code, count(*) FROM gis_nodes WHERE properties ? 'import' AND properties->>'import' = $1 GROUP BY 1 ORDER BY 2 DESC`, tag)
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
	rows, err = m.pool.Query(ctx, `SELECT type_code, count(*), round(sum(length_m)::numeric / 1000, 1)::float8 FROM gis_edges
		WHERE properties ? 'import' AND properties->>'import' = $1 GROUP BY 1 ORDER BY 2 DESC`, tag)
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
	Status     string         `json:"status"` // running | done | failed | replaced | deleted
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
	if m.Running() {
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
	if _, err := tx.Exec(ctx, `DELETE FROM gis_edges WHERE properties ? 'import' AND properties->>'import' = $1`, tag); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM gis_nodes WHERE properties ? 'import' AND properties->>'import' = $1`, tag); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM gis_layout_backup WHERE tag = $1`, tag); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE gdb_imports SET status = 'deleted' WHERE tag = $1`, tag); err != nil {
		return nil, err
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
