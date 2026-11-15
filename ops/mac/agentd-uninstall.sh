#!/bin/bash
# agentd launchd agentini to'xtatadi va o'chiradi. Ma'lumotlar (~/.commander: kalit, config, outbox) QOLADI;
# to'liq tozalash uchun: ops/mac/agentd-uninstall.sh --purge (kalit ham o'chadi: keyin markazda "device revoke" qiling).
set -euo pipefail
LABEL="uz.commander.agentd"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -f "$HOME/.commander/bin/agentd.mjs" "$HOME/.commander/bin/cc-hook.mjs" "$HOME/.commander/bin/cc-statusline.mjs" "$HOME/.commander/bin/cc-mcp.mjs" "$HOME/.commander/agentd.sock"
if [ "${1:-}" = "--purge" ]; then rm -rf "$HOME/.commander"; echo "~/.commander o'chirildi"; fi
echo "agentd o'chirildi"
