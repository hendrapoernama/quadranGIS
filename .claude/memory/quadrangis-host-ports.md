---
name: quadrangis-host-ports
description: "Port host yang sudah terpakai di mesin ini (PostgreSQL lokal 5432, container proyek \"qai\" di 6379/29092/80/443/8090, proses lain di 8080) dan port yang dipakai QuadranGIS"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-25T09:11:04.830Z
---

Di mesin pengembangan ini beberapa port host sudah terpakai oleh hal lain:
- 5432: PostgreSQL native Windows (bukan Docker) — koneksi ke localhost:5432 masuk ke instance ini, bukan container.
- 6379, 29092, 80, 443, 8090, 3001: container proyek lain bernama `qai-*` (qai-redis, qai-kafka, qai-nginx, qai-api, qai-grafana). Jangan dihentikan.
- 8080: proses host lain (PID berubah-ubah).

QuadranGIS (docker-compose.yml) karena itu memetakan: Postgres 5434, Redis 6380, Kafka host-listener 29093; port nginx/backend bisa diubah lewat `HTTPS_PORT`, `HTTP_PORT`, `BACKEND_PORT` di `.env` (di mesin ini dipakai 8443 / 8081 / 8085).

**Why:** Menghindari bentrok port yang sempat membuat backend tersambung ke Postgres yang salah dan Kafka gagal bind.

**How to apply:** Saat menjalankan backend lokal pakai `DATABASE_URL=...localhost:5434`, `REDIS_ADDR=localhost:6380`, `KAFKA_BROKERS=localhost:29093`, dan `HTTP_ADDR=:8085` (bukan 8080). Lihat juga [[quadrangis-dev-env-quirks]].
