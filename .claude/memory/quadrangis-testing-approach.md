---
name: quadrangis-testing-approach
description: "Cara menguji fitur QuadranGIS yang mengubah data / butuh layanan eksternal — prosedur lengkap kini di skill proyek uji-quadrangis; di sini fakta & keputusan yang melatarinya"
metadata:
  node_type: memory
  type: project
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-29T13:00:00.000Z
---

Prosedur, perintah, dan alat uji (login captcha, manuver uji & pemulihan, mock LLM, Playwright helper)
dipindah 29 Sep 2026 ke skill proyek `.claude/skills/uji-quadrangis/` (SKILL.md + `scripts/`).
Alat uji lama di scratchpad sesi 261f5261 (folder temp) tidak lagi dirujuk.

- **Akun uji (DB dev)**: `admin` / `quadran123` (diganti pengguna 27 Sep 2026; `Admin#12345` tidak berlaku). Setelah login halaman awal Dashboard, bukan `/map`.
- **Kunci OpenRouter asli (terlihat 29 Sep 2026)**: pengguna mengisi `ai.openrouter.api_key` dan menjadikan OpenRouter penyedia bawaan. Jangan memakainya untuk uji tanpa izin; uji lewat penyedia `anthropic` yang diarahkan ke mock.
- Nama model bawaan (`claude-sonnet-5`, `gpt-5-mini`, `kimi-k2-0905-preview`, `openrouter/auto`) belum diverifikasi ke layanan asli.
- Laporan berkala buatan uji dihapus (`generated_by <> 'system'`); penjadwal membuat ulang laporan periode lengkap terakhir dalam ≤ 5 menit.
- Manuver uji di `REC-GMB-02-05` (hilirnya 4 GD / 65 pelanggan per 29 Sep 2026). Setiap uji menambah catatan kejadian padam / manuver yang tidak bisa dihapus lewat UI (uji 29 Sep 2026: kejadian #94, #95).
- Uji izin: izin dibaca dari role terkini di DB tiap request (cache 30 dtk); pulihkan role setelah uji.

**Why:** Uji tanpa pemulihan meninggalkan jaringan padam atau key uji aktif di sistem yang dipakai pengguna secara langsung (pengguna membuka aplikasi di browsernya sendiri selama sesi).

**How to apply:** Muat skill `uji-quadrangis` sebelum menguji; rencanakan pemulihan (finally + watchdog) dan laporkan jejak data uji. Terkait: [[quadrangis-bulk-sim-state]], [[quadrangis-dev-env-quirks]], [[quadrangis-off-markers-ai-scope]].
