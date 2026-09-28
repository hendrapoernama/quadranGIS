-- Status operasi pelanggan: "Tidak operasi" / "Bongkar" = pelanggan tidak dihitung (rekap nyala / padam,
-- beban, SAIDI / SAIFI / ENS, pelanggan per wilayah) dan tampil abu-abu di peta. Pelanggan tanpa SR (tidak
-- tersambung ke saluran apa pun) dianggap tidak operasi / sudah dibongkar.

UPDATE component_types t SET attributes = COALESCE(t.attributes, '[]'::jsonb) ||
  '[{"key":"status_operasi","label":"Status operasi","label_en":"Operating status","type":"select","options":["Operasi","Tidak operasi","Bongkar"]},
    {"key":"keterangan_operasi","label":"Keterangan status operasi","label_en":"Operating status note","type":"text"}]'::jsonb
WHERE t.is_sink AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.attributes, '[]'::jsonb)) a WHERE a->>'key' = 'status_operasi');

UPDATE gis_nodes n SET properties = n.properties || '{"status_operasi":"Tidak operasi","keterangan_operasi":"tanpa SR (tidak tersambung)"}'::jsonb,
  updated_at = now()
FROM component_types t
WHERE t.code = n.type_code AND t.is_sink AND NOT (n.properties ? 'status_operasi')
  AND NOT EXISTS (SELECT 1 FROM gis_edges e WHERE e.from_node_id = n.id)
  AND NOT EXISTS (SELECT 1 FROM gis_edges e WHERE e.to_node_id = n.id);
