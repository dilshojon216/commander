#!/bin/bash
# Commander machine offboarding script
# Qo'llash: ops/remove-machine.sh <ssh-alias>
set -euo pipefail

# Jarayon markerlari (COMMANDER_PROGRESS=1): ops/lib/progress.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/progress.sh"

SSH_ALIAS="${1:-}"

if [ -z "$SSH_ALIAS" ]; then
  echo "xato: ssh alias kerak"
  echo "qo'llash: ops/remove-machine.sh <ssh-alias>"
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_SCRIPT="$ROOT_DIR/ops/mac/commander-admin.sh"
UNINSTALL_SCRIPT_LINUX="$ROOT_DIR/ops/ubuntu/agentd-uninstall.sh"
UNINSTALL_SCRIPT_WINDOWS="$ROOT_DIR/ops/windows/agentd-uninstall.ps1"

echo "=== Commander machine uninstall ==="
echo "SSH alias: $SSH_ALIAS"
echo ""

# OS aniqlash
UNAME_RESULT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" 'uname -s' 2>/dev/null | tr -d '\r' || true)
case "$UNAME_RESULT" in
  Darwin) REMOTE_OS=macos ;;
  Linux) REMOTE_OS=linux ;;
  *)
    # Windows orqali uname bo'lmasa, %OS% bilan tekshiramiz
    OS_PROBE=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" 'echo %OS%' 2>/dev/null | tr -d '\r' | tail -1 || true)
    case "$OS_PROBE" in
      Windows_NT) REMOTE_OS=windows ;;
      *) REMOTE_OS=linux ;;
    esac
    ;;
esac

# Windows o'chirish
if [ "$REMOTE_OS" = "windows" ]; then
  echo "Windows mashinasini o'chirmoqda..."
  echo ""

  commander_step 1 3 "Stopping and removing Scheduled Task"
  echo "[1/3] Stopping and removing Scheduled Task..."
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
    "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\\.commander\\agentd-uninstall.ps1" 2>&1 || {
    # Dasturiy xato: uninstall.ps1 yo'q bo'lsa, qo'lda copy qilish kerak
    echo "Uninstall.ps1 serverda mavjud emas — copy qilmoqda..."
    scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes \
      "$UNINSTALL_SCRIPT_WINDOWS" \
      "$SSH_ALIAS":%USERPROFILE%\\.commander\\ >/dev/null 2>&1
    ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
      "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\\.commander\\agentd-uninstall.ps1" 2>&1
  }

  echo ""
  commander_step 2 3 "Revoking device from center"
  echo "[2/3] Revoking device from center..."
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
EOF
)
  REVOKE_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$REVOKE_SCRIPT" 2>&1) || true
  echo "$REVOKE_OUTPUT"

  echo ""
  commander_step 3 3 "Windows cleanup complete"
  echo "[3/3] Windows cleanup complete"
  echo ""
  commander_result "$(json_object sshAlias "$SSH_ALIAS" platform windows action remove status success)"
  echo "✅ Windows machine offboarding tayyor!"
  echo "   SSH alias: $SSH_ALIAS"
  echo ""
  echo "Note: Center'da device revoke qilish uchun qo'lda ishga tushiring (agar kerak bo'lsa):"
  echo "   $ADMIN_SCRIPT device revoke <device-id>"
  exit 0
fi

# macOS o'chirish
if [ "$REMOTE_OS" = "macos" ]; then
  echo "macOS mashinasini o'chirmoqda..."
  echo ""

  commander_step 1 3 "Stopping and removing launchd service"
  echo "[1/3] Stopping and removing launchd service..."
  MACOS_STOP=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

UID_N=$(id -u)
LABEL="uz.commander.agentd"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Service stopped and removed"
else
  echo "Service not running"
fi
EOF
)

  MACOS_STOP_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$MACOS_STOP" 2>&1) || true
  echo "$MACOS_STOP_OUTPUT"

  echo ""
  commander_step 2 3 "Removing binaries"
  echo "[2/3] Removing binaries..."
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -c '
    rm -f "$HOME/.commander/bin/agentd.mjs" \
          "$HOME/.commander/bin/cc-hook.mjs" \
          "$HOME/.commander/bin/cc-statusline.mjs" \
          "$HOME/.commander/bin/cc-mcp.mjs" \
          "$HOME/.commander/bin/cc-hook-socketd"
    echo "Binaries removed"
  ' 2>&1 || true

  echo ""
  commander_step 3 3 "Revoking device from center"
  echo "[3/3] Revoking device from center..."
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
rm -f "$CONFIG"
echo "Device config cleared"
EOF
)
  REVOKE_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$REVOKE_SCRIPT" 2>&1) || true
  echo "$REVOKE_OUTPUT"

  echo ""
  commander_result "$(json_object sshAlias "$SSH_ALIAS" platform macos action remove status success)"
  echo "✅ macOS machine offboarding tayyor!"
  echo "   SSH alias: $SSH_ALIAS"
  echo ""
  echo "Note: Center'da device revoke qilish uchun qo'lda ishga tushiring (agar kerak bo'lsa):"
  echo "   $ADMIN_SCRIPT device revoke <device-id>"
  exit 0
fi

# Linux o'chirish (default)
echo "Linux mashinasini o'chirmoqda..."
echo ""

# Step 1: Disable service
commander_step 1 4 "Stopping and disabling service"
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
commander_step 2 4 "Uninstalling binaries"
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
commander_step 3 4 "Restoring settings.json backup"
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
commander_step 4 4 "Revoking device from center"
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
commander_result "$(json_object sshAlias "$SSH_ALIAS" platform linux action remove status success)"
echo "✅ Machine offboarding tayyor!"
echo "   SSH alias: $SSH_ALIAS"
echo ""
echo "Note: Center'da device revoke qilish uchun qo'lda ishga tushiring (agar kerak bo'lsa):"
echo "   $ADMIN_SCRIPT device revoke <device-id>"
