---
name: uji-quadrangis
description: Prosedur menguji QuadranGIS di lingkungan dev lokal (Docker) — build & restart container, login akun uji lewat captcha, uji manuver padam/nyala dengan pemulihan, uji AI Assistant dengan server LLM tiruan, uji penanda padam berkedip, dan tangkapan layar UI mode gelap/terang dengan Playwright. Pakai setiap kali perlu memverifikasi perubahan di aplikasi yang berjalan, terutama yang mengubah data jaringan atau konfigurasi.
---

# Uji QuadranGIS (dev lokal)

Pengguna membuka aplikasi yang sama di browsernya selama sesi, jadi setiap uji yang mengubah data
atau konfigurasi WAJIB dipulihkan (blok `finally` + pengawas waktu) dan jejaknya dilaporkan.

## 1. Build & restart

- RAM mesin sempit: build satu per satu, jangan paralel.
  `docker compose build backend && docker compose up -d backend`, lalu frontend dengan cara yang sama.
- `go vet` lokal: `GOTOOLCHAIN=local GOFLAGS=-p=2 go vet ./internal/...` (di folder `backend`).
- Frontend: `npx tsc --noEmit -p .` (di folder `frontend`). Jangan `prettier --write` tanpa opsi;
  proyek tidak punya konfigurasi prettier.
- Setelah restart backend dengan data massal, API diam 20–35 detik sampai log
  `[graph] pengelompokan` muncul (`docker logs qgis-backend`). Migrasi baru tercatat sebagai
  `[db] menjalankan migrasi NNN_...sql`.
- Setelah restart frontend, tunggu sampai login merespons:
  `until curl -sk -m 5 -o /dev/null -w "%{http_code}" https://127.0.0.1:8443/login | grep -q 200; do sleep 3; done`
- Port host dan nama container ada di `.env` / `docker-compose.yml` (nginx HTTPS 8443, container
  `qgis-backend`, `qgis-frontend`, `qgis-postgres`). SQL langsung:
  `docker exec qgis-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select ..."'`

## 2. Login & API

- Akun uji dev: `admin` / `quadran123` (hanya DB dev lokal).
- Token untuk curl: `T=$(bash .claude/skills/uji-quadrangis/scripts/login.sh)`
- Selalu pakai `https://127.0.0.1:8443`, bukan `localhost` (Chromium headless kadang gagal via IPv6).

## 3. Uji manuver (padam / nyala)

- Objek uji: recloser `REC-GMB-02-05` (node id 2702657; hilirnya 4 GD / 65 pelanggan) atau
  LBS 3 way `LBS3-GMB-03-07` (id 2702661).
- Buka: `POST /api/gis/maneuver {"node_id":2702657,"action":"open","kind":"GANGGUAN","note":"uji ..."}`
- Pulihkan: `POST /api/gis/maneuver {"node_id":2702657,"action":"close","note":"pulihkan uji"}`.
  Jalankan HANYA bila pembukaan berhasil (menutup yang sudah tertutup tetap menambah catatan manuver).
- Verifikasi pemulihan: status node `closed`, `GET /api/power/outages?active=1` kosong.
- Setiap uji meninggalkan catatan kejadian padam / manuver di riwayat (tidak bisa dihapus lewat UI):
  sebutkan nomornya di laporan.

## 4. Uji AI dengan server LLM tiruan

- Pengguna punya kunci OpenRouter asli (penyedia bawaan). JANGAN memakainya atau mengubah
  konfigurasi `ai.openrouter.*` tanpa izin eksplisit — memakai kredit pengguna.
- Jalankan mock di latar belakang: `python .claude/skills/uji-quadrangis/scripts/mock_llm.py <scratchpad>/mock.log`
  (port 9911; mencatat system prompt & pesan lengkap per baris JSON; mendukung format Anthropic
  `/v1/messages` dan OpenAI-compatible).
- Arahkan penyedia `anthropic` ke mock lewat `PUT /api/admin/configs`:
  `ai.anthropic.base_url` = `http://host.docker.internal:9911`, `ai.anthropic.api_key` = kunci uji.
  Kirim permintaan dengan `"provider":"anthropic"` eksplisit (`/api/ai/chat`, `/api/ai/ops`).
- Pulihkan di `trap ... EXIT`: `ai.anthropic.base_url` = `https://api.anthropic.com`,
  `ai.anthropic.api_key` = `" "` (satu spasi = hapus), dan konfigurasi lain yang diubah
  (mis. `ai.scope_strict` = `true`). Hentikan proses mock sesudahnya.
- Mock hanya membuktikan isi prompt yang dikirim, bukan perilaku model asli.

## 5. Uji penanda padam berkedip / cluster merah

- Tanpa manuver: sementara set `monitoring.off_marker_types` = `pelanggan_tr` (±88 pelanggan TR
  memang padam permanen), lalu kembalikan ke `gd,trafo_gi`. Dengan manuver: lihat bagian 3.
- Penanda dimuat ulang lewat realtime (manuver) atau polling `monitoring.power_refresh_seconds`.
- Periksa di halaman: `window.__qgisMap.querySourceFeatures('offmark')`,
  `getPaintProperty('offmark-icon','icon-opacity')` bergantian 1 / 0.2 saat penanda di layar.

## 6. Playwright (tangkapan layar & uji UI)

- Pasang Playwright di luar repo (mis. folder scratchpad): `npm i --prefix <dir> playwright@1.47`
  lalu jalankan skrip dengan `NODE_PATH=<dir>/node_modules node skrip.js`.
- Helper siap pakai: `scripts/pw-helpers.js` (`launch`, `login`, `go`, `apiOf`, `watchdog`, `log`).
- Pola wajib untuk uji yang mengubah data: `apiOf(ctx, token)` untuk manuver/konfigurasi (tidak
  bergantung halaman), `watchdog(ms, restore)` + `finally` yang memulihkan, log bertahap ke file,
  dan jalankan skrip panjang di latar belakang lalu tunggu file log-nya.
- Render headless memakai GPU perangkat lunak (swiftshader) dan sangat lambat untuk peta padat:
  - tunggu `domcontentloaded`, jangan `networkidle` (WebSocket realtime);
  - jangan menunggu event `idle` MapLibre — tidak pernah terjadi selama ada penanda padam berkedip di layar;
  - ukur kinerja di dalam halaman (event `render`, jeda `setInterval`), bukan dari waktu `evaluate`;
  - `page.evaluate` bisa macet bermenit-menit, maka pasang pengawas waktu.
- Setiap UI baru dicek di mode gelap (`colorScheme: 'dark'` + `localStorage.qgis_theme='dark'`) dan terang.
  Kelas Tailwind baru yang berwarna perlu padanan `.dark` di `frontend/app/globals.css`.

## 7. Laporan

Laporkan hasil apa adanya: yang lolos, yang gagal (dengan keluaran), yang dilewati, dan jejak data
uji yang tertinggal (nomor kejadian padam / manuver, konfigurasi yang sempat diubah dan sudah dipulihkan).
