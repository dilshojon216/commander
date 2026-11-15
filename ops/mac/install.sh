#!/bin/bash
# Commander installation script for Mac
# Idempotently loads LaunchAgent plists for caffeinate and backup

set -e

USER_ID=$(id -u)
SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "=========================================="
echo "Commander Mac Setup"
echo "=========================================="
echo "User: $(whoami) (UID: $USER_ID)"
echo "Scripts directory: $SCRIPTS_DIR"
echo ""

# Verify scripts exist
for script in backup.sh caffeinate.plist backup.plist; do
  if [ ! -f "$SCRIPTS_DIR/$script" ] && [ ! -f "$SCRIPTS_DIR/uz.commander.${script}" ]; then
    # Handle both naming conventions
    actual_script=""
    if [ "$script" = "caffeinate.plist" ]; then
      actual_script="$SCRIPTS_DIR/uz.commander.caffeinate.plist"
    elif [ "$script" = "backup.plist" ]; then
      actual_script="$SCRIPTS_DIR/uz.commander.backup.plist"
    elif [ "$script" = "backup.sh" ]; then
      actual_script="$SCRIPTS_DIR/backup.sh"
    fi
    if [ ! -f "$actual_script" ]; then
      echo "ERROR: Missing script: $script"
      exit 1
    fi
  fi
done

echo "Step 1: Make backup script executable"
chmod +x "$SCRIPTS_DIR/backup.sh"
chmod +x "$SCRIPTS_DIR/restore.sh"
echo "✓ Scripts are executable"

echo ""
echo "Step 2: Copy LaunchAgent plists to ~/Library/LaunchAgents/"
AGENT_DIR=~/Library/LaunchAgents

# Caffeinate agent
CAFFEINATE_PLIST="$AGENT_DIR/uz.commander.caffeinate.plist"
if [ -f "$CAFFEINATE_PLIST" ]; then
  echo "  - uz.commander.caffeinate.plist (updating)"
  launchctl bootout gui/$USER_ID "$CAFFEINATE_PLIST" 2>/dev/null || true
else
  echo "  - uz.commander.caffeinate.plist (new)"
fi
cp "$SCRIPTS_DIR/uz.commander.caffeinate.plist" "$CAFFEINATE_PLIST"
chmod 644 "$CAFFEINATE_PLIST"

# Backup agent
BACKUP_PLIST="$AGENT_DIR/uz.commander.backup.plist"
if [ -f "$BACKUP_PLIST" ]; then
  echo "  - uz.commander.backup.plist (updating)"
  launchctl bootout gui/$USER_ID "$BACKUP_PLIST" 2>/dev/null || true
else
  echo "  - uz.commander.backup.plist (new)"
fi
cp "$SCRIPTS_DIR/uz.commander.backup.plist" "$BACKUP_PLIST"
chmod 644 "$BACKUP_PLIST"

echo "✓ Plists copied"

echo ""
echo "Step 3: Load LaunchAgent plists"
launchctl bootstrap gui/$USER_ID "$CAFFEINATE_PLIST"
echo "✓ uz.commander.caffeinate loaded"

launchctl bootstrap gui/$USER_ID "$BACKUP_PLIST"
echo "✓ uz.commander.backup loaded"

echo ""
echo "Step 4: Verify LaunchAgents are running"
echo ""
launchctl print gui/$USER_ID/uz.commander.caffeinate | grep -E "state|pid" | head -2
echo ""
launchctl print gui/$USER_ID/uz.commander.backup | grep -E "state|pid" | head -2

echo ""
echo "=========================================="
echo "Installation complete!"
echo "=========================================="
echo ""
echo "What's running:"
echo "  • uz.commander.caffeinate: Keeps Mac awake (KeepAlive mode)"
echo "  • uz.commander.backup: Daily backup at 03:30 AM"
echo ""
echo "Logs:"
echo "  • ~/Library/Logs/commander/caffeinate.log"
echo "  • ~/Library/Logs/commander/backup.log"
echo ""
echo "Backups:"
echo "  • Stored in: ~/commander-backups/"
echo "  • Retention: 14 days"
echo "  • Restore with: $SCRIPTS_DIR/restore.sh <backup-file.sql.gz> --confirm"
echo ""
