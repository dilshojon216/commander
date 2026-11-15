#!/bin/bash
# EGASI ishga tushiradi (DR): imzo kalitining shifrlangan zaxirasi. Kalit Keychain'dan eksport qilinmaydi (non-exportable ACL);
# zaxirani FAQAT imzolovchi binary'si yaratadi, shu sabab egasi tasdig'i (Touch ID yoki hisob paroli) + passphrase (min 12 belgi) SHART.
# Terminalsiz/avtomatlashtirilgan ishga tushirishda rad etadi. Natija: AES-256-GCM + PBKDF2-600k JSON (ochiq kalit faylga tushmaydi).
#   bash ops/mac/signer-backup.sh            yaratadi (~/commander-backups/signer-key-YYYYmmdd-HHMMSS.json, 0600)
#   bash ops/mac/signer-backup.sh --verify FILE   passphrase bilan ochib fingerprint'ni ko'rsatadi
# Tiklash (yangi Mac): bash ops/mac/signer-install.sh --generate (yoki build) so'ng:  commander-signer restore-backup --in FILE
# Zaxirani oflayn/alohida joyda saqlang; passphrase'ni parol menejerida. Zaxirasiz Mac yo'qolsa: agentd'larda `center-key reset`.
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }
STATE="${SIGNER_STATE_DIR:-$HOME/.commander-signer}"
BIN="$STATE/bin/commander-signer"
[ -x "$BIN" ] || { echo "imzolovchi o'rnatilmagan: bash ops/mac/signer-install.sh"; exit 1; }
[ -t 0 ] || { echo "interaktiv terminal kerak (egasi tasdig'i va passphrase)"; exit 1; }
if [ "${1:-}" = "--verify" ]; then exec "$BIN" verify-backup --in "${2:?fayl}"; fi
OUT_DIR="$HOME/commander-backups"
mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
OUT="$OUT_DIR/signer-key-$(date +%Y%m%d-%H%M%S).json"
umask 077
"$BIN" export-backup --out "$OUT" --state-dir "$STATE"
chmod 600 "$OUT"
echo "Saqlang: $OUT (oflayn nusxa + passphrase parol menejerida). Tekshirish: bash ops/mac/signer-backup.sh --verify $OUT"
