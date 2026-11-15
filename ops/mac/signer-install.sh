#!/bin/bash
# Commander imzolovchisini (apps/signer, TASKS 5.7 / H-02) Mac'ga o'rnatadi: uz.commander.signer launchd agenti (foydalanuvchi nomidan).
# Markaz buyruq-imzo kaliti macOS Keychain'ga (generic password, ACL = faqat shu binary) ko'chiriladi; markaz konteyneri kalitni ko'rmaydi.
#
# Foydalanish:
#   bash ops/mac/signer-install.sh --expect-fingerprint FP [--volume NAME] [--identity "Codesign identity"] [--skip-build]
#       FP: markaz hozirgi imzo kaliti fingerprint'i (`ops/mac/commander-admin.sh center-key show`). Kalit Keychain'da bo'lmasa
#       center_secrets volume'idan O'QISH REJIMIDA nusxalanadi (quvur orqali, diskka ochiq yozilmaydi) va fingerprint mos kelishi
#       tekshiriladi; mos kelmasa hech narsa saqlanmaydi.
#   bash ops/mac/signer-install.sh --expect-fingerprint FP --remove-volume-key
#       FAQAT egasi: kalit fayli volume'dan o'chiriladi. Shartlar: imzolovchi shu kalit bilan ishlayapti, markaz imzolovchidan
#       foydalanayapti, shifrlangan zaxira (signer-backup.sh) mavjud, FP terminalda qo'lda yoziladi. Bu skriptni avtomatlashtirmang.
#   --generate: (yangi o'rnatish, eski kalit yo'q) kalit Keychain ichida yaratiladi; agentd'lar `center-key reset` talab qiladi!
#   --reimport: binary qayta qurilgan/imzolangan va Keychain ACL uni tanimaydi (show kodi 9): eski element o'chiriladi va kalit
#       volume'dan qayta import qilinadi (volume'da kalit bo'lishi shart; yo'q bo'lsa: commander-signer restore-backup --in FILE).
# Muhit: SIGNER_STATE_DIR (sukut ~/.commander-signer)
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../migrate/lib.sh
source "$ROOT/ops/migrate/lib.sh"

LABEL="uz.commander.signer"
STATE="${SIGNER_STATE_DIR:-$HOME/.commander-signer}"
BIN="$STATE/bin/commander-signer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"
PORT=4320   # 4317 center, 4318 dashboard, 4319 agentd OTLP
PROJECT="commander"
COMPOSE_FILE="$ROOT/apps/center/docker-compose.yml"
EXPECT=""; VOLUME=""; IDENTITY="-"; SKIP_BUILD=0; REMOVE_VOL=0; GENERATE=0; REIMPORT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-fingerprint) EXPECT="${2:?}"; shift ;;
    --volume) VOLUME="${2:?}"; shift ;;
    --identity) IDENTITY="${2:?}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    --remove-volume-key) REMOVE_VOL=1 ;;
    --generate) GENERATE=1 ;;
    --reimport) REIMPORT=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "noma'lum parametr: $1" ;;
  esac
  shift
done

resolve_volume() {
  if [ -z "$VOLUME" ]; then
    local cid
    cid="$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -a -q app 2>/dev/null || true)"
    [ -n "$cid" ] || die "'$PROJECT' loyihasida app konteyneri topilmadi (--volume NAME bering)"
    VOLUME="$(container_volume "$cid" /var/lib/commander-secrets)"
  fi
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "volume topilmadi: $VOLUME"
}

