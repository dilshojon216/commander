#!/bin/bash
# dashboard-install.sh / dashboard-redeploy.sh uchun umumiy funksiyalar (source qilinadi, to'g'ridan-to'g'ri ishga tushirilmaydi).

DASH_LABEL="uz.commander.dashboard"
DASH_HOST="127.0.0.1"
DASH_PORT="4318"
DASH_URL="http://$DASH_HOST:$DASH_PORT/"
# H-01: "/" sessiyasiz /login ga yo'naltiradi (307); salomatlik tekshiruvi ochiq /login sahifasida (200).
DASH_HEALTH_URL="http://$DASH_HOST:$DASH_PORT/login"
DASH_LOG_DIR="$HOME/Library/Logs/commander"
DASH_LOG="$DASH_LOG_DIR/dashboard.log"
DASH_LOG_MAX_BYTES=$((10 * 1024 * 1024))

# Log 10 MB dan oshsa: nusxa -> dashboard.log.1, asl fayl kesiladi (truncate).
# launchd faylni O_APPEND bilan ochadi, shuning uchun `mv` emas, kesish ishlatiladi (deskriptor o'zgarmaydi).
dash_rotate_log() {
  mkdir -p "$DASH_LOG_DIR"
  [ -f "$DASH_LOG" ] || return 0
  local size
  size=$(stat -f %z "$DASH_LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$DASH_LOG_MAX_BYTES" ]; then
    cp "$DASH_LOG" "$DASH_LOG.1" && : > "$DASH_LOG"
    echo "   log aylantirildi: $DASH_LOG.1"
  fi
}

# HTTP 200 ni kutadi (sukut 60 s). Qaytish: 0 = tayyor.
dash_wait_200() {
  local timeout="${1:-60}" code=""
  for _ in $(seq 1 "$timeout"); do
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$DASH_HEALTH_URL" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  echo "   oxirgi javob kodi: ${code:-none}" >&2
  return 1
}

# .next production build bormi (BUILD_ID).
DASH_DIST="${COMMANDER_DASHBOARD_DIST:-.next-release}"
dash_has_build() { [ -f "$1/apps/dashboard/$DASH_DIST/BUILD_ID" ]; }
