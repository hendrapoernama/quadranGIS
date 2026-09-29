#!/usr/bin/env bash
# Login akun uji QuadranGIS (captcha aritmetika) dan cetak token JWT ke stdout.
# Pakai:  T=$(bash .claude/skills/uji-quadrangis/scripts/login.sh)
#         curl -sk -H "Authorization: Bearer $T" https://127.0.0.1:8443/api/power/summary
# Variabel opsional: BASE (bawaan https://127.0.0.1:8443), QG_USER, QG_PASS.
BASE="${BASE:-https://127.0.0.1:8443}"
USER_="${QG_USER:-admin}"
PASS_="${QG_PASS:-quadran123}"
J='Content-Type: application/json'

solve() {
  local a op b
  a=$(echo "$1" | awk '{print $1}'); op=$(echo "$1" | awk '{print $2}'); b=$(echo "$1" | awk '{print $3}')
  case "$op" in "+") echo $((a + b)) ;; "-") echo $((a - b)) ;; *) echo $((a * b)) ;; esac
}

for attempt in 1 2 3 4 5 6; do
  c=$(curl -sk -m 20 "$BASE/api/auth/captcha")
  cid=$(echo "$c" | sed -n 's/.*"captcha_id":"\([^"]*\)".*/\1/p')
  q=$(echo "$c" | sed -n 's/.*"question":"\([^"]*\)".*/\1/p')
  L=$(curl -sk -m 30 -H "$J" -X POST \
    -d "{\"username\":\"$USER_\",\"password\":\"$PASS_\",\"captcha_id\":\"$cid\",\"captcha_answer\":\"$(solve "$q")\"}" \
    "$BASE/api/auth/login")
  T=$(echo "$L" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -n "$T" ]; then
    echo "$T"
    exit 0
  fi
  sleep 3 # API belum siap (mis. graf masih dimuat setelah restart backend)
done
echo "login gagal: $L" >&2
exit 1
