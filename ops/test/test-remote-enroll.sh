#!/bin/bash
# add-machine.sh `remote_enroll` testi: enrollment kodi agentd'ga FAQAT stdin orqali yetadi (argv/ps'da va mahalliy ssh buyrug'ida
# yo'q), noto'g'ri formatdagi kod ssh chaqirilmasdan rad etiladi. Soxta `ssh` va soxta agentd; hech qanday haqiqiy mashina yo'q.
# Ishga tushirish: bash ops/test/test-remote-enroll.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home/.commander/bin"
SECRET="ABCDE-FGH23"

# soxta ssh: tanlovlarni (-o X) va host'ni tashlab, qolgan buyruqni mahalliy shell'da bajaradi; o'z argv'ini yozadi
cat > "$WORK/bin/ssh" <<'EOS'
#!/bin/bash
echo "$@" >> "$FAKE_SSH_LOG"
while [ "${1:-}" = "-o" ]; do shift 2; done
shift   # host
exec bash -c "$*"
EOS
# soxta agentd: argv va stdin'ni yozadi
cat > "$WORK/home/.commander/bin/agentd.mjs" <<'EOS'
echo "ARGV:$*" >> "$FAKE_AGENTD_LOG"
read -r line; echo "STDIN:$line" >> "$FAKE_AGENTD_LOG"
echo "enrollment tayyor: deviceId=11111111-2222-4333-8444-555555555555 machineId=66666666-7777-4888-9999-000000000000"
EOS
chmod +x "$WORK/bin/ssh"

export FAKE_SSH_LOG="$WORK/ssh.log" FAKE_AGENTD_LOG="$WORK/agentd.log" HOME="$WORK/home" PATH="$WORK/bin:$PATH"
: > "$FAKE_SSH_LOG"; : > "$FAKE_AGENTD_LOG"

# funksiyalarni add-machine.sh dan ajratib olish (butun skriptni ishga tushirmasdan)
source <(sed -n '/^remote_enroll()/,/^}/p;/^parse_enroll_ids()/,/^}/p' "$HERE/add-machine.sh")
SSH_ALIAS=fake NODE_BIN=bash CLAUDE_BIN=/usr/bin/claude CENTER_URL=https://center.test

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "XATO: $1"; fi; }

ENROLL_CODE="$SECRET"
result=$(remote_enroll); status=$?
check "remote_enroll muvaffaqiyatli" '[ $status -eq 0 ]'
check "ENROLL_OK qaytdi" 'echo "$result" | grep -q ENROLL_OK'
check "kod agentd stdin'iga yetdi" 'grep -q "^STDIN:$SECRET\$" "$FAKE_AGENTD_LOG"'
check "kod agentd argv'ida YO'Q" '! grep "^ARGV:" "$FAKE_AGENTD_LOG" | grep -q "$SECRET"'
check "agentd --code-stdin bilan chaqirildi" 'grep "^ARGV:" "$FAKE_AGENTD_LOG" | grep -q -- "--code-stdin"'
check "mahalliy ssh buyrug'ida kod YO'Q" '! grep -q "$SECRET" "$FAKE_SSH_LOG"'
check "chiqishda kod YO'Q" '! echo "$result" | grep -q "$SECRET"'

parse_enroll_ids "$result"
check "deviceId ajratildi" '[ "$DEVICE_ID" = "11111111-2222-4333-8444-555555555555" ]'
check "machineId ajratildi" '[ "$MACHINE_ID" = "66666666-7777-4888-9999-000000000000" ]'

: > "$FAKE_SSH_LOG"
for bad in "" "abc def" "a;rm -rf /" "x'y" 'a$(id)'; do
  ENROLL_CODE="$bad"; remote_enroll >/dev/null 2>&1; rc=$?
  check "noto'g'ri kod rad etiladi: '$bad'" '[ $rc -ne 0 ]'
done
check "noto'g'ri kodda ssh chaqirilmadi" '[ ! -s "$FAKE_SSH_LOG" ]'

echo "remote-enroll: $pass o'tdi, $fail yiqildi"
[ "$fail" -eq 0 ]
