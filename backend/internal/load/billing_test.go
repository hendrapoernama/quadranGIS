package load

import (
	"archive/zip"
	"bytes"
	"testing"
	"time"
)

func TestParseNum(t *testing.T) {
	cases := map[string]float64{"215": 215, "1.284,5": 1284.5, "1,284.5": 1284.5, "1.284": 1284, "1,284": 1284, "12,5": 12.5, "0.75": 0.75, " 3 400 ": 3400}
	for in, want := range cases {
		got, ok := ParseNum(in)
		if !ok || got != want {
			t.Errorf("ParseNum(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	if _, ok := ParseNum("abc"); ok {
		t.Error("ParseNum(abc) should fail")
	}
}

func TestParsePeriod(t *testing.T) {
	want := time.Date(2026, 8, 1, 0, 0, 0, 0, Loc)
	for _, in := range []string{"202608", "2026-08", "2026/08", "08/2026", "08-2026", "2026-08-15"} {
		got, ok := ParsePeriod(in)
		if !ok || !got.Equal(want) {
			t.Errorf("ParsePeriod(%q) = %v, %v", in, got, ok)
		}
	}
	if _, ok := ParsePeriod("13/2026"); ok {
		t.Error("ParsePeriod(13/2026) should fail")
	}
}

func TestParseBillingCSV(t *testing.T) {
	raw := []byte("\xEF\xBB\xBFIDPEL;BLTH;KWH;Nama Pelanggan;TARIF;DAYA\n" +
		"512345678901;202608;215;Andi;R1;1300\n" +
		"512345678902;202608;1.284,5;Budi;B2;6600\n" +
		"512345678901;202608;10;Andi;R1;1300\n" + // ganda → dijumlahkan
		";202608;5;;;\n" + // IDPEL kosong
		"512345678903;202608;x;;;\n" + // kWh tidak valid
		"\n")
	p, err := ParseBilling(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Rows) != 2 || p.Merged != 1 || p.NErrors != 2 || p.Lines != 5 {
		t.Fatalf("rows=%d merged=%d errors=%d lines=%d", len(p.Rows), p.Merged, p.NErrors, p.Lines)
	}
	if p.Rows[0].KWh != 225 || p.Rows[1].KWh != 1284.5 || p.Rows[1].Name != "Budi" || p.Rows[1].DayaVA != 6600 {
		t.Fatalf("unexpected rows %+v", p.Rows)
	}
}

func TestParseBillingDefaultPeriod(t *testing.T) {
	if _, err := ParseBilling([]byte("idpel,kwh\n1,2\n"), nil); err == nil {
		t.Fatal("expected error without period")
	}
	per := time.Date(2026, 7, 1, 0, 0, 0, 0, Loc)
	p, err := ParseBilling([]byte("idpel,kwh\n1,2\n"), &per)
	if err != nil || len(p.Rows) != 1 || !p.Rows[0].Period.Equal(per) {
		t.Fatalf("%v %+v", err, p)
	}
}

func TestParseBillingXLSX(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("xl/sharedStrings.xml")
	w.Write([]byte(`<sst><si><t>IDPEL</t></si><si><t>KWH</t></si><si><t>BLTH</t></si></sst>`))
	w, _ = zw.Create("xl/worksheets/sheet1.xml")
	w.Write([]byte(`<worksheet><sheetData>
		<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="s"><v>1</v></c></row>
		<row r="2"><c r="A2"><v>512345678901</v></c><c r="B2" t="inlineStr"><is><t>202608</t></is></c><c r="C2"><v>215.5</v></c></row>
		<row r="3"><c r="A3"><v>5.12345678902E+11</v></c><c r="C3"><v>100</v></c><c r="B3"><v>202608</v></c></row>
	</sheetData></worksheet>`))
	zw.Close()
	p, err := ParseBilling(buf.Bytes(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Format != "xlsx" || len(p.Rows) != 2 || p.Rows[0].IDPel != "512345678901" || p.Rows[0].KWh != 215.5 || p.Rows[1].IDPel != "512345678902" {
		t.Fatalf("%+v %+v", p, p.Rows)
	}
}
