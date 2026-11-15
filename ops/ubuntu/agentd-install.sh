#!/bin/bash
# Ubuntu serverda (foydalanuvchi nomidan, root EMAS): bundle'ni ~/.commander/bin ga qo'yadi va systemd --user unit o'rnatadi.
# Mac'da yig'ilgan dist-bundle/ papkasini serverga nusxalang (scp -r dist-bundle <server>:), so'ng:
#   BUNDLE_DIR=~/dist-bundle ./agentd-install.sh <ops/ubuntu papkasidagi skript>   (service shablon skript yonida bo'lishi kerak)
# Enroll: node ~/.commander/bin/agentd.mjs enroll --center https://<mac>.<tailnet>.ts.net --code <kod> --claude-bin "$(command -v claude)"
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "root bilan ishga tushirmang"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="${BUNDLE_DIR:-$HERE/../../dist-bundle}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
[ -x "$NODE_BIN" ] || { echo "node topilmadi (Node >= 22 o'rnating)"; exit 1; }
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node >= 22 kerak"; exit 1; }
BIN_DIR="$HOME/.commander/bin"
mkdir -p "$BIN_DIR" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.commander"
for f in agentd cc-hook cc-statusline cc-mcp; do install -m 755 "$BUNDLE_DIR/$f.mjs" "$BIN_DIR/$f.mjs"; done
# Sessiyalararo xabar (2.10): hook'lar + MCP server (skript yonida ../lib/ bo'lsa; add-machine.sh uni alohida ishga tushiradi)
if [ -f "$HERE/../lib/commander-messaging-setup.mjs" ]; then "$NODE_BIN" "$HERE/../lib/commander-messaging-setup.mjs" --node-bin "$NODE_BIN" || echo "OGOHLANTIRISH: messaging setup bajarilmadi"; fi
PATH_VALUE="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__PATH__#$PATH_VALUE#g" "$HERE/commander-agentd.service.template" > "$HOME/.config/systemd/user/commander-agentd.service"
systemctl --user daemon-reload
# Foydalanuvchi tizimga kirmasa ham ishlashi uchun (bir marta sudo kerak bo'lishi mumkin):
loginctl enable-linger "$USER" || echo "OGOHLANTIRISH: 'sudo loginctl enable-linger $USER' ni qo'lda bajaring"
if [ ! -f "$HOME/.commander/config.json" ]; then echo "avval enroll qiling (yuqoriga qarang), keyin: systemctl --user enable --now commander-agentd"; exit 0; fi
systemctl --user enable --now commander-agentd
systemctl --user restart commander-agentd
echo "holat: systemctl --user status commander-agentd | log: journalctl --user -u commander-agentd -f"
