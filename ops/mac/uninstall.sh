#!/bin/bash
# Commander uninstallation script for Mac
# Idempotently unloads LaunchAgent plists for caffeinate and backup

set -e

USER_ID=$(id -u)

echo "=========================================="
echo "Commander Mac Uninstall"
echo "=========================================="
echo "User: $(whoami) (UID: $USER_ID)"
echo ""

AGENT_DIR=~/Library/LaunchAgents
CAFFEINATE_PLIST="$AGENT_DIR/uz.commander.caffeinate.plist"
BACKUP_PLIST="$AGENT_DIR/uz.commander.backup.plist"

echo "Step 1: Unload LaunchAgent plists"

if launchctl print gui/$USER_ID/uz.commander.caffeinate > /dev/null 2>&1; then
  launchctl bootout gui/$USER_ID "$CAFFEINATE_PLIST"
  echo "✓ uz.commander.caffeinate unloaded"
else
  echo "  uz.commander.caffeinate not loaded"
fi

if launchctl print gui/$USER_ID/uz.commander.backup > /dev/null 2>&1; then
  launchctl bootout gui/$USER_ID "$BACKUP_PLIST"
  echo "✓ uz.commander.backup unloaded"
else
  echo "  uz.commander.backup not loaded"
fi

echo ""
echo "Step 2: Remove plist files"

if [ -f "$CAFFEINATE_PLIST" ]; then
  rm "$CAFFEINATE_PLIST"
  echo "✓ Removed uz.commander.caffeinate.plist"
else
  echo "  uz.commander.caffeinate.plist not found"
fi

if [ -f "$BACKUP_PLIST" ]; then
  rm "$BACKUP_PLIST"
  echo "✓ Removed uz.commander.backup.plist"
else
  echo "  uz.commander.backup.plist not found"
fi

echo ""
echo "=========================================="
echo "Uninstall complete!"
echo "=========================================="
echo ""
echo "Note: Backups in ~/commander-backups/ and logs in ~/Library/Logs/commander/"
echo "are NOT automatically deleted. Remove them manually if desired."
echo ""
