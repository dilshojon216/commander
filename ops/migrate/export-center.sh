#!/bin/bash
# Commander Center eksporti (ko'chirish / DR): DB dump + center_secrets volume + .env.
# Sirlar (.env, secrets) shifrlanadi; ochiq nusxa diskka umuman yozilmaydi (tar -> openssl oqimi).
#
# Foydalanish:
#   bash ops/migrate/export-center.sh [--output DIR] [--project NAME] [--compose-file FILE]
#                                     [--env-file FILE] [--passphrase-file FILE]
#   --project       compose loyiha nomi (default: commander)
#   --compose-file  default: apps/center/docker-compose.yml
#   --env-file      eksport qilinadigan .env (default: compose fayl yonidagi .env)
#   --passphrase-file  0600 fayl, birinchi qatori passphrase. Berilmasa terminaldan so'raladi (2 marta).
#                      Passphrase HECH QACHON argument sifatida berilmaydi.
#   --output        bo'sh yoki mavjud bo'lmagan katalog (default: ~/commander-export-<vaqt>, 0700)
#
# Natija (hammasi 0600): db.sql.gz, secrets.tar.enc, env.enc, manifest.txt, checksums.txt, EXPORT_INFO.txt
# Eksport vaqtida `app` to'xtatiladi (izchil dump) va oxirida (xato bo'lsa ham) qayta ishga tushiriladi.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_DIR/ops/migrate/lib.sh"

PROJECT="commander"
COMPOSE_FILE="$REPO_DIR/apps/center/docker-compose.yml"
ENV_FILE=""
OUT=""
PASSPHRASE_FILE=""
PASSPHRASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUT="${2:?--output DIR}"; shift ;;
    --project) PROJECT="${2:?--project NAME}"; shift ;;
    --compose-file) COMPOSE_FILE="${2:?--compose-file FILE}"; shift ;;
    --env-file) ENV_FILE="${2:?--env-file FILE}"; shift ;;
    --passphrase-file) PASSPHRASE_FILE="${2:?--passphrase-file FILE}"; shift ;;
    --passphrase|--passphrase=*) die "--passphrase qo'llanmaydi (argv'da sir). --passphrase-file ishlating" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "noma'lum parametr: $1" ;;
  esac
  shift
done

[ -f "$COMPOSE_FILE" ] || die "compose fayl topilmadi: $COMPOSE_FILE"
[ -n "$ENV_FILE" ] || ENV_FILE="$(dirname "$COMPOSE_FILE")/.env"
[ -f "$ENV_FILE" ] || die ".env topilmadi: $ENV_FILE (--env-file bering)"

if [ -n "$PASSPHRASE_FILE" ]; then read_passphrase_file "$PASSPHRASE_FILE"; else prompt_passphrase 1; fi
require_openssl

umask 077
[ -n "$OUT" ] || OUT="$HOME/commander-export-$(date +%Y%m%d-%H%M%S)"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then die "chiqish katalogi bo'sh emas: $OUT"; fi
mkdir -p "$OUT"; chmod 700 "$OUT"
OUT="$(cd "$OUT" && pwd)"

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_ro() { dc exec -T -e PGOPTIONS='-c default_transaction_read_only=on' db psql -U commander -d commander -At -c "$1"; }

T_START=$(date +%s)
log "=== Commander Center eksporti ==="
log "Loyiha: $PROJECT | compose: $COMPOSE_FILE | chiqish: $OUT"

DB_CID="$(dc ps -q db)"
[ -n "$DB_CID" ] && [ "$(docker inspect -f '{{.State.Running}}' "$DB_CID")" = true ] || die "db konteyneri ishlamayapti"
APP_CID="$(dc ps -a -q app)"
[ -n "$APP_CID" ] || die "app konteyneri topilmadi (secrets volume'ini aniqlash uchun kerak)"
SECRETS_VOL="$(container_volume "$APP_CID" /var/lib/commander-secrets)"
[ -n "$SECRETS_VOL" ] || die "app konteynerida /var/lib/commander-secrets volume'i yo'q"
log "✓ db ishlayapti; secrets volume: $SECRETS_VOL"

