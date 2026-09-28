package switchcmd

import (
	"strings"
	"testing"
	"time"
)

func TestParseEnglish(t *testing.T) {
	c, err := Parse([]byte(`{"event_id":"E1","code":"LBS-GMB-01-2","type":"lbs_2way","status":"OPEN","outage_category":"gangguan",
		"timestamp":"2026-09-29T10:15:00+07:00","note":"trip OCR","source":"SCADA"}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.EventID != "E1" || c.Code != "LBS-GMB-01-2" || c.Type != "lbs_2way" || c.Action != "open" || c.Category != "GANGGUAN" || c.Source != "SCADA" || c.Note != "trip OCR" {
		t.Fatalf("hasil = %+v", c)
	}
	if c.At == nil || !c.At.Equal(time.Date(2026, 9, 29, 3, 15, 0, 0, time.UTC)) {
		t.Fatalf("waktu = %v", c.At)
	}
}

func TestParseIndonesian(t *testing.T) {
	c, err := Parse([]byte(`{"nama":"E35N","jenis":"Gardu Distribusi","status":"tutup","tanggal":"2026-09-29 10:20:30"}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Code != "E35N" || c.Type != "Gardu Distribusi" || c.Action != "close" || c.Category != "" {
		t.Fatalf("hasil = %+v", c)
	}
	// tanpa zona = WIB
	if c.At == nil || !c.At.Equal(time.Date(2026, 9, 29, 3, 20, 30, 0, time.UTC)) {
		t.Fatalf("waktu = %v", c.At)
	}
}

func TestParseAliases(t *testing.T) {
	cases := map[string]string{"deenergize": "open", "de-energized": "open", "buka": "open", "energize": "close", "on": "close", "Tutup": "close"}
	for st, want := range cases {
		c, err := Parse([]byte(`{"code":"X","status":"` + st + `","kategori":"bencana_alam"}`))
		if err != nil || c.Action != want || c.Category != "BENCANA ALAM" {
			t.Errorf("status %q: %+v, %v", st, c, err)
		}
	}
	c, err := Parse([]byte(`{"code":"X","status":"open","category":"maintenance","timestamp":1790640000000}`))
	if err != nil || c.Category != "PEMELIHARAAN" || c.At == nil || c.At.Unix() != 1790640000 {
		t.Fatalf("alias kategori / epoch ms: %+v, %v", c, err)
	}
	c, err = Parse([]byte(`{"id":1234,"status":"close"}`))
	if err != nil || c.ID != 1234 {
		t.Fatalf("id angka: %+v, %v", c, err)
	}
}

func TestParseErrors(t *testing.T) {
	for raw, want := range map[string]string{
		`bukan json`: "JSON",
		`{"status":"open","kategori":"GANGGUAN"}`: "kode",
		`{"code":"X"}`:                                    "status wajib",
		`{"code":"X","status":"toggle"}`:                  "tidak dikenal",
		`{"code":"X","status":"open"}`:                    "kategori padam",
		`{"code":"X","status":"open","kategori":"ABC"}`:   "kategori padam",
		`{"code":"X","status":"close","tanggal":"besok"}`: "tanggal",
	} {
		if _, err := Parse([]byte(raw)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, diharapkan memuat %q", raw, err, want)
		}
	}
}
