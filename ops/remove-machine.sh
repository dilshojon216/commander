#!/bin/bash
# Commander machine offboarding script
# Qo'llash: ops/remove-machine.sh <ssh-alias>
set -euo pipefail

SSH_ALIAS="${1:-}"

if [ -z "$SSH_ALIAS" ]; then
  echo "xato: ssh alias kerak"
  echo "qo'llash: ops/remove-machine.sh <ssh-alias>"
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_SCRIPT="$ROOT_DIR/ops/mac/commander-admin.sh"
UNINSTALL_SCRIPT="$ROOT_DIR/ops/ubuntu/agentd-uninstall.sh"

echo "=== Commander machine uninstall ==="
echo "SSH alias: $SSH_ALIAS"
echo ""

# Step 1: Disable service
echo "[1/4] Stopping and disabling service..."
STOP_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

if systemctl --user is-active --quiet commander-agentd 2>/dev/null; then
  systemctl --user stop commander-agentd
fi
systemctl --user disable commander-agentd 2>/dev/null || true
echo "Service stopped"
EOF
)

STOP_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$STOP_SCRIPT" 2>&1) || {
  echo "Service stop xatosi:"
  echo "$STOP_OUTPUT"
  exit 1
}
echo "$STOP_OUTPUT"

# Step 2: Uninstall binaries and config
echo "[2/4] Uninstalling binaries..."
UNINSTALL=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

BIN_DIR="$HOME/.commander/bin"
CONFIG_DIR="$HOME/.config/systemd/user"

# Binaries o'chirish
bash -lc 'claude mcp remove commander --scope user' >/dev/null 2>&1 || true
rm -f "$BIN_DIR/agentd.mjs" "$BIN_DIR/cc-hook.mjs" "$BIN_DIR/cc-statusline.mjs" "$BIN_DIR/cc-mcp.mjs" 2>/dev/null || true
rm -f "$CONFIG_DIR/commander-agentd.service" 2>/dev/null || true

systemctl --user daemon-reload 2>/dev/null || true

echo "Binaries uninstalled"
EOF
)

UNINSTALL_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$UNINSTALL" 2>&1) || {
  echo "Uninstall xatosi:"
  echo "$UNINSTALL_OUTPUT"
  exit 1
}
echo "$UNINSTALL_OUTPUT"

# Step 3: Restore settings.json backup (agar mavjud bo'lsa)
echo "[3/4] Restoring settings.json backup..."
RESTORE_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
BACKUP=$(ls -t "$SETTINGS.bak-commander-"* 2>/dev/null | head -1 || echo "")

if [ -n "$BACKUP" ]; then
  cp "$BACKUP" "$SETTINGS"
  chmod 600 "$SETTINGS"
  echo "Settings restored from: $BACKUP"
else
  echo "No backup found; settings.json unchanged"
fi
EOF
)

RESTORE_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$RESTORE_SCRIPT" 2>&1) || true
echo "$RESTORE_OUTPUT"

# Step 4: Revoke device (optional, agar center API bilan bog'liq bo'lsa)
echo "[4/4] Revoking device from center..."
REVOKE_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

CONFIG="$HOME/.commander/config.json"
if [ -f "$CONFIG" ]; then
  DEVICE_ID=$(grep -oE '"deviceId":"[^"]+"' "$CONFIG" | cut -d'"' -f4)
  if [ -n "$DEVICE_ID" ]; then
    echo "Device ID: $DEVICE_ID (revoke on center if needed)"
  fi
fi

# Config o'chirish (ixtiyoriy)
rm -f "$CONFIG" 2>/dev/null || true
echo "Device config cleared"
EOF
)

REVOKE_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$REVOKE_SCRIPT" 2>&1) || true
echo "$REVOKE_OUTPUT"

echo ""
echo "✅ Machine offboarding tayyor!"
echo "   SSH alias: $SSH_ALIAS"
echo ""
echo "Note: Center'da device revoke qilish uchun qo'lda ishga tushiring (agar kerak bo'lsa):"
echo "   $ADMIN_SCRIPT device revoke <device-id>"
