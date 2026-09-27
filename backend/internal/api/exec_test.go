package api

import (
	"testing"
	"time"
)

func TestPeriodOf(t *testing.T) {
	loc := jakartaLoc()
	d := time.Date(2026, 9, 27, 10, 0, 0, 0, loc) // Minggu
	cases := []struct {
		kind      string
		from, to  string
		titlePart string
	}{
		{"daily", "2026-09-27", "2026-09-28", "Harian 27 September 2026"},
		{"weekly", "2026-09-21", "2026-09-28", "21 September 2026 – 27 September 2026"},
		{"monthly", "2026-09-01", "2026-10-01", "Bulanan September 2026"},
	}
	for _, c := range cases {
		f, e := periodOf(c.kind, d)
		if f.Format("2006-01-02") != c.from || e.Format("2006-01-02") != c.to {
			t.Errorf("%s: %s–%s", c.kind, f, e)
		}
		if title := periodTitle(c.kind, f, e); !contains(title, c.titlePart) {
			t.Errorf("%s: judul %q", c.kind, title)
		}
	}
	// periode lengkap terakhir (dipakai penjadwal)
	cur, _ := periodOf("weekly", d)
	pf, _ := periodOf("weekly", cur.Add(-time.Hour))
	if pf.Format("2006-01-02") != "2026-09-14" {
		t.Errorf("minggu sebelumnya: %s", pf)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
