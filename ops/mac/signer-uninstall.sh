#!/bin/bash
# Imzolovchi launchd agentini to'xtatadi va plist'ni o'chiradi. Kalit va loglar SAQLANADI.
#   bash ops/mac/signer-uninstall.sh [--delete-key --confirm-fingerprint FP]
# --delete-key: kalitni Keychain'dan o'chiradi (egasi: Touch ID/parol so'raladi). DIQQAT: markaz SIGNER_SOCKET bilan ishlayotgan
# bo'lsa va volume'da kalit nusxasi yo'q bo'lsa, zaxirasiz o'chirish barcha agentd'larni qayta pin qilishni talab qiladi.
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }
LABEL="uz.commander.signer"
STATE="${SIGNER_STATE_DIR:-$HOME/.commander-signer}"
BIN="$STATE/bin/commander-signer"
UID_N="$(id -u)"
FP=""; DEL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --delete-key) DEL=1 ;;
    --confirm-fingerprint) FP="${2:?}"; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "noma'lum parametr: $1"; exit 1 ;;
  esac
  shift
done
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ $LABEL to'xtatildi, plist o'chirildi (kalit, log va $STATE saqlandi)"
if [ "$DEL" = 1 ]; then
  [ -n "$FP" ] || { echo "--confirm-fingerprint FP kerak"; exit 1; }
  "$BIN" delete-key --confirm-fingerprint "$FP"
fi
