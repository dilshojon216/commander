# Masofaviy boshqaruvni yoqish

## Nima bu

Commander ikki xil ishlaydi:

- **Kuzatish** (status, token, limit) har doim ishlaydi. Mashinaga agentd o'rnatilishi bilan ko'rinadi.
- **Masofaviy boshqaruv** (yangi sessiya ochish, prompt yuborish, to'xtatish, ruxsat berish) har bir mashinada **sukut bo'yicha O'CHIQ**.

Sabab: masofadan bajarish = RCE (masofadan kod ishga tushirish). Shuning uchun uni faqat mashina egasi, ongli ravishda yoqadi. Markaz (center) buni o'zi yoqa olmaydi va o'zgartira olmaydi.

## Qanday ishlaydi

1. Mac'dan `ops/remote-control.sh` ssh orqali serverga kiradi.
2. U yerdagi agentd'ning lokal `~/.commander/policy.json` faylini o'zgartiradi: `agentd policy enable` va `agentd policy allow-root <papka>`.
3. Center serverga hech qachon o'zi ulanmaydi. Mashina center'ga faqat tashqariga (outbound) ulanadi, siyosat esa mashinaning o'zida turadi.
4. `allowedRoots` ruxsat etilgan papkalar ro'yxati: Commander faqat shu papkalar ichida sessiya ocha oladi. `~/.ssh`, `~/.aws`, `~/.claude`, `~/.commander` kabi maxfiy papkalar hech qachon ruxsat etilmaydi. Fayl tizimi ildizi (`/`, `C:\`) doim rad etiladi. `$HOME` ning o'zi `allow-root` bilan rad etiladi: uni faqat alohida, ongli buyruq `policy allow-home` (yoki `--home`) qo'shadi, qarang "Butun $HOME ni ildiz qilish".

Siyosat fayli yo'q, buzuq yoki boshqalarga ochiq bo'lsa, masofaviy boshqaruv "o'chiq" hisoblanadi.

## Buyruqlar (Mac'dan)

```bash
# Yoqish: kamida bitta --root yoki --home kerak
./ops/remote-control.sh <ssh-alias> enable --root <papka> [--root <papka> ...]

# Butun $HOME ni ildiz qilib yoqish (serverlarda sessiyalar uyda ishlasa); --root bilan birga ham bo'ladi
./ops/remote-control.sh <ssh-alias> enable --home

# Holatni ko'rish
./ops/remote-control.sh <ssh-alias> show

# O'chirish
./ops/remote-control.sh <ssh-alias> disable
```

Eslatmalar:

- `--root` va `--home` faqat `enable` bilan ishlatiladi.
- Papkadagi `~` serverdagi `$HOME` ga almashtiriladi: `--root ~/project`.
- OS (Linux yoki Windows) avtomatik aniqlanadi.
- Windows misoli: `./ops/remote-control.sh "<user>@<win-pc-ip>" enable --root E:/working`
- ssh `BatchMode` va `StrictHostKeyChecking=yes` bilan ishlaydi: parol so'ralmaydi, server oldindan `known_hosts` da bo'lishi kerak.

Misol:

```bash
./ops/remote-control.sh dev_box enable --root ~/project --root ~/work
./ops/remote-control.sh dev_box show
```

## Yangi server qo'shish

```bash
./ops/add-machine.sh <alias> --name <nom> --enable-remote --root ~/project
```

Sessiyalar uy papkasining o'zida ishlaydigan serverlar uchun: `./ops/add-machine.sh <alias> --name <nom> --enable-remote --home` (`--root` shart emas; ikkalasini birga ham berish mumkin).

`--enable-remote` bo'lmasa mashina faqat **kuzatish** rejimida qo'shiladi. `--root` / `--home` faqat `--enable-remote` bilan beriladi (kamida bittasi kerak). Keyinroq yoqish uchun yuqoridagi `remote-control.sh enable` yetarli.

## Butun $HOME ni ildiz qilish (`--home` / `allow-home`)

Serverlarda ko'pincha sessiyalar uy papkasining o'zida (`/home/prod-a` va h.k.) ishlaydi, shuning uchun `allow-root ~/project` yetmaydi. Egasi qarori (2026-11-14, PLAN.md ADR) bo'yicha `$HOME` ni ildiz qilish mumkin, lekin faqat aniq buyruq bilan:

```bash
./ops/remote-control.sh <ssh-alias> enable --home      # serverlarga tavsiya (sessiyalar uyda ishlasa)
node ~/.commander/bin/agentd.mjs policy allow-home      # serverning o'zida; yoqganda ogohlantirish chiqadi
node ~/.commander/bin/agentd.mjs policy deny-home       # qaytarish (faqat $HOME ni olib tashlaydi)
```

- `policy allow-root $HOME` hamon rad etiladi (xato `allow-home` ni ko'rsatadi): tasodifan keng ildiz qo'shib bo'lmaydi. Fayl tizimi ildizi (`/`, `C:\`) har qanday holda taqiq.
- **Nima ochiladi:** `$HOME` va uning HAR QANDAY ichki papkasida sessiya ochish/davom ettirish, prompt, loyiha md o'qish/TASKS.md tahrirlash, git, checkpoint, scan va (`allow-deploy` bo'lsa) deploy. Yani Claude shu papkalardagi hamma fayllarni o'qishi/yozishi mumkin bo'lgan sessiyalarni masofadan boshqarish mumkin.
- **Baribir yopiq qoladi** (cwd sifatida ham, loyiha md o'qishda ham, scan'da ham): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.claude`, `~/.commander`, `~/.config/commander` (va `COMMANDER_HOME` boshqa joyga ko'rsatsa, o'sha papka). Ularga symlink orqali kirish ham rad etiladi (realpath).
- **Himoyalanmagan:** boshqa maxfiy fayllar (`~/.bashrc`, `~/.netrc`, `~/.kube`, `~/.docker`, `~/.config/gh`, `.env` fayllar). `$HOME` ichida ochilgan sessiya ularni Claude vositalari orqali o'qishi yoki yozishi mumkin; shuning uchun faqat ishonchli serverlarda yoqing va `auto` rejimini yoqmang.
- Log ildizlari (`allow-log-root`) uchun `$HOME` rad etiladi.

## Hozirgi mashinalar

| ssh alias | Commander nomi |
|---|---|
| `ProdAGlobal` | prod-a |
| `prod_b_global` | prod-b |
| `dev_box` | agent |
| `testserverHome` | testserver |
| `acme_app_ai` | acmeapp-ai |
| `<user>@<win-pc-ip>` | win-pc |
| (lokal Mac) | Mac |

Mac o'zida ssh kerak emas: agentd buyrug'ini to'g'ridan-to'g'ri ishga tushiring (keyingi bo'lim).

## Qo'lda (serverda)

Serverga kirib, agentd'ning o'zini ishga tushirish mumkin:

```bash
node ~/.commander/bin/agentd.mjs policy show
node ~/.commander/bin/agentd.mjs policy enable
node ~/.commander/bin/agentd.mjs policy allow-root ~/project
node ~/.commander/bin/agentd.mjs policy disable
```

Hamma `policy` buyruqlari (`allow-root` va boshqalar papka talab qiladi, u mutlaq va mavjud bo'lishi shart):

| Buyruq | Nima qiladi | Sukut |
|---|---|---|
| `policy show` | Joriy siyosatni ko'rsatadi | - |
| `policy enable` / `disable` | Masofaviy boshqaruvni yoqadi / o'chiradi | o'chiq |
| `policy allow-root <papka>` | Papkani ruxsat etilganlarga qo'shadi (sessiya ochish faqat shu ichida) | bo'sh |
| `policy remove-root <papka>` | Papkani ro'yxatdan olib tashlaydi | - |
| `policy allow-home` / `deny-home` | Butun `$HOME` ni ildiz qiladi / olib tashlaydi (maxfiy papkalar yopiq qoladi; ogohlantirish chiqadi) | taqiq |
| `policy allow-auto` / `deny-auto` | `auto` ruxsat rejimi (avto-tasdiq) | taqiq |
| `policy allow-config` / `allow-config-read` / `deny-config` | Sozlamalar sinxronlash: o'qish va yozish / faqat o'qish / taqiq | taqiq |
| `policy allow-logs` / `deny-logs` | Log ko'ruvchi (docker, journal; faqat o'qish) | ruxsat |
| `policy allow-log-root <papka>` / `remove-log-root <papka>` | Fayl loglari uchun ruxsat etilgan papka | bo'sh |
| `policy allow-scan` / `deny-scan` | Xavfsizlik / dependency tekshiruvi (faqat o'qish) | ruxsat |
| `policy allow-deploy` / `deny-deploy` | Deploy va rollback (qadamlarni mashinada bajaradi = RCE). `deny-deploy` shell'ni ham o'chiradi | taqiq |
| `policy allow-deploy-shell` / `deny-deploy-shell` | Deploy retseptidagi `shell:` qadamlari (alohida ruxsat) | taqiq |

Hamma buyruqlar faqat `policy enable` bo'lgandagina ta'sir qiladi: u o'chiq bo'lsa, qolgan ruxsatlar ham rad etiladi. Siyosat markazdan o'zgartirilmaydi.

## Tekshirish va muammolar

Yoqqandan keyin:

```bash
./ops/remote-control.sh <ssh-alias> show
```

`remote.enabled: true` va `allowedRoots` ro'yxatida papkangiz ko'rinishi kerak. Dashboard'da mashina kartasi va "Yangi sessiya" oynasida mashina faollashadi.

| Xabar yoki holat | Sabab va yechim |
|---|---|
| `xato: agentd o'rnatilmagan` | Serverda agentd yo'q: avval `./ops/add-machine.sh <alias> --name <nom>` |
| `node topilmadi` (preflight) | Serverda Node 22+ yo'q yoki login shell'da PATH'da emas. Node'ni o'rnating (nvm bo'lsa ham ishlaydi, lekin versiya 22+ bo'lsin) |
| ssh `Permission denied` / parol so'raydi | `BatchMode` ishlatiladi: kalit bilan kirish sozlangan bo'lishi kerak (`~/.ssh/config` dagi alias va kalit) |
| `Host key verification failed` | Server `known_hosts` da yo'q. Bir marta qo'lda `ssh <alias>` qilib, barmoq izini tasdiqlang |
| `allow-root: papka mavjud emas` / `mutlaq yo'l kerak` | Papka serverda mavjud va mutlaq (yoki `~/...`) bo'lishi kerak |
| `allow-root: $HOME ning o'zi ... ruxsat etilmaydi` | Aniq loyiha papkasini bering (`~/project`) yoki butun uy uchun ongli ravishda `policy allow-home` / `--home` |
| `policy fayli yaroqsiz yoki xavfsiz emas` | `~/.commander/policy.json` buzilgan yoki ruxsatlari ochiq: `chmod 600 ~/.commander/policy.json` yoki faylni o'chirib, qaytadan yoqing |
| Dashboard'da hamon "o'chiq" | Bir necha soniya kuting (agentd siyosatni qayta o'qiydi), `show` bilan tekshiring. Mashinada agentd eski bo'lsa, uni yangilang |
| Mashina oflayn | Boshqaruv ishlamaydi: avval agentd ishlayotganini tekshiring (`systemctl --user status commander-agentd`) |

## tmux talabi

To'liq boshqaruv uchun Linux serverda **tmux** o'rnatilgan bo'lishi kerak:

| Imkoniyat | tmux kerakmi |
|---|---|
| Kuzatish, ruxsat so'rovlari, Claude savollariga javob | yo'q |
| Commander orqali yangi sessiya (`claude --bg`) va unga prompt | yo'q |
| "Davom ettirish", "Yopish", terminalda ochilgan sessiyani boshqarish | **ha** |

O'rnatish: `ssh -t <ssh-alias> 'sudo apt install -y tmux'`. `ops/add-machine.sh` tmux yo'qligini aniqlasa ogohlantiradi.
Windows'da tmux yo'q: u yerda "Davom ettirish"/"Yopish" ishlamaydi.

## Terminal sessiyalarini avtomatik tmux'da ochish

Oddiy terminal oynasida ochilgan `claude` ni Commander faqat **ko'radi** (prompt yuborib bo'lmaydi). Agar `claude` tmux
ichida ochilsa — to'liq boshqariladi: prompt, to'xtatish, "Davom ettirish", "Yopish". Buni har safar qo'lda qilmaslik uchun:

