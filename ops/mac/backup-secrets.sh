#!/bin/bash
# Commander center_secrets zaxirasi (shifrlangan): queue-prompt.key va (imzolovchi o'rnatilmagan bo'lsa) command-signing.key.
# Imzolovchi (5.7) rejimida imzo kaliti Keychain'da: uning zaxirasi alohida, egasi ishga tushiradi: ops/mac/signer-backup.sh.
# Bu kalitlar yo'qolsa: barcha agentd qayta pin qilinadi, navbatdagi shifrlangan promptlar o'qilmaydi.
# backup.sh faqat DB'ni oladi; bu skript alohida ishlatiladi. Natijani oflayn/alohida joyda saqlang.
#
# Foydalanish:
#   bash ops/mac/backup-secrets.sh [--passphrase-file FILE] [--output-dir DIR] [--project NAME] [--compose-file FILE] [--volume NAME]
#   bash ops/mac/backup-secrets.sh --verify FILE.tar.enc [--passphrase-file FILE] [...]
#     --verify: zaxirani ochib, ichidagi fayllar sha256'ini joriy volume bilan solishtiradi (ochiq nusxa diskka tushmaydi).
#   Passphrase: --passphrase-file (0600) yoki terminaldan (2 marta). HECH QACHON argument emas.
#   Manba volume: --volume, aks holda compose `app` konteyneridagi /var/lib/commander-secrets volume'i (faqat o'qish).
#
# Tiklash (ochiq nusxa diskka yozilmaydi):
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:PASSFILE -in center-secrets-X.tar.enc \
#     | docker run --rm -i -v commander_center_secrets:/v timescale/timescaledb:2.32.0-pg16 tar -xpf - -C /v
#   (yoki to'liq ko'chirish uchun: ops/migrate/import-center.sh)

set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../migrate/lib.sh
source "$REPO_DIR/ops/migrate/lib.sh"

OUT_DIR="$HOME/commander-backups"
PROJECT="commander"
COMPOSE_FILE="$REPO_DIR/apps/center/docker-compose.yml"
VOLUME=""
PASSPHRASE_FILE=""
PASSPHRASE=""
VERIFY=""
RETENTION_DAYS=30

while [ $# -gt 0 ]; do
  case "$1" in
    --passphrase-file) PASSPHRASE_FILE="${2:?}"; shift ;;
    --output-dir) OUT_DIR="${2:?}"; shift ;;
    --project) PROJECT="${2:?}"; shift ;;
    --compose-file) COMPOSE_FILE="${2:?}"; shift ;;
    --volume) VOLUME="${2:?}"; shift ;;
    --verify) VERIFY="${2:?}"; shift ;;
    --passphrase|--passphrase=*|--no-encrypt) die "$1 qo'llanmaydi (sir argv'da yoki ochiq kalitlar diskda)" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "noma'lum parametr: $1" ;;
  esac
  shift
done

umask 077
if [ -z "$VOLUME" ]; then
  APP_CID="$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -a -q app 2>/dev/null || true)"
  [ -n "$APP_CID" ] || die "'$PROJECT' loyihasida app konteyneri topilmadi (--volume NAME bering)"
  VOLUME="$(container_volume "$APP_CID" /var/lib/commander-secrets)"
fi
docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "volume topilmadi: $VOLUME"

if [ -n "$PASSPHRASE_FILE" ]; then read_passphrase_file "$PASSPHRASE_FILE"; else prompt_passphrase "$([ -z "$VERIFY" ] && echo 1 || echo 0)"; fi
require_openssl

LIVE="$(volume_checksums "$VOLUME")"
[ -n "$LIVE" ] || die "volume bo'sh: $VOLUME"
# 5.7 (H-02): imzo kaliti Keychain'ga ko'chirilgan va volume'dan olib tashlangan bo'lsa u bu zaxirada BO'LMAYDI (DR: signer-backup.sh).
if ! echo "$LIVE" | grep -q 'command-signing.key$'; then
  APP_CID_CHK="${APP_CID:-$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -a -q app 2>/dev/null || true)}"
  if [ -n "$APP_CID_CHK" ] && docker inspect "$APP_CID_CHK" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^SIGNER_SOCKET=.'; then
    log "OGOHLANTIRISH: volume'da command-signing.key yo'q (kalit imzolovchida, Keychain). Uning zaxirasi: bash ops/mac/signer-backup.sh"
  else
    die "volume'da command-signing.key yo'q: $VOLUME"
  fi
fi
echo "$LIVE" | grep -q 'queue-prompt.key$' || log "OGOHLANTIRISH: volume'da queue-prompt.key yo'q (hali navbatga prompt qo'yilmagan bo'lishi mumkin)"

# Zaxirani ochib, fayllar sha256'ini volume bilan solishtirish (ochiq nusxa faqat konteyner xotirasida)
verify_backup() {
  local got
  got="$(decrypt_stream -in "$1" | docker run --rm -i "$CMDR_TOOLBOX_IMAGE" sh -c \
    'mkdir -p /tmp/x && tar -xf - -C /tmp/x && cd /tmp/x && find . -type f | sort | xargs -r sha256sum')" || return 1
  [ -n "$got" ] && [ "$got" = "$LIVE" ]
}

if [ -n "$VERIFY" ]; then
  [ -s "$VERIFY" ] || die "zaxira fayli bo'sh yoki yo'q: $VERIFY"
  if verify_backup "$VERIFY"; then
    log "✓ $VERIFY: ochildi, $(echo "$LIVE" | wc -l | tr -d ' ') fayl sha256 volume ($VOLUME) bilan mos"
    exit 0
  fi
  die "$VERIFY: ochilmadi yoki volume bilan mos emas (passphrase noto'g'ri yoki kalitlar o'zgargan)"
fi

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/center-secrets-$TS.tar.enc"
log "=== center_secrets zaxirasi: $VOLUME -> $OUT ==="

# Volume faqat o'qish uchun ulanadi; tar oqimi to'g'ridan-to'g'ri shifrlanadi (ochiq tar diskka yozilmaydi)
docker run --rm -v "$VOLUME":/v:ro "$CMDR_TOOLBOX_IMAGE" tar -cf - -C /v . | encrypt_stream -out "$OUT.partial"
[ -s "$OUT.partial" ] || { rm -f "$OUT.partial"; die "shifrlangan fayl bo'sh"; }
if ! verify_backup "$OUT.partial"; then rm -f "$OUT.partial"; die "yaratilgan zaxira qayta ochib tekshirilmadi"; fi
mv "$OUT.partial" "$OUT"; chmod 600 "$OUT"
(cd "$OUT_DIR" && sha256_file "$(basename "$OUT")" > "center-secrets-$TS.sha256" && chmod 600 "center-secrets-$TS.sha256")
log "✓ $(basename "$OUT"): $(wc -c < "$OUT" | tr -d ' ') bayt, $(echo "$LIVE" | wc -l | tr -d ' ') fayl, qayta ochib tekshirildi"

# Rotatsiya: kalitlar kam o'zgaradi, lekin eski zaxiralar ham ishlaydi; $RETENTION_DAYS kundan eskilari o'chiriladi
find "$OUT_DIR" -maxdepth 1 \( -name 'center-secrets-*.tar.enc' -o -name 'center-secrets-*.sha256' \) -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
log "✓ joriy secrets zaxiralari: $(find "$OUT_DIR" -maxdepth 1 -name 'center-secrets-*.tar.enc' | wc -l | tr -d ' ')"
log "Passphrase'ni parol menejerida saqlang: usiz zaxira foydasiz."
