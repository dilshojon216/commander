#!/bin/bash
# Commander Center importi (target mashinada): export-center.sh natijasidan DB, center_secrets va .env'ni tiklaydi.
#
# Foydalanish:
#   bash ops/migrate/import-center.sh --export-dir DIR [--project NAME] [--compose-file FILE]
#                                     [--env-file DEST] [--passphrase-file FILE] [--port N] [--db-only] [--force]
#   --export-dir    eksport katalogi (default: joriy katalog)
#   --project       compose loyiha nomi (default: commander)
#   --compose-file  default: apps/center/docker-compose.yml (app image'i build qilinadi yoki `image:` bo'lsa ishlatiladi)
#   --env-file      ochilgan .env shu yerga 0600 bilan yoziladi (default: compose fayl yonidagi .env; mavjud bo'lsa --force kerak)
#   --passphrase-file  0600 fayl. Berilmasa terminaldan so'raladi. Passphrase HECH QACHON argument emas.
#   --port N        .env'dagi PORT (host port, 127.0.0.1:N -> 4317) ni almashtirish (masalan sinov uchun)
#   --db-only       DB va secrets'ni tiklaydi, app'ni ishga tushirmaydi
#   --force         loyihaning mavjud konteyner/volume'lari yoki mavjud .env ustidan yozishga ruxsat
#
# Ochiq sirlar diskka yozilmaydi (faqat o'rnatilgan .env): secrets.tar.enc -> openssl -> tar oqimi volume ichiga.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_DIR/ops/migrate/lib.sh"

EXPORT_DIR="$(pwd)"
PROJECT="commander"
COMPOSE_FILE="$REPO_DIR/apps/center/docker-compose.yml"
ENV_DEST=""
PASSPHRASE_FILE=""
PASSPHRASE=""
PORT_OVERRIDE=""
DB_ONLY=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --export-dir) EXPORT_DIR="${2:?--export-dir DIR}"; shift ;;
    --project) PROJECT="${2:?--project NAME}"; shift ;;
    --compose-file) COMPOSE_FILE="${2:?--compose-file FILE}"; shift ;;
    --env-file) ENV_DEST="${2:?--env-file DEST}"; shift ;;
    --passphrase-file) PASSPHRASE_FILE="${2:?--passphrase-file FILE}"; shift ;;
    --port) PORT_OVERRIDE="${2:?--port N}"; shift ;;
    --db-only) DB_ONLY=1 ;;
    --force) FORCE=1 ;;
    --passphrase|--passphrase=*) die "--passphrase qo'llanmaydi (argv'da sir). --passphrase-file ishlating" ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "noma'lum parametr: $1" ;;
  esac
  shift
done

umask 077
EXPORT_DIR="$(cd "$EXPORT_DIR" && pwd)" || die "eksport katalogi topilmadi"
[ -f "$COMPOSE_FILE" ] || die "compose fayl topilmadi: $COMPOSE_FILE"
[ -n "$ENV_DEST" ] || ENV_DEST="$(dirname "$COMPOSE_FILE")/.env"
[ -z "$PORT_OVERRIDE" ] || [[ "$PORT_OVERRIDE" =~ ^[0-9]+$ ]] || die "--port raqam bo'lishi kerak"
for f in db.sql.gz secrets.tar.enc env.enc manifest.txt checksums.txt; do
  [ -f "$EXPORT_DIR/$f" ] || die "eksportda $f yo'q ($EXPORT_DIR)"
done

T_START=$(date +%s)
log "=== Commander Center importi ==="
log "Eksport: $EXPORT_DIR | loyiha: $PROJECT | compose: $COMPOSE_FILE | .env -> $ENV_DEST"

# 1. Checksumlar (mos kelmasa — to'xtaymiz)
(cd "$EXPORT_DIR" && sha256_check checksums.txt >/dev/null) || die "checksum mos emas: fayllar buzilgan yoki o'zgartirilgan"
log "✓ checksumlar mos"

# 2. Xavfsizlik: mavjud deploy'ni bilmasdan ustidan yozmaslik
EXISTING_CT="$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT")"
EXISTING_VOL="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
if [ -n "$EXISTING_CT$EXISTING_VOL" ] && [ "$FORCE" != 1 ]; then
  die "'$PROJECT' loyihasida konteyner/volume'lar bor. Ustidan yozish uchun --force (avval zaxira oling!)"
fi
if [ -e "$ENV_DEST" ] && [ "$FORCE" != 1 ]; then die "$ENV_DEST mavjud. Ustidan yozish uchun --force"; fi

# 3. Passphrase va .env
if [ -n "$PASSPHRASE_FILE" ]; then read_passphrase_file "$PASSPHRASE_FILE"; else prompt_passphrase 0; fi
require_openssl
TMP_ENV="$(mktemp "$(dirname "$ENV_DEST")/.env.import.XXXXXX")"
trap 'rm -f "$TMP_ENV"' EXIT
decrypt_stream -in "$EXPORT_DIR/env.enc" -out "$TMP_ENV" 2>/dev/null || die "env.enc ochilmadi (passphrase noto'g'ri?)"
if [ -n "$PORT_OVERRIDE" ]; then
  if grep -q '^PORT=' "$TMP_ENV"; then sed -i.bak "s/^PORT=.*/PORT=$PORT_OVERRIDE/" "$TMP_ENV" && rm -f "$TMP_ENV.bak"
  else echo "PORT=$PORT_OVERRIDE" >> "$TMP_ENV"; fi
