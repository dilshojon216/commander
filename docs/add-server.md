# Yangi server (mashina) qo'shish

Commander'ga yangi Ubuntu yoki Windows mashinani qo'shish bitta buyruq bilan Mac'dan bajariladi:
`ops/add-machine.sh`. Skript ssh orqali serverga kiradi, agentd'ni o'rnatadi, markazga ulaydi va Claude Code
hook'larini sozlaydi. Markaz serverga hech qachon o'zi ulanmaydi — server markazga o'zi (outbound) ulanadi.

## 1. Tayyorgarlik (bir marta, serverda)

| Talab | Tekshirish | Izoh |
|---|---|---|
| Tailscale | `tailscale status` | Server va Mac bitta tailnet'da. Ommaviy port ochilmaydi. |
| Oddiy foydalanuvchi | `whoami` (root emas) | agentd root bilan ishga tushirilmaydi. |
| Node.js ≥ 22 | `node --version` | nvm bilan ham bo'ladi — skript o'zi topadi. |
| Claude Code | `claude --version` | O'rnatilgan va bir marta login qilingan bo'lsin. |
| systemd --user (Linux) | `systemctl --user status` | agentd foydalanuvchi servisi sifatida ishlaydi. |
| tmux (Linux) | `tmux -V` | "Davom ettirish"/"Yopish" va terminal sessiyalarni boshqarish uchun. O'rnatish: `sudo apt install -y tmux`. |
| Windows | Windows 10/11 + OpenSSH Server, Git Bash | Admin bo'lmagan foydalanuvchi; skript preflight'da tekshiradi. |

## 2. Mac'da ssh sozlash

`~/.ssh/config` ga server uchun alias qo'shing (kalit bilan, parolsiz kirish):

```
Host yangi_server
  HostName 100.x.y.z          # Tailscale IP yoki MagicDNS nomi
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
  UseKeychain yes
  AddKeysToAgent yes
```

Birinchi marta qo'lda kirib host kalitini tasdiqlang: `ssh yangi_server` (skript `StrictHostKeyChecking=yes` bilan
ishlaydi — noma'lum host kalitini o'zi qabul qilmaydi). Kirish so'roqsiz ishlashini tekshiring:
`ssh -o BatchMode=yes yangi_server true`.

## 3. Qo'shish

Faqat kuzatish (status, token, limit, suhbatni ko'rish, ruxsat so'rovlariga javob):

```
./ops/add-machine.sh yangi_server --name yangi
```

Kuzatish + masofaviy boshqaruv (sessiya ochish, prompt, to'xtatish, "Davom ettirish"):

```
./ops/add-machine.sh yangi_server --name yangi --enable-remote --home          # butun uy papkasi
./ops/add-machine.sh yangi_server --name yangi --enable-remote --root ~/project # faqat aniq papka
```

- `--name` — dashboard/Telegram'da ko'rinadigan nom.
- `--home` va `--root` haqida: [Masofaviy boshqaruvni yoqish](/help/remote-control).
- `--dry-run` — hech narsa o'zgartirmay, nima qilinishini ko'rsatadi.
- OS (Linux/Windows) avtomatik aniqlanadi; majburlash: `--os linux|windows`.

Windows misoli (alias o'rniga `user@host` ham bo'ladi):

```
./ops/add-machine.sh <user>@<win-pc-ip> --name win-pc
```

## 4. Skript nima qiladi (Linux)

1. **Preflight** — Linux, root emas, `claude`, Node ≥ 22, systemd --user, linger holati.
2. **Bundle** — agentd va hook'lar Mac'da yig'iladi.
3. **Nusxalash** — fayllar serverga (`~/.commander/bin/`).
4. **Enrollment kodi** — bir martalik kod yaratiladi (faqat stdin orqali uzatiladi, hech qayerda chop etilmaydi).
5. **O'rnatish va ulash** — har mashina o'z Ed25519 kalitini yaratadi va markazga ro'yxatdan o'tadi.
6. **settings.json** — `~/.claude/settings.json` ga hook'lar qo'shiladi (eski fayl zaxiralanadi:
   `~/.claude/settings.json.bak-commander-*`); sessiyalararo xabar (MCP) sozlanadi.
7. **Servis** — `commander-agentd` systemd --user servisi ishga tushadi; holat tekshiriladi.

Oxirida (so'ralgan bo'lsa) masofaviy boshqaruv yoqiladi va tmux yo'q bo'lsa ogohlantiriladi.
Skript idempotent: qayta ishga tushirish xavfsiz — **agentd'ni yangilash ham xuddi shu buyruq**.

## 5. Keyin (bir marta, serverda)

- **Linger** (server qayta yonganda agentd o'zi ishga tushishi uchun). Skript ogohlantirsa:
  ```
  ssh -t yangi_server 'sudo loginctl enable-linger $USER'
  ```
- **tmux** yo'q bo'lsa: `ssh -t yangi_server 'sudo apt install -y tmux'`.

## 6. Tekshirish

- Dashboard → **Mashinalar**: yangi mashina onlayn (yashil), agentd versiyasi ko'rinadi.
- Serverda: `node ~/.commander/bin/agentd.mjs status` va `node ~/.commander/bin/agentd.mjs policy show`.
- Serverda `claude` sessiyasini oching — u bir necha soniyada **Sessiyalar** ro'yxatida paydo bo'ladi.

## 7. Muammolar

| Belgi | Sabab va yechim |
|---|---|
| `Permission denied (publickey)` | ssh-agent'da kalit yo'q (Mac qayta yongandan keyin): `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`. |
| `Host key verification failed` | Birinchi marta qo'lda `ssh yangi_server` qilib host kalitini tasdiqlang. |
| `node topilmadi` / `Node >= 22 kerak` | Serverda Node 22+ o'rnating (nvm yoki NodeSource). |
| `claude topilmadi` | Serverda Claude Code'ni o'rnating va login qiling. |
| `systemd --user mavjud emas` | Foydalanuvchi sessiyasi yo'q — linger'ni yoqing va qayta kiring. |
| Mashina oflayn | Serverda: `systemctl --user status commander-agentd`, log: `journalctl --user -u commander-agentd -n 50`. |
| "Masofaviy boshqaruv o'chiq" | Kutilgan holat — [yo'riqnoma](/help/remote-control) bo'yicha yoqing. |

## 8. Mashinani olib tashlash

```
./ops/remove-machine.sh yangi_server
```

Servis to'xtatiladi va o'chiriladi. Dashboard'dagi tarix (sessiyalar, tokenlar) saqlanib qoladi.
Mashinaning kalitini markazda bekor qilish (revoke) avtomatik emas — skript oxirida ko'rsatgan device ID bilan qo'lda:
`ops/mac/commander-admin.sh device revoke <device-id>`.

## Hozirgi mashinalar

| ssh alias | Nom | OS |
|---|---|---|
| (lokal) | users-macbook-pro | macOS (markaz) |
| ProdAGlobal | prod-a | Ubuntu |
| prod_b_global | prod-b | Ubuntu |
| dev_box | agent | Ubuntu |
| testserverHome | testserver | Ubuntu |
| acme_app_ai | acmeapp-ai | Ubuntu |
| <user>@<win-pc-ip> | win-pc | Windows |
