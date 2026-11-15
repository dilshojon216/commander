# Mac markazing (task 0.4): "Markaz" rejimi

Holat: 2026-11-13. Commander center va PostgreSQL 16 + TimescaleDB (`timescale/timescaledb:2.32.0-pg16`) Docker Compose'da Mac'da ishlaydigan konfiguratsiya.

---

## Nima ishlayapti

```
Mac (users-macbook-pro)
├── Docker Desktop
│   ├── PostgreSQL 16 + TimescaleDB (container: commander-db-1)
│   └── Center NestJS API (container: commander-app-1)
├── LaunchAgent: uz.commander.caffeinate
│   └── caffeinate -s -i (KeepAlive)
├── LaunchAgent: uz.commander.backup
│   └── Har kecha 03:30 da pg_dump → ~/commander-backups/
└── LaunchAgent: uz.commander.dashboard
    └── Web dashboard: production `next start -H 127.0.0.1 -p 4318` (KeepAlive)
```

**Tailscale tayanish:**
- Center `127.0.0.1:4317` da tinglaydi.
- Tailscale serve: `https://<mac>.<tailnet>.ts.net/` → center (HTTPS, avtomatik sertifikat).
- Barcha Ubuntu va telefon: WS orqali tailnet ichida ulana oladi.

---

## Qayerda nima

| Manzil | Maqsad |
|---|---|
| `apps/center/docker-compose.yml` | Compose konfiguratsiyasi (`name: commander`, healthcheck, 127.0.0.1 bind) |
| `apps/center/.env` | AUTH_TOKEN va POSTGRES_PASSWORD (chmod 600, gitignored) |
| `.env` ichida | Faqat AUTH_TOKEN va POSTGRES_PASSWORD; qolgan `env:` .env.example'dan |
| `~/Library/LaunchAgents/uz.commander.{caffeinate,backup}.plist` | LaunchAgent qaydlari |
| `ops/mac/{install,uninstall,backup,restore}.sh` | Setup va backup/restore skriptlari |
| `~/commander-backups/` | Kunlik pg_dump nusxalari (gzip, 14 kun ushlab turish) |
| `~/Library/LaunchAgents/uz.commander.dashboard.plist` | Dashboard xizmati (`ops/mac/uz.commander.dashboard.plist.template` dan) |
| `ops/mac/dashboard-{install,redeploy,uninstall}.sh` | Dashboard xizmatini o'rnatish / yangilash / o'chirish |
| `apps/dashboard/.env.local` | Dashboard'ning center tokenlari (faqat serverda; plist'ga ko'chirilmaydi) |
| `~/Library/Logs/commander/` | caffeinate.log, backup.log, dashboard.log |

---

## Boshlang'ich setup

```bash
cd ~/working/commander/apps/center

# 1. .env yaratildi (AUTH_TOKEN va POSTGRES_PASSWORD). 
#    Hozir o'zi qilingan, shuning uchun bu qadam o'tkazish mumkin.

# 2. Docker Compose'ni boshlash
docker compose up -d --build

# 3. Xolati tekshirish
docker compose ps
# Ikkalasi (db va app) "healthy" bo'lishi kerak

# 4. Health endpoint'ni sinovdan o'tkazish
curl http://127.0.0.1:4317/health
# {"ok":true} qaytarishi kerak

# 5. LaunchAgent'larni o'rnatish
bash ops/mac/install.sh
# ✓ uz.commander.caffeinate loaded
# ✓ uz.commander.backup loaded

# 6. Birinchi backup'ni qo'l bilan chiqarish va qayta tiklash sinovidan o'tkazish
bash ops/mac/backup.sh
# ✓ Backup created: ~/commander-backups/commander-20261113-012345.sql.gz

# 7. Temporary qurilmani yaratish va restore sinovini o'tkazish
# (docs/infra/mac-center.md'ning "Backup/restore sinovining orin-yo'li" bo'limiga qarang)
```

---

## Xolati tekshirish

### Konteynerlar

```bash
# Status ko'rish
docker compose ps

# Log ko'rish
docker compose logs -f app
docker compose logs -f db

# Center health check
curl -s http://127.0.0.1:4317/health | jq .

# Authenticated endpoint sinovida (AUTH_TOKEN qayta .env'dan)
TOKEN=$(grep AUTH_TOKEN ~/working/commander/apps/center/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/sessions | jq .

# Unauthenticated (401 qaytarishi kerak)
curl -s http://127.0.0.1:4317/api/sessions
# {"statusCode":401,"message":"Unauthorized",...}
```

### Tailscale

