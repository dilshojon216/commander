#!/bin/bash
# Commander admin CLI (enrollment kodlari, klient tokenlar, revoke, lockdown, audit verify).
# HTTP admin yuzasi YO'Q: bu skript center konteyneri ichida `node dist/cli.js` ni ishga tushiradi.
# Foydalanish: ops/mac/commander-admin.sh enroll-code create --kind agentd --machine-name mac-mini
#              ops/mac/commander-admin.sh client pair --kind mobile --name "iPhone" --scopes read,approve   (QR + kod)
#              ops/mac/commander-admin.sh --help
set -euo pipefail
cd "$(dirname "$0")/../../apps/center"
exec docker compose exec -T app node dist/cli.js "$@"
