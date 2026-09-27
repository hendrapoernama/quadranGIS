package load

// kWh pelanggan bulanan (hasil billing / AP2T, diimpor dari berkas CSV / XLSX) untuk analisa
// susut gardu distribusi terhadap energi terjual ke pelanggan.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// BillRow adalah satu baris kWh pelanggan per bulan.
type BillRow struct {
	Line   int       `json:"line"`
	Period time.Time `json:"period"`
	IDPel  string    `json:"idpel"`
	KWh    float64   `json:"kwh"`
	Name   string    `json:"name,omitempty"`
	Tarif  string    `json:"tarif,omitempty"`
	DayaVA float64   `json:"daya_va,omitempty"`
	NodeID int64     `json:"node_id,omitempty"`
	By     string    `json:"by,omitempty"` // idpel | kode_ssot | code
}

// BillError adalah baris berkas yang ditolak.
type BillError struct {
	Line   int    `json:"line"`
	IDPel  string `json:"idpel,omitempty"`
	Reason string `json:"reason"`
}

// BillParse adalah hasil membaca berkas.
type BillParse struct {
	Rows    []BillRow   `json:"-"`
	Errors  []BillError `json:"errors"`
	NErrors int         `json:"n_errors"`
	Lines   int         `json:"lines"`
	Merged  int         `json:"merged"` // baris ganda (periode + IDPEL sama) yang dijumlahkan
	Columns []string    `json:"columns"`
	Format  string      `json:"format"`
}

const maxBillErrors = 200

var billAliases = map[string][]string{
	"idpel":  {"idpel", "idpelanggan", "nomorpelanggan", "nopel", "custid", "customerid", "customerno"},
	"kwh":    {"kwh", "pemakaiankwh", "kwhjual", "kwhterjual", "jumlahkwh", "pemakaian", "energikwh", "consumption", "kwhpakai"},
	"period": {"periode", "blth", "thbl", "bulan", "bulantahun", "period", "month"},
	"name":   {"nama", "namapelanggan", "name", "customername"},
	"tarif":  {"tarif", "tariff", "gol", "golongan"},
	"daya":   {"daya", "dayava", "power", "va"},
}

func normHeader(s string) string {
	s = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(s, "\ufeff")))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ParseBilling membaca berkas CSV (pemisah , ; tab |) atau XLSX (lembar pertama). Baris pertama
