---
name: quadrangis-off-markers-ai-scope
description: "Penanda padam berkedip/cluster merah (GD & trafo GI) dan pembatasan ruang lingkup AI (ai.scope_strict), dibangun 29 Sep 2026: keputusan desain & yang belum teruji"
metadata:
  node_type: memory
  type: project
  originSessionId: 3919e078-2a03-41b5-89c0-7d709c4e8b37
  modified: 2026-09-29T05:38:25.849Z
---

Dibangun 29 Sep 2026 (migrasi `046_off_markers_ai_scope.sql`, belum di-commit saat ditulis):

- **Penanda padam**: `GET /api/power/off-markers` (tipe dari `monitoring.off_marker_types`, bawaan `gd,trafo_gi`; objek rencana/non aktif/bongkar dikecualikan). Sumber GeoJSON ber-cluster di `MapCanvas`, dipakai Pusat Operasi dan Editor Peta lewat hook `useOffMarkers`.
  - Kedip sengaja dua keadaan (700 ms), tanpa transisi paint, dan hanya selama ada penanda di area tampilan. Versi awal yang berupa gelombang halus sekitar 12 fps membuat peta terus dirender.
  - Semua 19 GD yang padam permanen di DB dev berstatus rencana/non aktif, jadi dalam kondisi normal tidak ada yang berkedip.
- **AI**: aturan `aiScopeRule` ditempel paling akhir di prompt sistem `/api/ai/chat` dan `/api/ai/ops` bila `ai.scope_strict` bernilai true (bawaan). Yang sudah diverifikasi baru isi prompt lewat mock. **Perilaku penolakan dengan model asli belum diuji**; pengguna punya kunci OpenRouter asli dan belum memberi izin memakainya untuk uji.

**Why:** Agar sesi berikutnya tahu alasan kedip dua keadaan (kinerja) dan bahwa kepatuhan model terhadap batasan belum terbukti.

**How to apply:** Bila pengguna melaporkan AI masih menjawab topik umum, uji dengan model asli (minta izin dulu) lalu perkuat aturan. Jangan kembalikan animasi halus tanpa mengukur render per detik. Terkait: [[quadrangis-testing-approach]], [[quadrangis-kafka-switch]].
