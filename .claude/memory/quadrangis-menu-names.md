---
name: quadrangis-menu-names
description: "Nama menu diganti 2 Okt 2026: Map Editor → Peta Kelistrikan, Editor Peta Jaringan → Peta Jaringan (/map); memori lama masih menyebut nama lama"
metadata:
  type: project
---

Atas permintaan pengguna (2 Okt 2026), migrasi `050_menu_peta_kelistrikan.sql` mengganti nama menu:
- induk **Map Editor** → **Peta Kelistrikan** (EN *Electrical Map*);
- **Editor Peta Jaringan** (`/map`) → **Peta Jaringan** (EN *Network Map*).

Nama menu ada di tabel `menus`, bukan di kode frontend. README dan Dokumentasi sudah memakai nama baru.

**Why:** memori lain (mis. [[quadrangis-feeder-coloring-plan]], [[quadrangis-edit-scope-plan]], [[quadrangis-mobile-plan]]) masih menulis "Editor Peta"; itu halaman yang sama.

**How to apply:** saat pengguna menyebut "Peta Jaringan", yang dimaksud halaman editor `/map` (`MapWorkspace.tsx`). "Peta Jaringan Listrik" adalah nama lama Pusat Operasi (`/monitoring`), bukan halaman ini. Pakai nama baru di teks/dokumentasi baru.
