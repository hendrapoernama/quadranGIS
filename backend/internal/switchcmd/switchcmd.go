// Package switchcmd mengurai perintah energize / de-energize (buka / tutup) objek jaringan dari sistem
// eksternal (SCADA, DMS, AMI, ...) yang dikirim lewat Kafka sebagai JSON. Nama kolom fleksibel (Indonesia /
// Inggris), mis.:
//
//	{"event_id": "SCADA-000123", "code": "LBS-GMB-01-2", "type": "lbs_2way", "status": "open",
//	 "outage_category": "GANGGUAN", "timestamp": "2026-09-29T10:15:00+07:00", "note": "trip OCR", "source": "SCADA"}
package switchcmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Command adalah satu perintah energize / de-energize.
type Command struct {
	EventID  string     `json:"event_id"`
	ID       int64      `json:"id"`       // id objek (opsional; alternatif kode)
	Code     string     `json:"code"`     // kode / nama / kode SSOT objek
	Type     string     `json:"type"`     // jenis objek: kode tipe (lbs_2way) atau nama tipe
	Action   string     `json:"action"`   // open (de-energize / buka) | close (energize / tutup)
	Category string     `json:"category"` // GANGGUAN | PEMELIHARAAN | MLS | MANUVER | BENCANA ALAM (wajib untuk open)
	At       *time.Time `json:"at"`       // waktu kejadian; nil = saat diterima
	Note     string     `json:"note"`
	Source   string     `json:"source"`
}

// Categories adalah kategori pemadaman yang dikenal (sama dengan gis.ManeuverKinds).
var Categories = []string{"GANGGUAN", "PEMELIHARAAN", "MLS", "MANUVER", "BENCANA ALAM"}

var (
	keyEvent    = []string{"event_id", "eventid", "id_event", "message_id", "msg_id"}
	keyID       = []string{"id", "object_id", "feature_id", "node_id", "edge_id"}
	keyCode     = []string{"code", "kode", "kode_objek", "object_code", "name", "nama", "nama_objek", "object_name", "object"}
	keyType     = []string{"type", "jenis", "jenis_objek", "type_code", "object_type", "tipe"}
	keyStatus   = []string{"status", "action", "aksi", "state", "command", "perintah"}
	keyCategory = []string{"outage_category", "kategori", "kategori_padam", "category", "kind", "jenis_padam"}
	keyTime     = []string{"timestamp", "tanggal", "date", "datetime", "waktu", "time", "ts", "event_time"}
	keyNote     = []string{"note", "catatan", "keterangan", "description", "remark"}
	keySource   = []string{"source", "sumber", "sistem", "system"}
)

var actionAlias = map[string]string{
	"open": "open", "opened": "open", "buka": "open", "dibuka": "open", "off": "open", "trip": "open", "padam": "open",
	"deenergize": "open", "de-energize": "open", "deenergized": "open", "de-energized": "open", "de_energize": "open", "0": "open",
	"close": "close", "closed": "close", "tutup": "close", "ditutup": "close", "on": "close", "nyala": "close",
	"energize": "close", "energized": "close", "1": "close",
}

var categoryAlias = map[string]string{
	"GANGGUAN": "GANGGUAN", "FAULT": "GANGGUAN", "TRIP": "GANGGUAN",
	"PEMELIHARAAN": "PEMELIHARAAN", "HAR": "PEMELIHARAAN", "MAINTENANCE": "PEMELIHARAAN",
	"MLS": "MLS", "MANUAL LOAD SHEDDING": "MLS", "LOAD SHEDDING": "MLS",
	"MANUVER": "MANUVER", "MANEUVER": "MANUVER", "SWITCHING": "MANUVER",
	"BENCANA ALAM": "BENCANA ALAM", "BENCANA": "BENCANA ALAM", "NATURAL DISASTER": "BENCANA ALAM", "DISASTER": "BENCANA ALAM",
}

// Location adalah zona waktu untuk tanggal tanpa zona (bawaan WIB).
var Location = func() *time.Location {
	if l, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		return l
	}
	return time.FixedZone("WIB", 7*3600)
}()