// berisi judul kolom; kolom IDPEL dan kWh wajib, periode boleh diganti periode bawaan.
func ParseBilling(raw []byte, defPeriod *time.Time) (*BillParse, error) {
	var table [][]string
	res := &BillParse{Format: "csv"}
	if len(raw) > 4 && bytes.HasPrefix(raw, []byte("PK\x03\x04")) {
		t, err := readXLSX(raw)
		if err != nil {
			return nil, err
		}
		table, res.Format = t, "xlsx"
	} else {
		t, err := readCSV(raw)
		if err != nil {
			return nil, err
		}
		table = t
	}
	if len(table) == 0 {
		return nil, errors.New("berkas kosong")
	}
	col := map[string]int{}
	for i, h := range table[0] {
		n := normHeader(h)
		for key, al := range billAliases {
			if _, done := col[key]; done {
				continue
			}
			for _, a := range al {
				if n == a {
					col[key] = i
					res.Columns = append(res.Columns, key+"="+strings.TrimSpace(h))
				}
			}
		}
	}
	if _, ok := col["idpel"]; !ok {
		return nil, errors.New("kolom IDPEL tidak ditemukan pada baris judul")
	}
	if _, ok := col["kwh"]; !ok {
		return nil, errors.New("kolom kWh tidak ditemukan pada baris judul")
	}
	_, hasPeriod := col["period"]
	if !hasPeriod && defPeriod == nil {
		return nil, errors.New("berkas tidak memiliki kolom periode (BLTH): pilih periode")
	}
	get := func(r []string, key string) string {
		if i, ok := col[key]; ok && i < len(r) {
			return strings.TrimSpace(r[i])
		}
		return ""
	}
	addErr := func(line int, id, reason string) {
		res.NErrors++
		if len(res.Errors) < maxBillErrors {
			res.Errors = append(res.Errors, BillError{Line: line, IDPel: id, Reason: reason})
		}
	}
	idx := map[string]int{}
	for i, r := range table[1:] {
		line := i + 2
		empty := true
		for _, v := range r {
			if strings.TrimSpace(v) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		res.Lines++
		id := normIDPel(get(r, "idpel"))
		if id == "" {
			addErr(line, "", "IDPEL kosong")
			continue
		}
		kwh, ok := ParseNum(get(r, "kwh"))
		if !ok || kwh < 0 || math.IsInf(kwh, 0) {
			addErr(line, id, fmt.Sprintf("kWh tidak valid: %q", get(r, "kwh")))
			continue
		}
		var per time.Time
		if hasPeriod && get(r, "period") != "" {
			p, ok := ParsePeriod(get(r, "period"))
			if !ok {
				addErr(line, id, fmt.Sprintf("periode tidak valid: %q", get(r, "period")))
				continue
			}
			per = p
		} else if defPeriod != nil {
			per = *defPeriod
		} else {
			addErr(line, id, "periode kosong")
			continue
		}
		daya, _ := ParseNum(get(r, "daya"))
		key := per.Format("200601") + "|" + id
		if j, dup := idx[key]; dup {
			res.Rows[j].KWh += kwh
			res.Merged++
			continue
		}
		idx[key] = len(res.Rows)
		res.Rows = append(res.Rows, BillRow{Line: line, Period: per, IDPel: id, KWh: kwh, Name: get(r, "name"), Tarif: get(r, "tarif"), DayaVA: daya})
	}
	return res, nil
}

func normIDPel(s string) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), " ", "")
	s = strings.Trim(s, "'\"")
	// angka Excel dalam notasi ilmiah (mis. 5.12345678901E+11)
	if strings.ContainsAny(s, "eE") && strings.Contains(s, "+") {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return strconv.FormatFloat(f, 'f', 0, 64)
		}
	}
	if strings.HasSuffix(s, ".0") {
		if _, err := strconv.ParseInt(strings.TrimSuffix(s, ".0"), 10, 64); err == nil {
			s = strings.TrimSuffix(s, ".0")
		}
	}
	return s
}

var (
	reThouDot   = regexp.MustCompile(`^-?\d{1,3}(\.\d{3})+$`)
	reThouComma = regexp.MustCompile(`^-?\d{1,3}(,\d{3})+$`)
)

// ParseNum membaca angka format Indonesia (1.234,5) maupun internasional (1,234.5).
func ParseNum(s string) (float64, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), " ", "")
	if s == "" {
		return 0, false
	}
	hasDot, hasComma := strings.Contains(s, "."), strings.Contains(s, ",")
	switch {
	case hasDot && hasComma:
		if strings.LastIndex(s, ",") > strings.LastIndex(s, ".") {
			s = strings.ReplaceAll(strings.ReplaceAll(s, ".", ""), ",", ".")
		} else {
			s = strings.ReplaceAll(s, ",", "")
		}
	case hasComma:
		if reThouComma.MatchString(s) {
			s = strings.ReplaceAll(s, ",", "")
		} else {
			s = strings.ReplaceAll(s, ",", ".")
		}
	case hasDot && reThouDot.MatchString(s):
		s = strings.ReplaceAll(s, ".", "")
	}
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

// ParsePeriod membaca periode bulan: 202609, 2026-09, 2026/09, 09/2026, 09-2026, 2026-09-01.
func ParsePeriod(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if len(s) >= 10 {
		s = s[:10]
		if t, err := time.ParseInLocation("2006-01-02", s, Loc); err == nil {
			return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, Loc), true
		}
	}
	for _, f := range []string{"200601", "2006-01", "2006/01", "01/2006", "01-2006", "1/2006", "1-2006"} {
		if t, err := time.ParseInLocation(f, s, Loc); err == nil {
			if t.Year() < 2000 || t.Year() > 2100 {
				return time.Time{}, false
			}
			return t, true
		}
	}
	return time.Time{}, false
}

