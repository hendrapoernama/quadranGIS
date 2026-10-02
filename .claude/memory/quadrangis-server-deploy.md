---
name: quadrangis-server-deploy
description: "QuadranGIS di-deploy ke server 10.3.187.7 (30 Sep 2026): lokasi, override compose, cara deploy ulang & salin DB tersaring, jebakan init Postgres, server bersama (sync_ems.py)"
metadata:
  node_type: memory
  type: project
  originSessionId: c6f0a2fc-1fcf-4a30-9b21-93226146c3a0
  modified: 2026-09-30T02:30:54.787Z
---

Sejak 30 Sep 2026 QuadranGIS berjalan di server **10.3.187.7** (Ubuntu 24.04, 16 core, 31 GB, Docker 28 + Compose 2.40, user `up2djkt`, grup docker, sudo butuh sandi). Akses: https://10.3.187.7 (sertifikat self-signed CN/SAN IP 10.3.187.7, berlaku s.d. Jan 2029). Hanya lewat VPN kantor (adapter "up2d jakarta"). Kata sandi SSH diberikan pengguna di chat, jangan ditulis ke berkas mana pun; tanyakan lagi bila perlu.

- Aplikasi di `~/quadrangis` (tar dari `git ls-files -co --exclude-standard` backend/frontend/nginx/scripts + compose). `.env` khusus server: APP_ENV=production, JWT_SECRET acak, CORS https://10.3.187.7, port 80/443 (+ backend 8080 di 127.0.0.1).
- `docker-compose.override.yml` di server: image Postgres dikunci ke digest `timescale/timescaledb-ha:pg16@sha256:903669a9…` (TimescaleDB 2.29.2, sama dengan dev), dan port Postgres 5434, Redis 6380, Kafka 29093, serta backend hanya di 127.0.0.1. Kafka belum bisa dijangkau SCADA luar; bila perlu, ubah advertised listener dan buka port dengan sengaja (pesan Kafka switch tidak dicek hak aksesnya).
- Berkas deploy (skrip setup, dump) ada di `~/quadrangis-deploy`. Salinan berkerjanya di scratchpad sesi `c6f0a2fc…`: `export-filtered.sh` (dijalankan di container dev) dan `restore-in-container.sh`.
- DB server = salinan DB dev **tanpa simulasi massal**: gis_nodes/edges tanpa `bulk`, scada_points & load_* hanya untuk 46 titik non-simulasi, dan data chunk `_timescaledb_internal._hyper_5_*` (load_30m) dikecualikan dari pg_dump lalu diisi ulang lewat COPY setelah `timescaledb_post_restore()`. Hasilnya ±73 MB, bukan ±1,5 GB. VPN hanya ±0,5 MB/s.
- Jebakan: pada start pertama volume baru, `pg_isready` sudah OK saat server sementara initdb masih jalan. Tunggu log "init process complete" sebelum DROP/restore, karena kalau tidak, container gagal init dan volume harus dibuat ulang.
- Build di server cepat (pull + build ±6,5 menit). Deploy ulang kode: kirim tar sumber → ekstrak ke ~/quadrangis (jangan timpa .env, override, nginx/certs) → `docker compose build backend && docker compose build frontend && docker compose up -d`.
- Server dipakai bersama job lain milik pengguna: `~/program/*.py` (sync_ems, sync_ews, uvicorn :8000), Cronicle :3012, port 6432 & 9090. Pada 30 Sep 2026, atas izin pengguna, 138 proses `sync_ems.py` yang macet (futex, Nov 2025 s/d Mar 2026, ±26 GB RAM) dihentikan. Yang aktif disisakan: PID 3858092 (dijalankan manual 21 Jul 2026). Penyebabnya, `pidof -x sync_ems.py` di run_sync_ems.sh tidak mendeteksi `python sync_ems.py`. Log sync_ems.log sudah 1,4 GB.

**Why:** pengguna meminta deploy ke server ini; detail di atas makan waktu untuk ditemukan.

**How to apply:** untuk deploy ulang/pembaruan, ikuti langkah di atas. Cek `free -h` dan jumlah `pgrep -fc sync_ems.py` dulu. Terkait: [[quadrangis-bulk-sim-state]], [[quadrangis-host-ports]], [[quadrangis-dev-env-quirks]].
