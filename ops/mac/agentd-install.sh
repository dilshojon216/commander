#!/bin/bash
# agentd ni shu Mac'ga o'rnatadi: bundle -> ~/.commander/bin, launchd agent uz.commander.agentd (foydalanuvchi nomidan, root EMAS).
# Avval enroll: node ~/.commander/bin/agentd.mjs enroll --center <url> --code <kod>  (yoki ushbu skriptdan keyin, start'dan oldin).
# Foydalanish: ops/mac/agentd-install.sh [--no-start]
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$HOME"
BIN_DIR="$HOME_DIR/.commander/bin"
LABEL="uz.commander.agentd"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
[ -x "$NODE_BIN" ] || { echo "node topilmadi"; exit 1; }
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node >= 22 kerak"; exit 1; }

echo "1) bundle yig'ilmoqda"
(cd "$ROOT" && npm run -w apps/agentd bundle >/dev/null)

echo "2) $BIN_DIR ga nusxalanmoqda"
mkdir -p "$HOME_DIR/.commander" "$BIN_DIR" "$HOME_DIR/Library/Logs/commander"
chmod 700 "$HOME_DIR/.commander"
for f in agentd cc-hook cc-statusline cc-mcp; do install -m 755 "$ROOT/dist-bundle/$f.mjs" "$BIN_DIR/$f.mjs"; done

echo "2b) sessiyalararo xabar (2.10): --inbox/--inbox-stop hook'lari + MCP server (idempotent, zaxira bilan)"
"$NODE_BIN" "$ROOT/ops/lib/commander-messaging-setup.mjs" --node-bin "$NODE_BIN" || echo "OGOHLANTIRISH: messaging setup bajarilmadi (yuqoridagi xabarga qarang); qo'lda: $NODE_BIN $ROOT/ops/lib/commander-messaging-setup.mjs"

echo "3) launchd plist"
PATH_VALUE="/opt/homebrew/bin:/usr/local/bin:$HOME_DIR/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__HOME__#$HOME_DIR#g" -e "s#__PATH__#$PATH_VALUE#g" \
  "$ROOT/ops/mac/$LABEL.plist.template" > "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

if [ "${1:-}" = "--no-start" ]; then echo "tayyor (start qilinmadi): $PLIST"; exit 0; fi
if [ ! -f "$HOME_DIR/.commander/config.json" ]; then
  echo "config.json yo'q: avval enroll qiling:"
  echo "  $NODE_BIN $BIN_DIR/agentd.mjs enroll --center <https url> --code <kod> --claude-bin \$(command -v claude)"
  exit 1
fi
UID_N="$(id -u)"
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
# bootout asinxron: xizmat to'liq tushguncha kutamiz, aks holda bootstrap "5: Input/output error" beradi
for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$UID_N" "$PLIST" || { sleep 2; launchctl bootstrap "gui/$UID_N" "$PLIST"; }
launchctl kickstart -k "gui/$UID_N/$LABEL"
echo "ishga tushdi. Holat: $NODE_BIN $BIN_DIR/agentd.mjs status   |   log: ~/Library/Logs/commander/agentd.log"