func readCSV(raw []byte) ([][]string, error) {
	raw = bytes.TrimPrefix(raw, []byte("\xEF\xBB\xBF"))
	first := raw
	if i := bytes.IndexByte(raw, '\n'); i >= 0 {
		first = raw[:i]
	}
	delim, best := ',', -1
	for _, d := range []rune{',', ';', '\t', '|'} {
		if n := bytes.Count(first, []byte(string(d))); n > best {
			delim, best = d, n
		}
	}
	r := csv.NewReader(bytes.NewReader(raw))
	r.Comma = delim
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.ReuseRecord = false
	out, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("CSV tidak dapat dibaca: %w", err)
	}
	return out, nil
}

// readXLSX membaca lembar pertama berkas XLSX (tanpa pustaka tambahan).
func readXLSX(raw []byte) ([][]string, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("XLSX tidak dapat dibaca: %w", err)
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	open := func(name string) (io.ReadCloser, bool) {
		f, ok := files[name]
		if !ok {
			return nil, false
		}
		rc, err := f.Open()
		return rc, err == nil
	}
	// string bersama
	var shared []string
	if rc, ok := open("xl/sharedStrings.xml"); ok {
		dec := xml.NewDecoder(rc)
		var cur strings.Builder
		in := false
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "si" {
					cur.Reset()
					in = true
				}
			case xml.CharData:
				if in {
					cur.Write(t)
				}
			case xml.EndElement:
				if t.Name.Local == "si" {
					shared = append(shared, cur.String())
					in = false
				}
			}
		}
		rc.Close()
	}
	sheet := "xl/worksheets/sheet1.xml"
	if _, ok := files[sheet]; !ok {
		names := []string{}
		for n := range files {
			if strings.HasPrefix(n, "xl/worksheets/") && strings.HasSuffix(n, ".xml") {
				names = append(names, n)
			}
		}
		sort.Strings(names)
		if len(names) == 0 {
			return nil, errors.New("XLSX tidak memiliki lembar kerja")
		}
		sheet = names[0]
	}
	rc, ok := open(sheet)
	if !ok {
		return nil, errors.New("lembar kerja XLSX tidak dapat dibuka")
	}
	defer rc.Close()
	dec := xml.NewDecoder(rc)
	var out [][]string
	var row []string
	var cellRef, cellType string
	var val strings.Builder
	inVal := false
	colIdx := func(ref string) int {
		n := 0
		for _, ch := range ref {
			if ch >= 'A' && ch <= 'Z' {
				n = n*26 + int(ch-'A'+1)
			} else {
				break
			}
		}
		return n - 1
	}
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("XLSX rusak: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				row = []string{}
			case "c":
				cellRef, cellType = "", ""
				for _, a := range t.Attr {
					if a.Name.Local == "r" {
						cellRef = a.Value
					} else if a.Name.Local == "t" {
						cellType = a.Value
					}
				}
				val.Reset()
			case "v", "t":
				inVal = true
			}
		case xml.CharData:
			if inVal {
				val.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v", "t":
				inVal = false
			case "c":
				v := val.String()
				if cellType == "s" {
					if i, err := strconv.Atoi(v); err == nil && i >= 0 && i < len(shared) {
						v = shared[i]
					}
				}
				ci := len(row)
				if cellRef != "" {
					ci = colIdx(cellRef)
				}
				for len(row) < ci {
					row = append(row, "")
				}
				if ci == len(row) {
					row = append(row, v)
				} else if ci >= 0 && ci < len(row) {
					row[ci] = v
				}
			case "row":
				out = append(out, row)
			}
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- penyimpanan

