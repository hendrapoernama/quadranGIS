---
name: user-prefs-quadrangis
description: "Preferensi pengguna QuadranGIS: berkomunikasi dalam bahasa Indonesia, memakai tema gelap, meminta fitur bertahap lewat tangkapan layar"
metadata:
  node_type: memory
  type: user
  originSessionId: 261f5261-5265-4074-9b49-c76938cb617f
  modified: 2026-09-25T18:42:16.117Z
---

- Pengguna menulis permintaan dalam bahasa Indonesia (singkat, sering berupa daftar poin + tangkapan layar UI); jawab dalam bahasa Indonesia.
- Pengguna memakai aplikasi dalam **tema gelap** dan pernah meminta warna latar/teks disesuaikan dengan tema. Setiap komponen UI baru harus dicek di mode gelap; kelas Tailwind baru (terutama varian opasitas seperti `bg-red-50/60`) perlu padanan `.dark` di `frontend/app/globals.css`.
- Pengguna menguji langsung di browsernya sambil saya bekerja (terlihat di log nginx), jadi perubahan data uji terlihat olehnya.

**Why:** Tercermin dari seluruh permintaan sesi 25–26 Sep 2026 dan koreksi warna mode gelap.

**How to apply:** Balas dalam bahasa Indonesia; verifikasi UI baru dengan screenshot mode gelap (Playwright `colorScheme: 'dark'`). Terkait: [[quadrangis-testing-approach]].
