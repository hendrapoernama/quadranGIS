package gdbimport

import (
	"archive/zip"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writeZip(t *testing.T, files map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "x.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(body))
	}
	_ = zw.Close()
	_ = f.Close()
	return p
}

func TestExtractGDB(t *testing.T) {
	z := writeZip(t, map[string]string{"data/kjt 05082026.gdb/a00000001.gdbtable": "x", "data/readme.txt": "y"})
	dir := t.TempDir()
	gdb, err := extractGDB(z, dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(gdb) != "kjt 05082026.gdb" {
		t.Fatalf("folder gdb = %q", gdb)
	}
	if _, err := os.Stat(filepath.Join(gdb, "a00000001.gdbtable")); err != nil {
		t.Fatal(err)
	}
}

func TestExtractGDBRejects(t *testing.T) {
	if _, err := extractGDB(writeZip(t, map[string]string{"a.txt": "x"}), t.TempDir()); !errors.Is(err, ErrBadArchive) {
		t.Fatalf("tanpa .gdb: err = %v", err)
	}
	if _, err := extractGDB(writeZip(t, map[string]string{"../evil.gdb/a": "x"}), t.TempDir()); !errors.Is(err, ErrBadArchive) {
		t.Fatalf("zip-slip: err = %v", err)
	}
	p := filepath.Join(t.TempDir(), "bukan.zip")
	_ = os.WriteFile(p, []byte("bukan zip"), 0o600)
	if _, err := extractGDB(p, t.TempDir()); !errors.Is(err, ErrBadArchive) {
		t.Fatalf("bukan zip: err = %v", err)
	}
}

func TestTagAndSchema(t *testing.T) {
	for tag, ok := range map[string]bool{"KJT-05082026": true, "ulp.a_1": true, "": false, "-x": false, "a b": false, "x;drop": false} {
		if ValidTag(tag) != ok {
			t.Errorf("ValidTag(%q) = %v", tag, !ok)
		}
	}
	if s := StagingSchema("KJT-05082026.v2"); s != "stg_kjt_05082026_v2" {
		t.Fatalf("schema = %q", s)
	}
}