// BillImport adalah riwayat satu impor (per periode).
type BillImport struct {
	ID         int       `json:"id"`
	Period     time.Time `json:"period"`
	FileName   string    `json:"file_name"`
	Rows       int       `json:"rows"`
	Matched    int       `json:"matched"`
	Unmatched  int       `json:"unmatched"`
	Errors     int       `json:"errors"`
	TotalKWh   float64   `json:"total_kwh"`
	Replaced   bool      `json:"replaced"`
	ImportedBy string    `json:"imported_by"`
	ImportedAt time.Time `json:"imported_at"`
}

// MatchCustomers mencari node pelanggan GIS untuk IDPEL: atribut idpel, lalu kode SSOT, lalu kode objek.
func (r *Repo) MatchCustomers(ctx context.Context, rows []BillRow) error {
	ids := make([]string, 0, len(rows))
	seen := map[string]bool{}
	for _, b := range rows {
		if !seen[b.IDPel] {
			seen[b.IDPel] = true
			ids = append(ids, b.IDPel)
		}
	}
	found := map[string]struct {
		id int64
		by string
	}{}
	queries := []struct{ by, sql string }{
		{"idpel", `SELECT n.properties->>'idpel', n.id FROM gis_nodes n JOIN component_types ct ON ct.code = n.type_code AND ct.is_sink
			WHERE n.properties ? 'idpel' AND n.properties->>'idpel' = ANY($1)`},
		{"kode_ssot", `SELECT n.properties->>'kode_ssot', n.id FROM gis_nodes n JOIN component_types ct ON ct.code = n.type_code AND ct.is_sink
			WHERE n.properties ? 'kode_ssot' AND n.properties->>'kode_ssot' = ANY($1)`},
		{"code", `SELECT n.code, n.id FROM gis_nodes n JOIN component_types ct ON ct.code = n.type_code AND ct.is_sink WHERE n.code = ANY($1)`},
	}
	for _, q := range queries {
		rest := []string{}
		for _, id := range ids {
			if _, ok := found[id]; !ok {
				rest = append(rest, id)
			}
		}
		for i := 0; i < len(rest); i += 50000 {
			j := i + 50000
			if j > len(rest) {
				j = len(rest)
			}
			rs, err := r.pool.Query(ctx, q.sql, rest[i:j])
			if err != nil {
				return err
			}
			for rs.Next() {
				var k string
				var id int64
				if rs.Scan(&k, &id) == nil {
					if _, dup := found[k]; !dup {
						found[k] = struct {
							id int64
							by string
						}{id, q.by}
					}
				}
			}
			rs.Close()
		}
	}
	for i := range rows {
		if f, ok := found[rows[i].IDPel]; ok {
			rows[i].NodeID, rows[i].By = f.id, f.by
		}
	}
	return nil
}

// ExistingBillRows menghitung baris tersimpan per periode.
func (r *Repo) ExistingBillRows(ctx context.Context, periods []time.Time) (map[string]int, error) {
	out := map[string]int{}
	if len(periods) == 0 {
		return out, nil
	}
	rs, err := r.pool.Query(ctx, `SELECT to_char(period, 'YYYY-MM'), count(*) FROM customer_kwh WHERE period = ANY($1::date[]) GROUP BY 1`, periods)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	for rs.Next() {
		var p string
		var n int
		if rs.Scan(&p, &n) == nil {
			out[p] = n
		}
	}
	return out, rs.Err()
}

