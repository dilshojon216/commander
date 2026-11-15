# Commander server

Turli kompyuterlardagi Claude Code hook'laridan yuborilgan sessiya hodisalarini (`POST /events`) yig'ib,
PostgreSQL'da saqlaydigan NestJS serveri (TypeORM, migratsiyalar bilan).

## Ishga tushirish

### 1. Docker Compose (tavsiya etiladi)

```bash
cp .env.example .env        # AUTH_TOKEN ni o'rnating (masalan: openssl rand -hex 24)
docker compose up -d --build
curl http://localhost:4317/health     # {"ok":true}
```

`postgres:16` va ilova birga ko'tariladi. Migratsiya ilova ishga tushganda avtomatik bajariladi
(`migrationsRun: true`). To'xtatish: `docker compose down` (ma'lumotlar `pgdata` volume'da qoladi,
butunlay o'chirish uchun `docker compose down -v`).

### 2. Lokal (Node.js >= 22.13)

```bash
npm install
cp .env.example .env        # DATABASE_URL ni o'z PostgreSQL'ingizga moslang
npm run build
npm run start:prod          # yoki: npm run start:dev
```

Server `0.0.0.0` da tinglaydi, shuning uchun boshqa kompyuterlar `http://<server-ip>:4317` orqali ulanishi mumkin.

## Sozlamalar (env)

| O'zgaruvchi     | Default | Izoh |
|-----------------|---------|------|
| `PORT`          | `4317`  | HTTP port |
| `DATABASE_URL`  | -       | PostgreSQL ulanish satri (majburiy) |
| `STALE_MINUTES` | `720`   | `active=true` ro'yxatda shuncha daqiqadan beri hodisa kelmagan sessiyalar ko'rsatilmaydi |

> Legacy `AUTH_TOKEN`, `POST /events` va `GET /sessions*` olib tashlangan (M-10): kirish faqat per-device identity (agentd) va `cmdr_` klient tokenlari bilan. Identity: `docs/infra/mac-center.md`.

## API

Klient REST API: `/v1/*` (`docs/PLAN.md` §8).

## Testlar

```bash
npm test            # unit testlar (vitest)
npm run test:e2e    # WS agent e2e (bazasiz)
npm run build
```

## Tuzilma

- `src/events` - sessiya hodisasini yozish yadrosi va `status_since` mantig'i (`session-state.ts`)
- `src/database` - entity'lar va qo'lda yozilgan migratsiya (`synchronize: false`)
