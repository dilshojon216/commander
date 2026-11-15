#!/bin/bash
# Commander Center tekshiruvi (ko'chirish/DR'dan keyin). Faqat o'qiydi.
#
# Foydalanish:
#   bash ops/migrate/verify-center.sh [--project NAME] [--compose-file FILE] [--env-file FILE]
#                                     [--center-url URL] [--export-dir DIR]
#   --center-url  default: http://127.0.0.1:<.env PORT yoki 4317>
#   --export-dir  berilsa manifest.txt bilan solishtiriladi (migrations, qatorlar, kalit sha256, fingerprint)
# Chiqish kodi: 0 = hamma muhim tekshiruv o'tdi, 1 = kamida bittasi yiqildi.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_DIR/ops/migrate/lib.sh"

PROJECT="commander"
COMPOSE_FILE="$REPO_DIR/apps/center/docker-compose.yml"
ENV_FILE=""
CENTER_URL=""
EXPORT_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?}"; shift ;;
    --compose-file) COMPOSE_FILE="${2:?}"; shift ;;
    --env-file) ENV_FILE="${2:?}"; shift ;;
    --center-url) CENTER_URL="${2:?}"; shift ;;
    --export-dir) EXPORT_DIR="${2:?}"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "noma'lum parametr: $1" ;;
  esac
  shift
done
[ -n "$ENV_FILE" ] || ENV_FILE="$(dirname "$COMPOSE_FILE")/.env"
[ -f "$ENV_FILE" ] || die ".env topilmadi: $ENV_FILE"
env_val() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }   # faqat ichki ishlatiladi, chop etilmaydi
[ -n "$CENTER_URL" ] || CENTER_URL="http://127.0.0.1:$(env_val PORT | grep . || echo 4317)"

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
manifest() { [ -n "$EXPORT_DIR" ] && sed -n "s/^$1=//p" "$EXPORT_DIR/manifest.txt"; }

PASS=0; FAIL=0; WARN=0
ok()   { echo "✓ $*"; PASS=$((PASS + 1)); }
bad()  { echo "✗ $*"; FAIL=$((FAIL + 1)); }
warn() { echo "⚠ $*"; WARN=$((WARN + 1)); }
cmp_manifest() {  # $1=nomi $2=haqiqiy $3=manifest kaliti [$4=ge]
  local want; want="$(manifest "$3")"
  if [ -z "$want" ]; then ok "$1: $2"
  elif [ "$2" = "$want" ]; then ok "$1: $2 (manifest bilan mos)"
  elif [ "${4:-}" = ge ] && [ "$2" -ge "$want" ] 2>/dev/null; then ok "$1: $2 (manifest $want, o'sgan)"
  else bad "$1: $2 != manifest $want"; fi
}

log "=== Commander Center tekshiruvi: loyiha $PROJECT, $CENTER_URL ==="

# 1. Konteynerlar
DB_CID="$(dc ps -q db)"; APP_CID="$(dc ps -q app)"
for pair in "db:$DB_CID" "app:$APP_CID"; do
  name="${pair%%:*}"; cid="${pair#*:}"
  st="$( [ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)"
  [ "$st" = healthy ] && ok "$name konteyneri: healthy" || bad "$name konteyneri: ${st:-ishlamayapti}"
done

# 2. /health
CODE="$(curl -s -o /tmp/cmdr-verify-health.$$ -w '%{http_code}' --max-time 5 "$CENTER_URL/health" || echo 000)"
BODY="$(cat /tmp/cmdr-verify-health.$$ 2>/dev/null)"; rm -f /tmp/cmdr-verify-health.$$
[ "$CODE" = 200 ] && echo "$BODY" | grep -q '"ok":true' && ok "GET /health: 200 $BODY" || bad "GET /health: $CODE"