if [ "$REMOVE_VOL" = 1 ]; then
  [ -n "$EXPECT" ] || die "--expect-fingerprint kerak"
  [ -t 0 ] || die "interaktiv terminal kerak: bu amalni faqat egasi qo'lda bajaradi"
  [ -x "$BIN" ] || die "imzolovchi o'rnatilmagan"
  resolve_volume
  got="$("$BIN" show | sed -n 's/^fingerprint //p')"
  [ "$got" = "$EXPECT" ] || die "Keychain'dagi kalit fingerprint'i ($got) kutilganga ($EXPECT) mos emas"
  cid="$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -q app)"
  [ -n "$cid" ] || die "app konteyneri ishlamayapti"
  docker exec "$cid" sh -c 'test -n "$SIGNER_SOCKET"' || die "markaz imzolovchi rejimida emas (SIGNER_SOCKET yo'q): kalitni o'chirish xavfli"
  center_logs="$(docker logs "$cid" 2>&1 || true)"
  grep -q "Command signer ready (fingerprint $EXPECT" <<<"$center_logs" || die "markaz loglarida shu fingerprint bilan 'Command signer ready' yo'q"
  ls "$HOME"/commander-backups/signer-key-*.json >/dev/null 2>&1 || die "shifrlangan zaxira yo'q: avval bash ops/mac/signer-backup.sh (va uni oflayn saqlang)"
  echo "Quyidagi fayllar $VOLUME volume'idan O'CHIRILADI: command-signing.key, command-signing.key.rotations.json"
  echo "Kalit endi faqat Keychain'da (va sizning shifrlangan zaxirangizda) qoladi. queue-prompt.key tegilmaydi."
  read -rp "Tasdiqlash uchun fingerprint'ni yozing ($EXPECT): " typed
  [ "$typed" = "$EXPECT" ] || die "bekor qilindi"
  docker run --rm -v "$VOLUME":/v "$CMDR_TOOLBOX_IMAGE" sh -c 'rm -f /v/command-signing.key /v/command-signing.key.rotations.json /v/command-signing.key.rotations.json.tmp /v/command-signing.key.new && ls /v'
  log "✓ volume'dagi imzo kaliti o'chirildi"
  exit 0
fi

echo "1) build + o'rnatish"
mkdir -p "$STATE/bin" "$HOME/Library/Logs/commander"
chmod 700 "$STATE" "$STATE/bin"
if [ "$SKIP_BUILD" = 0 ]; then swift build -c release --package-path "$ROOT/apps/signer" >/dev/null; fi
BUILT="$ROOT/apps/signer/.build/release/commander-signer"
[ -x "$BUILT" ] || die "binary yo'q: $BUILT"
# Binary o'zgarmagan bo'lsa qayta nusxalanmaydi/imzolanmaydi: ad-hoc imzoda cdhash o'zgarsa Keychain ACL mos kelmay qoladi.
if [ ! -x "$BIN" ] || ! cmp -s "$BUILT" "$BIN.unsigned" 2>/dev/null; then
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
  cp "$BUILT" "$BIN.unsigned"
  cp "$BUILT" "$BIN"
  codesign --force --sign "$IDENTITY" --identifier "$LABEL" "$BIN" 2>/dev/null
  chmod 755 "$BIN"
  echo "   o'rnatildi + imzolandi ($([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY")): $BIN"
  echo "   ESLATMA: binary o'zgargan bo'lsa Keychain birinchi o'qishda egasidan 'Always Allow' so'rashi mumkin."
else
  echo "   binary o'zgarmagan: mavjud imzolangan nusxa saqlandi"
fi

echo "2) kalit"
import_from_volume() {
  resolve_volume
  echo "   volume'dan o'qish rejimida import ($VOLUME), fingerprint $EXPECT"
  docker run --rm -v "$VOLUME":/s:ro "$CMDR_TOOLBOX_IMAGE" test -f /s/command-signing.key || die "volume'da command-signing.key yo'q: zaxiradan tiklang (commander-signer restore-backup --in FILE)"
  docker run --rm -v "$VOLUME":/s:ro "$CMDR_TOOLBOX_IMAGE" cat /s/command-signing.key | "$BIN" import --pem-stdin --expect-fingerprint "$EXPECT"
  if docker run --rm -v "$VOLUME":/s:ro "$CMDR_TOOLBOX_IMAGE" test -f /s/command-signing.key.rotations.json; then
    docker run --rm -v "$VOLUME":/s:ro "$CMDR_TOOLBOX_IMAGE" cat /s/command-signing.key.rotations.json | "$BIN" import-rotations --stdin --state-dir "$STATE"
  fi
}
set +e
"$BIN" show >/dev/null 2>&1
HAVE=$?
set -e
if [ "$HAVE" -eq 0 ]; then
  got="$("$BIN" show | sed -n 's/^fingerprint //p')"
  [ -z "$EXPECT" ] || [ "$got" = "$EXPECT" ] || die "Keychain'da BOSHQA kalit bor ($got), kutilgan $EXPECT: tegilmadi"
  echo "   Keychain'da kalit bor: fingerprint $got"