# 1. Kalit fingerprint'i (app ishlab turganida, CLI faqat o'qiydi)
APP_WAS_RUNNING=""
FINGERPRINT=""
if [ "$(docker inspect -f '{{.State.Running}}' "$APP_CID")" = true ]; then
  APP_WAS_RUNNING=1
  FINGERPRINT="$(dc exec -T app node dist/cli.js center-key show --json 2>/dev/null | sed -n 's/.*"fingerprint":"\([^"]*\)".*/\1/p' || true)"
fi
log "✓ center-key fingerprint: ${FINGERPRINT:-?}"

restart_app() {
  if [ -n "$APP_WAS_RUNNING" ]; then
    log "app qayta ishga tushirilmoqda..."
    dc start app >/dev/null 2>&1 || log "WARNING: app'ni qayta ishga tushirib bo'lmadi: docker compose -p $PROJECT start app"
  fi
}
trap restart_app EXIT

# 2. App'ni to'xtatish (dump izchil bo'lishi uchun)
if [ -n "$APP_WAS_RUNNING" ]; then
  T_STOP=$(date +%s)
  dc stop app >/dev/null 2>&1
  log "✓ app to'xtatildi"
fi

# 3. DB dump (pg_dump custom, backup.sh bilan bir xil format; restore.sh tiklay oladi)
dc exec -T db pg_dump --username=commander --format=custom commander | gzip > "$OUT/db.sql.gz"
OBJECTS="$(gunzip -c "$OUT/db.sql.gz" | dc exec -T db pg_restore --list | grep -c -v '^;' || true)"
[ "${OBJECTS:-0}" -gt 0 ] || die "dump tekshiruvi muvaffaqiyatsiz (pg_restore --list)"
log "✓ DB dump: $(du -h "$OUT/db.sql.gz" | cut -f1), $OBJECTS obyekt"

# 4. Manifest (sirlar yo'q: sanoqlar, versiyalar, fingerprint, kalit fayllar sha256)
{
  echo "created_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "source_host=$(hostname -s)"
  echo "source_project=$PROJECT"
  echo "timescaledb=$(psql_ro "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
  echo "migrations=$(psql_ro 'SELECT count(*) FROM migrations')"
  for t in sessions token_usage devices audit_log commands; do
    echo "rows.$t=$(psql_ro "SELECT count(*) FROM $t")"
  done
  echo "center_key_fingerprint=$FINGERPRINT"
  volume_checksums "$SECRETS_VOL" | while read -r h f; do echo "secret.${f#./}=$h"; done
} > "$OUT/manifest.txt"
if ! grep -q '^secret\.command-signing\.key=' "$OUT/manifest.txt"; then
  # 5.7: kalit imzolovchida (Keychain) bo'lsa volume'da bo'lmaydi. Target Mac bo'lsa: signer-backup.sh zaxirasi (commander-signer restore-backup).
  # Target Ubuntu bo'lsa (imzolovchi yo'q, fayl backend): kalit volume'da bo'lishi shart: --remove-volume-key ni bajarmang.
  center_uses_signer "$APP_CID" || die "secrets volume'da command-signing.key yo'q"
  log "OGOHLANTIRISH: command-signing.key volume'da yo'q (kalit imzolovchida, Keychain). Target'ga alohida ko'chiring: ops/mac/signer-backup.sh -> commander-signer restore-backup"
fi

# 5. Secrets: volume faqat o'qish uchun ulanadi, tar oqimi to'g'ridan-to'g'ri shifrlanadi
docker run --rm -v "$SECRETS_VOL":/v:ro "$CMDR_TOOLBOX_IMAGE" tar -cf - -C /v . | encrypt_stream -out "$OUT/secrets.tar.enc"
N_SECRETS="$(decrypt_stream -in "$OUT/secrets.tar.enc" | tar -tf - | grep -c -v '/$' || true)"
[ "${N_SECRETS:-0}" -ge 1 ] || die "secrets.tar.enc qayta ochib tekshirilmadi"
log "✓ secrets.tar.enc: $N_SECRETS fayl (shifrlangan, qayta ochib tekshirildi)"

# 6. .env (shifrlangan)
encrypt_stream -in "$ENV_FILE" -out "$OUT/env.enc"
ENV_KEYS="$(decrypt_stream -in "$OUT/env.enc" | grep -c '^[A-Z_][A-Z0-9_]*=' || true)"
log "✓ env.enc: $ENV_KEYS kalit (qiymatlar chiqarilmaydi)"

# 7. App'ni qayta ishga tushirish (downtime'ni qisqartirish uchun checksumlardan oldin)
trap - EXIT
restart_app
[ -n "${T_STOP:-}" ] && log "✓ app downtime: $(( $(date +%s) - T_STOP )) s"

# 8. Checksumlar va ma'lumot fayli
cat > "$OUT/EXPORT_INFO.txt" <<EOF
Commander Center eksporti: $(date -u '+%Y-%m-%d %H:%M:%S UTC'), manba: $(hostname -s), loyiha: $PROJECT

  db.sql.gz        pg_dump --format=custom | gzip (SHIFRLANMAGAN: faqat Tailscale/SSH orqali uzating)
  secrets.tar.enc  center_secrets volume (openssl aes-256-cbc, pbkdf2 600000, salt)
  env.enc          .env (xuddi shu shifr)
  manifest.txt     sanoqlar, fingerprint, kalit fayllar sha256 (import/verify solishtiradi)
  checksums.txt    sha256

Ko'chirish (katalog 0700, fayllar 0600 qoladi):
  rsync -a --chmod=D700,F600 <bu katalog>/ user@target:/opt/commander/import/
Target'da:
  bash ops/migrate/import-center.sh --export-dir /opt/commander/import --passphrase-file ~/.commander-pass
  bash ops/migrate/verify-center.sh --export-dir /opt/commander/import
EOF
(cd "$OUT" && sha256_file db.sql.gz secrets.tar.enc env.enc manifest.txt > checksums.txt)
chmod 600 "$OUT"/*

log "=== Eksport tayyor: $OUT ($(( $(date +%s) - T_START )) s) ==="
sed 's/^\([0-9a-f]\{16\}\)[0-9a-f]*/\1…/' "$OUT/checksums.txt"
grep -v '^secret\.' "$OUT/manifest.txt" | sed 's/^/  /'
