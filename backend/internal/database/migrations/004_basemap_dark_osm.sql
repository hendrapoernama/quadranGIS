-- =====================================================================
-- 004: basemap gelap memakai OSM standar yang dibalik warnanya di klien
--      (CARTO Dark Matter kini mewajibkan API key).
-- =====================================================================
UPDATE app_configs
   SET value = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
       description = 'Basemap gelap (XYZ). Bila app.basemap_dark_invert=true, tile dibalik warnanya di klien (OSM standar -> mode gelap tanpa API key)'
 WHERE key = 'app.basemap_dark_url'
   AND value LIKE 'https://basemaps.cartocdn.com/%';

UPDATE app_configs SET value = '&copy; OpenStreetMap contributors'
 WHERE key = 'app.basemap_attribution' AND value LIKE '%CARTO%';

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('app.basemap_dark_invert',   'true', 'bool', 'general', 'Balik warna tile basemap gelap di klien (true untuk OSM standar; false bila memakai penyedia tile gelap asli)'),
 ('app.basemap_fallback_url',  'https://tile.openstreetmap.de/{z}/{x}/{y}.png', 'string', 'general', 'Mirror OSM yang dipakai otomatis bila basemap utama gagal dimuat berulang')
ON CONFLICT (key) DO NOTHING;