fi
chmod 600 "$TMP_ENV"; mv -f "$TMP_ENV" "$ENV_DEST"; trap - EXIT
log "✓ .env o'rnatildi (0600, $(grep -c '^[A-Z_][A-Z0-9_]*=' "$ENV_DEST") kalit)${PORT_OVERRIDE:+, PORT=$PORT_OVERRIDE}"
if grep -q '^TELEGRAM_BOT_TOKEN=..*' "$ENV_DEST"; then
  log "DIQQAT: TELEGRAM_BOT_TOKEN o'rnatilgan. Manba center hali ishlayotgan bo'lsa ikki poller to'qnashadi (409):"
  log "        avval manbani to'xtating yoki bu yerda tokenni bo'shating."
fi

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_DEST" "$@"; }
manifest() { sed -n "s/^$1=//p" "$EXPORT_DIR/manifest.txt"; }

wait_healthy() {  # $1=container, $2=soniya
  local i s
  for i in $(seq 1 "$2"); do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true)"
    [ "$s" = healthy ] && return 0
    sleep 1
  done
  log "konteyner $1 holati: ${s:-?}"; return 1
}

# 4. Konteyner va volume'larni compose orqali yaratish (to'g'ri label'lar bilan)
if [ "$FORCE" = 1 ] && [ -n "$EXISTING_CT" ]; then dc down >/dev/null 2>&1 || true; fi
dc create >/dev/null 2>&1 || dc create
APP_CID="$(dc ps -a -q app)"
SECRETS_VOL="$(container_volume "$APP_CID" /var/lib/commander-secrets)"
[ -n "$SECRETS_VOL" ] || die "app konteynerida secrets volume'i yo'q"

# 5. Secrets: shifrlangan oqim -> volume ichida tar -x (ochiq nusxa host diskiga tushmaydi)
decrypt_stream -in "$EXPORT_DIR/secrets.tar.enc" \
  | docker run --rm -i -v "$SECRETS_VOL":/v "$CMDR_TOOLBOX_IMAGE" sh -c 'find /v -mindepth 1 -delete && tar -xpf - -C /v' \
  || die "secrets tiklanmadi (passphrase noto'g'ri?)"
BAD=0
while read -r h f; do
  want="$(manifest "secret.${f#./}")"
  if [ "$h" = "$want" ]; then log "✓ ${f#./}: sha256 ${h:0:16}… mos"; else log "✗ ${f#./}: sha256 mos emas"; BAD=1; fi
done < <(volume_checksums "$SECRETS_VOL")
[ "$BAD" = 0 ] || die "secrets checksum mos emas"
log "✓ secrets volume tiklandi: $SECRETS_VOL"

# 6. DB: compose db (.env'dagi POSTGRES_PASSWORD bilan initdb) + restore.sh (TimescaleDB pre/post_restore)
dc up -d db >/dev/null 2>&1
DB_CID="$(dc ps -q db)"
wait_healthy "$DB_CID" 120 || die "db sog'lom bo'lmadi"
T_DB=$(date +%s)
bash "$REPO_DIR/ops/mac/restore.sh" "$EXPORT_DIR/db.sql.gz" --confirm --container "$DB_CID" | sed 's/^/  /'
log "✓ DB tiklandi ($(( $(date +%s) - T_DB )) s)"

psql_q() { docker exec "$DB_CID" psql -U commander -d commander -At -c "$1"; }
MIG="$(psql_q 'SELECT count(*) FROM migrations')"
[ "$MIG" = "$(manifest migrations)" ] || die "migrations soni mos emas: $MIG != $(manifest migrations)"
for t in sessions token_usage devices audit_log commands; do
  n="$(psql_q "SELECT count(*) FROM $t")"
  [ "$n" = "$(manifest "rows.$t")" ] || die "$t qatorlari mos emas: $n != $(manifest "rows.$t")"
done
log "✓ migrations=$MIG, qator sonlari manifest bilan mos"

# 7. App
if [ "$DB_ONLY" = 0 ]; then
  T_APP=$(date +%s)
  dc up -d >/dev/null 2>&1 || dc up -d
  wait_healthy "$APP_CID" 180 || die "app sog'lom bo'lmadi: docker compose -p $PROJECT logs app"
  log "✓ app sog'lom ($(( $(date +%s) - T_APP )) s)"
else
  log "--db-only: app ishga tushirilmadi"
fi

log "=== Import tugadi ($(( $(date +%s) - T_START )) s) ==="
log "Keyingi qadam:"
log "  bash ops/migrate/verify-center.sh --project $PROJECT --compose-file $COMPOSE_FILE --env-file $ENV_DEST --export-dir $EXPORT_DIR"
