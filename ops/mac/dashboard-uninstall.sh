#!/bin/bash
# Dashboard launchd xizmatini (uz.commander.dashboard) to'xtatadi va plist'ni o'chiradi.
# .next build, .env.local va loglar QOLADI.
set -euo pipefail
LABEL="uz.commander.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "dashboard xizmati o'chirildi (qo'lda: npm run -w apps/dashboard start)"
