#!/bin/bash
# ops/lib/progress.sh va skriptlardagi jarayon markerlari testi: COMMANDER_PROGRESS=1 bo'lmasa marker YO'Q, bo'lsa format barqaror,
# natija JSON'i yaroqli (in'ektsiyasiz) va sirsiz. Hech qanday haqiqiy mashinaga ulanmaydi (faqat --dry-run va kutubxona).
# Ishga tushirish: bash ops/test/test-progress-markers.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "XATO: $1"; }
check() { if eval "$2"; then ok; else bad "$1"; fi; }

# --- kutubxona ---
. "$HERE/lib/progress.sh"

out=$(commander_step 1 3 "Sarlavha" 2>&1); check "env'siz marker yo'q" '[ -z "$out" ]'
out=$(COMMANDER_PROGRESS=1 commander_step 2 7 "Fayllarni nusxalash" 2>&1 >/dev/null)
check "qadam markeri formati" '[ "$out" = "##commander-step 2/7 Fayllarni nusxalash" ]'
out=$(commander_result '{"a":"b"}' 2>&1); check "env'siz natija yo'q" '[ -z "$out" ]'

json=$(json_object machineName 'a"b\c' sshAlias 'x y' deviceId '' status success)
check "bo'sh qiymat tashlanadi" '! echo "$json" | grep -q deviceId'
check "qochirilgan JSON yaroqli" 'echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"machineName\"]==\"a\\\"b\\\\c\""'
inj=$(json_object machineName 'x","status":"hacked')
check "in'ektsiya mumkin emas" 'echo "$inj" | python3 -c "import json,sys; d=json.load(sys.stdin); assert list(d)==[\"machineName\"]"'
nl=$(json_object machineName $'a\nb'); check "yangi qator qochiriladi" 'echo "$nl" | python3 -c "import json,sys; json.load(sys.stdin)"'

# --- add-machine --dry-run ---
all=$("$HERE/add-machine.sh" h --name t --dry-run 2>&1); check "env'siz skriptda marker yo'q" '! echo "$all" | grep -q "^##commander"'
marked=$(COMMANDER_PROGRESS=1 "$HERE/add-machine.sh" h --name t --dry-run 2>/dev/null); check "markerlar stdout'ga tushmaydi" '! echo "$marked" | grep -q "^##commander"'
err=$(COMMANDER_PROGRESS=1 "$HERE/add-machine.sh" h --name t --dry-run 2>&1 >/dev/null)
steps=$(echo "$err" | grep -c '^##commander-step ')
check "kamida 7 ta qadam markeri" '[ "$steps" -ge 7 ]'
check "barcha qadam markerlari formatda" '! echo "$err" | grep "^##commander-step " | grep -vqE "^##commander-step [0-9]+/[0-9]+ .+$"; true'
check "marker satrlarida sir belgisi yo'q" '! echo "$err" | grep "^##commander" | grep -qiE "cmdr_|token|secret|code=|--code"'

# --- remove-machine: har [k/N] qadamda marker bor ---
stages=$(grep -cE '^\s*echo "\[[0-9]/[0-9]\]' "$HERE/remove-machine.sh")
markers=$(grep -cE '^\s*commander_step [0-9] [0-9] ' "$HERE/remove-machine.sh")
check "remove-machine: har qadam markerli ($markers/$stages)" '[ "$stages" -gt 0 ] && [ "$stages" -eq "$markers" ]'
check "remove-machine: natija markeri bor" 'grep -q commander_result "$HERE/remove-machine.sh"'

echo "progress-markers: $pass o'tdi, $fail yiqildi"
[ "$fail" -eq 0 ]
