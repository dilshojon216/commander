#!/bin/bash
# Dashboard yangilanishi: production build + launchd xizmatini qayta ishga tushirish (kickstart -k) + HTTP 200 tekshiruvi.
# Foydalanish: bash ops/mac/dashboard-redeploy.sh [--no-build]
# Eslatma: build vaqtida .next almashadi, eski server bir necha soniya xato berishi mumkin; kickstart buni tuzatadi.
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=dashboard-lib.sh
. "$ROOT/ops/mac/dashboard-lib.sh"
UID_N="$(id -u)"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"

launchctl print "gui/$UID_N/$DASH_LABEL" >/dev/null 2>&1 || {
  echo "xizmat o'rnatilmagan: avval bash ops/mac/dashboard-install.sh"; exit 1;
}

if [ "${1:-}" != "--no-build" ]; then
  echo "1) build"
  # `next build` distDir'ni boshida tozalaydi: build yiqilsa ishlab turgan xizmat chunk'larsiz qoladi (2026-11-14).
  # Shuning uchun avval zaxira nusxa; yiqilsa qaytariladi va xizmat eski versiyada davom etadi.
  DIST_PATH="$ROOT/apps/dashboard/$DASH_DIST"
  BACKUP_PATH="$DIST_PATH.prev"
  rm -rf "$BACKUP_PATH"
  if dash_has_build "$ROOT"; then cp -R "$DIST_PATH" "$BACKUP_PATH"; fi
  if ! (cd "$ROOT" && COMMANDER_DASHBOARD_DIST="$DASH_DIST" PATH="$(dirname "$NODE_BIN"):$PATH" npm run -w apps/dashboard build); then
    if [ -d "$BACKUP_PATH" ]; then
      rm -rf "$DIST_PATH" && mv "$BACKUP_PATH" "$DIST_PATH"
      echo "XATO: build yiqildi — oldingi versiya qaytarildi, xizmat o'zgarmadi" >&2
    else
      echo "XATO: build yiqildi (oldingi build yo'q edi)" >&2
    fi
    exit 1
  fi
  rm -rf "$BACKUP_PATH"
fi
dash_has_build "$ROOT" || { echo "XATO: .next/BUILD_ID yo'q" >&2; exit 1; }

echo "2) kickstart -k"
dash_rotate_log
launchctl kickstart -k "gui/$UID_N/$DASH_LABEL"

echo "3) HTTP 200 kutilmoqda"
if dash_wait_200 60; then
  echo "tayyor: $DASH_URL"
else
  echo "XATO: dashboard 200 qaytarmadi. Log: tail -50 $DASH_LOG" >&2
  exit 1
fi