var timeLayouts = []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05", "2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04", "02-01-2006 15:04:05", "02/01/2006 15:04:05", "02-01-2006 15:04", "02/01/2006 15:04",
	"2006/01/02 15:04:05", "2006-01-02"}

// Parse mengurai pesan JSON menjadi perintah yang tervalidasi.
func Parse(raw []byte) (Command, error) {
	var m map[string]any
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	if err := d.Decode(&m); err != nil || m == nil {
		return Command{}, errors.New("pesan bukan objek JSON yang valid")
	}
	low := make(map[string]any, len(m))
	for k, v := range m {
		low[strings.ToLower(strings.TrimSpace(k))] = v
	}
	var c Command
	c.EventID = str(pick(low, keyEvent))
	c.Code = str(pick(low, keyCode))
	c.Type = str(pick(low, keyType))
	c.Note = str(pick(low, keyNote))
	c.Source = str(pick(low, keySource))
	if v := pick(low, keyID); v != nil {
		if n, ok := toInt(v); ok && n > 0 {
			c.ID = n
		} else if c.Code == "" {
			c.Code = str(v) // "id" berisi kode (bukan angka)
		}
	}
	if c.ID <= 0 && c.Code == "" {
		return c, errors.New("kode / nama objek wajib diisi (code / kode / name / nama)")
	}
	st := str(pick(low, keyStatus))
	if st == "" {
		return c, errors.New("status wajib diisi: open / close")
	}
	a, ok := actionAlias[strings.ToLower(st)]
	if !ok {
		return c, fmt.Errorf("status %q tidak dikenal (gunakan open / close)", st)
	}
	c.Action = a
	if cat := str(pick(low, keyCategory)); cat != "" {
		k := strings.ToUpper(strings.Join(strings.FieldsFunc(cat, func(r rune) bool { return r == '_' || r == '-' || r == ' ' }), " "))
		v, ok := categoryAlias[k]
		if !ok {
			return c, fmt.Errorf("kategori padam %q tidak dikenal (%s)", cat, strings.Join(Categories, " / "))
		}
		c.Category = v
	}
	if c.Action == "open" && c.Category == "" {
		return c, fmt.Errorf("kategori padam (outage_category) wajib untuk status open / de-energize: %s", strings.Join(Categories, " / "))
	}
	if v := pick(low, keyTime); v != nil && str(v) != "" {
		t, err := ParseTime(v)
		if err != nil {
			return c, err
		}
		c.At = &t
	}
	return c, nil
}

// ParseTime menerima RFC 3339, "YYYY-MM-DD HH:MM[:SS]", "DD-MM-YYYY HH:MM[:SS]" (WIB bila tanpa zona),
// atau epoch detik / milidetik.
func ParseTime(v any) (time.Time, error) {
	if n, ok := toFloat(v); ok {
		switch {
		case n > 1e14: // mikrodetik
			return time.UnixMicro(int64(n)), nil
		case n > 1e11: // milidetik
			return time.UnixMilli(int64(n)), nil
		case n > 1e8:
			sec, frac := math.Modf(n)
			return time.Unix(int64(sec), int64(frac*1e9)), nil
		}
	}
	s := str(v)
	for _, l := range timeLayouts {
		if t, err := time.ParseInLocation(l, s, Location); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("tanggal %q tidak dikenal (gunakan ISO 8601, mis. 2026-09-29T10:15:00+07:00)", s)
}

func pick(m map[string]any, keys []string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(x)
	case json.Number:
		return x.String()
	case bool:
		return strconv.FormatBool(x)
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case float64:
		return x, true
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(x), 64); err == nil && strings.IndexFunc(x, func(r rune) bool { return r == '-' || r == ':' }) < 0 {
			return f, true
		}
	}
	return 0, false
}

func toInt(v any) (int64, bool) {
	switch x := v.(type) {
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	case float64:
		return int64(x), x == math.Trunc(x)
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return n, err == nil
	}
	return 0, false
}
