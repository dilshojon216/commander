#!/bin/bash
# Commander machine onboarding script
# Qo'llash: ops/add-machine.sh <ssh-alias | user@host> [--name <machine-name>] [--os linux|windows] [--dry-run]
#                              [--enable-remote (--root <papka> [--root <papka>]... | --home | ikkalasi)]   # masofaviy boshqaruvni ham yoqish (egasi tanlovi); --home = butun $HOME (`policy allow-home`)
# OS avtomatik aniqlanadi (ssh orqali, faqat o'qiydi): Linux (systemd --user) yoki Windows (Scheduled Task, ops/windows/*).
# Idempotent: agar allaqachon o'rnatilgan bo'lsa, qayta ishga tushirish xavfsiz
# COMMANDER_PROGRESS=1 bo'lsa progress markerlar chiqaradi: ##commander-step <k>/<N> <title> va ##commander-result <JSON>
set -euo pipefail

# Jarayon markerlari (COMMANDER_PROGRESS=1): ops/lib/progress.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/progress.sh"

# Enrollment kodini uzoq mashinada agentd'ning stdin'iga beradi: kod skript matni (ssh stdin) ichida boradi va faqat here-string
# orqali `--code-stdin` ga tushadi, shuning uchun hech qayerda argv/ps'da ko'rinmaydi. Kod formati oldindan tekshiriladi.
remote_enroll() {
  case "$ENROLL_CODE" in
    ''|*[!A-Za-z0-9_-]*) echo "Enrollment kodi formati noto'g'ri"; return 1 ;;
  esac
  local script
  script=$(cat <<EOS
set -euo pipefail
"\$NODE_BIN" "\$HOME/.commander/bin/agentd.mjs" enroll --center "\$CENTER_URL" --code-stdin --claude-bin "\$CLAUDE_BIN" <<< '$ENROLL_CODE' 2>&1
echo "ENROLL_OK"
EOS
)
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
    NODE_BIN="$NODE_BIN" CLAUDE_BIN="$CLAUDE_BIN" CENTER_URL="$CENTER_URL" bash -s <<< "$script" 2>&1
}

# Enrollment chiqishidan "deviceId=<uuid> machineId=<uuid>" qatorini o'qiydi (sir emas; ustaga natija sifatida beriladi).
parse_enroll_ids() {
  DEVICE_ID=$(printf '%s\n' "$1" | sed -n 's/.*deviceId=\([0-9a-fA-F-]\{36\}\).*/\1/p' | head -1)
  MACHINE_ID=$(printf '%s\n' "$1" | sed -n 's/.*machineId=\([0-9a-fA-F-]\{36\}\).*/\1/p' | head -1)
}

# Parametrlarni parse qilish
SSH_ALIAS="${1:-}"
MACHINE_NAME=""
DRY_RUN=false
FORCE_OS=""
ENABLE_REMOTE=false
REMOTE_ROOTS=()
REMOTE_HOME=false
CLAUDE_TMUX=false

if [ -z "$SSH_ALIAS" ]; then
  echo "xato: ssh alias kerak"
  echo "qo'llash: ops/add-machine.sh <ssh-alias> [--name <machine-name>] [--dry-run]"
  exit 2
fi

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      MACHINE_NAME="$2"
      shift 2
      ;;
    --os)
      FORCE_OS="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --enable-remote)
      ENABLE_REMOTE=true
      shift
      ;;
    --root)
      [ -n "${2:-}" ] || { echo "xato: --root uchun papka kerak"; exit 2; }
      REMOTE_ROOTS+=("$2")
      shift 2
      ;;
    --home)
      REMOTE_HOME=true
      shift
      ;;
    --claude-tmux)
      CLAUDE_TMUX=true
      shift
      ;;
    *)
      echo "noma'lum flag: $1"
      exit 2
      ;;
  esac
done

if [ -z "$MACHINE_NAME" ]; then
  MACHINE_NAME="$SSH_ALIAS"