```bash
# HTTPS serve'ni tekshirish
curl -s https://<mac>.<tailnet>.ts.net/health | jq .

# Tailscale status
tailscale status

# Serve status
tailscale serve status
```

### LaunchAgent'lar

```bash
UID=$(id -u)

# Caffeinate statusi
launchctl print gui/$UID/uz.commander.caffeinate | grep -E "state|pid"

# Backup statusi
launchctl print gui/$UID/uz.commander.backup | grep -E "state|NextScheduled"

# Log'lar
tail -f ~/Library/Logs/commander/caffeinate.log
tail -f ~/Library/Logs/commander/backup.log
```

### Web dashboard (doimiy xizmat, `uz.commander.dashboard`)

Dashboard `127.0.0.1:4318` da faqat lokal ishlaydi (Tailscale'ga chiqarilmaydi). Mac menu-bar ilovasining
"Commander" oynasi (WKWebView) va brauzer shu manzilni ochadi. Xizmat production Next serverini ishga tushiradi
(`/opt/homebrew/opt/node@24/bin/node <repo>/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 4318`,
WorkingDirectory `apps/dashboard`), RunAtLoad + KeepAlive. Env'da faqat `NODE_ENV=production`, `PATH`, `HOME`:
tokenlarni Next o'zi `apps/dashboard/.env.local` dan o'qiydi, plist'ga yozilmaydi.

```bash
bash ops/mac/dashboard-install.sh            # .next yo'q bo'lsa build; 4318 dagi qo'lda ishga tushirilgan
                                             # `next start` (cwd apps/dashboard) to'xtatiladi; bootstrap; HTTP 200 kutadi
bash ops/mac/dashboard-install.sh --rebuild  # majburiy qayta build bilan
bash ops/mac/dashboard-redeploy.sh           # KOD YANGILANGANDA: build + kickstart -k + 200 tekshiruvi
bash ops/mac/dashboard-redeploy.sh --no-build
bash ops/mac/dashboard-uninstall.sh          # xizmatni o'chirish (.next va .env.local qoladi)

launchctl print gui/$(id -u)/uz.commander.dashboard | grep -E "state|pid"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4318/   # 200
tail -f ~/Library/Logs/commander/dashboard.log
```

- 4318 ni boshqa jarayon band qilgan bo'lsa (cwd `apps/dashboard` va buyrug'i next/node emas) install skripti
  unga tegmaydi va xato bilan chiqadi.
- Log 10 MB dan oshsa install/redeploy uni `dashboard.log.1` ga nusxalab kesadi (launchd fayl deskriptorini
  ushlab turgani uchun `mv` emas, truncate).
- Build paytida eski server bir necha soniya xato berishi mumkin; redeploy darhol `kickstart -k` qiladi.
- `npm run -w apps/dashboard dev` endi port to'qnashuvi beradi: dev uchun avval `launchctl bootout gui/$(id -u)/uz.commander.dashboard`
  (keyin `bash ops/mac/dashboard-install.sh` bilan qaytaring).

### Docker Desktop autostart

Docker Desktop o'zi startup'da ishga tushadi-mi tekshirish:

```bash
# Sozlama fayli
cat ~/Library/Group\ Containers/group.com.docker/settings.json | grep -i autostartapp

# Yoki GUI: Settings → General → "Start Docker Desktop when you log in"
```

---

## Boshqarish

### Boshlash / qayta boshlash

```bash
cd ~/working/commander/apps/center

# Boshlash
docker compose up -d

# Qayta boshlash
docker compose restart

# To'xtatish
docker compose down
# (ma'lumot saqlanib qoladi, named volume pgdata tanlangan)
```

### Backup va restore

```bash
# Qo'l bilan backup (kunlik 03:30'da avtomatik)
bash ops/mac/backup.sh

# Mavjud nusxalarni ko'rish
ls -lh ~/commander-backups/

# Kering tiklash (3 ta qadamda)
# 1. Sinovdan o'tkazish (dry-run)
bash ops/mac/restore.sh ~/commander-backups/commander-YYYYMMDD-HHMMSS.sql.gz
# "DRY-RUN MODE: Would restore..."

# 2. Haqiqiy restore (--confirm bilan)
bash ops/mac/restore.sh ~/commander-backups/commander-YYYYMMDD-HHMMSS.sql.gz --confirm
# "✓ Restore completed successfully"
```

### LaunchAgent'larni qayta o'rnatish

```bash
# O'chirish
bash ops/mac/uninstall.sh

# Qayta o'rnatish
bash ops/mac/install.sh
```

### Xavfli dursirish: Mac uxlamaslik

