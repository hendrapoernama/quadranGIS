-- Header bergaya infografis (logo PLN, nama unit, judul menu, logo Danantara) di bagian atas semua menu;
-- tampil / sembunyi diatur di Administrasi › Konfigurasi › Identitas Aplikasi.

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('app.page_banner', 'true', 'bool', 'branding', 'Tampilkan header (logo PLN, nama unit, judul menu, logo Danantara) di bagian atas semua menu')
ON CONFLICT (key) DO NOTHING;
