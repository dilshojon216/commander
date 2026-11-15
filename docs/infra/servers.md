# Commander Servers

Onboarded machines - SSH aliases va machine names.

## Onboarded Machines

| SSH Alias | Machine Name | Status |
|---|---|---|
| (Mac) | users-macbook-pro | online (center) |
| ProdAGlobal | ProdAGlobal | pending |
| prod_b_global | prod_b_global | pending |
| dev_box | dev_box | pending |
| testserver | testserver | pending |
| acme_app_ai | acme_app_ai | pending |
| `<user>@<win-pc-ip>` (Windows 11, hostname <win-hostname>) | win-pc | online (center, 2026-11-13) |

## Adding a Machine

```bash
cd ops
./add-machine.sh <ssh-alias | user@host> [--name <machine-name>] [--os linux|windows] [--dry-run]
```

OS ssh orqali avtomatik aniqlanadi (faqat o'qiydi). `--dry-run` hech narsa o'zgartirmaydi.
`~/.ssh/config` alias o'rniga `user@ip` ham ishlaydi (Windows PC uchun: `./add-machine.sh <user>@<win-pc-ip> --name win-pc`).

### Linux

Preflight checks:
- OS: Linux
- User: not root
- Claude: available in login shell PATH
- Node: >= 22, available in login shell PATH
- systemd --user: available

Steps:
1. SSH preflight checks
2. Build bundle locally
3. Copy bundle + install script to server
4. Create enrollment code (TTL: 15 min)
5. Run install + enroll on server
6. Update ~/.claude/settings.json (backup created)
7. Enable and start systemd service

Verification:
- agentd status check
- Center database query (machine online)

### Windows (10/11, OpenSSH)

Talablar: OpenSSH server (kalit bilan, BatchMode), Node >= 22 (PATH'da), `claude` (PATH'da; npm `claude.cmd` ham bo'ladi),
**Git for Windows** (Claude Code hook buyruqlarini Git Bash orqali bajaradi), foydalanuvchi Windows'ga kirgan bo'lishi
(Task "faqat kirganda ishlaydi" rejimida). Admin huquqi kerak emas.

Qadamlar (`ops/windows/*`): preflight.ps1 (o'qiydi) -> bundle build -> scp -> `agentd-install.ps1 -NoStart`
(`~/.commander/bin`, `.commander` ACL: foydalanuvchi+SYSTEM+Administrators, Scheduled Task "Commander agentd" + yashirin nazoratchi VBS)
-> `enroll.ps1` (kod faqat stdin orqali; allaqachon enroll qilingan bo'lsa o'tkazib yuboriladi) -> `merge-claude-settings.mjs`
(zaxira `settings.json.bak-commander-<ts>`, JSON tekshiruv; hook buyrug'i `"C:/Program Files/nodejs/node.exe" "C:/Users/<u>/.commander/bin/cc-hook.mjs"`)
-> `start-task.ps1` -> `agentd status` ws `ready` + `verify-hook.mjs` (sintetik SessionStart, Git Bash orqali).

Qo'lda boshqarish (PC'da, oddiy PowerShell):
```powershell
Get-ScheduledTask -TaskName 'Commander agentd'                  # holat
Stop-ScheduledTask / Start-ScheduledTask -TaskName 'Commander agentd'
node "$env:USERPROFILE\.commander\bin\agentd.mjs" status       # ws holati
Get-Content "$env:LOCALAPPDATA\commander\agentd.log" -Tail 50   # log (5 MB, .1 zaxira)
powershell -ExecutionPolicy Bypass -File agentd-uninstall.ps1    # ops/windows/; -Purge kalit va configni ham o'chiradi
```

Eslatma: `remove-machine.sh` hozircha faqat Linux; Windows uchun `agentd-uninstall.ps1` + settings.json zaxirasidan tiklash + markazda `device revoke` qo'lda.

## Removing a Machine

```bash
cd ops
./remove-machine.sh <ssh-alias>
```

Steps:
1. Stop and disable systemd service
2. Uninstall binaries
3. Restore settings.json from backup
4. Clear device config

Note: Device revoke on center (if needed) must be done manually via:
```bash
ops/mac/commander-admin.sh device revoke <device-id>
```

## Troubleshooting

### Windows: agentd ishlamayapti
- Foydalanuvchi Windows'ga kirmagan bo'lsa Task ishga tushmaydi (qo'lda kiring; Task `AtLogOn`).
- `agentd status` "ulanib bo'lmadi": log'ni ko'ring (`%LOCALAPPDATA%\commander\agentd.log`); `EADDRINUSE` = boshqa agentd nusxasi allaqachon ishlayapti.
- SSH sessiyasi administrator foydalanuvchida "elevated" bo'ladi: bu normal, Task baribir oddiy (Limited) huquq bilan ishlaydi.
- Hook ishlamasa: `node verify-hook.mjs --bash "C:\Program Files\Git\bin\bash.exe" --session-id zz-test` (ops/windows/).

### Linger not enabled
If service stops after logout, run on the server:
```bash
sudo loginctl enable-linger $USER
```

### Settings merge failed
The script backs up settings.json before merging (`.bak-commander-<timestamp>`).
To restore manually:
```bash
cp ~/.claude/settings.json.bak-commander-* ~/.claude/settings.json
chmod 600 ~/.claude/settings.json
```

### Enrollment code expired
Create a new one and retry enroll:
```bash
NODE_BIN=/path/to/node ~/.commander/bin/agentd.mjs enroll \
  --center <url> \
  --code <new-code> \
  --claude-bin $(command -v claude)
```
