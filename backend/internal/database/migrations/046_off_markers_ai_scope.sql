-- Penanda peta objek padam (gardu distribusi & trafo GI berkedip merah; cluster merah bila banyak)
-- dan pembatasan ruang lingkup asisten AI.

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('monitoring.off_marker_types',         'gd,trafo_gi', 'string', 'monitoring', 'Tipe objek yang ditandai berkedip merah di peta saat padam (kode tipe, pisahkan koma)'),
 ('monitoring.off_marker_cluster_radius', '50',         'int',    'monitoring', 'Radius pengelompokan penanda padam menjadi cluster merah (piksel layar; 0 = tanpa cluster)'),
 ('monitoring.off_marker_cluster_max_zoom', '15',       'int',    'monitoring', 'Zoom tertinggi pengelompokan penanda padam; di atasnya setiap objek tampil berkedip sendiri'),
 ('ai.scope_strict',                     'true',        'bool',   'ai',         'Batasi asisten AI hanya menjawab topik QuadranGIS & jaringan distribusi listrik (pertanyaan lain ditolak)')
ON CONFLICT (key) DO NOTHING;
