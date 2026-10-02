-- Impor GDB bertahap: GDB baru dibandingkan dulu dengan batch yang sudah ada (pratinjau), lalu diterapkan per objek
-- (tambah / ubah / hapus) sehingga id objek tetap dan rujukan (manuver, kejadian padam, foto, titik SCADA, ...) aman.
--
-- gdb_import_objects mencatat kunci identitas setiap objek batch → id objek QuadranGIS, beserta sidik isi milik GDB
-- saat terakhir diterapkan (baseline). Dengan baseline, pratinjau membedakan perubahan dari GDB, perubahan lokal
-- (editor), dan konflik (keduanya berubah). Kunci simpul: g:<GlobalID> | gi:<kode GI> | p:<posisi UTM 1 cm>;
-- kunci saluran: <GlobalID garis / s:<tipe> sintesis>|<kunci simpul awal>><kunci simpul akhir>.

CREATE TABLE IF NOT EXISTS gdb_import_objects (
  tag        text   NOT NULL,
  kind       text   NOT NULL CHECK (kind IN ('node', 'edge')),
  key        text   NOT NULL,
  obj_id     bigint NOT NULL,
  hash       text   NOT NULL DEFAULT '',   -- '' = sudah tidak ada di GDB, dipertahankan atas keputusan pengguna
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tag, kind, key)
);
CREATE INDEX IF NOT EXISTS gdb_import_objects_obj_idx ON gdb_import_objects (kind, obj_id);

-- ringkasan pratinjau perbandingan (dipertahankan di riwayat)
ALTER TABLE gdb_imports ADD COLUMN IF NOT EXISTS preview jsonb NOT NULL DEFAULT '{}'::jsonb;

-- GlobalID objek impor: cek tumpang tindih dengan batch lain
CREATE INDEX IF NOT EXISTS gis_nodes_gdb_globalid_idx ON gis_nodes ((properties->>'gdb_globalid')) WHERE properties ? 'gdb_globalid';

-- atribut milik GDB (ditulis gdbimport/build_staging.sql); atribut lain (isian pengguna) tidak disentuh impor bertahap
CREATE OR REPLACE FUNCTION qgis_gdb_prop_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['gdb_layer', 'gdb_globalid', 'gdb_status', 'kode_ssot', 'penyulang', 'penghantar', 'kodegd', 'jurusan', 'idpel',
    'rel', 'gi', 'jenis_kubikel', 'fungsi_kubikel', 'merek', 'fungsi', 'pembatas_zona', 'normal', 'daya_kva', 'status_operasi',
    'keterangan_operasi', 'jumlah_jurusan', 'nomor_gd', 'kapasitas_kva', 'jumlah_trafo', 'alamat', 'jenis', 'tarif', 'daya_va', 'no_meter',
    'fasa', 'type_jointing', 'kepala_penyulang', 'sintesis', 'keterangan', 'jenis_tiang', 'ukuran']
$$;

CREATE OR REPLACE FUNCTION qgis_gdb_props(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(p) e WHERE e.key = ANY (qgis_gdb_prop_keys())
$$;

-- geometri ternormalisasi (UTM 48S, grid 1 cm) untuk kunci posisi & perbandingan
CREATE OR REPLACE FUNCTION qgis_gdb_geomtext(g geometry) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN g IS NULL THEN '' ELSE ST_AsText(ST_SnapToGrid(ST_Transform(g, 32748), 0.01)) END
$$;

-- kunci dasar simpul: GI = kode, objek ber-GlobalID = GlobalID, selain itu (junction, ujung garis, kubikel sintesis) = posisi
CREATE OR REPLACE FUNCTION qgis_gdb_node_key(p_code text, p jsonb, g geometry) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p->>'gdb_layer' = 'gi' THEN 'gi:' || p_code
              WHEN coalesce(p->>'gdb_globalid', '') <> '' THEN 'g:' || (p->>'gdb_globalid')
              ELSE 'p:' || qgis_gdb_geomtext(g) END
$$;

-- kunci dasar saluran: GlobalID garis (satu garis GDB bisa terpotong menjadi beberapa saluran) + kunci kedua ujung
CREATE OR REPLACE FUNCTION qgis_gdb_edge_key(p_type text, p jsonb, a_key text, b_key text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN coalesce(p->>'gdb_globalid', '') <> '' THEN 'g:' || (p->>'gdb_globalid')
              WHEN p->>'sintesis' = 'true' THEN 's:' || p_type
              ELSE 'x:' || coalesce(p->>'gdb_layer', '') || ':' || p_type END || '|' || coalesce(a_key, '?') || '>' || coalesce(b_key, '?')
$$;

-- sidik isi milik GDB: tipe, kode, nama, geometri & denah asli (sebelum denah gardu diperbesar), atribut GDB
CREATE OR REPLACE FUNCTION qgis_gdb_hash(p_type text, p_code text, p_name text, g geometry, fp geometry, p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT md5(concat_ws('|', p_type, p_code, p_name, qgis_gdb_geomtext(g), qgis_gdb_geomtext(fp), qgis_gdb_props(p)::text))
$$;
