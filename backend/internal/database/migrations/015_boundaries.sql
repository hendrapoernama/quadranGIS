-- =====================================================================
-- 015: overlay batas wilayah (UP3 dan ULP). Poligon ULP dimuat dari
--      shapefile docs/bts_area (disematkan di backend, dimuat saat tabel
--      kosong); UP3 = gabungan (dissolve) poligon ULP per nama area.
-- =====================================================================
CREATE TABLE IF NOT EXISTS gis_boundaries (
    id         bigserial PRIMARY KEY,
    level      text NOT NULL CHECK (level IN ('up3','ulp')),
    code       text NOT NULL DEFAULT '',
    name       text NOT NULL,
    parent     text NOT NULL DEFAULT '',          -- ULP: nama UP3 induk
    properties jsonb NOT NULL DEFAULT '{}'::jsonb, -- atribut asli shapefile
    geom       geometry(MultiPolygon, 4326) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gis_boundaries_geom_idx ON gis_boundaries USING gist (geom);
CREATE INDEX IF NOT EXISTS gis_boundaries_level_idx ON gis_boundaries (level, name);

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('map.boundary_visible', 'true', 'bool',  'general', 'Tampilkan overlay batas UP3 secara bawaan (tiap pengguna dapat mengubahnya di peta)'),
 ('map.boundary_opacity', '0.15', 'float', 'general', 'Transparansi isi bawaan overlay batas UP3 (0 = transparan, 1 = pekat)')
ON CONFLICT (key) DO NOTHING;
