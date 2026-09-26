package gis

import (
	"encoding/json"
	"testing"
)

func TestNormalizeGeometryUnwrapsSinglePartMulti(t *testing.T) {
	typ, g, err := normalizeGeometry(json.RawMessage(`{"type":"MultiLineString","coordinates":[[[106.8,-6.2],[106.81,-6.21]]]}`))
	if err != nil || typ != "LineString" {
		t.Fatalf("multi satu bagian harus menjadi LineString: %s %v", typ, err)
	}
	if !coordsClose(g, json.RawMessage(`{"type":"LineString","coordinates":[[106.8,-6.2],[106.81,-6.21]]}`)) {
		t.Fatalf("koordinat berubah: %s", g)
	}
	if _, _, err := normalizeGeometry(json.RawMessage(`{"type":"MultiPoint","coordinates":[[1,2],[3,4]]}`)); err == nil {
		t.Fatal("multipart dua bagian harus ditolak")
	}
}

func TestCoordsCloseTolerance(t *testing.T) {
	a := json.RawMessage(`{"type":"Point","coordinates":[106.8330001,-6.1760002]}`)
	b := json.RawMessage(`{"type":"Point","coordinates":[106.833000123456789,-6.176000187654321]}`) // presisi penuh QGIS
	if !coordsClose(a, b) {
		t.Fatal("selisih presisi harus dianggap sama")
	}
	c := json.RawMessage(`{"type":"Point","coordinates":[106.8331,-6.176]}`) // ~11 m
	if coordsClose(a, c) {
		t.Fatal("pergeseran nyata harus terdeteksi")
	}
}

func TestPropsRoundTrip(t *testing.T) {
	orig := map[string]any{"daya_kva": 250.0, "merek": "Trafindo", "code": "bentrok", "scada": true}
	flat := map[string]any{}
	flattenProps(flat, orig)
	if _, ok := flat["p_code"]; !ok {
		t.Fatalf("atribut bernama kolom bawaan harus diberi awalan p_: %v", flat)
	}
	// kolom bawaan & kosong diabaikan saat import
	flat["qgis_id"], flat["qgis_kind"], flat["type_code"], flat["kosong"], flat["null"] = 12.0, "node", "gd", "", nil
	back := propsFromFields(flat)
	if propsChanged(orig, back) {
		t.Fatalf("atribut tidak kembali utuh: %v -> %v", orig, back)
	}
	back["daya_kva"] = 315.0
	if !propsChanged(orig, back) {
		t.Fatal("perubahan nilai harus terdeteksi")
	}
}

func TestEdgeEndpointMovesFollowTopology(t *testing.T) {
	cur := json.RawMessage(`{"type":"LineString","coordinates":[[106.80005,-6.2],[106.805,-6.205],[106.81,-6.21]]}`)
	// file lama: ujung awal masih di posisi sebelum node dipindah, vertex tengah sama
	oldFile := json.RawMessage(`{"type":"LineString","coordinates":[[106.8,-6.2],[106.805,-6.205],[106.81,-6.21]]}`)
	if _, changed := edgeGeometryUpdate(cur, oldFile); changed {
		t.Fatal("perbedaan hanya di ujung (mengikuti node) tidak boleh dianggap perubahan")
	}
	// vertex tengah digeser di QGIS: geometri baru dipakai, ujung tetap di posisi node sekarang
	moved := json.RawMessage(`{"type":"LineString","coordinates":[[106.8,-6.2],[106.806,-6.204],[106.81,-6.21]]}`)
	g, changed := edgeGeometryUpdate(cur, moved)
	if !changed {
		t.Fatal("pergeseran vertex tengah harus terdeteksi")
	}
	c, _ := lineCoords(g)
	if c[0][0] != 106.80005 || c[1][0] != 106.806 {
		t.Fatalf("ujung harus tetap, tengah mengikuti file: %v", c)
	}
}