elif [ "$HAVE" -eq 9 ]; then
  [ "$REIMPORT" = 1 ] || die "Keychain ACL bu binary build'ini tanimaydi (qayta qurilgan?). Kalit volume'da bo'lsa: --reimport --expect-fingerprint FP; aks holda: $BIN restore-backup --in FILE"
  [ -n "$EXPECT" ] || die "--reimport uchun --expect-fingerprint kerak"
  echo "   eski Keychain elementi (boshqa build ACL'i) o'chiriladi va kalit qayta import qilinadi"
  security delete-generic-password -s uz.commander.signer -a command-signing-ed25519 >/dev/null
  import_from_volume
elif [ "$HAVE" -eq 3 ] && [ "$GENERATE" = 1 ]; then
  "$BIN" generate
  echo "   YANGI kalit yaratildi: barcha agentd'larda 'agentd center-key reset' kerak bo'ladi (yoki eski kalitni import qiling)"
elif [ "$HAVE" -eq 3 ]; then
  [ -n "$EXPECT" ] || die "Keychain'da kalit yo'q: --expect-fingerprint FP bering (import) yoki --generate"
  import_from_volume
else
  die "Keychain'dan kalitni o'qib bo'lmadi (kod $HAVE): $BIN show"
fi
got="$("$BIN" show | sed -n 's/^fingerprint //p')"
[ -z "$EXPECT" ] || [ "$got" = "$EXPECT" ] || die "tekshiruv muvaffaqiyatsiz: fingerprint $got != $EXPECT"
echo "   ✓ fingerprint $got (o'zgarmagan)"

echo "3) launchd: $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__BIN__#$BIN#g" -e "s#__STATE__#$STATE#g" -e "s#__HOME__#$HOME#g" "$ROOT/ops/mac/$LABEL.plist.template" > "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$UID_N" "$PLIST"
# Port boshqa jarayonda band bo'lsa "ishlayapti" deb yolg'on aytmaslik uchun: tinglayotgan jarayon aynan shu binary bo'lishi shart.
listener_cmd() { local pid; pid="$(lsof -nP -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"; [ -n "$pid" ] && ps -o command= -p "$pid" || true; }
for _ in $(seq 1 30); do case "$(listener_cmd)" in "$BIN"*) break ;; esac; sleep 0.5; done
case "$(listener_cmd)" in "$BIN"*) ;; *) die "127.0.0.1:$PORT ni imzolovchi tinglamayapti (band: '$(listener_cmd)'): ~/Library/Logs/commander/signer.log" ;; esac
[ "$(stat -f '%Lp' "$STATE/run/auth.secret")" = "600" ] || die "auth.secret ruxsati 0600 emas"
echo "   ✓ uz.commander.signer ishlayapti (127.0.0.1:$PORT, auth: $STATE/run/auth.secret)"
echo
echo "Keyingi qadamlar:"
echo "  - markazni qayta ishga tushiring (docker compose ... up -d --build): SIGNER_SOCKET orqali imzolovchidan foydalanadi"
echo "  - egasi: bash ops/mac/signer-backup.sh   (shifrlangan DR zaxirasi: Touch ID/parol + passphrase)"
echo "  - egasi (zaxiradan keyin): bash ops/mac/signer-install.sh --expect-fingerprint $got --remove-volume-key"
