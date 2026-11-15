# Commander — Claude Code buyruq markazi

Bitta foydalanuvchi uchun platforma: barcha Mac, Windows va Ubuntu mashinalardagi
[Claude Code](https://claude.com/claude-code) sessiyalarini bitta markazdan **kuzatish** va **boshqarish**.

- **Kuzatish:** sessiya holati (ishlayapti / kutyapti / tugadi), token sarfi, obuna limitlari
  (rasmiy qiymat yoki taxmin ekani doim ko'rsatiladi), mashinalar salomatligi, loyiha va vazifalar.
- **Boshqarish:** permission so'rovlarini tasdiqlash/rad etish, Claude savollariga (AskUserQuestion) javob,
  sessiyaga prompt yuborish, to'xtatish, tmux'da davom ettirish/yopish, istalgan mashinada yangi sessiya ochish.
- **Klientlar:** web dashboard (Next.js), Mac menu-bar ilovasi (SwiftUI), Flutter telefon ilovasi, Telegram bot.

> Loyiha shaxsiy foydalanish uchun yozilgan, UI va kommentlar o'zbek tilida (lotin).

## Arxitektura

```
 Mashinalar (Mac / Ubuntu / Windows)                    Markaz (Mac)                     Klientlar
 ┌──────────────────────────────┐                ┌──────────────────────────┐      ┌──────────────────┐
 │ Claude Code ── hooks ──┐     │  outbound WSS  │ center (NestJS)          │◄────►│ dashboard (web)  │
 │                        ▼     │ ─────────────► │  ├─ commands + audit_log │      │ menubar (macOS)  │
 │                    agentd ───┼── Tailscale ──►│  ├─ approvals, limits    │◄────►│ mobile (Flutter) │
 │  (Ed25519 kalit, policy.json)│                │  └─ Telegram bot         │      │ Telegram         │
 └──────────────────────────────┘                │ PostgreSQL + TimescaleDB │      └──────────────────┘
                                                 │ signer (Keychain, Swift) │
                                                 └──────────────────────────┘
```

- **agentd** — har mashinadagi daemon. Faqat markazga *chiqadi* (inbound port yo'q), hook'lardan
  lokal socket orqali hodisa oladi, imzolangan buyruqlarni lokal `policy.json` bo'yicha bajaradi.
- **center** — NestJS 12 API + WebSocket gateway, TypeORM, PostgreSQL 16 + TimescaleDB.
- **signer** — macOS Keychain'dagi kalit bilan buyruqlarni imzolaydi; agentd faqat imzolangan buyruqni qabul qiladi.
- **libs/contracts** — Zod sxemalari, yagona haqiqat manbai. Swift va Dart tiplari shundan generatsiya qilinadi.

## Tuzilma

```
apps/
  center/      NestJS API + WS gateway + Telegram
  agentd/      mashina daemoni (Node 22, bitta bundle; launchd / systemd / Windows task)
  dashboard/   Next.js 16 web (127.0.0.1:4318)
  signer/      Swift imzolovchi xizmat (Keychain)
  menubar/     macOS menu-bar ilova
  mobile/      Flutter ilova (BLoC)
libs/
  contracts/   Zod sxemalar + JSON Schema → Swift/Dart codegen
  hooks/       Claude Code hook va statusline skriptlari
clients/       generatsiya qilingan Swift/Dart paketlar, fixture'lar
ops/           o'rnatish, zaxira, mashina qo'shish skriptlari (mac / ubuntu / windows)
docs/          PLAN.md (reja + ADR), TASKS.md, yo'riqnomalar
```

## Ishga tushirish

Talablar: Node 22+, npm, Docker (center + Postgres uchun), [Tailscale](https://tailscale.com) (mashinalar o'rtasida).
Ixtiyoriy: Xcode / Swift 6 (signer, menubar), Flutter (mobile), tmux (masofaviy boshqaruv uchun).

```bash
npm install
npm run build          # barcha loyihalar (Nx)
npm run test
npm run lint
npm run typecheck

# Center + DB
cp apps/center/.env.example apps/center/.env      # qiymatlarni o'zgartiring
docker compose -f apps/center/docker-compose.yml up -d --build

# Dashboard
cp apps/dashboard/.env.example apps/dashboard/.env.local
npm run -w apps/dashboard dev                      # http://127.0.0.1:4318
```

Batafsil:

- Markazni Mac'da o'rnatish — [`docs/infra/mac-center.md`](docs/infra/mac-center.md)
- Tailscale sozlash — [`docs/infra/tailscale.md`](docs/infra/tailscale.md)
- Yangi server/mashina qo'shish — [`docs/add-server.md`](docs/add-server.md)
  (`ops/add-machine.sh <ssh-alias> --name <nom>`; markaz manzili `COMMANDER_CENTER_URL` yoki `ops/.center-url` faylida)
- Masofaviy boshqaruvni yoqish — [`docs/remote-control.md`](docs/remote-control.md)
- `claude` ni avtomatik tmux'da ochish — `ops/claude-tmux.sh local install`

## Xavfsizlik tamoyillari

1. **Masofaviy bajarish = RCE.** Har bir remote amal `commands` jadvaliga va `audit_log`ga yoziladi.
2. **Faqat outbound ulanish.** Mashinalar markazga o'zi ulanadi; ommaviy port ochilmaydi (Tailscale ichida).
3. **Per-device identity.** Har agentd o'z Ed25519 kalitiga ega; buyruqlar signer tomonidan imzolanadi.
4. **Masofaviy boshqaruv sukut bo'yicha o'chiq.** Har mashinada egasi `agentd policy` bilan ruxsat etilgan papkalarni o'zi belgilaydi.
5. **Fail-safe.** Markaz yo'q bo'lsa permission hook lokal promptga qaytadi, hech qachon avtomatik `allow` qilmaydi.
6. **Redaksiya.** Prompt, tool input va transcript parchalari DB/Telegram'ga yozilishdan oldin `redact()` dan o'tadi.
7. **Step-up.** Xavfli amallar (deploy, rollback) qo'shimcha tasdiq (Telegram / passkey / Touch ID) talab qiladi.

Sirlar (`.env`, kalitlar, `.auth/`, zaxiralar) repozitoriyga kirmaydi — `.gitignore`ga qarang.
Testlardagi `sk-ant-…`, `ghp_…` kabi qiymatlar redaksiyani tekshirish uchun soxta namunalar.

## Hujjatlar

- [`docs/PLAN.md`](docs/PLAN.md) — to'liq reja va arxitektura qarorlari (ADR)
- [`docs/TASKS.md`](docs/TASKS.md) — ish ro'yxati va holati
- [`CLAUDE.md`](CLAUDE.md) — kod uslubi va qat'iy qoidalar

## Litsenziya

[MIT](LICENSE)
