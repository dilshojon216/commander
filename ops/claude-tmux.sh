#!/bin/bash
# Interaktiv `claude` ni avtomatik tmux ichida ochish (6.20): rc faylga snippet o'rnatadi/olib tashlaydi.
# Qo'llash:
#   ops/claude-tmux.sh local install|uninstall|status          # shu Mac (~/.zshrc) yoki shu Linux (~/.bashrc)
#   ops/claude-tmux.sh <ssh-alias> install|uninstall|status    # server (Linux, ~/.bashrc) ssh orqali
# rc fayl o'zgartirishdan oldin zaxiralanadi (<rc>.bak-commander-<vaqt>). Snippet: ops/lib/claude-tmux.snippet.sh.
# Windows qo'llab-quvvatlanmaydi (tmux yo'q).
set -euo pipefail

TARGET="${1:-}"
ACTION="${2:-}"
usage() { sed -n '3,5p' "$0" | sed 's/^# //'; exit 2; }
[ -n "$TARGET" ] || usage
case "$ACTION" in install | uninstall | status) ;; *) usage ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
SNIPPET="$HERE/lib/claude-tmux.snippet.sh"
[ -f "$SNIPPET" ] || { echo "snippet topilmadi: $SNIPPET" >&2; exit 1; }

# Masofada ham, lokalda ham bir xil ishlaydigan amal (bash). $1=action, $2=rc fayl; snippet stdin'dan (install).
# `$( heredoc )` bash 3.2'da case qavslarini buzadi — read -d '' bilan o'qiymiz
IFS= read -r -d '' REMOTE_ACTION <<'EOF' || true
set -euo pipefail
action="$1"; rc="$2"
begin='# >>> commander claude-tmux >>>'
end='# <<< commander claude-tmux <<<'
installed() { [ -f "$rc" ] && grep -qF "$begin" "$rc"; }
strip() { awk -v b="$begin" -v e="$end" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$rc"; }
case "$action" in
  status)
    if installed; then echo "o'rnatilgan: $rc"; else echo "o'rnatilmagan: $rc"; fi
    command -v tmux >/dev/null 2>&1 && echo "tmux: $(tmux -V)" || echo "OGOHLANTIRISH: tmux yo'q — o'rnating (Linux: sudo apt install -y tmux; Mac: brew install tmux)"
    ;;
  install)
    snippet=$(cat)
    touch "$rc"
    cp -p "$rc" "$rc.bak-commander-$(date +%Y%m%d-%H%M%S)"
    tmp=$(mktemp); strip > "$tmp"; printf '\n%s\n' "$snippet" >> "$tmp"
    cat "$tmp" > "$rc"; rm -f "$tmp"
    echo "o'rnatildi: $rc (yangi terminal oynasida yoki 'source $rc' dan keyin ishlaydi)"
    command -v tmux >/dev/null 2>&1 || echo "OGOHLANTIRISH: tmux yo'q — o'rnatilmaguncha claude odatdagidek ochiladi"
    ;;
  uninstall)
    if ! installed; then echo "o'rnatilmagan: $rc"; exit 0; fi
    cp -p "$rc" "$rc.bak-commander-$(date +%Y%m%d-%H%M%S)"
    tmp=$(mktemp); strip > "$tmp"; cat "$tmp" > "$rc"; rm -f "$tmp"
    echo "olib tashlandi: $rc (ochiq terminallarda: unset -f claude)"
    ;;
esac
EOF

if [ "$TARGET" = "local" ]; then
  case "$(uname -s)" in
    Darwin) RC="$HOME/.zshrc" ;;
    Linux) RC="$HOME/.bashrc" ;;
    *) echo "qo'llab-quvvatlanmaydi: $(uname -s)"; exit 1 ;;
  esac
  bash -c "$REMOTE_ACTION" _ "$ACTION" "$RC" < "$SNIPPET"
  exit 0
fi

SSH=(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes "$TARGET")
OS_PROBE=$("${SSH[@]}" 'echo %OS%' 2>/dev/null | tr -d '\r' | tail -1 || true)
[ "$OS_PROBE" != "Windows_NT" ] || { echo "Windows qo'llab-quvvatlanmaydi (tmux yo'q)"; exit 1; }
REMOTE_OS=$("${SSH[@]}" 'uname -s' | tr -d '\r')
case "$REMOTE_OS" in
  Linux) RC_REMOTE='$HOME/.bashrc' ;;
  Darwin) RC_REMOTE='$HOME/.zshrc' ;;
  *) echo "qo'llab-quvvatlanmaydi: $REMOTE_OS"; exit 1 ;;
esac
# Skript argv'da (printf %q), snippet stdin'da; rc yo'li serverda kengayadi
"${SSH[@]}" "bash -c $(printf '%q' "$REMOTE_ACTION") _ $(printf '%q' "$ACTION") \"$RC_REMOTE\"" < "$SNIPPET"