Keep-awake `caffeinate -s -i` dan tashqari:

- **Ekran uyku vaqti:** `caffeinate -i` (default) bu bilan kelinadi
- **Tizim uyku vaqti:** `caffeinate -s` (default) bu bilan kelinadi
- **Qopqoq yopilganda:** E'tibor bering, `caffeinate` bu holatda **ishlamaydi**. 
  Xavfsiz dursirish uchun (ixtiyoriy):
  ```bash
  # AC' da aslo uxlamaydi (root talab qiladi)
  sudo pmset -c sleep 0
  
  # Oyna aslo uyumavsin (root talab qiladi)
  sudo pmset -c displaysleep 0
  
  # Joriy sozlamalarni ko'rish
  pmset -g
  ```

---

## Buzilgan holatlarni tuzatish

### Docker konteyner boshlanmaydi

```bash
# 1. Log'ni ko'rish
docker compose logs

# 2. Asosiy holatni tekshirish
docker compose ps

# 3. Rekompilya qilish
docker compose down -v
docker compose up -d --build

# 4. Agar port allaqachon band bo'lsa:
lsof -i :4317
```

### Backup script xato beradi

```bash
# 1. Docker Compose ishlab turayotganini tekshir
cd apps/center
docker compose ps

# 2. Bazaning ishlab turganini tekshir
docker compose ps db
docker compose exec db pg_isready

# 3. Backup log'ni ko'rish
tail -f ~/Library/Logs/commander/backup.log
```

### Tailscale ulanish ishlamaydi

```bash
# 1. Tailscale xolati
tailscale status

# 2. Serve xolati
tailscale serve status

# 3. Center ishlayotganini tekshir
curl http://127.0.0.1:4317/health

# 4. MagicDNS tekshirish
nslookup <mac>.<tailnet>.ts.net
```

---

## Zaxira: Masofaviy nusxa (hali o'zaro kerak emas)

PLAN.md'da qayd qilinganidek, hozir backuplar faqat **lokal** turadi (`~/commander-backups/`).

Kelajakda Ubuntu server'ga masofaviy nusxa uchun joyni qoldirish:

```bash
# PLACEHOLDER: Masofaviy nusxa Faza 2'da
# ops/mac/remote-sync-backup.sh (future)
# 
# Qo'sh qiladi:
# - SSH orqali Ubuntu serverga backup ko'chirish
# - Shifrlash (GPG/TLS)
# - Retention: remote'da 30 kun
#
# LaunchAgent: uz.commander.backup.sh chaqirusidan keyin Telegram'ga ogohlantirish
```

---

## Qabul testi (0.4 yakuniy)

Hamma quyidagilar qo'l bilan tekshirildi:

- ✅ `docker compose ps` — `db` va `app` both `healthy`
- ✅ `curl 127.0.0.1:4317/health` — `{"ok":true}`
- ✅ `curl https://<mac>.ts.net/health` — HTTPS ishlaydi (tailnet ichidan)
- ✅ Auth token qo'lma: `curl -H "Authorization: Bearer <TOKEN>" /api/sessions` → ruxsatli
- ✅ Auth token yo'qlansadi: `/api/sessions` → 401
- ✅ `launchctl print` — caffeinate running (KeepAlive)
- ✅ `pmset -g assertions | grep caffeinate` — assertion faol
- ✅ `bash ops/mac/backup.sh` — nusxa yaratiladi va `~/.last-success-ts` yoziladi
- ✅ `bash ops/mac/restore.sh <backup.sql.gz> --confirm` — temporal qurilmada test qilindi, ruxsat
- ✅ Docker Desktop AutoStart: checked `~/Library/Group Containers/.../settings.json` — AutoStart qiymat

---

## Raqobatch

