#!/bin/bash
# Commander zaxiralarini off-site'ga nusxalash (Mac -> boshqa mashina yoki lokal disk).
# DB dump'lari jo'natishdan OLDIN shifrlanadi (ochiq dump hech qachon off-site'ga chiqmaydi);
# center-secrets-*.tar.enc allaqachon shifrlangan (backup-secrets.sh).
#
# Foydalanish:
#   bash ops/mac/backup-offsite.sh <user@host | /mutlaq/lokal/yo'l> [--passphrase-file FILE] [--dry-run] [--rotation-days N]
#   user@host   -> rsync over SSH (BatchMode, StrictHostKeyChecking=accept-new), manzil ~/backups/commander/
#   /yo'l       -> lokal katalog (masalan tashqi disk yoki tarmoq diski mount'i)
#   --passphrase-file  0600 fayl (default: ~/.commander/backup.pass, bo'lsa). Yo'q bo'lsa terminaldan so'raladi.
#                      backup-secrets.sh bilan bir xil passphrase ishlatish mumkin.
#   --dry-run   shifrlash vaqtinchalik katalogda, rsync --dry-run, hech narsa o'chirilmaydi
#
# Off-site'da hech narsa avtomatik `--delete` bilan o'chirilmaydi: faqat --rotation-days (default 30) dan eskilar.
# Tiklash: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:PASSFILE -in X.sql.gz.enc -out X.sql.gz
#          bash ops/mac/restore.sh X.sql.gz --confirm

set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../migrate/lib.sh
source "$REPO_DIR/ops/migrate/lib.sh"

SOURCE="${CMDR_BACKUP_DIR:-$HOME/commander-backups}"
TARGET="${1:-}"
[ -n "$TARGET" ] && [ "${TARGET#-}" = "$TARGET" ] || die "Foydalanish: $0 <user@host | /lokal/yo'l> [--passphrase-file FILE] [--dry-run] [--rotation-days N]"
shift
DRY_RUN=0
ROTATION_DAYS=30
PASSPHRASE_FILE=""
PASSPHRASE=""
[ -f "$HOME/.commander/backup.pass" ] && PASSPHRASE_FILE="$HOME/.commander/backup.pass"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rotation-days) ROTATION_DAYS="${2:?}"; shift ;;
    --passphrase-file) PASSPHRASE_FILE="${2:?}"; shift ;;
    --passphrase|--passphrase=*) die "--passphrase qo'llanmaydi; --passphrase-file ishlating" ;;
    *) die "noma'lum parametr: $1" ;;
  esac
  shift
done
[[ "$ROTATION_DAYS" =~ ^[0-9]+$ ]] || die "--rotation-days raqam bo'lishi kerak"
DRY_TAG=""; [ "$DRY_RUN" = 1 ] && DRY_TAG=" (DRY-RUN)"

umask 077
if [ -n "$PASSPHRASE_FILE" ]; then read_passphrase_file "$PASSPHRASE_FILE"; else prompt_passphrase 1; fi
require_openssl

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
if [ "${TARGET#/}" != "$TARGET" ]; then
  MODE=local; DEST="'$TARGET'"   # sh -c buyruqlari uchun qo'shtirnoqda
  remote() { sh -c "$1"; }
  mkdir -p "$TARGET" || die "$TARGET yaratilmadi"; chmod 700 "$TARGET"
  RSYNC_DEST="$TARGET/"
else
  MODE=ssh; DEST='~/backups/commander'
  remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$1"; }
  remote "mkdir -p $DEST && chmod 700 $DEST" >/dev/null 2>&1 || die "SSH ulanmadi: $TARGET (ssh-copy-id va BatchMode'ni tekshiring)"
  RSYNC_DEST="$TARGET:backups/commander/"
fi

log "=== Off-site nusxa: $SOURCE -> $TARGET ($MODE), rotatsiya $ROTATION_DAYS kun$DRY_TAG ==="

# 1. Staging: dump'larni shifrlash (keshlanadi; mtime manbadan ko'chiriladi, rotatsiya to'g'ri ishlashi uchun)
if [ "$DRY_RUN" = 1 ]; then STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT; else STAGE="$SOURCE/offsite"; fi
mkdir -p "$STAGE"; chmod 700 "$STAGE"
NEW=0
for f in "$SOURCE"/commander-*.sql.gz; do
  [ -f "$f" ] || continue
  out="$STAGE/$(basename "$f").enc"
  [ -s "$out" ] && [ ! "$out" -ot "$f" ] && continue   # mtime manbadan ko'chirilgan: teng = tayyor
  encrypt_stream -in "$f" -out "$out.partial" && mv "$out.partial" "$out"
  touch -r "$f" "$out"; NEW=$((NEW + 1))
done
for f in "$SOURCE"/center-secrets-*.tar.enc; do
  [ -f "$f" ] || continue
  [ -f "$STAGE/$(basename "$f")" ] || { cp -p "$f" "$STAGE/"; NEW=$((NEW + 1)); }
done
# Lokal rotatsiyada o'chgan dump'larning staging nusxasini ham olib tashlash (off-site'da esa qoladi)
for e in "$STAGE"/commander-*.sql.gz.enc; do
  [ -f "$e" ] || continue
  [ -f "$SOURCE/$(basename "$e" .enc)" ] || rm -f "$e"
done
chmod 600 "$STAGE"/* 2>/dev/null || true
COUNT="$(find "$STAGE" -maxdepth 1 -type f | wc -l | tr -d ' ')"
[ "$COUNT" -gt 0 ] || die "nusxalanadigan zaxira yo'q ($SOURCE)"
PLAIN="$(find "$STAGE" -maxdepth 1 -type f ! -name '*.enc' | wc -l | tr -d ' ')"
[ "$PLAIN" = 0 ] || die "staging'da shifrlanmagan fayl bor — to'xtatildi"
log "✓ staging: $COUNT shifrlangan fayl ($NEW yangi/yangilangan)"

# 2. rsync (--delete YO'Q: lokal fayl o'chsa ham off-site nusxa qoladi). Rejimlar staging'dan (-a): 0600/0700;
#    --chmod ishlatilmaydi: macOS openrsync uni qo'llamaydi.
RSYNC_OPTS=(-a --itemize-changes --include='*.enc' --exclude='*')
[ "$MODE" = ssh ] && RSYNC_OPTS+=(-e "ssh ${SSH_OPTS[*]}")
[ "$DRY_RUN" = 1 ] && RSYNC_OPTS+=(--dry-run)
CHANGES="$(rsync "${RSYNC_OPTS[@]}" "$STAGE/" "$RSYNC_DEST")" || die "rsync xatosi"
log "✓ rsync: $(echo -n "$CHANGES" | grep -c '^[<>c]f' || true) fayl uzatildi$DRY_TAG"

# 3. Off-site rotatsiya
FIND_OLD="find $DEST -maxdepth 1 \\( -name 'commander-*.sql.gz.enc' -o -name 'center-secrets-*.tar.enc' \\) -mtime +$ROTATION_DAYS"
if [ "$DRY_RUN" = 1 ]; then
  OLD="$(remote "$FIND_OLD" 2>/dev/null | wc -l | tr -d ' ')"
  log "[dry-run] $ROTATION_DAYS kundan eski $OLD fayl o'chirilardi"
else
  remote "$FIND_OLD -delete" >/dev/null 2>&1 || log "WARNING: off-site rotatsiya bajarilmadi"
  log "✓ off-site'da: $(remote "find $DEST -maxdepth 1 -name '*.enc' | wc -l" | tr -d ' ') shifrlangan fayl"
fi
log "=== Tayyor ==="
