#!/bin/bash
# Barcha public jadvallardagi aniq qatorlar sonini chiqaradi (hypertable'lar ham).
# Usage: db-counts.sh            -> compose'dagi db servisi
#        db-counts.sh <container> -> istalgan konteyner (masalan restore sinovi uchun)
set -e
SQL="SELECT table_name || '=' || (xpath('/row/c/text()',
       query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name"
if [ -n "${1:-}" ]; then
  docker exec -i "$1" psql -U commander -d commander -At -c "$SQL"
else
  cd "$(cd "$(dirname "$0")/../../apps/center" && pwd)"
  docker compose exec -T db psql -U commander -d commander -At -c "$SQL"
fi
