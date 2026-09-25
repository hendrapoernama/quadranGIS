#!/usr/bin/env bash
# Membuat sertifikat self-signed untuk pengembangan (HTTPS lokal).
# Berjalan di Linux/macOS maupun Git Bash di Windows.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: jangan ubah "/C=ID/..." menjadi path
DIR="$(cd "$(dirname "$0")/.." && pwd)/nginx/certs"
mkdir -p "$DIR"
HOST="${1:-localhost}"

# openssl.exe di Windows butuh path bergaya Windows
topath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# Beberapa instalasi openssl menunjuk ke openssl.cnf yang tidak ada; pakai konfigurasi minimal.
CONF="$DIR/.openssl.cnf"
printf '[req]\ndistinguished_name = dn\n[dn]\n' > "$CONF"
trap 'rm -f "$CONF"' EXIT

OPENSSL_CONF="$(topath "$CONF")" openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$(topath "$DIR/server.key")" -out "$(topath "$DIR/server.crt")" \
  -subj "/C=ID/ST=Jakarta/O=QuadranGIS/CN=$HOST" \
  -addext "subjectAltName=DNS:$HOST,DNS:localhost,IP:127.0.0.1"
echo "Sertifikat dibuat di $DIR (server.crt, server.key)"
