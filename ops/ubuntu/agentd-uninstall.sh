#!/bin/bash
# agentd systemd --user unit'ini o'chiradi (~/.commander ma'lumotlari qoladi; --purge bilan o'chadi).
set -euo pipefail
systemctl --user disable --now commander-agentd 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/commander-agentd.service"
systemctl --user daemon-reload || true
rm -f "$HOME/.commander/bin/"{agentd,cc-hook,cc-statusline,cc-mcp}.mjs "$HOME/.commander/agentd.sock"
if [ "${1:-}" = "--purge" ]; then rm -rf "$HOME/.commander"; fi
echo "agentd o'chirildi"
