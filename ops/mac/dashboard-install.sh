#!/bin/bash
# Web dashboard'ni doimiy launchd xizmati qiladi: uz.commander.dashboard (foydalanuvchi nomidan, root EMAS).
# Production Next server: `next start -H 127.0.0.1 -p 4318`, WorkingDirectory apps/dashboard (.env.local'ni Next o'zi o'qiydi;
# tokenlar plist'ga KO'CHIRILMAYDI). RunAtLoad + KeepAlive. Log: ~/Library/Logs/commander/dashboard.log
# Foydalanish: bash ops/mac/dashboard-install.sh [--rebuild]
#   --rebuild  .next bo'lsa ham qayta build qiladi (keyingi yangilanishlar uchun: ops/mac/dashboard-redeploy.sh)
# Muhit: NODE_BIN (sukut /opt/homebrew/opt/node@24/bin/node)
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=dashboard-lib.sh
. "$ROOT/ops/mac/dashboard-lib.sh"
DASH_DIR="$ROOT/apps/dashboard"
PLIST="$HOME/Library/LaunchAgents/$DASH_LABEL.plist"
UID_N="$(id -u)"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"
[ -x "$NODE_BIN" ] || { echo "node topilmadi: $NODE_BIN (NODE_BIN=... bilan bering)"; exit 1; }
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node >= 20 kerak"; exit 1; }
NEXT_BIN="$("$NODE_BIN" -p "require.resolve('next/dist/bin/next', { paths: ['$DASH_DIR'] })")"
[ -f "$NEXT_BIN" ] || { echo "next topilmadi: avval ildizda npm install"; exit 1; }
[ -f "$DASH_DIR/.env.local" ] || echo "OGOHLANTIRISH: $DASH_DIR/.env.local yo'q (center API tokenlari): dashboard faqat lokal ma'lumotni ko'rsatadi"

echo "1) build"
if [ "${1:-}" = "--rebuild" ] || ! dash_has_build "$ROOT"; then
  (cd "$ROOT" && COMMANDER_DASHBOARD_DIST="$DASH_DIST" PATH="$(dirname "$NODE_BIN"):$PATH" npm run -w apps/dashboard build)
else
  echo "   .next mavjud (BUILD_ID): build o'tkazib yuborildi (--rebuild bilan majburlash)"
fi

echo "2) launchd plist: $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
dash_rotate_log
PATH_VALUE="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__NEXT__#$NEXT_BIN#g" -e "s#__CWD__#$DASH_DIR#g" \
    -e "s#__HOME__#$HOME#g" -e "s#__PATH__#$PATH_VALUE#g" \
    "$ROOT/ops/mac/$DASH_LABEL.plist.template" > "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

echo "3) eski xizmat / qo'lda ishga tushirilgan server to'xtatiladi"
launchctl bootout "gui/$UID_N/$DASH_LABEL" 2>/dev/null || true
# bootout asinxron: xizmat to'liq tushguncha kutamiz, aks holda bootstrap "5: Input/output error" beradi
for _ in $(seq 1 20); do launchctl print "gui/$UID_N/$DASH_LABEL" >/dev/null 2>&1 || break; sleep 0.5; done

# Faqat 127.0.0.1:4318 ni tinglayotgan, cwd = apps/dashboard va buyrug'i next/node bo'lgan jarayon o'ldiriladi.
for pid in $(lsof -nP -iTCP@"$DASH_HOST":"$DASH_PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [ "$cwd" = "$DASH_DIR" ] && printf '%s' "$cmd" | grep -Eq '(^|[/ ])(next|node)([ -]|$)|next-server'; then
    echo "   to'xtatilmoqda: pid $pid ($cmd)"
    kill -TERM "$pid" 2>/dev/null || true
  else
    echo "XATO: $DASH_HOST:$DASH_PORT ni boshqa jarayon band qilgan (pid $pid: $cmd, cwd $cwd). Tegmadim." >&2
    exit 1
  fi
done
for _ in $(seq 1 20); do
  lsof -nP -iTCP@"$DASH_HOST":"$DASH_PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break
  sleep 0.5
done
if lsof -nP -iTCP@"$DASH_HOST":"$DASH_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "XATO: port $DASH_PORT bo'shamadi" >&2; exit 1
fi

echo "4) bootstrap"
launchctl bootstrap "gui/$UID_N" "$PLIST" || { sleep 2; launchctl bootstrap "gui/$UID_N" "$PLIST"; }
launchctl enable "gui/$UID_N/$DASH_LABEL" 2>/dev/null || true

echo "5) HTTP 200 kutilmoqda: $DASH_URL"
if dash_wait_200 60; then
  echo "tayyor: $DASH_URL  (launchd: $DASH_LABEL, log: $DASH_LOG)"
  echo "yangilash: bash ops/mac/dashboard-redeploy.sh   |   o'chirish: bash ops/mac/dashboard-uninstall.sh"
else
  echo "XATO: dashboard 60 s ichida 200 qaytarmadi. Log: tail -50 $DASH_LOG" >&2
  exit 1
fi