// SaveBilling menyimpan baris per periode (replace = hapus dulu seluruh data periode itu).
func (r *Repo) SaveBilling(ctx context.Context, rows []BillRow, fileName, actor string, replace bool, nErrors map[string]int) ([]BillImport, error) {
	byPeriod := map[string][]BillRow{}
	keys := []string{}
	for _, b := range rows {
		k := b.Period.Format("2006-01")
		if _, ok := byPeriod[k]; !ok {
			keys = append(keys, k)
		}
		byPeriod[k] = append(byPeriod[k], b)
	}
	sort.Strings(keys)
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	out := []BillImport{}
	for _, k := range keys {
		list := byPeriod[k]
		per := list[0].Period
		imp := BillImport{Period: per, FileName: fileName, Rows: len(list), Replaced: replace, ImportedBy: actor, Errors: nErrors[k]}
		for _, b := range list {
			imp.TotalKWh += b.KWh
			if b.NodeID != 0 {
				imp.Matched++
			} else {
				imp.Unmatched++
			}
		}
		if replace {
			if _, err := tx.Exec(ctx, `DELETE FROM customer_kwh WHERE period = $1`, per); err != nil {
				return nil, err
			}
		}
		if err := tx.QueryRow(ctx, `INSERT INTO customer_kwh_imports (period, file_name, rows, matched, unmatched, errors, total_kwh, replaced, imported_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, imported_at`, per, fileName, imp.Rows, imp.Matched, imp.Unmatched, imp.Errors, imp.TotalKWh, replace, actor).
			Scan(&imp.ID, &imp.ImportedAt); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `CREATE TEMP TABLE IF NOT EXISTS tmp_customer_kwh (LIKE customer_kwh) ON COMMIT DROP`); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `TRUNCATE tmp_customer_kwh`); err != nil {
			return nil, err
		}
		src := make([][]any, len(list))
		for i, b := range list {
			var node, daya any
			if b.NodeID != 0 {
				node = b.NodeID
			}
			if b.DayaVA > 0 {
				daya = b.DayaVA
			}
			src[i] = []any{per, b.IDPel, node, b.KWh, nullStr(b.Name), nullStr(b.Tarif), daya, imp.ID}
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"tmp_customer_kwh"}, []string{"period", "idpel", "node_id", "kwh", "name", "tarif", "daya_va", "import_id"}, pgx.CopyFromRows(src)); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO customer_kwh (period, idpel, node_id, kwh, name, tarif, daya_va, import_id)
			SELECT period, idpel, node_id, kwh, name, tarif, daya_va, import_id FROM tmp_customer_kwh
			ON CONFLICT (period, idpel) DO UPDATE SET node_id = EXCLUDED.node_id, kwh = EXCLUDED.kwh, name = EXCLUDED.name,
				tarif = EXCLUDED.tarif, daya_va = EXCLUDED.daya_va, import_id = EXCLUDED.import_id`); err != nil {
			return nil, err
		}
		out = append(out, imp)
	}
	return out, tx.Commit(ctx)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// BillImports mengembalikan riwayat impor terbaru.
func (r *Repo) BillImports(ctx context.Context, limit int) ([]BillImport, error) {
	rs, err := r.pool.Query(ctx, `SELECT i.id, i.period, COALESCE(i.file_name,''), i.rows, i.matched, i.unmatched, i.errors, i.total_kwh, i.replaced,
		COALESCE(i.imported_by,''), i.imported_at FROM customer_kwh_imports i ORDER BY i.imported_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := []BillImport{}
	for rs.Next() {
		var b BillImport
		if rs.Scan(&b.ID, &b.Period, &b.FileName, &b.Rows, &b.Matched, &b.Unmatched, &b.Errors, &b.TotalKWh, &b.Replaced, &b.ImportedBy, &b.ImportedAt) == nil {
			out = append(out, b)
		}
	}
	return out, rs.Err()
}

// DeleteBillImport menghapus satu impor beserta baris yang masih miliknya.
func (r *Repo) DeleteBillImport(ctx context.Context, id int) (int64, error) {
	tag, err := r.pool.Exec(ctx, `DELETE FROM customer_kwh WHERE import_id = $1`, id)
	if err != nil {
		return 0, err
	}
	_, err = r.pool.Exec(ctx, `DELETE FROM customer_kwh_imports WHERE id = $1`, id)
	return tag.RowsAffected(), err
}

