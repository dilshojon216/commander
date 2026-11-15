#!/bin/bash
# Remote boshqaruv (2.3-2.7) jonli sinovi: FAQAT shu Mac'da, vaqtinchalik papkada, haiku bilan.
# Qadamlar: policy'ni faqat shu papka uchun yoqadi -> qisqa muddatli control tokeni -> `session.start` (Telegram'da
# "Tasdiqlash" tugmasini 2 daqiqa ichida BOSING) -> prompt -> stop -> tozalash (policy o'chiriladi, token revoke, papka o'chadi).
# Token faqat 0600 faylda, hech qachon chop etilmaydi. Foydalanish: bash ops/mac/control-smoke.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="${NODE:-/opt/homebrew/opt/node@24/bin/node}"
AGENTD="$NODE $HOME/.commander/bin/agentd.mjs"
API="http://127.0.0.1:4317"
DIR="$ROOT/.cmdr-control-smoke"   # ishonchli ish papkasi (commander) ichida: yangi papka "Workspace not trusted" beradi
WORK="$(mktemp -d)"; umask 077
TOKEN_FILE="$WORK/token"; TOKEN_ID=""

cleanup() {
  set +e
  $AGENTD policy remove-root "$DIR" >/dev/null 2>&1; $AGENTD policy disable >/dev/null 2>&1
  [ -n "$TOKEN_ID" ] && bash "$ROOT/ops/mac/commander-admin.sh" token revoke "$TOKEN_ID" >/dev/null 2>&1
  for id in $(claude agents --all --json 2>/dev/null | python3 -c "import json,sys; [print(e['id']) for e in json.load(sys.stdin) if e.get('id') and e.get('cwd','').endswith('.cmdr-control-smoke')]"); do claude stop "$id" >/dev/null 2>&1; sleep 3; claude rm "$id" >/dev/null 2>&1; done
  claude purge "$DIR" --yes >/dev/null 2>&1; rm -rf "$DIR"; shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"; rm -rf "$WORK"
  echo "tozalandi: policy o'chiq, token revoke, papka o'chirildi"
}
trap cleanup EXIT

mkdir -p "$DIR"
$AGENTD policy allow-root "$DIR" >/dev/null && $AGENTD policy enable >/dev/null
J=$(bash "$ROOT/ops/mac/commander-admin.sh" token create --kind web --name control-smoke --scopes read,control --expires-days 1 --json)
printf '%s' "$J" | python3 -c "import json,sys; d=json.load(sys.stdin); open('$TOKEN_FILE','w').write(d['token']); print(d['id'])" > "$WORK/id"; TOKEN_ID=$(cat "$WORK/id")
H() { echo "Authorization: Bearer $(cat "$TOKEN_FILE")"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
wait_status() { # <commandId> <timeoutSec> -> yakuniy status
  for _ in $(seq 1 "$2"); do
    S=$(curl -s -H "$(H)" "$API/v1/commands/$1" | field "d['status']+' '+str(d['errorCode'])")
    case "$S" in done*|failed*|rejected*|expired*) echo "$S"; return;; esac; sleep 2
  done; echo "timeout"
}
MID=$(curl -s -H "$(H)" "$API/v1/machines" | python3 -c "import json,sys; print([m['id'] for m in json.load(sys.stdin)['items'] if m['slug'].startswith('users-mbp')][0])")
# Center policy holatini heartbeat (15 s) orqali biladi: yoqilgani markazga yetguncha kutamiz
echo "0) policy yoqildi, markaz bilishini kutyapmiz (≤45 s)..."
for _ in $(seq 1 45); do
  EN=$(curl -s -H "$(H)" "$API/v1/machines" | python3 -c "import json,sys; m=[m for m in json.load(sys.stdin)['items'] if m['id']=='$MID'][0]; print('1' if (m.get('control') or {}).get('enabled') else '0')")
  [ "$EN" = "1" ] && break; sleep 1
done
[ "$EN" = "1" ] || { echo "   markaz policy yoqilganini ko'rmadi"; exit 1; }
echo "1) session.start yuborilmoqda: Telegram'da 'Tasdiqlash' tugmasini 2 daqiqa ichida bosing..."
R=$(curl -s -X POST "$API/v1/commands" -H "$(H)" -H 'content-type: application/json' -d "{\"type\":\"session.start\",\"machineId\":\"$MID\",\"cwd\":\"$DIR\",\"prompt\":\"Reply with exactly the word SMOKE0 and nothing else.\",\"model\":\"haiku\",\"permissionMode\":\"plan\"}")
CID=$(echo "$R" | field "d['command']['id']"); echo "   status: $(echo "$R" | field "d['command']['status']+' '+str(d['command']['errorCode'])")"
echo "   natija: $(wait_status "$CID" 70)"
SESS=None
for _ in $(seq 1 15); do
  SESS=$(curl -s -H "$(H)" "$API/v1/commands/$CID" | field "d['sessionId']"); [ "$SESS" != "None" ] && break; sleep 2
done
echo "   sessiya: $SESS"
[ "$SESS" != "None" ] || exit 1
echo "   birinchi javob tugashini kutyapmiz..."
for _ in $(seq 1 30); do
  # markaz sessiyani darhol 'idle' qilib yaratadi: birinchi javob tugaganini 'done' bildiradi
  ST=$(curl -s -H "$(H)" "$API/v1/sessions/$SESS" | field "d['status']"); [ "$ST" = done ] && break; sleep 2
done
echo "2) session.prompt"
P=$(curl -s -X POST "$API/v1/commands" -H "$(H)" -H 'content-type: application/json' -d "{\"type\":\"session.prompt\",\"sessionId\":\"$SESS\",\"text\":\"Reply with exactly the word SMOKE1 and nothing else.\"}" | field "d['command']['id']")
echo "   natija: $(wait_status "$P" 60)"
echo "3) session.stop"
S2=$(curl -s -X POST "$API/v1/commands" -H "$(H)" -H 'content-type: application/json' -d "{\"type\":\"session.stop\",\"sessionId\":\"$SESS\"}" | field "d['command']['id']")
echo "   natija: $(wait_status "$S2" 40)"
