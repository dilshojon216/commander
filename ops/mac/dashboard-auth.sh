#!/bin/bash
# Dashboard lokal autentifikatsiyasi (H-01, TASKS 5.6): egasi uchun CLI.
#   bash ops/mac/dashboard-auth.sh setup              # bir martalik sozlash kodi (10 daqiqa)
#   bash ops/mac/dashboard-auth.sh password           # zaxira parol (interaktiv, TTY shart)
#   bash ops/mac/dashboard-auth.sh status             # nima sozlangan
#   bash ops/mac/dashboard-auth.sh revoke-sessions    # hamma sessiyani tugatish
#   bash ops/mac/dashboard-auth.sh remove <password|passkeys|app>
#   bash ops/mac/dashboard-auth.sh audit [N]
# Holat: apps/dashboard/.auth/ (0700; credentials/sessions 0600). Repo'ga tushmaydi (.gitignore).
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
exec "$NODE_BIN" "$ROOT/apps/dashboard/scripts/auth-cli.mjs" "$@"