```
./ops/claude-tmux.sh local install            # shu Mac (~/.zshrc)
./ops/claude-tmux.sh testserverHome install  # server (~/.bashrc)
./ops/claude-tmux.sh <alias> status           # holat
./ops/claude-tmux.sh <alias> uninstall        # olib tashlash
```

O'rnatilgach, **yangi terminal oynasida** `claude` yozasiz — u o'zi `cc-<papka>-xxxx` nomli tmux sessiyasida ochiladi.

- O'zgarishsiz qoladi: `claude -p`, `--print`, `--version`, `--help`, `--bg`, subkomandalar (`mcp`, `update`, `doctor`,
  `agents`, `auth`, `stop` …), skriptlar va allaqachon tmux ichidagi terminal.
- Bir martalik o'chirish: `COMMANDER_NO_TMUX=1 claude`.
- tmux'dan chiqmasdan ajralish: `Ctrl-b` keyin `d` (sessiya ishlashda davom etadi); qaytish: `tmux attach -t cc-…`.
- Skroll: `Ctrl-b [` (chiqish `q`). Qulaylik uchun `~/.tmux.conf` ga: `set -g mouse on` va `set -g history-limit 50000`.
- rc fayl o'zgartirishdan oldin zaxiralanadi: `~/.zshrc.bak-commander-<vaqt>`.
- Yangi server qo'shishda: `./ops/add-machine.sh <alias> --name <nom> --claude-tmux`.
- Windows: qo'llab-quvvatlanmaydi (tmux yo'q).
