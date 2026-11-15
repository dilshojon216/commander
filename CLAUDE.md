# Commander — Claude Command Center

Bitta foydalanuvchi uchun platforma: barcha Mac va Ubuntu serverlardagi Claude Code
sessiyalarini bitta markazdan kuzatish (status, token, obuna limitlari) va boshqarish
(permission approve/deny, prompt yuborish, to'xtatish, yangi sessiya ochish).

To'liq reja: `docs/PLAN.md`. Ish ro'yxati: `docs/TASKS.md`. Arxitektura qarorini
o'zgartirishdan oldin PLAN.md'ni yangilang (ADR bo'limi), keyin kod.

## Tuzilma (monorepo, npm workspaces + Nx)

```
apps/
  center/        NestJS 12 API + WebSocket gateway (v0 server shu yerda)
  agentd/        Har mashinadagi daemon (Node 22, bitta binary; launchd / systemd)
  dashboard/     Next.js 16 web
  telegram-bot/  grammY bot (center ichida modul bo'lib boshlanadi, keyin ajratiladi)
  menubar/       macOS menu-bar ilova (SwiftUI, MenuBarExtra)
  mobile/        Flutter ilova (BLoC, Clean Architecture)
libs/
  contracts/     Zod sxemalar + TS tiplari: REST DTO, WS xabarlari, hook payload'lari
  hooks/         Claude Code hook skriptlari (agentd'ga lokal socket orqali gapiradi)
docs/            PLAN.md, TASKS.md, adr/
```

`libs/contracts` — yagona haqiqat manbai. Center, agentd va dashboard xabar
formatini faqat shu yerdan import qiladi. Flutter va Swift uchun tiplar
`contracts`dan generatsiya qilinadi (JSON Schema → codegen), qo'lda yozilmaydi.

## Stack

- Center: NestJS 12 (ESM, `"type": "module"`, importlarda `.js` kengaytma), TypeORM 1.x,
  PostgreSQL 16 + TimescaleDB, `ws` adapter. Test: Vitest.
- agentd: Node 22, TypeScript, `ws`, `@anthropic-ai/claude-agent-sdk` (faqat tekshirilgandan keyin).
- Dashboard: Next.js 16 — bu versiya trainingdagidan farq qiladi, kod yozishdan oldin
  `node_modules/next/dist/docs/` ni o'qing.
- Tarmoq: Tailscale (barcha mashinalar, telefon). Ommaviy portlar ochilmaydi.

## Buyruqlar

```bash
# Ildizdan (bir marta `npm install`; Nx keshlaydi, contracts avtomatik build bo'ladi)
npm run build | test | lint | typecheck      # barcha loyihalar (nx run-many)
npx nx run @commander/center:test:e2e
docker compose -f apps/center/docker-compose.yml up --build   # center + Postgres

# Center + DB (Mac'da; Postgres+TimescaleDB brew services, Docker faqat CI/test uchun)
brew services start postgresql@16
npm run -w apps/center start:dev
npm run -w apps/center test
npm run -w apps/center test:e2e

# Dashboard
npm run -w apps/dashboard dev        # 127.0.0.1:4318

# agentd (lokal sinov)
npm run -w apps/agentd dev -- --center wss://<mac>.<tailnet>.ts.net:4317
```

## Qat'iy qoidalar

1. **Masofaviy bajarish = RCE.** Har bir remote amal (prompt, stop, start, approve/deny)
   `commands` jadvaliga yoziladi va `audit_log`ga tushadi. Audit yozuvisiz amal yo'q.
2. **Mashinalar faqat outbound ulanadi.** agentd center'ga WebSocket ochadi; center
   mashinaga hech qachon o'zi ulanmaydi. Inbound port ochadigan kod yozmang.
3. **Per-device identity.** Har agentd o'z Ed25519 kalitiga ega; umumiy `AUTH_TOKEN`
   faqat bootstrap (enrollment) uchun. Yangi endpoint qo'shsangiz — qaysi identity
   (device / client / telegram) ruxsat olishini guard bilan aniq belgilang.
4. **Fail-safe.** Hook center'ga ulana olmasa — sessiyani buzmaydi: status hooklari jim
   o'tkazib yuboradi, permission hooki lokal promptga qaytadi (`ask`), hech qachon
   avtomatik `allow` qilmaydi.
5. **Sirlarni saqlamang.** Prompt matni, tool input, transcript parchalari DB'ga
   yozilganda `redact()` dan o'tadi (token, kalit, `.env` qiymatlari). Telegram'ga
   to'liq tool input yuborilmaydi — qisqartirilgan, redakt qilingan ko'rinish.
6. **Limit raqamlari** faqat `limit_windows.source` bilan ko'rsatiladi
   (`official` | `estimate`). Taxminni rasmiy raqamdek ko'rsatmang.
7. Migratsiyalar faqat TypeORM migration orqali; `synchronize: true` taqiqlangan.
8. Hypertable'lar (`token_usage`, `session_events`, `machine_heartbeats`) uchun PK
   vaqt ustunini o'z ichiga oladi; retention/compression siyosati migratsiyada.

## Kod uslubi

- TypeScript strict. `any` yo'q; tashqi kirish (HTTP, WS, hook stdin) Zod bilan tekshiriladi.
- Kommentlar va UI matnlari o'zbek tilida (lotin), identifikatorlar ingliz tilida.
- Har modul: `*.module.ts`, `*.service.ts`, `*.controller.ts|gateway.ts`, sof logika
  alohida faylda (masalan `session-state.ts`) va unit test bilan.
- Yangi WS xabar turi → avval `libs/contracts`, keyin center, keyin klientlar.

## Agentlarga yo'naltirish

| Ish | Agent |
|---|---|
| Center modullari, guard, gateway | `nestjs-dev` |
| Schema, hypertable, migratsiya | `db-schema` |
| launchd/systemd, Tailscale, docker | `devops` |
| Dashboard | `react-frontend` |
| Mobil ilova | `flutter-dev` |
| Review / security | `code-review` |

## Hozirgi holat (migratsiyadan oldin)

- `apps/center` — ishlaydigan v0 (POST /events, GET /sessions; 0.2'da `server/`dan ko'chirildi).
  `sessions`/`session_events` jadvallari yangi sxemaga migratsiya qilinadi.
- `apps/dashboard` — center API'dan o'qiydi (Faza 2'da o'tkazildi).
- `~/.claude/hooks/session-report.sh` — Faza 1'da agentd hookiga almashtiriladi.
- `~/.claude/mods/session-board` — fayl asosidagi mod; Faza 4'da (4.5) center'dan o'qiydigan
  qilib qayta yoziladi yoki o'chiriladi (PLAN.md, "Qayta foydalanish" bo'limi).