- Tizim uyqusining xavfi (task 0.3 bo'limida tavsiyalar)
- Qopqoq yopilgan holatda: Wi-Fi buziladi → Tailscale uziladi → Approval'lar kutib qoladi (0-fazada bildirasi)
- Mac o'g'irlansa: Barcha flotga erkin kiraberadi — Telegram'da revoke qilish kerak (Faza 4)
- Backup: tugan fuqarolarning elektr tomonida, Tailscale o'chiq bo'lsa o'tkazilmaydi

---

## Qo'shimcha

- Center healthcheck: `GET /health`
- PostgreSQL healthcheck: `pg_isready -U commander -d commander`
- OTel endpoint: agentd `127.0.0.1:4319/v1/logs` chaqiradi — hozir o'zaro kerak emas


---

## TimescaleDB'ga o'tish (task 0.5, 2026-11-13)

- Image: `timescale/timescaledb:2.32.0-pg16` (Alpine/musl). Eski `postgres:16` Debian/glibc, collation farqi bo'lgani uchun eski hajm qayta ishlatilmadi: **logik ko'chirish** (pg_dump -> yangi hajm -> restore -> `CREATE EXTENSION timescaledb`).
- Yangi hajm: `commander_pgdata_ts` (compose'da `pgdata_ts`). **Eski hajm `commander_pgdata` o'zgartirilmagan va compose'ga ulanmagan**, foydalanuvchi o'chirguncha saqlanadi. Qaytish kerak bo'lsa: compose'da image'ni `postgres:16`, hajmni `pgdata` ga qaytaring (eski hajmdagi sxema v0; yangi app migratsiyalari uni qayta v2 ga o'tkazadi).
- Eski hajmni o'chirish (**ishga tushirilmagan**, faqat foydalanuvchi qaroridan keyin):
  ```bash
  docker volume rm commander_pgdata
  ```
- v0 jadvallar (`sessions_v0`, `session_events_v0`) bazada qoldirilgan; ularni o'chirish alohida DROP migratsiyasi bo'ladi.

### Backup / restore (TimescaleDB)

- `backup.sh` o'zgarmagan mohiyatda (`pg_dump --format=custom`), lekin `pipefail` va dump butunligini tekshirish (`pg_restore --list`) qo'shildi.
- `restore.sh` bazani DROP + CREATE qiladi, `CREATE EXTENSION timescaledb`, `timescaledb_pre_restore()`, `pg_restore` (dump'dagi `EXTENSION timescaledb` yozuvlarisiz), `timescaledb_post_restore()`. `--container NAME` bilan istalgan konteynerga (masalan throwaway sinov) tiklanadi. Default rejimda `app` to'xtatilib, keyin qayta ishga tushiriladi.
- `ops/mac/db-counts.sh [container]`: barcha jadvallar qatorlari soni (restore'ni solishtirish uchun).
- Restore sinovi: `docker run -d --name cmdr-ts -e POSTGRES_USER=commander -e POSTGRES_PASSWORD=x -e POSTGRES_DB=commander timescale/timescaledb:2.32.0-pg16`, `bash ops/mac/restore.sh <dump> --confirm --container cmdr-ts`, `db-counts.sh` ikkala tomonda, `docker rm -f -v cmdr-ts`.
- Image'ni yangilash: restore maqsadidagi timescaledb versiyasi dump olingan versiyadan eski bo'lmasligi kerak; avval backup, keyin tag'ni almashtiring (minor yangilanishda `ALTER EXTENSION timescaledb UPDATE` ilova ulanishidan oldin, yangi sessiyada).

### Sxema testlari (haqiqiy TimescaleDB kerak)

```bash
docker run -d --name cmdr-ts-test -e POSTGRES_USER=commander -e POSTGRES_PASSWORD=devpw -p 127.0.0.1:55432:5432 timescale/timescaledb:2.32.0-pg16
TEST_DATABASE_URL=postgres://commander:devpw@127.0.0.1:55432/postgres npm run -w apps/center test:db
docker rm -f -v cmdr-ts-test
```
Testlar har biri uchun alohida throwaway baza yaratadi: migratsiya up/down/up, v0->v2 ma'lumot ko'chirish, entity/DB mosligi, hypertable/cagg/audit/statistika.

---

## Identity: enrollment kodlari, tokenlar, revoke, lockdown (task 0.6)

Admin amallari HTTP'da **yo'q**: faqat center konteyneri ichidagi CLI. (`tailscale serve` 127.0.0.1:4317 ni proksilaydi, shu sabab asosiy portda "localhost-only" tekshiruvi ma'noga ega emas; admin route umuman yaratilmagan, tailnet va lokal'da `404`.)

```bash
cd ~/working/commander
A=ops/mac/commander-admin.sh      # = docker compose exec -T app node dist/cli.js "$@"

# 1) agentd uchun bir martalik kod (15 daqiqa, bir marta; kod faqat shu chiqishda ko'rinadi)
$A enroll-code create --kind agentd --machine-name mac-mini [--ttl-minutes 15] [--json]
$A enroll-code list
#    Agent: POST https://<mac>.<tailnet>.ts.net/v1/enroll
#    {"code","public_key"(xom 32 bayt Ed25519, base64url),"hardware_id","hostname","os","arch"} -> {device_id, machine_id}

# 2) klient token (dashboard / menubar / mobile / telegram). Scope: read | approve | control | admin
$A token create --kind web --name dashboard --scopes read --expires-days 90
$A token create --kind web --name my-admin --scopes admin,read      # GET /v1/audit uchun
$A token list

# 3) bekor qilish (darhol kuchga kiradi)
$A device list
$A device revoke <device-id>
$A token revoke <token-id>

# 4) favqulodda to'xtatish: device-imzoli va token'li mutating so'rovlar + enroll rad etiladi, o'qish ishlaydi
$A lockdown on      # | off | status

# 5) audit zanjirini tekshirish (HTTP: GET /v1/audit?verify=1, admin token)
$A audit verify
```

Dev'da (DB host'dan ko'rinsa): `npm run build -w @commander/center && DATABASE_URL=... npm run -w @commander/center cli -- <buyruq>`.

**Dashboard'ni klient tokenga o'tkazish:** `apps/dashboard/.env` da `COMMANDER_API_TOKEN=<cmdr_... token>` (read scope yetarli) va dashboard'ni qayta ishga tushiring; `GET /sessions*` ikkala turni ham qabul qiladi. Eski `AUTH_TOKEN` hook'lar (`POST /events`) va o'tish davri uchun qoladi; `/v1/*` da AUTH_TOKEN yaroqsiz. Hook'lar agentd'ga o'tgach (Faza 1) AUTH_TOKEN o'chiriladi.

**Audit'ni ko'rish:** `curl -H "Authorization: Bearer $ADMIN_TOKEN" 'http://127.0.0.1:4317/v1/audit?limit=50[&before=<id>][&action=device.revoked]'`. Faqat `psql` bilan ham: `SELECT id, action, target, details FROM audit_log ORDER BY id DESC LIMIT 50;` (UPDATE/DELETE trigger bilan bloklangan; test yozuvlari `zz-test-0.6` nomi bilan belgilangan).

**Imzolangan so'rov (agentd uchun qisqa spetsifikatsiya):** sarlavhalar `X-Device-Id`, `X-Timestamp` (epoch ms), `X-Nonce` (16-64 belgi base64url, har so'rovga yangi), `X-Signature` (base64url, Ed25519, 64 bayt). Imzolanadigan satr (`buildCanonicalString` in `libs/contracts`): `COMMANDER-SIG-V1\nMETHOD\n/path\nsorted(rawQuery)\nsha256hex(body)\nts\nnonce\ndevice_id`. Soat farqi 60 s dan oshsa 401; takroriy nonce 401; bekor qilingan qurilma 401. Tana `application/json` bo'lishi shart (xom tana xeshlanadi).

**Rate-limit/to'fon:** enroll: 30 so'rov/daqiqa va 5 (IP) / 10 (global) xato / 10 daqiqa; auth xatolari 300/daqiqa dan keyin 429. Audit'da takroriy xatolar oynada bitta `count`li qatorga aylanadi. Limitlar xotirada (restartda tiklanadi).

### Sxema testlari (0.6 dan keyin)

`test:db` endi identity testlarini ham o'z ichiga oladi (`test/db/identity.db-spec.ts`: HTTP orqali enrollment, imzo, token scope, lockdown, audit, zanjir buzilishi). Docker buyrug'i yuqoridagidek.

### Sxema testlari (1.4 dan keyin)

`test:db` agentd kanalini ham o'z ichiga oladi (`test/db/agent-channel.db-spec.ts`: haqiqiy `ws` mijoz + Ed25519, challenge-response, events/usage/limits ikki marta yuborilganda bitta qator va ack, presence/stale, revoke, audit, legacy `POST /events`). Docker buyrug'i yuqoridagidek. DB'siz variant: `npm run -w apps/center test:e2e` (`test/agent-ws.e2e-spec.ts`).

### Klient o'qish API, /ws/client, approvals (1.5-1.7 center tomoni)

- Tekshirish uchun qisqa muddatli token: `ops/mac/commander-admin.sh token create --kind web --name <nom> --scopes read[,approve] --expires-days 1 --json`, ishlatib bo'lgach `token revoke <id>`. REST: `Authorization: Bearer cmdr_...`; WS: `Sec-WebSocket-Protocol: commander.v1, cmdr-token.<token>` (query string'da emas).
- Sxema testlari (1.7 dan keyin): `test/db/client-api.db-spec.ts` (REST + `/ws/client` + approvals + limitlar + lockdown, haqiqiy TimescaleDB), `schema.db-spec.ts` approvals migratsiyasini ham tekshiradi. Docker buyrug'i yuqoridagidek.
- Lockdown'da: masofaviy approval `allow` 403, `deny` ruxsat; o'qish va `/ws/client` ishlaydi (`lockdown.updated` push).
