# Commander — Ish ro'yxati (fazalar bo'yicha)

Asos: `docs/PLAN.md`. Hajm: S = 0.5-1 kun, M = 2-3 kun, L = 4-6 kun (1 dasturchi + Claude).
Har faza oxiridagi "Qabul mezoni" bajarilmaguncha keyingisiga o'tilmaydi.

---

## Faza 0 — Poydevor (≈1 hafta)

Maqsad: monorepo, tarmoq va xavfsiz identity tayyor; hali yangi funksiya yo'q.

| # | Task | Nega shu tartibda | Hajm |
|---|---|---|---|
| 0.1 | ✅ **(2026-11-13 bajarildi, PLAN.md 13-bo'lim)** **Spike: imkoniyatlarni Claude Code 2.1.x'da qo'lda tekshirish** — (a) `PermissionRequest` hook bloklab kutadimi, timeout'da nima bo'ladi; (b) OTel `claude_code.api_request` eventida token/model/session.id bormi; (c) status line JSON'da `rate_limits` bormi; (d) Agent SDK obuna (OAuth) bilan ishlaydimi; (e) `claude --bg` + `claude agents --json` + `claude stop`. Natija: PLAN.md 9-bo'lim jadvali yangilanadi | Butun arxitektura shu 5 faktga tayanadi; noto'g'ri bo'lsa reja o'zgaradi | M |
| 0.2 | ✅ **(2026-11-13 bajarildi: npm workspaces + Nx 24, `apps/center`, `apps/dashboard`, `libs/contracts` (Zod 4, tsc→dist, faqat v0 wire kontrakt); center Dockerfile ildiz kontekstidan; lint faqat dashboard'da bor)** Nx monorepo: `server/`→`apps/center`, `dashboard/`→`apps/dashboard`, `libs/contracts` (Zod) | Keyingi hamma kod umumiy kontraktlarga tayanadi | M |
| 0.3 | ✅ **(2026-11-13: ACL o'zgarmadi, serve HTTPS ishlaydi, acme_app_ai va testserverHome'dan tekshirildi; docs/infra/tailscale.md)** Tailscale: Mac + barcha Ubuntu + telefon tailnet'ga; ACL (grants): `tag:agent` → `tag:center:4317` faqat; `tailscale serve` HTTPS | Mashinalar markazga ulana olmasa hech narsa ishlamaydi | S |
| 0.4 | ✅ **(2026-11-13 bajarildi)** Mac "markaz" rejimi: `caffeinate` launchd (KeepAlive), Postgres+TimescaleDB Docker Compose (PLAN.md qaroridan o'zgarish — Docker yoqilmagan), center Docker Compose, kunlik `pg_dump` → `~/commander-backups/` (14-kun ushlab turish). **Qaror o'zgarishi:** Docker'ni Homebrew bilan Postgres o'rnatish o'rniga, komposit bilan saqlash (user Docker Desktop shunga tayanadi, konteynerlar avtomatik restart, named volume). PLAN.md va TASKS.md yangilanaga | Mac uxlasa markaz yo'q — eng katta operatsion xavf | S |
| 0.5 | ✅ **(2026-11-13 bajarildi, PLAN.md §7)** **Qo'shimcha talab:** loyiha bo'yicha kunlik (Asia/Tashkent) va umrbod token statistikasi: `projects.repo_key/kind`, `token_usage.project_id`, `upsert_project()`, `token_usage_daily_by_project` cagg + `project_token_totals`/`repo_token_totals`/`token_usage_daily_total` view'lari. DB: Postgres 16 → TimescaleDB image, yangi sxema migratsiyasi (`machines`, `devices`, `sessions` v2, hypertable'lar), eski `sessions`/`session_events`dan ma'lumot ko'chirish | Barcha keyingi modullar shu jadvallarga yozadi | M |
| 0.6 | ✅ **(2026-11-13 bajarildi, PLAN.md §9 "Qarorlar (0.6)", docs/infra/mac-center.md "Identity")** CLI-only admin (`ops/mac/commander-admin.sh`), `POST /v1/enroll`, imzolangan so'rovlar (`@DeviceAuth`, `GET /v1/devices/me`), klient tokenlar (`@ClientAuth(scope)`), lockdown, audit interceptor + `GET /v1/audit[?verify=1]`; migratsiya `Identity1731400900000`; v0 `POST /events` (AUTH_TOKEN) o'zgarmagan. Tekshirilmagan: WS handshake, step-up, passkey/QR pairing, cheklangan DB roli. Identity: device enrollment (bir martalik kod → Ed25519 public key), client tokenlar (dashboard/menubar/mobile), `audit_log` interceptor | RCE platformasi: identity'siz remote amal qo'shilmaydi | M |

**Qabul mezoni:** `apps/center` testlari yashil; Ubuntu serverdan `curl https://<mac>.ts.net/health` ishlaydi, tailnet tashqarisidan ishlamaydi; enroll qilingan qurilma imzosi tekshiriladi, imzosiz so'rov 401.

---

## Faza 1 — MVP: "Hamma narsa bitta ekranda" (≈2 hafta)

Maqsad: barcha mashinalardagi sessiyalar, tokenlar va limit taxmini real vaqtda ko'rinadi + Telegram'dan permission approve/deny.

| # | Task | Nega | Hajm |
|---|---|---|---|
| 1.1 | ✅ **(2026-11-13 bajarildi: `apps/agentd`, PLAN.md "Qarorlar (1.1-1.3, 1.5)"; Mac'da launchd'da ishlayapti, center'da online=true; Ubuntu o'rnatish skripti tayyor, serverlarda hali o'rnatilmagan)** `agentd` skeleti: outbound WSS, qayta ulanish (exponential backoff), heartbeat, lokal disk navbati (offline buferi), launchd plist + systemd unit | Hamma ma'lumot shu kanal orqali o'tadi | L |
| 1.1a | ✅ **(2026-11-13 bajarildi; 1.7 PermissionRequest entry hali qo'shilmagan)** **ops/add-machine.sh va remove-machine.sh**: Xavfsiz onboarding/offboarding skriptlari; preflight checks (OS, Node 22+, systemd), bundle, enroll, settings.json merge (backup), service enable; docs/infra/servers.md| 5 ta Ubuntu serverda agentd o'rnatish uchun | S |
| 1.1b | ✅ **(2026-11-13: 5 Ubuntu + Mac + Windows onlayn; linger: prod-b, testserver, acmeapp-ai da qo'lda kerak)** **Serverlarni onboard qilish**: ProdAGlobal, prod_b_global, dev_box, testserver, acme_app_ai; har biri uchun qo'llash: `./add-machine.sh <alias>`| Barcha sessiyalar center'da ko'rinish uchun | S |
| 1.1c | ✅ **(2026-11-13 bajarildi: PLAN.md "Qarorlar (Windows qo'llab-quvvatlash)")** Windows qo'llab-quvvatlash: agentd + cc-hook + cc-statusline (named pipe, yo'l normalizatsiyasi, `claude.cmd` xavfsiz chaqirish, Scheduled Task + yashirin nazoratchi, fayl logi), `ops/windows/*`, `add-machine.sh` OS aniqlash; `win-pc` onboard qilindi. Qolgan: `remove-machine.sh` Windows uchun, `S4U`, real sessiyada OTel tekshiruvi | Windows 11 PC'dagi sessiyalar ham center'da | M |
| 1.2 | ✅ **(2026-11-13: `libs/hooks` cc-hook; settings.json hali almashtirilmagan)** Hook ko'prigi: `cc-hook` (kichik binary/skript) → agentd Unix socket. `session-report.sh` o'rniga. Statuslar + `transcript_path` | Mavjud hook mantiqini saqlab, HTTP'ni socketga almashtiradi | M |
| 1.3 | ✅ **(2026-11-13: OTLP receiver + transcript tailer agentd'da; OTel env hali settings.json'da yoqilmagan)** Token yig'ish: agentd lokal OTLP/HTTP qabul qiluvchi (`127.0.0.1:4319`) → center; fallback: transcript JSONL tail (`requestId` bo'yicha dedup) | Token — foydalanuvchi so'ragan asosiy raqam | L |
| 1.4 | ✅ **(2026-11-13 bajarildi, PLAN.md §8 + "Qarorlar (1.4)")** Center: `ingest` moduli (events, usage batch), `token_usage` hypertable + continuous aggregate (5 daqiqa / 1 soat). **Amalga oshirilgan:** WS `/ws/agent` (challenge-response, ack/nack, presence/stale, rate/size limitlar), `libs/contracts/src/agent-protocol.ts`, `agent.events|usage|limits` -> `session_events`/`token_usage`/`limit_samples` (idempotent), migratsiya `AgentChannel`. Qolgan: `/ws/client` fan-out (1.6), revoke'da push-uzish (4.1) | Dashboard va limit hisoblash shu agregatlarga tayanadi | M |
| 1.5 | ✅ **(2026-11-13: agentd tomoni `cc-statusline` + `agent.limits`; center: `limits/limits-logic.ts` (rasmiy g'olib, stale, reset, kalibrlangan estimate), `GET /v1/limits`, `GET /v1/{machines,sessions,projects,usage,usage/summary}`; PLAN §8 + "Qarorlar (1.5-1.7)")** Limit moduli: rasmiy manba (0.1 natijasiga ko'ra: status line `rate_limits`) bo'lsa — uni; bo'lmasa taxmin (5 soatlik oyna, haftalik oyna, `source=estimate`) + qo'lda kalibrlash | Limit — ikkinchi asosiy so'rov | M |
| 1.6 | ✅ **(2026-11-13 bajarildi, center: `/ws/client`, `realtime/`, kontrakt `client-protocol.ts`; klientlar (dashboard, bot) hali ulanmagan)** Realtime: WS `/ws/client` (sessions, machines, usage, limits, approvals kanallari) | Barcha 4 klient shu bitta oqimdan foydalanadi | M |
| 1.7 | ✅ **(2026-11-13: agent tomoni ham bajarildi, Mac'da PermissionRequest hooki yoqildi, dashboard orqali e2e sinaldi; 5 server + Windows'ga ham yoqildi; Telegram orqali haqiqiy allow sinaldi (dev_box))** *(center tomoni ✅ 2026-11-13: `approval.request/cancel/decision/expired`, `approvals` jadvali, `POST /v1/approvals/:id/decision`, lockdown: allow rad, deny ruxsat; agentd/cc-hook tomoni va Telegram qolgan)* Remote permission: `PermissionRequest` hook → agentd → center → Telegram/dashboard → qaror; timeout → lokal prompt| "To'liq nazorat"ning eng qimmatli qismi | L |
| 1.8 | ✅ **(2026-11-13 bajarildi: `apps/center/src/telegram/`, PLAN.md "Qarorlar (1.8)"; deploy qilindi, polling ishlayapti; egasi hali /start bosmagan: `telegram pending` -> `telegram allow <id>`)** Telegram bot: chat_id allowlist, bildirishnomalar, inline Approve/Deny, `/status`, `/usage` | Telefon ilovasidan oldin mobil kanal | M |
| 1.9 | ✅ **(2026-11-13 bajarildi: SSR proxy + SSE bridge, token brauzerga chiqmaydi)** Dashboard: center API'ga o'tish (sessiyalar barcha mashinalardan), token grafigi, limit kartasi, approval navbati| Web — asosiy ekran | M |

**Qabul mezoni:** Mac va 1 ta Ubuntu serverdagi sessiyalar dashboard'da 2 soniya ichida ko'rinadi; har sessiyaning token soni transcript'dagi yig'indidan ±1% farq qiladi; Telegram'da kelgan permission so'roviga "Approve" bosilganda terminaldagi sessiya davom etadi; center o'chirilganda sessiya lokal prompt bilan ishlashda davom etadi (avto-allow yo'q). — **✅ 2026-11-13 bajarildi: 7 mashina jonli; token aniqligi 50/50 so'rov 0% farq; Telegram Approve → sessiya davom etdi; center o'chiq → lokal prompt.**

---

## Faza 2 — Loyihalar va boshqaruv (≈2 hafta)

| # | Task | Nega | Hajm |
|---|---|---|---|
| 2.1 | agentd project reporter: ro'yxatdagi papkalar uchun git log/branch/dirty, `TODOS.md`, `CHANGELOG.md` snapshot (hash o'zgarsa yuboradi) | Dashboard endi lokal diskka bog'liq emas | M |
| 2.2 | Center `projects` + `project_snapshots`; dashboard loyihalar sahifasini API'ga o'tkazish, `lib/git.ts` lokal o'qishni o'chirish | Uzoq serverlardagi loyihalar ham ko'rinadi | M |
| 2.3 | ✅ **(2026-11-13 bajarildi: commands moduli, imzolangan dispatch (center Ed25519, TOFU pin), audit, lockdown)** `commands` moduli: holat mashinasi (`pending→sent→acked→running→done/failed/expired`), idempotency, audit| Har remote amal shu konveyerdan o'tadi | M |
| 2.4 | ✅ **(2026-11-13 bajarildi: `claude --bg`, lokal policy (default o'chiq), Telegram step-up; Mac'da jonli sinaldi)** Remote start: agentd Agent SDK runner (yoki 0.1 natijasiga ko'ra `claude -p --input-format stream-json`), allowlist'dagi cwd, permission-mode cheklovi| Foydalanuvchining "yangi sessiya ochib vazifa berish" talabi | L |
| 2.5 | ✅ **(2026-11-13 bajarildi: prompt = stop → supervisor roster bo'shashini kutish → `--bg --resume` (nusxasiz); stop ishlaydi; jonli sinaldi)** Boshqariladigan sessiyalarga prompt yuborish / interrupt / stop| Yuqoridagi runner ustiga qo'shiladi | M |
| 2.6 | Terminal sessiyalar uchun: `stop` (SIGINT `claude agents --json` dagi pid'ga), prompt yuborish — faqat tmux ichida ochilganlarga (`cc` wrapper + `send-keys`) | Interaktiv sessiyalarga rasmiy kirish yo'li cheklangan | M |
| 2.7 | ✅ **(2026-11-13 bajarildi: start va acceptEdits/auto uchun Telegram ikkinchi tasdiq)** Start uchun qo'shimcha tasdiq: yangi sessiya ochish so'rovi Telegram/telefonda ikkinchi tasdiq (step-up) talab qiladi| RCE xavfini kamaytirish | S |
| 2.8 | Loyiha rejasi: agentd har loyihadagi `docs/TASKS.md` (yoki `TASKS.md`) jadvalini o'qiydi (`# \| Task \| ... \| holat`), center `project_tasks` ga saqlaydi; dashboard'da bajarilgan/qolgan/jarayondagi vazifalar | Har loyihada nima qilindi, nima qoldi — bir ekranda | M |
| 2.9 | Vazifa bo'yicha token: `/task <id>` (UserPromptSubmit hooki orqali) sessiyani vazifaga bog'laydi; fallback — git branch nomi (`task/1.4-...`) yoki promptdagi raqam; `token_usage` vaqt oralig'i bo'yicha vazifaga atributsiya; hisobot: vazifa → sessiyalar, vaqt, token, API ekvivalenti | Har vazifa qancha turishini bilish va keyingisini rejalash | M |
| 2.10 | Sessiyalararo xabar: center'da pochta qutisi, agentd MCP vositalari `send_message(to, text)` / `inbox()`; yetkazish hook orqali (UserPromptSubmit → kontekst, bo'sh sessiyani Stop-hook orqali uyg'otish); faqat bitta loyiha ichida, audit, hajm cheklovi, "hamkasb xabari, buyruq emas" ramkasi, kill-switch | Frontend va backend sessiyalari (turli mashinada ham) bir-biri bilan kelishib ishlaydi | L |
| 2.11 | **Chatni jonli ko'rish** (foydalanuvchi qarori: markazda saqlanmaydi): agentd transcript'ni o'qiydi → redakt → center relay → klient; offline holat | Sessiya sahifasining asosi (dizayn: Session) | L |
| 2.12 | **Ruxsat rejimi:** joriy `permission_mode`ni ko'rsatish; Qo'lda/Avto/Reja faqat yangi sessiyada (jonli tekshiruv: `--resume --permission-mode` NUSXA ochadi, ishlab turgan sessiya rejimini almashtirib bo'lmaydi); joriy rejim ko'rsatiladi ✅; `bypassPermissions` masofadan taqiqlangan | Dizayndagi rejim paneli | M |
| 2.13 | **Avtomatik ruxsat qoidalari:** sessiya/loyiha bo'yicha muddatli qoida (masalan Edit/Write avto-ruxsat), Bash uchun yo'q; audit | Terminal sessiyalari uchun masofaviy "acceptEdits" | M |
| 2.14 | **Plan'ni masofadan tasdiqlash:** ExitPlanMode so'rovi Telegram/dashboard'da reja matni bilan (avval haqiqiy sessiyada sinash) | Telefondan rejani o'qib tasdiqlash | S |
| 2.15 | **Loyiha ish maydoni** (dizayn: ProjectWork): vazifalar doskasi (Qoldi→Jarayonda→Tekshiruvda→Bajarildi) sessiyaga biriktirilgan, vaqt/token/baho; kunlik ko'rinish (reja vs haqiqiy, kun xulosasi); `.md` spec'dan vazifalar ajratish | 2.8/2.9 ustiga UI va ish oqimi | L |
| 2.16 | **Dashboard yangi dizayni** (docs/design/project/*.dc.html): web ekranlar real ma'lumot bilan | Foydalanuvchi dizayni | L |

**Qabul mezoni:** dashboard'dan Ubuntu serverda yangi sessiya ochib vazifa berish, uning jonli chiqishini ko'rish, o'rtasida to'xtatish ishlaydi; har amal `audit_log`da kim/qachon/qayerdan bilan; allowlist'dan tashqari papkada start rad etiladi.

---

## Faza 3 — Klientlar (≈3 hafta, parallel bo'lishi mumkin)

| # | Task | Nega | Hajm |
|---|---|---|---|
| 3.1 | `libs/contracts` → JSON Schema → Dart va Swift model codegen | Klientlar kontraktdan chetga chiqmasin | S |
| 3.2 | Mac menu-bar (SwiftUI MenuBarExtra): sessiyalar soni/holati, limit %, approval bildirishnomalari (UNUserNotification actions) | Kundalik eng tez ko'rinish | L |
| 3.3 | Flutter ilova: login (device pairing QR), sessiyalar, token/limit, approvals, remote start | Telefondan to'liq nazorat | L |
| 3.4 | Push: Telegram asosiy kanal; Flutter uchun FCM/APNs (center → push) faqat ilova tayyor bo'lgach | Push infratuzilmasi qimmat — Telegram yetarli bo'lguncha kechiktiriladi | M |
| 3.5 | `session-board` modini center'dan o'qiydigan qilib qayta yozish (barcha mashinalar) yoki o'chirish | Fayl asosidagi holat faqat bitta Mac'ni ko'radi | S |
| 3.6 | **Maskot "Navbatchi"** (dizayn: Mascot): menu-bar va web'da holatga qarab poza/antenna rangi, burchakdan chiqish animatsiyasi | Ogohlantirishlarni yoqimli va ko'zga tashlanadigan qilish | S |

**Qabul mezoni:** telefondan approve → terminal davom etadi (≤3 s); menu-bar limit % dashboard bilan bir xil; mod barcha mashinalardagi sessiyalarni ko'rsatadi.

---

## Faza 4 — Mustahkamlash (≈1 hafta)

| # | Task | Hajm |
|---|---|---|
| 4.1 | Kalitlarni aylantirish (device key rotation), qurilmani bekor qilish (revoke) — darhol WS uzish | S |
| 4.2 | Retention: `session_events` 90 kun, `token_usage` raw 30 kun + agregatlar abadiy; compression | S |
| 4.3 | Center'ni Ubuntu'ga ko'chirish runbook'i (pg_dump/restore, DNS = Tailscale MagicDNS nomi o'zgarmaydi) | M |
| 4.4 | Xavfsizlik review (`code-review` agent + `/security-review`), penetratsion sinov: o'g'irlangan client token, replay, chat_id spoofing | M |
| 4.5 | Kuzatuv: center o'z health'ini Telegram'ga (agentd offline > 10 daqiqa, DB disk > 80%) | S |

---

## Birinchi 10 task (prioritet bo'yicha)

1. 0.1 Spike — imkoniyatlarni tekshirish (M)
2. 0.3 Tailscale + ACL (S)
3. 0.4 Mac keep-awake + backup (S)
4. 0.2 Monorepo + contracts (M)
5. 0.5 TimescaleDB sxema + migratsiya (M)
6. 0.6 Device identity + audit (M)
7. 1.1 agentd skeleti (L)
8. 1.2 Hook ko'prigi (M)
9. 1.3 + 1.4 Token yig'ish va saqlash (L + M)
10. 1.7 + 1.8 Remote permission + Telegram (L + M)