# 3. DB (ishlab turgan db konteyneri orqali, faqat o'qish)
if [ -n "$DB_CID" ]; then
  q() { docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$DB_CID" psql -U commander -d commander -At -c "$1" 2>/dev/null; }
  TABLES="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
  [ "${TABLES:-0}" -gt 0 ] && ok "jadvallar: $TABLES" || bad "jadval yo'q"
  TSDB="$(q "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
  [ -n "$TSDB" ] && ok "timescaledb: $TSDB" || bad "timescaledb kengaytmasi yo'q"
  HT="$(q "SELECT count(*) FROM timescaledb_information.hypertables")"
  [ "${HT:-0}" -gt 0 ] && ok "hypertable'lar: $HT" || bad "hypertable yo'q"
  cmp_manifest "migrations" "$(q 'SELECT count(*) FROM migrations')" migrations
  for t in sessions token_usage devices commands; do cmp_manifest "rows.$t" "$(q "SELECT count(*) FROM $t")" "rows.$t"; done
  # app ishga tushgach audit yozuvlari qo'shilishi mumkin
  cmp_manifest "rows.audit_log" "$(q 'SELECT count(*) FROM audit_log')" rows.audit_log ge
fi

# 4. Secrets volume
if [ -n "$APP_CID" ]; then
  VOL="$(container_volume "$APP_CID" /var/lib/commander-secrets)"
  MODES="$(docker run --rm -v "$VOL":/v:ro "$CMDR_TOOLBOX_IMAGE" sh -c 'cd /v && stat -c "%a %n" *' 2>/dev/null)"
  for k in command-signing.key queue-prompt.key; do
    m="$(echo "$MODES" | awk -v k="$k" '$2==k{print $1}')"
    if [ -z "$m" ] && [ "$k" = command-signing.key ] && center_uses_signer "$APP_CID"; then warn "$k volume'da yo'q: kalit imzolovchida (Keychain), fingerprint quyida tekshiriladi"; continue; fi
    if [ -z "$m" ]; then bad "$k yo'q"; continue; fi
    [ "$m" = 600 ] || warn "$k rejimi $m (0600 kutilgan)"
    h="$(volume_checksums "$VOL" | awk -v k="./$k" '$2==k{print $1}')"
    want="$(manifest "secret.$k")"
    if [ -z "$want" ]; then ok "$k: bor, sha256 ${h:0:16}…"
    elif [ "$h" = "$want" ]; then ok "$k: sha256 ${h:0:16}… (manifest bilan mos)"
    else bad "$k: sha256 mos emas"; fi
  done

  # 5. Kalit fingerprint va audit zanjiri (CLI, faqat o'qiydi)
  FP="$(dc exec -T app node dist/cli.js center-key show --json 2>/dev/null | sed -n 's/.*"fingerprint":"\([^"]*\)".*/\1/p')"
  [ -n "$FP" ] && cmp_manifest "center-key fingerprint" "$FP" center_key_fingerprint || bad "center-key show ishlamadi"
  AUDIT="$(dc exec -T app node dist/cli.js audit verify 2>&1 | tail -1)"
  echo "$AUDIT" | grep -q '^OK' && ok "audit zanjiri: $AUDIT" || bad "audit zanjiri: $AUDIT"
fi

# 6. Konfiguratsiya (qiymatlar chop etilmaydi)
[ -n "$(env_val AUTH_TOKEN)" ] && warn "AUTH_TOKEN .env'da qolgan: M-10 bo'yicha ishlatilmaydi, o'chirib tashlang" || ok "AUTH_TOKEN yo'q (legacy yo'l olib tashlangan)"
PGP="$(env_val POSTGRES_PASSWORD)"
if [ -z "$PGP" ]; then bad "POSTGRES_PASSWORD bo'sh"; elif [ "$PGP" = commander ]; then warn "POSTGRES_PASSWORD standart qiymatda"; else ok "POSTGRES_PASSWORD o'rnatilgan"; fi
[ "$(file_mode "$ENV_FILE")" = 600 ] && ok ".env rejimi 0600" || warn ".env rejimi $(file_mode "$ENV_FILE") (0600 tavsiya)"
[ -n "$(env_val TELEGRAM_BOT_TOKEN)" ] && echo "  Telegram bot: yoqilgan (manba center'dagi bot to'xtatilganiga ishonch hosil qiling)" || echo "  Telegram bot: o'chiq"

echo ""
echo "Qo'lda qoladigan qadamlar:"
echo "  - agentd'lar yangi markazga ulanishi: CENTER_PUBLIC_URL/agentd config'dagi nom endi shu mashinaga olib kelishi kerak"
echo "    (docs/infra/center-migration.md §2: MagicDNS nomi mashinaga bog'liq; ko'chirishda agentd config yangilanadi"
echo "     yoki Tailscale Services nomi ishlatiladi). Keyin: dashboard'da mashinalar 'online' ekanini tekshiring."
echo "  - Telegram: faqat bitta center'da token bo'lsin."

echo ""
log "=== Natija: $PASS o'tdi, $FAIL yiqildi, $WARN ogohlantirish ==="
[ "$FAIL" = 0 ]
