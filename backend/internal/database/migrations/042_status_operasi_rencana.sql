-- Status operasi untuk semua objek titik bertopologi: Operasi / Rencana / Tidak operasi / Bongkar.
-- Objek non-operasi tidak dihitung di rekap nyala / padam (gardu, trafo, pelanggan, beban, SAIDI / SAIFI,
-- wilayah, dampak kejadian) dan tampil abu-abu di peta. Gardu berkode / bernama "REN" / "RENCANA" = rencana.

-- pelanggan: tambah opsi Rencana pada atribut yang sudah ada (migrasi 041)
UPDATE component_types t SET attributes = (
  SELECT jsonb_agg(CASE WHEN a->>'key' = 'status_operasi'
                        THEN jsonb_set(a, '{options}', '["Operasi","Rencana","Tidak operasi","Bongkar"]'::jsonb) ELSE a END ORDER BY o)
  FROM jsonb_array_elements(t.attributes) WITH ORDINALITY x(a, o))
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.attributes, '[]'::jsonb)) a WHERE a->>'key' = 'status_operasi');

-- objek titik bertopologi lain: tambah atribut
UPDATE component_types t SET attributes = COALESCE(t.attributes, '[]'::jsonb) ||
  '[{"key":"status_operasi","label":"Status operasi","label_en":"Operating status","type":"select","options":["Operasi","Rencana","Tidak operasi","Bongkar"]},
    {"key":"keterangan_operasi","label":"Keterangan status operasi","label_en":"Operating status note","type":"text"}]'::jsonb
WHERE t.topology AND t.geom_kind IN ('point', 'polygon') AND t.code <> 'junction'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.attributes, '[]'::jsonb)) a WHERE a->>'key' = 'status_operasi');

-- gardu rencana: kode / nomor gardu mengandung kata REN atau RENCANA (mis. "REN GARDU BARU", "REN_GD_WING_461")
UPDATE gis_nodes n SET properties = n.properties || '{"status_operasi":"Rencana","keterangan_operasi":"kode gardu REN (rencana)"}'::jsonb,
  updated_at = now()
WHERE n.type_code IN ('gd', 'gh') AND NOT (n.properties ? 'status_operasi')
  AND (n.code ~* '(^|[^a-z])(ren|rencana)([^a-z]|$)' OR coalesce(n.properties->>'nomor_gd', '') ~* '(^|[^a-z])(ren|rencana)([^a-z]|$)');
