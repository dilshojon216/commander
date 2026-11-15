# >>> commander claude-tmux >>>
# Commander (6.20): interaktiv `claude` avtomatik tmux ichida ochiladi — sessiyani Commander to'liq boshqaradi
# (prompt, to'xtatish, "Davom ettirish"/"Yopish"). bash va zsh. O'chirish: COMMANDER_NO_TMUX=1 claude ...
# Boshqaruv: ops/claude-tmux.sh <local|ssh-alias> install|uninstall|status
claude() {
  case $- in *i*) ;; *) command claude "$@"; return ;; esac
  if [ -n "${TMUX:-}" ] || [ -n "${COMMANDER_NO_TMUX:-}" ] || [ ! -t 0 ] || [ ! -t 1 ] || ! command -v tmux >/dev/null 2>&1; then
    command claude "$@"; return
  fi
  if [ $# -gt 0 ]; then
    # Subkomandalar (interaktiv REPL emas) — o'zgarishsiz
    case "$1" in
      agents|attach|auth|auto-mode|config|doctor|gateway|import|install|logs|mcp|migrate-installer|plugin|plugins|purge|remote-control|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade)
        command claude "$@"; return ;;
    esac
    # Bosh-siz / bir martalik rejimlar — o'zgarishsiz
    for __cc_a in "$@"; do
      case "$__cc_a" in
        -p|--print|-v|--version|-h|--help|--bg|--output-format|--output-format=*|--input-format|--input-format=*)
          unset __cc_a; command claude "$@"; return ;;
      esac
    done
    unset __cc_a
  fi
  local __cc_bin __cc_name
  # funksiya emas, haqiqiy binary yo'li (bash/zsh): subshell'da funksiyani olib tashlab qidiramiz
  __cc_bin=$(unset -f claude 2>/dev/null; command -v claude) || { command claude "$@"; return; }
  case "$__cc_bin" in /*) ;; *) command claude "$@"; return ;; esac
  __cc_name="cc-$(printf '%s' "${PWD##*/}" | LC_ALL=C tr -c 'A-Za-z0-9_-' '-' | cut -c1-24)-$(printf '%04x' $(( (RANDOM * 32768 + RANDOM) % 65536 )))"
  # tmux >=3.0: buyruq argv sifatida (shell'siz) — argumentlar xavfsiz uzatiladi
  tmux new-session -s "$__cc_name" -c "$PWD" "$__cc_bin" "$@"
}
# <<< commander claude-tmux <<<
