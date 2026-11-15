#!/bin/bash
# Commander restore script for Mac (PostgreSQL 16 + TimescaleDB)
# Restores a dump made by backup.sh. WARNING: DROPS and recreates the `commander` database.
#
# Usage: ./restore.sh <backup-file.sql.gz> [--confirm] [--container NAME]
#   (default target: compose'dagi `db` servisi; restore vaqtida `app` to'xtatiladi
#    va oldin ishlayotgan bo'lsa qayta ishga tushiriladi)
#   --container NAME: istalgan TimescaleDB konteyneriga (masalan bir xil image'dan
#                     throwaway sinov konteyneri) tiklaydi; compose'ga tegilmaydi.
#
# TimescaleDB tiklash tartibi (rasmiy):
#   1. bo'sh baza yaratish + CREATE EXTENSION timescaledb
#   2. SELECT timescaledb_pre_restore()
#   3. pg_restore (dump'dagi `EXTENSION timescaledb` yozuvlari ro'yxatdan chiqarib tashlanadi,
#      chunki kengaytma allaqachon yaratilgan)
#   4. SELECT timescaledb_post_restore()
# Dump TimescaleDB'siz eski (v0, postgres:16) bazadan bo'lsa ham shu tartib ishlaydi.
# Maqsadli image'dagi timescaledb versiyasi dump olingan versiyadan eski bo'lmasligi kerak.

set -e
set -o pipefail

BACKUP_FILE=""
CONFIRM_FLAG=""
CONTAINER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) CONFIRM_FLAG="--confirm" ;;
    --container) CONTAINER="${2:?--container needs a name}"; shift ;;
    *) BACKUP_FILE="$1" ;;
  esac
  shift
done

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup-file.sql.gz> [--confirm] [--container NAME]"
  echo ""
  echo "Available backups:"
  /bin/ls -lh ~/commander-backups/commander-*.sql.gz 2>/dev/null || echo "  (none)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "=========================================="
echo "WARNING: This will DROP and recreate the 'commander' database!"
echo "=========================================="
echo "Backup file: $BACKUP_FILE"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"
echo "Target: ${CONTAINER:-compose db service}"
echo ""

# Dry-run mode (default)
if [ "$CONFIRM_FLAG" != "--confirm" ]; then
  echo "DRY-RUN MODE: Would restore from this backup"
  echo "Run with --confirm to actually restore:"
  echo "  $0 '$BACKUP_FILE' --confirm${CONTAINER:+ --container $CONTAINER}"
  exit 0
fi

COMPOSE_DIR="$(cd "$(dirname "$0")/../../apps/center" && pwd)"
if [ -n "$CONTAINER" ]; then
  TARGET="$CONTAINER"
  dx() { docker exec -i "$TARGET" "$@"; }
  APP_WAS_RUNNING=""
else
  cd "$COMPOSE_DIR"
  if ! docker compose ps db 2>/dev/null | grep -q "Up"; then
    echo "ERROR: Database container not running"
    exit 1
  fi
  TARGET="$(docker compose ps -q db)"
  dx() { docker exec -i "$TARGET" "$@"; }
  APP_WAS_RUNNING=""
  if docker compose ps app 2>/dev/null | grep -q "Up"; then
    APP_WAS_RUNNING=1
    echo "Stopping app..."
    docker compose stop app
  fi
fi

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  docker exec "$TARGET" rm -f /tmp/restore.dump /tmp/restore.list >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Preparing dump..."
gunzip -c "$BACKUP_FILE" > "$WORK/restore.dump"
docker cp "$WORK/restore.dump" "$TARGET:/tmp/restore.dump"
dx pg_restore --list /tmp/restore.dump \
  | grep -v -E 'EXTENSION - timescaledb|COMMENT - EXTENSION timescaledb' > "$WORK/restore.list"
docker cp "$WORK/restore.list" "$TARGET:/tmp/restore.list"

PSQL="psql -U commander -v ON_ERROR_STOP=1 -q"

echo "Recreating database..."
dx $PSQL -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'commander' AND pid <> pg_backend_pid()" > /dev/null
dx $PSQL -d postgres -c "DROP DATABASE IF EXISTS commander WITH (FORCE)"
dx $PSQL -d postgres -c "CREATE DATABASE commander"
dx $PSQL -d commander -c "CREATE EXTENSION IF NOT EXISTS timescaledb"

echo "Restoring database from $BACKUP_FILE..."
dx $PSQL -d commander -c "SELECT timescaledb_pre_restore()" > /dev/null
if dx pg_restore --username=commander --dbname=commander --no-owner --exit-on-error -L /tmp/restore.list /tmp/restore.dump; then
  RESTORE_OK=1
else
  RESTORE_OK=""
fi
# post_restore har holda chaqiriladi (restoring rejimi bazada qolib ketmasin)
dx $PSQL -d commander -c "SELECT timescaledb_post_restore()" > /dev/null

if [ -z "$RESTORE_OK" ]; then
  echo "ERROR: pg_restore failed"
  exit 1
fi
echo "✓ Restore completed successfully"

echo ""
echo "Verifying restored database..."
dx psql -U commander -d commander -At -c "SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema='public'"
dx psql -U commander -d commander -At -c "SELECT 'timescaledb=' || extversion FROM pg_extension WHERE extname='timescaledb'"
echo "✓ Database verification passed"

if [ -n "$APP_WAS_RUNNING" ]; then
  echo "Starting app..."
  (cd "$COMPOSE_DIR" && docker compose start app)
fi
