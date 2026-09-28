-- Status operasi "Non aktif" (mis. status INACTIVE pada GDB PLN): sama seperti Rencana / Tidak operasi / Bongkar,
-- objek tidak dihitung di rekap nyala / padam.
UPDATE component_types t SET attributes = (
  SELECT jsonb_agg(CASE WHEN a->>'key' = 'status_operasi'
                        THEN jsonb_set(a, '{options}', '["Operasi","Rencana","Non aktif","Tidak operasi","Bongkar"]'::jsonb) ELSE a END ORDER BY o)
  FROM jsonb_array_elements(t.attributes) WITH ORDINALITY x(a, o))
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.attributes, '[]'::jsonb)) a WHERE a->>'key' = 'status_operasi');
