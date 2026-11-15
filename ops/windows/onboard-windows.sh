#!/bin/bash
# `ops/add-machine.sh` tomonidan source qilinadi (Windows 10/11 + OpenSSH). O'zgaruvchilar add-machine.sh'dan:
#   SSH_ALIAS (alias yoki user@host), MACHINE_NAME, DRY_RUN, ROOT_DIR, CENTER_URL, ADMIN_SCRIPT, BUNDLE_DIR
# Windows'da ssh default shell'i cmd.exe; murakkab ishlar PowerShell skriptlari (ops/windows/*.ps1) orqali, ular serverga scp qilinadi.
# Enrollment kodi FAQAT stdin orqali ketadi (argv, log, ps ro'yxatida ko'rinmaydi) va hech qachon chop etilmaydi.

onboard_windows() {
  local SSHO=(-o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes)
  local WIN_DIR="$ROOT_DIR/ops/windows"
  local REMOTE_TMP='commander-onboard'   # %USERPROFILE%\commander-onboard (scp/ssh nisbiy yo'li)
  local PS='powershell -NoProfile -ExecutionPolicy Bypass -File'
  rssh() { ssh "${SSHO[@]}" "$SSH_ALIAS" "$@" 2> >(grep -v -e 'post-quantum' -e 'store now' -e 'openssh.com/pq' >&2); }

  echo "OS: Windows"
  echo "[1/8] Windows preflight (node >= 22, claude, Git Bash, admin emas)..."
  local OUT NODE_BIN CLAUDE_BIN BASH_BIN WIN_HOME ENROLLED TASK_EXISTS
  if $DRY_RUN; then
    echo "  (dry-run: scp preflight.ps1 + ssh powershell preflight)"
    NODE_BIN='C:\Program Files\nodejs\node.exe'; CLAUDE_BIN='claude.cmd'; BASH_BIN='C:\Program Files\Git\bin\bash.exe'
    WIN_HOME='C:\Users\<user>'; ENROLLED=no; TASK_EXISTS=no
  else
    rssh "if not exist $REMOTE_TMP mkdir $REMOTE_TMP" >/dev/null
    scp "${SSHO[@]}" -q "$WIN_DIR/preflight.ps1" "$SSH_ALIAS:$REMOTE_TMP/" 2>/dev/null
    OUT=$(rssh "$PS $REMOTE_TMP\\preflight.ps1" | tr -d '\r') || { echo "PREFLIGHT FAILED:"; echo "$OUT"; return 1; }
    echo "$OUT"
    NODE_BIN=$(echo "$OUT" | sed -n 's/^node=//p');       CLAUDE_BIN=$(echo "$OUT" | sed -n 's/^claude=//p')
    BASH_BIN=$(echo "$OUT" | sed -n 's/^bash=//p');       WIN_HOME=$(echo "$OUT" | sed -n 's/^userprofile=//p')
    ENROLLED=$(echo "$OUT" | sed -n 's/^enrolled=//p');   TASK_EXISTS=$(echo "$OUT" | sed -n 's/^task=//p')
  fi

  echo "[2/8] Building bundle locally..."
  if $DRY_RUN; then echo "  (dry-run: npm run bundle)"; else
    (cd "$ROOT_DIR" && npm run -w apps/agentd bundle >/dev/null 2>&1) || { echo "Bundle qilishda xato"; return 1; }
  fi

  echo "[3/8] Copying bundle + scripts to server..."
  if $DRY_RUN; then echo "  (dry-run: scp *.mjs + ops/windows/*)"; else
    scp "${SSHO[@]}" -q "$BUNDLE_DIR"/agentd.mjs "$BUNDLE_DIR"/cc-hook.mjs "$BUNDLE_DIR"/cc-statusline.mjs "$BUNDLE_DIR"/cc-mcp.mjs \
      "$ROOT_DIR"/ops/lib/commander-messaging-setup.mjs "$WIN_DIR"/agentd-install.ps1 "$WIN_DIR"/start-task.ps1 "$WIN_DIR"/enroll.ps1 "$WIN_DIR"/verify-hook.mjs "$WIN_DIR"/merge-claude-settings.mjs \
      "$SSH_ALIAS:$REMOTE_TMP/" 2>/dev/null || { echo "scp xatosi"; return 1; }
  fi

  echo "[4/8] Install (~/.commander/bin, ACL, Scheduled Task; hali ishga tushirilmaydi)..."
  if $DRY_RUN; then echo "  (dry-run: agentd-install.ps1 -NoStart)"; else
    rssh "$PS $REMOTE_TMP\\agentd-install.ps1 -BundleDir $REMOTE_TMP -NodeBin \"$NODE_BIN\" -NoStart" | tr -d '\r' || { echo "Install xatosi"; return 1; }
  fi

  echo "[5/8] Enrollment..."
  local ENROLL_CODE=""
  if [ "$ENROLLED" = "yes" ]; then
    echo "  Mashina allaqachon ulangan (config.json'da deviceId bor): enroll o'tkazib yuboriladi"
  elif $DRY_RUN; then
    echo "  (dry-run: enroll-code create + enroll.ps1 stdin orqali)"
  else
    ENROLL_CODE=$("$ADMIN_SCRIPT" enroll-code create --kind agentd --machine-name "$MACHINE_NAME" --ttl-minutes 15 --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));if(!j.code)process.exit(1);process.stdout.write(j.code)})') || { echo "Enrollment code yaratishda xato"; return 1; }
    [ -n "$ENROLL_CODE" ] || { echo "Enrollment code bo'sh"; return 1; }
    echo "  Enrollment code created (TTL: 15 min; stdin orqali uzatiladi)"
    printf '%s\n' "$ENROLL_CODE" | rssh "$PS $REMOTE_TMP\\enroll.ps1 -Center $CENTER_URL -NodeBin \"$NODE_BIN\" -ClaudeBin \"$CLAUDE_BIN\"" | tr -d '\r' \
      || { unset ENROLL_CODE; echo "Enroll xatosi"; return 1; }
    unset ENROLL_CODE
  fi

  echo "[6/8] Merging ~/.claude/settings.json (hooks, OTel env, statusLine; zaxira + JSON tekshiruv)..."
  if $DRY_RUN; then echo "  (dry-run: merge-claude-settings.mjs)"; else
    # cmd.exe `/c "..." ...` qo'shtirnoq bilan boshlangan buyruqni buzadi: node'ni PowerShell orqali chaqiramiz.
    rssh "powershell -NoProfile -Command \"& '$NODE_BIN' '$REMOTE_TMP\\merge-claude-settings.mjs' --machine-name '$MACHINE_NAME' --node-bin '$NODE_BIN'\"" | tr -d '\r' || { echo "Settings merge xatosi"; return 1; }
  fi

  echo "[6b/8] Sessiyalararo xabar (2.10): --inbox/--inbox-stop hook'lari va MCP server..."
  if $DRY_RUN; then echo "  (dry-run: commander-messaging-setup.mjs)"; else
    rssh "powershell -NoProfile -Command \"& '$NODE_BIN' '$REMOTE_TMP\\commander-messaging-setup.mjs' --node-bin '$NODE_BIN' --claude-bin '$CLAUDE_BIN'\"" | tr -d '\r' || { echo "Messaging setup xatosi"; return 1; }
  fi

  echo "[7/8] Starting Scheduled Task 'Commander agentd'..."
  if $DRY_RUN; then echo "  (dry-run: Stop/Start-ScheduledTask)"; else
    rssh "$PS $REMOTE_TMP\\start-task.ps1" | tr -d '\r' \
      || { echo "Task start xatosi (foydalanuvchi Windows'ga kirganmi? Task faqat tizimga kirgan foydalanuvchi uchun ishlaydi)"; return 1; }
  fi

  echo "[8/8] Verification..."
  if $DRY_RUN; then echo "  (dry-run: agentd status + verify-hook.ps1)"; else
    local i ST=""
    for i in 1 2 3 4 5 6 7 8 9 10; do
      ST=$(rssh "powershell -NoProfile -Command \"& '$NODE_BIN' (Join-Path \$env:USERPROFILE '.commander\\bin\\agentd.mjs') status\"" 2>/dev/null | tr -d '\r') && echo "$ST" | grep -q '"state":"ready"' && break
      sleep 3
    done
    echo "agentd status: $ST"
    echo "$ST" | grep -q '"state":"ready"' || { echo "agentd ws 'ready' emas (log: %LOCALAPPDATA%\\commander\\agentd.log)"; return 1; }
    local VSID="zz-onboard-${MACHINE_NAME}-$(date +%s)"
    echo "Sintetik SessionStart ($VSID) settings.json'dagi AYNAN hook buyrug'i bilan..."
    rssh "powershell -NoProfile -Command \"& '$NODE_BIN' '$REMOTE_TMP\\verify-hook.mjs' --bash '$BASH_BIN' --session-id '$VSID'\"" | tr -d '\r' || { echo "Hook tekshiruvi muvaffaqiyatsiz"; return 1; }
    echo "WIN_VERIFY_SESSION_ID=$VSID"
    rssh "rmdir /s /q $REMOTE_TMP" >/dev/null 2>&1 || true
  fi

  echo ""
  echo "Windows mashina onboarding tayyor: $SSH_ALIAS ($MACHINE_NAME)"
  if ! $DRY_RUN; then echo "   Settings zaxira: %USERPROFILE%\\.claude\\settings.json.bak-commander-* (serverda)"; fi
}
