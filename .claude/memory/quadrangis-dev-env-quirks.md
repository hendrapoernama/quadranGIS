---
name: quadrangis-dev-env-quirks
description: "Kekhasan lingkungan dev Windows untuk QuadranGIS - memori 16 GB hampir penuh (go build bisa crash), openssl psqlODBC tanpa openssl.cnf, Git Bash mengubah \"/C=ID\" jadi path, go mod tidy menaikkan versi Go"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-25T18:42:02.502Z
---

Kekhasan mesin dev Windows ini untuk proyek QuadranGIS (D:\Aplikasi\qikb\quadranGIS):
- RAM 16 GB dan biasanya ~15 GB terpakai: `go build` pernah crash (`runtime: sysUsedOS` throw) saat berjalan bersamaan dengan build Next.js dan Kafka JVM. Jalankan build satu per satu, pakai `GOFLAGS=-p=2`.
- `openssl` yang ada di PATH adalah bawaan psqlODBC dan menunjuk ke openssl.cnf yang tidak ada; `scripts/gen-cert.sh` sudah menangani ini (config minimal + `cygpath -m` + `MSYS_NO_PATHCONV=1`).
- Git Bash mengubah argumen berawalan "/" (mis. `-subj /C=ID/...`, `docker exec ... /opt/kafka/bin/...`) menjadi path Windows; gunakan `MSYS_NO_PATHCONV=1`.
- `go mod tidy` tanpa pin menarik `github.com/rogpeppe/go-internal` v1.16 yang butuh Go 1.25 dan mengubah directive `go` di go.mod; go.mod mem-pin v1.12.0 agar tetap Go 1.24 (sesuai `golang:1.24-alpine` di Dockerfile). Pakai `GOTOOLCHAIN=local`.
- Tool Bash di sesi ini gagal mem-parse perintah panjang berisi banyak heredoc; tulis file dengan tool Write.
- `docker compose build backend frontend` sekaligus pernah gagal ("failed to receive status: ... EOF", VM Docker 3,8 GB kehabisan memori); build satu per satu: `docker compose build backend && docker compose build frontend`. Setelah build, API bisa lambat/macet ±1–2 menit.
- Playwright Chromium kadang tidak bisa membuka `https://localhost:8443` (ERR_TIMED_OUT, kemungkinan IPv6) padahal curl bisa; pakai `https://127.0.0.1:8443`. Setelah container frontend restart, tunggu `/login` merespons 200 dulu sebelum navigasi.

- Frontend tidak punya konfigurasi prettier; `npx prettier --write` memakai kutip ganda dan merusak gaya proyek. Pakai `npx prettier --single-quote --print-width 200` hanya pada berkas yang ditulis sendiri.
- Gambar panduan `frontend/public/guide/*.jpg` ikut dibakar ke image frontend: setelah mengambil ulang tangkapan layar, build frontend lagi.
- Skrip Python lewat heredoc bash rawan: `
` dan tab (gofmt) sering tidak cocok; untuk penggantian teks banyak, tulis skrip ke berkas scratchpad dengan tool Write. `sleep` panjang diblokir — tunggu layanan dengan `until curl ...; do sleep 3; done`.

**Why:** Semua ini sempat memakan waktu debugging pada sesi 25 Sep 2026 (tiga butir terakhir 27 Sep 2026).

**How to apply:** Cek dulu hal-hal di atas sebelum menyimpulkan ada bug di kode. Terkait: [[quadrangis-host-ports]].
