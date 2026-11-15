#!/bin/bash
# ops/lib/claude-tmux.snippet.sh testi: bash va zsh'da, haqiqiy psevdo-terminal (script) bilan, tmux/claude stub'lari orqali
# qaysi holatda tmux'ga o'raladi, qaysida to'g'ridan-to'g'ri claude chaqiriladi — argv bilan tekshiriladi.
# Haqiqiy ~/.zshrc / ~/.bashrc ga tegmaydi (vaqtinchalik HOME). Ishga tushirish: bash ops/test/test-claude-tmux.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SNIPPET="$HERE/lib/claude-tmux.snippet.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home" "$WORK/my proj"
OUT="$WORK/out.txt"
for b in tmux claude; do
  printf '#!/bin/sh\nprintf "%s" >> "%s"\nfor a in "$@"; do printf " [%%s]" "$a" >> "%s"; done\necho >> "%s"\n' "$b" "$OUT" "$OUT" "$OUT" > "$WORK/bin/$b"
  chmod +x "$WORK/bin/$b"
done

pass=0
fail=0
# $1=shell, $2=env prefix, $3=expected first word (tmux|claude), qolganlari: claude argumentlari
run_case() {
  local sh="$1" envp="$2" want="$3"
  shift 3
  local args=""
  for a in "$@"; do args="$args $(printf '%q' "$a")"; done
  : > "$OUT"
  local cmd="source $(printf '%q' "$SNIPPET"); cd $(printf '%q' "$WORK/my proj"); $envp claude$args"
  # script(1): stdin/stdout TTY bo'lsin (interaktiv terminaldagidek)
  HOME="$WORK/home" PATH="$WORK/bin:/usr/bin:/bin" ZDOTDIR="$WORK/home" script -q /dev/null "$sh" -i -c "$cmd" < /dev/null > /dev/null 2>&1
  local got
  got=$(head -1 "$OUT")
  if [ "${got%% *}" = "$want" ] || [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "XATO [$sh] claude$args -> kutildi '$want', bo'ldi '$got'"
  fi
  LAST="$got"
}

for sh in bash zsh; do
  command -v "$sh" >/dev/null || { echo "o'tkazildi: $sh yo'q"; continue; }
  # o'raladi
  run_case "$sh" "" tmux
  case "$LAST" in *"[-s] [cc-my-proj-"*"[-c] ["*"my proj] [$WORK/bin/claude]"*) pass=$((pass + 1)) ;; *) fail=$((fail + 1)); echo "XATO [$sh] tmux argv: $LAST" ;; esac
  run_case "$sh" "" tmux --model opus
  run_case "$sh" "" tmux --resume abc
  run_case "$sh" "" tmux -c
  run_case "$sh" "" tmux "salom dunyo; rm -rf /"
  case "$LAST" in *"[salom dunyo; rm -rf /]"*) pass=$((pass + 1)) ;; *) fail=$((fail + 1)); echo "XATO [$sh] argument bitta qolmadi: $LAST" ;; esac
  # o'ralmaydi
  for a in "-p hi" "--print hi" "--version" "-v" "--help" "--bg hi" "update" "mcp list" "doctor" "agents" "auth status" "stop x" "plugin list" "--output-format=json -p x"; do
    # shellcheck disable=SC2086
    run_case "$sh" "" claude $a
  done
  run_case "$sh" "COMMANDER_NO_TMUX=1" claude
  run_case "$sh" "TMUX=/tmp/x,1,0" claude
done

# Interaktiv bo'lmagan shell (skript): funksiya o'ramaydi
: > "$OUT"
HOME="$WORK/home" PATH="$WORK/bin:/usr/bin:/bin" bash -c "source $(printf '%q' "$SNIPPET"); claude" < /dev/null > /dev/null 2>&1
if [ "$(head -1 "$OUT")" = "claude" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "XATO interaktiv emas: $(head -1 "$OUT")"; fi

echo "o'tdi: $pass, xato: $fail"
[ "$fail" -eq 0 ]
