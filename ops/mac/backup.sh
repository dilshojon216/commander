#!/bin/bash
# Commander backup script for Mac
# Uses docker compose to dump PostgreSQL/TimescaleDB database to ~/commander-backups/
# Retention: 14 days. Logs to ~/Library/Logs/commander/backup.log
#
# TimescaleDB: oddiy `pg_dump --format=custom` yetarli (kengaytma, hypertable'lar va
# continuous aggregate'lar dump'ga tushadi). Tiklashda esa timescaledb_pre_restore() /
# post_restore() kerak: restore.sh buni o'zi qiladi. pg_dump "circular foreign-key
# constraints" haqida ogohlantirishi mumkin (timescaledb katalogi), bu zararsiz.

set -e
set -o pipefail   # pg_dump xatosi gzip orqasida yashirinib qolmasin

# launchd minimal PATH beradi (/usr/bin:/bin:...): docker (/usr/local/bin) topilmasa tungi zaxira
# "container not running" deb yiqiladi (2026-11-14 03:30 hodisasi)
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

LOG_FILE=~/Library/Logs/commander/backup.log
BACKUP_DIR=~/commander-backups
TIMESTAMP_FILE=$BACKUP_DIR/.last-success-ts
RETENTION_DAYS=14

# Dump'lar sir saqlashi mumkin (prompt parchalari, tokenlar xeshi): faqat egasi o'qiydi (0600/0700)
umask 077

# Ensure backup/log directories exist
mkdir -p "$BACKUP_DIR" "$(dirname "$LOG_FILE")"
chmod 700 "$BACKUP_DIR"

# Log function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Backup started ==="

cd "$(cd "$(dirname "$0")/../../apps/center" && pwd)"

# Verify docker compose is running
if ! docker compose ps db 2>/dev/null | grep -q "Up"; then
  log "ERROR: Database container not running (docker compose ps db)"
  exit 1
fi

BACKUP_FILE="$BACKUP_DIR/commander-$(date +%Y%m%d-%H%M%S).sql.gz"

# Dump database via docker compose, compress on the fly
if docker compose exec -T db pg_dump \
  --username=commander \
  --format=custom \
  commander | gzip > "$BACKUP_FILE"; then

  # Dump butunligini tekshirish: pg_restore o'qiy olishi va jadvallar ro'yxati bo'sh emasligi
  # `docker compose exec -T` stdin'ni ba'zan bo'sh uzatadi ("input file is too short (read 0)", 2026-11-14) — 3 marta urinamiz
  # stdin quvuri o'rniga fayl: konteynerga nusxa (`docker compose cp`) va pg_restore faylni o'qiydi — stdin bo'sh kelish muammosi yo'q
  verify_dump() {
    local tmp="/tmp/verify-$$.dump"
    gunzip -c "$BACKUP_FILE" > "$BACKUP_DIR/.verify-$$.dump" || return 1
    docker compose cp "$BACKUP_DIR/.verify-$$.dump" "db:$tmp" >/dev/null 2>&1 || { rm -f "$BACKUP_DIR/.verify-$$.dump"; return 1; }
    rm -f "$BACKUP_DIR/.verify-$$.dump"
    local rc=0
    docker compose exec -T db pg_restore --list "$tmp" > /dev/null || rc=1
    docker compose exec -T db rm -f "$tmp" >/dev/null 2>&1 || true
    return $rc
  }
  verified=0
  for attempt in 1 2 3; do
    if verify_dump; then verified=1; break; fi
    log "WARN: dump verification attempt $attempt failed, retrying"
    sleep 2
  done
  if [ "$verified" != 1 ]; then
    log "ERROR: dump verification failed (pg_restore --list): $BACKUP_FILE"
    rm -f "$BACKUP_FILE"
    exit 1
  fi

  chmod 600 "$BACKUP_FILE"
  FILE_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  log "✓ Backup created: $BACKUP_FILE (size: $FILE_SIZE)"

  # Write success timestamp
  date +%s > "$TIMESTAMP_FILE"
  log "✓ Success timestamp written to $TIMESTAMP_FILE"

  # Markazga xabar (5.5): settings['backup.last_success'] -> center "zaxira 26 soatdan eski" ogohlantirishini shundan hisoblaydi.
  # Konteynerga fayl ulash kerak emas va Ubuntu'ga ko'chganda ham ishlaydi. Xato zaxirani yiqitmaydi (faqat ogohlantirish).
  BACKUP_BYTES=$(wc -c < "$BACKUP_FILE" | tr -d ' ')
  if docker compose exec -T db psql -U commander -d commander -q -v ON_ERROR_STOP=1 -c \
    "INSERT INTO settings (key, value, updated_at) VALUES ('backup.last_success', jsonb_build_object('ts', $(cat "$TIMESTAMP_FILE"), 'bytes', $BACKUP_BYTES), now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()" > /dev/null 2>&1; then
    log "✓ Backup heartbeat recorded in center DB (settings backup.last_success)"
  else
    log "WARN: could not record backup heartbeat in center DB (center health will warn after 26h)"
  fi
else
  log "ERROR: pg_dump failed"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Rotate old backups (>14 days)
log "Rotating backups older than $RETENTION_DAYS days..."
OLD_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name "commander-*.sql.gz" -mtime +$RETENTION_DAYS 2>/dev/null | wc -l)
find "$BACKUP_DIR" -maxdepth 1 -name "commander-*.sql.gz" -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
if [ "$OLD_COUNT" -gt 0 ]; then
  log "✓ Deleted $OLD_COUNT old backup(s)"
fi

# Show current backups
CURRENT_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name "commander-*.sql.gz" 2>/dev/null | wc -l)
log "✓ Current backups: $CURRENT_COUNT"

log "=== Backup completed successfully ==="
