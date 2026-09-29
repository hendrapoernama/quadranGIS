---
name: quadrangis-claude-setup
description: "Lokasi memori & skill Claude Code untuk QuadranGIS dipindah ke folder aplikasi (29 Sep 2026) atas permintaan pengguna; cara kerjanya dan cara memulihkan bila memori tidak termuat"
metadata:
  type: project
---

Atas permintaan pengguna (29 Sep 2026) memori dan skill proyek disimpan di dalam folder aplikasi:

- Memori otomatis: `D:/Aplikasi/qikb/quadranGIS/.claude/memory/` (dipindah dari `~/.claude/projects/d--Aplikasi-qikb-quadranGIS/memory/`, folder lama dihapus setelah checksum 14 file cocok).
- Diarahkan lewat `autoMemoryDirectory` di `.claude/settings.local.json` (path absolut, khusus mesin ini; file itu di-`.gitignore`). Setting proyek ini hanya dihormati bila folder proyek dipercaya (workspace trust) dan `permissions.blockReadsOutsideWorkingDirectories` tidak aktif.
- Skill proyek: `.claude/skills/uji-quadrangis/` (prosedur & alat uji). Skill bawaan akun (docx, pdf, xlsx, ...) di `~/.claude/skills/synced/` sengaja tidak dipindah: dikelola sinkronisasi Anthropic.
- `.claude/memory/` dan `.claude/skills/` belum di-commit dan belum di-gitignore; memori berisi kata sandi akun uji dev & catatan khusus mesin — tanyakan pengguna sebelum meng-commit.

**Why:** Pengguna ingin pengetahuan Claude tentang proyek ini ikut berada di folder aplikasi.

**How to apply:** Bila sesi baru tidak memuat memori (index MEMORY.md tidak muncul), periksa `/memory` atau `/context`; cadangannya salin isi `.claude/memory/` kembali ke `~/.claude/projects/d--Aplikasi-qikb-quadranGIS/memory/`. Tulis memori baru ke `.claude/memory/`. Terkait: [[quadrangis-testing-approach]].