fi
if $ENABLE_REMOTE && [ ${#REMOTE_ROOTS[@]} -eq 0 ] && ! $REMOTE_HOME; then
  echo "xato: --enable-remote uchun kamida bitta --root <papka> yoki --home kerak"
  exit 2
fi
if ! $ENABLE_REMOTE && { [ ${#REMOTE_ROOTS[@]} -gt 0 ] || $REMOTE_HOME; }; then
  echo "xato: --root/--home faqat --enable-remote bilan"
  exit 2
fi

# Onboarding'dan keyin (egasi so'ragan bo'lsa) masofaviy boshqaruvni yoqish: ops/remote-control.sh
maybe_enable_remote() {
  $ENABLE_REMOTE || return 0
  local args=()
  for r in ${REMOTE_ROOTS[@]+"${REMOTE_ROOTS[@]}"}; do args+=(--root "$r"); done
  if $REMOTE_HOME; then args+=(--home); fi
  echo ""
  echo "Masofaviy boshqaruv yoqilmoqda..."
  if $DRY_RUN; then
    echo "  (dry-run: ops/remote-control.sh $SSH_ALIAS enable ${args[*]})"
  else
    "$ROOT_DIR/ops/remote-control.sh" "$SSH_ALIAS" enable "${args[@]}"
  fi
}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Center manzili: COMMANDER_CENTER_URL yoki ops/.center-url fayli (git'ga kirmaydi), masalan https://<mac>.<tailnet>.ts.net
CENTER_URL="${COMMANDER_CENTER_URL:-$(cat "$ROOT_DIR/ops/.center-url" 2>/dev/null || true)}"
[ -n "$CENTER_URL" ] || { echo "Center URL yo'q: COMMANDER_CENTER_URL=... bering yoki ops/.center-url fayliga yozing" >&2; exit 1; }
ADMIN_SCRIPT="$ROOT_DIR/ops/mac/commander-admin.sh"
BUNDLE_DIR="$ROOT_DIR/dist-bundle"
INSTALL_SCRIPT_LINUX="$ROOT_DIR/ops/ubuntu/agentd-install.sh"
INSTALL_SCRIPT_MAC="$ROOT_DIR/ops/mac/agentd-install.sh"

echo "=== Commander onboarding ==="
echo "SSH alias: $SSH_ALIAS"
echo "Machine name: $MACHINE_NAME"
echo "Center URL: $CENTER_URL"
echo "Dry-run: $DRY_RUN"
echo ""

# OS aniqlash: uname -s orqali Darwin (macOS), Windows'da cmd.exe `%OS%` ni "Windows_NT" ga kengaytiradi; Linux — qolgan.
REMOTE_OS="$FORCE_OS"
if [ -z "$REMOTE_OS" ]; then
  # Avval uname bilan tekshiramiz (macOS/Linux)
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
fi
if [ "$REMOTE_OS" = "windows" ]; then
  # shellcheck source=windows/onboard-windows.sh
  source "$ROOT_DIR/ops/windows/onboard-windows.sh"
  onboard_windows
  rc=$?
  [ "$rc" -eq 0 ] && maybe_enable_remote
  exit "$rc"
fi
if [ "$REMOTE_OS" = "macos" ]; then
  # macOS: preflight + install launchd + enroll
  commander_step 1 7 "macOS preflight tekshiruvi"
  echo "[1/7] macOS preflight checks..."

  MACOS_PREFLIGHT=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

errors=""

# User tekshirish
if [ "$(id -u)" -eq 0 ]; then
  errors="$errors"$'\n'"xato: root bilan ishga tushirmang"
fi

# Claude yo'lini tekshirish
CLAUDE_PATH=$(command -v claude 2>/dev/null || echo "")
if [ -z "$CLAUDE_PATH" ]; then
  errors="$errors"$'\n'"xato: claude topilmadi (PATH'da bo'lishi kerak)"
fi

# Node tekshirish (nvm yoki homebrew)
NODE_PATH=$(command -v node 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_PATH=$(ls -1d "$HOME/.nvm/versions/node/v*/bin/node" 2>/dev/null | sort -V | tail -1 || echo "")
fi
if [ -z "$NODE_PATH" ] && [ -d "/opt/homebrew/bin" ]; then
  NODE_PATH=$(/opt/homebrew/bin/node -v >/dev/null 2>&1 && echo "/opt/homebrew/bin/node" || echo "")
fi

if [ -z "$NODE_PATH" ]; then
  errors="$errors"$'\n'"xato: node topilmadi"
fi

# Node versiyasini tekshirish
if [ -n "$NODE_PATH" ]; then
  NODE_VERSION=$("$NODE_PATH" -v 2>/dev/null || echo "")
  MAJOR=$(echo "$NODE_VERSION" | grep -oE '^v[0-9]+' | grep -oE '[0-9]+' || echo "0")
  if [ "$MAJOR" -lt 22 ]; then
    errors="$errors"$'\n'"xato: Node >= 22 kerak (v$MAJOR topildi)"
  fi
fi

if [ -n "$errors" ]; then
  echo "PREFLIGHT XATO:$errors"
  exit 1
fi

echo "PREFLIGHT OK"
echo "claude=$CLAUDE_PATH"
echo "node=$NODE_PATH"
EOF
)

  if ! $DRY_RUN; then
    MACOS_PREFLIGHT_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$MACOS_PREFLIGHT" 2>&1) || {
      echo "PREFLIGHT FAILED:"
      echo "$MACOS_PREFLIGHT_OUTPUT"
      exit 1
    }
    echo "$MACOS_PREFLIGHT_OUTPUT"
    CLAUDE_BIN=$(echo "$MACOS_PREFLIGHT_OUTPUT" | grep "^claude=" | cut -d= -f2-)
    NODE_BIN=$(echo "$MACOS_PREFLIGHT_OUTPUT" | grep "^node=" | cut -d= -f2-)
  else
    echo "  (dry-run: macOS preflight script)"
    NODE_BIN="/opt/homebrew/bin/node"
    CLAUDE_BIN="/opt/homebrew/bin/claude"
  fi

  commander_step 2 7 "Bundle yigʻish"
  echo "[2/7] Building bundle locally..."
  if ! $DRY_RUN; then
    (cd "$ROOT_DIR" && npm run -w apps/agentd bundle >/dev/null 2>&1) || {
      echo "Bundle qilishda xato"
      exit 1
    }
  else
    echo "  (dry-run: npm run bundle)"
  fi

  commander_step 3 7 "Fayllar serverga nusxalash"
  echo "[3/7] Copying files to server..."
  if ! $DRY_RUN; then
    ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" mkdir -p /tmp/commander-onboard
    scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes \
      "$INSTALL_SCRIPT_MAC" \
      "$SSH_ALIAS":/tmp/commander-onboard/ >/dev/null 2>&1
    scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes \
      "$BUNDLE_DIR"/*.mjs \
      "$SSH_ALIAS":/tmp/commander-onboard/ >/dev/null 2>&1
  else
    echo "  (dry-run: scp bundle + install script)"
  fi

  commander_step 4 7 "Enrollment kodi yaratish"
  echo "[4/7] Creating enrollment code..."
  ALREADY_ENROLLED=false
  ENROLL_CODE=""
  if ! $DRY_RUN && ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
      'grep -q "\"deviceId\"" "$HOME/.commander/config.json" 2>/dev/null'; then
    ALREADY_ENROLLED=true
    echo "  Mashina allaqachon ulangan (config.json'da deviceId bor) — enroll o'tkazib yuboriladi"
  fi
  if $DRY_RUN; then
    ENROLL_CODE="TEST-CODE-DRY-RUN"
  elif ! $ALREADY_ENROLLED; then
    ENROLL_CODE=$("$ADMIN_SCRIPT" enroll-code create --kind agentd --machine-name "$MACHINE_NAME" --ttl-minutes 15 --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));if(!j.code)process.exit(1);process.stdout.write(j.code)})') || {
      echo "Enrollment code yaratishda xato"
      exit 1
    }
    [ -n "$ENROLL_CODE" ] || { echo "Enrollment code bo'sh"; exit 1; }
    echo "  Enrollment code created (TTL: 15 min)"
  fi

  commander_step 5 7 "O'rnatish va enrollment"
  echo "[5/7] Running install and enroll on server..."
  if ! $DRY_RUN; then
    # macOS o'rnatish
    ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
      NODE_BIN="$NODE_BIN" bash -c '
        cd /tmp/commander-onboard
        mkdir -p "$HOME/dist-bundle"
        mv *.mjs "$HOME/dist-bundle/" 2>/dev/null || true
        NODE_BIN="$NODE_BIN" bash agentd-install.sh --no-start 2>&1
      ' || {
      echo "macOS install xatosi"
      exit 1
    }

    # Enrollment (code stdin'dan oqiladi)
    if ! $ALREADY_ENROLLED; then
      MAC_ENROLL_RESULT=$(remote_enroll) || {
        echo "Enroll xatosi:"
        echo "$MAC_ENROLL_RESULT"
        exit 1
      }
      echo "$MAC_ENROLL_RESULT"
      parse_enroll_ids "$MAC_ENROLL_RESULT"
    fi
    unset ENROLL_CODE
  else
    echo "  (dry-run: macOS install and enroll)"
  fi

  # macOS orqali settings.json yangilash shart emas (launchd service o'tishi bunga doir emas)
  commander_step 6 7 "Xabarlashuv xizmati"
  echo "[6/7] Setting up messaging service..."
  if ! $DRY_RUN; then
    ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
      "PATH=\"\$(dirname '$NODE_BIN'):\$PATH\" '$NODE_BIN' '$HOME/.commander/bin/cc-mcp.mjs' register 2>&1" || true
  else
    echo "  (dry-run: messaging setup)"
  fi

  commander_step 7 7 "Servis ishga tushirish"
  echo "[7/7] Starting launchd service..."
  if ! $DRY_RUN; then
    ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -c '
      UID_N=$(id -u)
      LABEL="uz.commander.agentd"
      launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "gui/$UID_N" "$HOME/Library/LaunchAgents/$LABEL.plist" || true
      launchctl kickstart -k "gui/$UID_N/$LABEL" 2>/dev/null || true
      echo "Service started OK"
    ' 2>&1
  else
    echo "  (dry-run: launchctl bootstrap/start)"
  fi

  echo ""
  echo "✅ macOS machine onboarding tayyor!"
  commander_result "$(json_object machineName "$MACHINE_NAME" sshAlias "$SSH_ALIAS" platform macos deviceId "${DEVICE_ID:-}" machineId "${MACHINE_ID:-}" status success)"
  maybe_enable_remote
  exit 0
fi

# Step 1: Preflight checks over SSH
commander_step 1 7 "SSH preflight tekshiruvi"
echo "[1/7] SSH preflight checks..."

PREFLIGHT_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

errors=""

# OS tekshirish
if [ "$(uname -s)" != "Linux" ]; then
  errors="$errors"$'\n'"xato: Linux kerak ($(uname -s) topildi)"
fi

# User tekshirish
if [ "$(id -u)" -eq 0 ]; then
  errors="$errors"$'\n'"xato: root bilan ishga tushirmang"
fi

# Claude yo'lini tekshirish (login shell dan)
CLAUDE_PATH=$(bash -lc 'command -v claude' 2>/dev/null || echo "")
if [ -z "$CLAUDE_PATH" ]; then
  errors="$errors"$'\n'"xato: claude topilmadi (login shell'da PATH'da bo'lsa ham)"
fi

# Node tekshirish (login shell'da, nvm uchun)
NODE_PATH_LOGIN=$(bash -lc 'command -v node' 2>/dev/null || echo "")
# nvm odatda faqat interaktiv shell'da yuklanadi — eng yangi versiyani to'g'ridan-to'g'ri qidiramiz
NODE_MAJOR_LOGIN=0
if [ -n "$NODE_PATH_LOGIN" ]; then
  NODE_MAJOR_LOGIN=$("$NODE_PATH_LOGIN" -v 2>/dev/null | grep -oE '^v[0-9]+' | grep -oE '[0-9]+' || echo 0)
fi
# Login shell'da Node yo'q yoki < 22 (masalan tizim Node'i eski, 22 esa faqat nvm'da): nvm'dagi eng yangisi olinadi
if [ -z "$NODE_PATH_LOGIN" ] || [ "$NODE_MAJOR_LOGIN" -lt 22 ]; then
  NODE_PATH_NVM=$(ls -1d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1 || echo "")
  [ -z "$NODE_PATH_NVM" ] || NODE_PATH_LOGIN="$NODE_PATH_NVM"
fi
if [ -z "$NODE_PATH_LOGIN" ]; then
  errors="$errors"$'\n'"xato: node topilmadi (login shell'da)"
fi

# Node versiyasini tekshirish
if [ -n "$NODE_PATH_LOGIN" ]; then
  NODE_VERSION=$("$NODE_PATH_LOGIN" -v 2>/dev/null || echo "")
  MAJOR=$(echo "$NODE_VERSION" | grep -oE '^v[0-9]+' | grep -oE '[0-9]+' || echo "0")
  if [ "$MAJOR" -lt 22 ]; then
    errors="$errors"$'\n'"xato: Node >= 22 kerak (v$MAJOR topildi)"
  fi
fi

# Systemd --user tekshirish
if ! systemctl --user status >/dev/null 2>&1; then
  errors="$errors"$'\n'"xato: systemd --user mavjud emas"
fi

# Linger tekshirish
LINGER_STATUS=$(loginctl show-user "$USER" -p Linger 2>/dev/null | grep -oE 'yes|no' || echo "unknown")

if [ -n "$errors" ]; then
  echo "PREFLIGHT XATO:$errors"
  exit 1
fi

echo "PREFLIGHT OK"
echo "claude=$CLAUDE_PATH"
echo "node=$NODE_PATH_LOGIN"
echo "linger=$LINGER_STATUS"
EOF
)

if $DRY_RUN; then
  echo "  (dry-run: SSH preflight script)"
  NODE_BIN="/usr/bin/node"
  CLAUDE_BIN="$(command -v claude)"
  LINGER="unknown"
else
  PREFLIGHT_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$PREFLIGHT_SCRIPT" 2>&1) || {
    echo "PREFLIGHT FAILED:"
    echo "$PREFLIGHT_OUTPUT"
    exit 1
  }
  echo "$PREFLIGHT_OUTPUT"

  # Parse preflight output
  CLAUDE_BIN=$(echo "$PREFLIGHT_OUTPUT" | grep "^claude=" | cut -d= -f2-)
  NODE_BIN=$(echo "$PREFLIGHT_OUTPUT" | grep "^node=" | cut -d= -f2-)
  LINGER=$(echo "$PREFLIGHT_OUTPUT" | grep "^linger=" | cut -d= -f2-)
fi

# Step 2: Build bundle locally
commander_step 2 7 "Bundle yigʻish"
echo "[2/7] Building bundle locally..."
if $DRY_RUN; then
  echo "  (dry-run: npm run bundle)"
else
  (cd "$ROOT_DIR" && npm run -w apps/agentd bundle >/dev/null 2>&1) || {
    echo "Bundle qilishda xato"
    exit 1
  }
fi

# Step 3: SCP bundle + install script + service template
commander_step 3 7 "Fayllar serverga nusxalash"
echo "[3/7] Copying files to server..."
if $DRY_RUN; then
  echo "  (dry-run: scp bundle + install script + service template)"
else
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" mkdir -p /tmp/commander-onboard
  scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes \
    "$INSTALL_SCRIPT_LINUX" \
    "$ROOT_DIR/ops/ubuntu/commander-agentd.service.template" \
    "$SSH_ALIAS":/tmp/commander-onboard/ >/dev/null 2>&1
  scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes \
    "$BUNDLE_DIR"/*.mjs \
    "$SSH_ALIAS":/tmp/commander-onboard/ >/dev/null 2>&1
fi

# Step 4: Create enrollment code (mashina allaqachon ulangan bo'lsa — o'tkazib yuboriladi)
commander_step 4 7 "Enrollment kodi yaratish"
echo "[4/7] Creating enrollment code..."
ALREADY_ENROLLED=false
ENROLL_CODE=""
if ! $DRY_RUN && ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
    'grep -q "\"deviceId\"" "$HOME/.commander/config.json" 2>/dev/null'; then
  ALREADY_ENROLLED=true
  echo "  Mashina allaqachon ulangan (config.json'da deviceId bor) — enroll o'tkazib yuboriladi"
fi
if $DRY_RUN; then
  ENROLL_CODE="TEST-CODE-DRY-RUN"
elif ! $ALREADY_ENROLLED; then
  ENROLL_CODE=$("$ADMIN_SCRIPT" enroll-code create --kind agentd --machine-name "$MACHINE_NAME" --ttl-minutes 15 --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));if(!j.code)process.exit(1);process.stdout.write(j.code)})') || {
    echo "Enrollment code yaratishda xato"
    exit 1
  }
  [ -n "$ENROLL_CODE" ] || { echo "Enrollment code bo'sh"; exit 1; }
  echo "  Enrollment code created (TTL: 15 min)"
fi

# Step 5: Install bundle and enroll
commander_step 5 7 "O'rnatish va enrollment"
echo "[5/7] Running install and enroll on server..."
if $DRY_RUN; then
  echo "  (dry-run: enroll script)"
else
  # Separate steps: 1) install, 2) enroll with code
  INSTALL_STEP=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail
BUNDLE_DIR=~/dist-bundle
NODE_BIN="$NODE_BIN"
mkdir -p "$HOME/dist-bundle"
mv /tmp/commander-onboard/*.mjs "$HOME/dist-bundle/" 2>/dev/null || true
BUNDLE_DIR="$BUNDLE_DIR" NODE_BIN="$NODE_BIN" bash /tmp/commander-onboard/agentd-install.sh --no-start 2>&1
EOF
)

  # Step 1: Install binaries and create service
  INSTALL_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" NODE_BIN="$NODE_BIN" bash -s <<< "$INSTALL_STEP" 2>&1) || {
    echo "Install xatosi:"
    echo "$INSTALL_OUTPUT"
    exit 1
  }

  # Step 2: Enroll with code (stdin'dan oqiladi, ps'da ko'rinmaydi)
  if ! $ALREADY_ENROLLED; then
    ENROLL_RESULT=$(remote_enroll) || {
      echo "Enroll xatosi:"
      echo "$ENROLL_RESULT"
      exit 1
    }
    echo "$ENROLL_RESULT"
    parse_enroll_ids "$ENROLL_RESULT"
  fi
  unset ENROLL_CODE
fi

# Step 6: Update settings.json
commander_step 6 7 "Settings.json yangilash"
echo "[6/7] Updating settings.json..."
if $DRY_RUN; then
  echo "  (dry-run: settings merge)"
else
  UPDATE_SETTINGS_SCRIPT=$(cat <<EOFSCRIPT
#!/bin/bash
set -euo pipefail

SETTINGS="\$HOME/.claude/settings.json"
BACKUP="\$SETTINGS.bak-commander-\$(date +%s)"

mkdir -p "\$HOME/.claude"
if [ -f "\$SETTINGS" ]; then
  cp "\$SETTINGS" "\$BACKUP"
  echo "Backup created: \$BACKUP"
else
  echo "{}" > "\$SETTINGS"
  echo "settings.json yo'q edi — yangisi yaratildi"
fi

NODE_BIN="$NODE_BIN"
MACHINE_NAME="$MACHINE_NAME"

"\$NODE_BIN" <<'EONODE'
const fs = require('fs');
const settingsFile = process.env.HOME + '/.claude/settings.json';
let settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));

if (!settings.env) settings.env = {};
Object.assign(settings.env, {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319',
  OTEL_LOGS_EXPORT_INTERVAL: '5000',
  OTEL_RESOURCE_ATTRIBUTES: 'host.name=' + process.env.MACHINE_NAME,
});

const hooks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
const nodeCmd = process.env.NODE_BIN || 'node';
const hookCommand = nodeCmd + ' \$HOME/.commander/bin/cc-hook.mjs';
const hookConfig = {
  type: 'command',
  command: hookCommand,
  timeout: 10,
  async: true
};

for (const hookName of hooks) {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[hookName]) {
    settings.hooks[hookName] = [{ hooks: [hookConfig] }];
  } else {
    const found = settings.hooks[hookName].some(h =>
      h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('cc-hook'))
    );
    if (!found) {
      settings.hooks[hookName].push({ hooks: [hookConfig] });
    }
  }
}

// Masofadan tasdiqlash (1.7): sinxron hook, xato/javobsiz holatda lokal so'rovga qaytadi, hech qachon avto-allow yo'q
{
  const groups = Array.isArray(settings.hooks.PermissionRequest) ? settings.hooks.PermissionRequest : [];
  const found = groups.some(g => g.hooks && g.hooks.some(hh => hh.command && hh.command.includes('cc-hook')));
  if (!found) groups.push({ hooks: [{ type: 'command', command: hookCommand + ' --permission', timeout: 330 }] });
  settings.hooks.PermissionRequest = groups;
}

if (!settings.statusLine) {
  settings.statusLine = {
    type: 'command',
    command: nodeCmd + ' \$HOME/.commander/bin/cc-statusline.mjs'
  };
} else if (settings.statusLine.command && !settings.statusLine.command.includes('cc-statusline')) {
  const existingCmd = settings.statusLine.command;
  settings.statusLine = {
    type: 'command',
    // cc-statusline argv'ni buyruq sifatida bajaradi va chiqishini o'zgartirmaydi
    command: nodeCmd + ' \$HOME/.commander/bin/cc-statusline.mjs ' + existingCmd
  };
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
fs.chmodSync(settingsFile, 0o600);
console.log('Settings updated');
EONODE
EOFSCRIPT
)

  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" NODE_BIN="$NODE_BIN" MACHINE_NAME="$MACHINE_NAME" bash -s <<< "$UPDATE_SETTINGS_SCRIPT" 2>&1
fi

# Step 6b: Sessiyalararo xabar (2.10): UserPromptSubmit `--inbox` + Stop `--inbox-stop` sinxron hook'lari va MCP server (idempotent, zaxira bilan)
commander_step 6 7 "Xabarlashuv xizmati"
echo "[6b/7] Sessiyalararo xabar: hook'lar va MCP server..."
if $DRY_RUN; then
  echo "  (dry-run: commander-messaging-setup.mjs)"
else
  scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes -q "$ROOT_DIR/ops/lib/commander-messaging-setup.mjs" "$SSH_ALIAS":/tmp/commander-onboard/
  # PATH: npm orqali o'rnatilgan `claude` (#!/usr/bin/env node) node'ni topishi uchun
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" \
    "PATH=\"\$(dirname '$NODE_BIN'):\$PATH\" '$NODE_BIN' /tmp/commander-onboard/commander-messaging-setup.mjs --node-bin '$NODE_BIN' --claude-bin '$CLAUDE_BIN'" 2>&1
fi

# Step 7: Start service
commander_step 7 7 "Servis ishga tushirish"
echo "[7/7] Starting systemd service..."
if $DRY_RUN; then
  echo "  (dry-run: systemctl enable/start)"
else
  START_SERVICE_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -euo pipefail

systemctl --user daemon-reload
systemctl --user enable commander-agentd
systemctl --user start commander-agentd

# Tekshirish
sleep 2
if systemctl --user is-active --quiet commander-agentd; then
  echo "Service started OK"
else
  echo "Service start failed"
  journalctl --user -u commander-agentd -n 20
  exit 1
fi
EOF
)

  START_OUTPUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" bash -s <<< "$START_SERVICE_SCRIPT" 2>&1) || {
    echo "Service start xatosi:"
    echo "$START_OUTPUT"
    exit 1
  }
  echo "$START_OUTPUT"

  # Linger ogohlantirish
  if [ "$LINGER" = "no" ]; then
    echo ""
    echo "⚠️  OGOHLANTIRISH: Linger o'zgartirilmadi. Service logout qilib tushadi."
    echo "    Buning oldini olish uchun, server'da ishga tushiring:"
    echo "    ssh -t $SSH_ALIAS 'sudo loginctl enable-linger \$USER'"
  fi
fi

# tmux: "Davom ettirish" / "Yopish" va terminal sessiyalarni boshqarish uchun kerak (6.14). O'rnatish sudo talab qiladi — egasi qiladi.
if ! $DRY_RUN; then
  if ! ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" 'command -v tmux' >/dev/null 2>&1; then
    echo ""
    echo "⚠️  OGOHLANTIRISH: serverda tmux yo'q — \"Davom ettirish\"/\"Yopish\" ishlamaydi. O'rnatish:"
    echo "    ssh -t $SSH_ALIAS 'sudo apt install -y tmux'"
  fi
fi

# Verifikatsiya: agentd status
echo ""
echo "Verifying agentd status..."
if $DRY_RUN; then
  echo "  (dry-run: agentd status)"
else
  STATUS_RESULT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS" "$NODE_BIN" '~/.commander/bin/agentd.mjs' status 2>&1 || echo "Status check failed") || true
  echo "$STATUS_RESULT"
fi

echo ""
echo "✅ Machine onboarding tayyor!"
echo "   SSH alias: $SSH_ALIAS"
echo "   Machine name: $MACHINE_NAME"
if ! $DRY_RUN; then
  echo "   Settings backup: ~/.claude/settings.json.bak-commander-* (serverda)"
fi

# Progress result marker — sirlarni saqlash
if ! $DRY_RUN; then
  commander_result "$(json_object machineName "$MACHINE_NAME" sshAlias "$SSH_ALIAS" platform linux deviceId "${DEVICE_ID:-}" machineId "${MACHINE_ID:-}" status success)"
fi

maybe_enable_remote

# 6.20: so'ralgan bo'lsa interaktiv `claude` ni avtomatik tmux'da ochish (Linux; ~/.bashrc, zaxira bilan)
if $CLAUDE_TMUX; then
  echo ""
  if $DRY_RUN; then echo "  (dry-run: ops/claude-tmux.sh $SSH_ALIAS install)"; else "$ROOT_DIR/ops/claude-tmux.sh" "$SSH_ALIAS" install; fi
fi
