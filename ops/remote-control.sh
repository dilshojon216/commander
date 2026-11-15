#!/bin/bash
# Mashinada masofaviy boshqaruvni (agentd policy) Mac'dan ssh orqali boshqarish — egasi ishga tushiradi (qoida: sukut o'chiq).
# Qo'llash:
#   ops/remote-control.sh <ssh-alias> enable --root <papka> [--root <papka>]...   # yoqish + ruxsat etilgan papkalar
#   ops/remote-control.sh <ssh-alias> enable --home [--root <papka>]...            # butun $HOME ni ildiz qilish (`policy allow-home`; serverlarda sessiyalar uyda ishlasa)
#   ops/remote-control.sh <ssh-alias> disable                                      # o'chirish
#   ops/remote-control.sh <ssh-alias> show                                         # holat
# --home: ~/.ssh ~/.gnupg ~/.aws ~/.claude ~/.commander baribir yopiq qoladi (docs/remote-control.md). `disable` siyosatni o'chiradi (allowedRoots saqlanadi).
# Papka `~/...` bo'lishi mumkin (serverdagi $HOME ga almashtiriladi). OS (Linux/Windows) avtomatik aniqlanadi.
set -euo pipefail

SSH_ALIAS="${1:-}"
ACTION="${2:-}"
usage() { sed -n '3,8p' "$0" | sed 's/^# //'; exit 2; }
[ -n "$SSH_ALIAS" ] && [ -n "$ACTION" ] || usage
shift 2

ROOTS=()
HOME_ROOT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ -n "${2:-}" ] || usage; ROOTS+=("$2"); shift 2 ;;
    --home) HOME_ROOT=true; shift ;;
    *) echo "noma'lum flag: $1"; usage ;;
  esac
done
case "$ACTION" in
  enable) { [ ${#ROOTS[@]} -gt 0 ] || $HOME_ROOT; } || { echo "xato: enable uchun kamida bitta --root <papka> yoki --home kerak"; exit 2; } ;;
  disable | show) { [ ${#ROOTS[@]} -eq 0 ] && ! $HOME_ROOT; } || { echo "xato: --root/--home faqat enable bilan"; exit 2; } ;;
  *) usage ;;
esac

SSH=(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_ALIAS")

OS_PROBE=$("${SSH[@]}" 'echo %OS%' 2>/dev/null | tr -d '\r' | tail -1 || true)

if [ "$OS_PROBE" = "Windows_NT" ]; then
  # Windows: cmd.exe orqali; node PATH'da (preflight shuni talab qiladi)
  AGENTD='"%USERPROFILE%\.commander\bin\agentd.mjs"'
  run() { "${SSH[@]}" "node $AGENTD $*" | tr -d '\r'; }
  win_home=$("${SSH[@]}" 'echo %USERPROFILE%' | tr -d '\r' | tail -1)
  expand() { case "$1" in "~"|"~/"*|"~\\"*) printf '%s%s' "$win_home" "${1:1}" ;; *) printf '%s' "$1" ;; esac; }
  quote() { printf '"%s"' "$1"; }
else
  # Linux: node — systemd unit'dagi aniq yo'l (nvm bo'lsa ham non-interaktiv ssh'da ishlaydi)
  NODE_BIN=$("${SSH[@]}" "sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' ~/.config/systemd/user/commander-agentd.service 2>/dev/null | head -1")
  [ -n "$NODE_BIN" ] || { echo "xato: agentd o'rnatilmagan ($SSH_ALIAS) — avval ops/add-machine.sh"; exit 1; }
  run() { "${SSH[@]}" "$(printf '%q' "$NODE_BIN") ~/.commander/bin/agentd.mjs $*"; }
  remote_home=$("${SSH[@]}" 'printf %s "$HOME"')
  expand() { case "$1" in "~"|"~/"*) printf '%s%s' "$remote_home" "${1:1}" ;; *) printf '%s' "$1" ;; esac; }
  quote() { printf '%q' "$1"; }
fi

case "$ACTION" in
  enable)
    for r in ${ROOTS[@]+"${ROOTS[@]}"}; do
      dir=$(expand "$r")
      echo "ruxsat etilgan papka: $dir"
      run policy allow-root "$(quote "$dir")"
    done
    if $HOME_ROOT; then
      echo "butun \$HOME ildiz qilinmoqda (policy allow-home); ~/.ssh ~/.gnupg ~/.aws ~/.claude ~/.commander yopiq qoladi"
      run policy allow-home
    fi
    run policy enable
    ;;
  disable) run policy disable ;;
  show) ;;
esac

echo ""
echo "=== $SSH_ALIAS: policy ==="
run policy show | grep -E "remote.enabled|allowedRoots|^  - " || true