// BillPeriods mengembalikan periode yang memiliki data kWh pelanggan.
func (r *Repo) BillPeriods(ctx context.Context) ([]map[string]any, error) {
	rs, err := r.pool.Query(ctx, `SELECT to_char(period, 'YYYY-MM'), count(*), count(node_id), COALESCE(sum(kwh), 0) FROM customer_kwh GROUP BY 1 ORDER BY 1 DESC`)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := []map[string]any{}
	for rs.Next() {
		var p string
		var n, m int
		var k float64
		if rs.Scan(&p, &n, &m, &k) == nil {
			out = append(out, map[string]any{"period": p, "rows": n, "matched": m, "kwh": k})
		}
	}
	return out, rs.Err()
}

// BillByNode mengembalikan kWh per node pelanggan pada satu periode, serta total baris tak terpetakan.
func (r *Repo) BillByNode(ctx context.Context, period time.Time) (map[int64]float64, int, float64, error) {
	rs, err := r.pool.Query(ctx, `SELECT node_id, kwh FROM customer_kwh WHERE period = $1`, period)
	if err != nil {
		return nil, 0, 0, err
	}
	defer rs.Close()
	out := map[int64]float64{}
	un, unK := 0, 0.0
	for rs.Next() {
		var id *int64
		var k float64
		if rs.Scan(&id, &k) != nil {
			continue
		}
		if id == nil {
			un++
			unK += k
			continue
		}
		out[*id] += k
	}
	return out, un, unK, rs.Err()
}

// BillUnmatched mengembalikan baris yang IDPEL-nya tidak ditemukan di GIS.
func (r *Repo) BillUnmatched(ctx context.Context, period time.Time, limit int) ([]BillRow, error) {
	rs, err := r.pool.Query(ctx, `SELECT idpel, kwh, COALESCE(name,''), COALESCE(tarif,''), COALESCE(daya_va,0) FROM customer_kwh
		WHERE period = $1 AND node_id IS NULL ORDER BY kwh DESC LIMIT $2`, period, limit)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := []BillRow{}
	for rs.Next() {
		b := BillRow{Period: period}
		if rs.Scan(&b.IDPel, &b.KWh, &b.Name, &b.Tarif, &b.DayaVA) == nil {
			out = append(out, b)
		}
	}
	return out, rs.Err()
}

// BillForNodes mengembalikan baris kWh (periode tertentu) untuk node-node pelanggan.
func (r *Repo) BillForNodes(ctx context.Context, period time.Time, nodes []int64) (map[int64]BillRow, error) {
	out := map[int64]BillRow{}
	if len(nodes) == 0 {
		return out, nil
	}
	rs, err := r.pool.Query(ctx, `SELECT node_id, idpel, kwh, COALESCE(name,''), COALESCE(tarif,''), COALESCE(daya_va,0) FROM customer_kwh
		WHERE period = $1 AND node_id = ANY($2)`, period, nodes)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	for rs.Next() {
		var b BillRow
		if rs.Scan(&b.NodeID, &b.IDPel, &b.KWh, &b.Name, &b.Tarif, &b.DayaVA) == nil {
			prev := out[b.NodeID]
			b.KWh += prev.KWh
			out[b.NodeID] = b
		}
	}
	return out, rs.Err()
}

// BillTrend mengembalikan Σ kWh per periode untuk node-node pelanggan (≤ 24 bulan terakhir).
func (r *Repo) BillTrend(ctx context.Context, nodes []int64, from time.Time) (map[string]float64, error) {
	out := map[string]float64{}
	if len(nodes) == 0 {
		return out, nil
	}
	rs, err := r.pool.Query(ctx, `SELECT to_char(period, 'YYYY-MM'), sum(kwh) FROM customer_kwh WHERE period >= $1 AND node_id = ANY($2) GROUP BY 1`, from, nodes)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	for rs.Next() {
		var p string
		var k float64
		if rs.Scan(&p, &k) == nil {
			out[p] = k
		}
	}
	return out, rs.Err()
}
