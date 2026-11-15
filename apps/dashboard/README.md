# Commander dashboard

Commander center API uchun Next.js 16 paneli (App Router, TypeScript, Tailwind 4). Interfeys o'zbek tilida (lotin),
qorong'i/yorug' mavzu.

Sahifalar: Umumiy, Sessiyalar (+ sessiya sahifasi: jonli chat, ruxsatlar, boshqaruv), Loyihalar (+ loyiha sahifasi:
30 kunlik token, TASKS.md rejasi va vazifa bo'yicha token, git commitlar, TODOS/CHANGELOG), Tokenlar, Mashinalar.
Hamma ma'lumot center API'dan (serverlardagi loyihalar ham): lokal diskka tegilmaydi.

## Ishga tushirish

```bash
cp .env.example .env.local   # tokenlarni to'ldiring
npm run dev                  # http://127.0.0.1:4318
npm run build && npm start   # production
```

## Sozlamalar (env, faqat server tomonda)

| O'zgaruvchi | Izoh |
|---|---|
| `COMMANDER_API_URL` | Center manzili (default `http://127.0.0.1:4317`) |
| `COMMANDER_API_TOKEN` | `read` token |
| `COMMANDER_APPROVE_TOKEN` | `read,approve`: ruxsat qarorlari |
| `COMMANDER_CONTROL_TOKEN` | `read,control`: prompt / to'xtatish / yangi sessiya |
| `DASHBOARD_HIDE_MACHINES` | Ko'rsatilmaydigan mashinalar |
| `DASHBOARD_ALLOWED_HOSTS` | Loopback'dan boshqa ruxsat etilgan `Host` nomlari |

## Xavfsizlik

- Tokenlar brauzerga chiqmaydi: brauzer `/api/c/*` proksi (qat'iy ruxsat ro'yxati, POST uchun Origin tekshiruvi va tana
  chegarasi), `/api/stream` va `/api/chat/[sessionId]/stream` (SSE) orqali gaplashadi.
- `proxy.ts` loopback bo'lmagan `Host` sarlavhalarini rad etadi (DNS-rebinding himoyasi).
- Markdown xavfsiz render qilinadi: raw HTML bajarilmaydi, rasmlar yuklanmaydi, `javascript:` havolalar tozalanadi.
- **Lokal autentifikatsiya (H-01, TASKS 5.6).** Hamma narsa (sahifalar, `/api/c/*`, `/api/stream`, `/api/chat/*`) sessiyasiz
  yopiq: sahifalar `/login` ga yo'naltiriladi, API 401 qaytaradi. Faqat `/login` va `/api/auth/*` ochiq. Pastda sozlash.

## Lokal kirish (Touch ID / parol): birinchi sozlash

Dashboard faqat egasi kira oladigan qilib himoyalangan. Hech qanday kirish usuli hali sozlanmagan bo'lsa, `/login` bo'sh
ko'rinadi: quyidagi qadamlarni **Terminal ilovasida o'zingiz** bajaring (sozlash buyruqlari TTY talab qiladi: Claude
sessiyasi yoki skript ularni ishga tushira olmaydi).

Hammasi repo ildizidan (`cd ~/working/commander`).

**1. Zaxira parol (tavsiya etiladi, Touch ID ishlamay qolsa kirish yo'li):**

```bash
bash ops/mac/dashboard-auth.sh password
```

Kamida 12 belgi (ko'p so'zli ibora yaxshi). Xesh (scrypt) `apps/dashboard/.auth/credentials.json` da (0600), repo'ga
tushmaydi. Parol fayli shu foydalanuvchi ostidagi jarayonlarga o'qilishi mumkin (oflayn taxmin), shuning uchun uzun ibora
tanlang; kundalik kirish uchun Touch ID (2 yoki 3) ishlating.

**2. Brauzer uchun passkey (Touch ID):**

```bash
bash ops/mac/dashboard-auth.sh setup        # 8 belgili kod chiqaradi (10 daqiqa, BIR marta)
```

Keyin Safari/Chrome'da **`http://localhost:4318/login`** ni oching (127.0.0.1 EMAS: WebAuthn IP manzilda ishlamaydi) ->
"Birinchi marta sozlash" -> kodni kiriting -> "Passkey qo'shish (Touch ID)" -> Touch ID. Shundan keyin "Touch ID bilan kirish" ishlaydi.

**3. Commander Mac ilovasi uchun (Touch ID):**

```bash
bash apps/menubar/scripts/build-app.sh      # kerak bo'lsa qayta yig'ish (/Applications ga o'rnatish: --install)
bash ops/mac/dashboard-auth.sh setup        # YANGI kod (2-qadamdagisi ishlatilgan bo'lishi mumkin)
```

Ilovada "Commander" oynasini oching (Dock/⌘D) -> "Birinchi marta sozlash" -> kod -> "Mac ilovani juftlash (Touch ID)".
Ilova siri Keychain'ga yoziladi; keyingi safar oyna ochilganda Touch ID so'raladi va sessiya avtomatik ochiladi.

**Tekshirish va boshqaruv:**

```bash
bash ops/mac/dashboard-auth.sh status            # nima sozlangan (sirlarsiz)
bash ops/mac/dashboard-auth.sh audit 30          # kirish/chiqish/ko'tarilish jurnali
bash ops/mac/dashboard-auth.sh revoke-sessions   # hamma sessiyani darhol tugatish
bash ops/mac/dashboard-auth.sh remove passkeys   # (yoki password | app) usulni olib tashlash
```

## Sessiya va qayta tasdiqlash (step-up)

| Qoida | Qiymat (env bilan o'zgaradi, chegaralangan) |
|---|---|
| Mutlaq umr | 12 soat (`DASHBOARD_SESSION_HOURS`, 1-24) |
| Faoliyatsiz (idle) | 2 soat (`DASHBOARD_IDLE_MINUTES`, 5-1440); faqat bosish/klaviatura va o'zgartiruvchi so'rovlar hisoblanadi, fon yangilanishi emas |
| Qayta tasdiq oynasi | 5 daqiqa (`DASHBOARD_ELEVATION_MINUTES`, 1-30) |
| Cookie | `commander_session`: HttpOnly, SameSite=Strict, Path=/, host-only (Secure/`__Host-` yo'q: http://localhost va Safari/WKWebView uchun) |
| CSRF | SameSite=Strict + Origin==Host + har o'zgartiruvchi so'rovda `X-CSRF-Token` (sessiyaga xos) |
| Parol urinishlari | 5 ta xatodan keyin 5 daqiqa blok (passkey/Mac ilova yo'li bloklanmaydi) |

Xavfli amallar (ruxsatni **allow** qilish, buyruq yuborish: sessiya ochish/prompt/rejim/remote control, navbat yaratish/o'zgartirish/ishga
tushirish, orkestratsiya boshlash, shablonni sessiyaga yuborish, avto-ruxsat qoidasi yaratish, config apply/rollback/sozlama,
PR ochish, TASKS.md'ga yozish, `commands/:id/confirm` (dashboard tasdig'i), xabar/guruh sozlamalari) oxirgi **5 daqiqa**
ichida yangi tasdiq (Touch ID / parol) talab qiladi. Kirishning o'zi ham yangi tasdiq hisoblanadi. Aks holda proksi 401
`reauth_required` qaytaradi, UI "Qayta tasdiqlash kerak" oynasini ko'rsatadi va tasdiqlangach amalni o'zi qayta yuboradi.
Rad etish (deny), bekor qilish, `session.stop`, o'qish talab qilmaydi. Ro'yxat: `lib/proxy-rules.ts` `elevationFor`
(FAIL-CLOSED: ro'yxatdagi istisnolardan tashqari har bir o'zgartiruvchi yo'l elevation talab qiladi).

## Mac dashboard step-up istisnosini qayta yoqish (egasi qarori)

**Eng oson yo'l:** dashboard'da `/settings` ("Umumiy sozlamalar") sahifasidagi "Dashboard'dan qilingan amallarga Telegram
tasdig'i kerak emas" tugmasi (6.17b): markaz `dashboard-control` qurilmasini o'zi topadi, o'zgarish elevation talab qiladi va
audit'ga (`settings.updated`) yoziladi. Lockdown'da faqat o'chirish mumkin. Quyidagi qo'lda SQL yo'li faqat zaxira uchun.

2026-11-14 da `commands.stepup_exempt_device_ids` **bo'shatilgan**: dashboard'dan sessiya ochish ham Telegram tasdig'ini
so'raydi. Endi dashboard'da lokal autentifikatsiya va qayta tasdiq bor, shuning uchun xohlasangiz istisnoni qaytarish
mumkin (Telegram ikkinchi tasdig'isiz, lekin dashboard'da Touch ID/parol bilan). Bu SIZNING qaroringiz: avtomatik yoqilmagan.

```bash
bash ops/mac/commander-admin.sh device list        # `dashboard-control` qurilmasining id'sini toping
docker exec commander-db-1 psql -U commander -d commander -c \
  "INSERT INTO settings(key,value) VALUES ('commands.stepup_exempt_device_ids','[\"<DEVICE_ID>\"]'::jsonb)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
```

(`settings` jadvali ustunlari sizning sxemangizga mos ekanini `\d settings` bilan tekshiring; DB konteyner nomi `docker ps`
da.) O'chirish: `UPDATE settings SET value='[]' WHERE key='commands.stepup_exempt_device_ids'`. Eslatma: `auto` rejim
istisnoga kirmaydi; istisno faqat `session.start`/`set_mode acceptEdits`/shu qoidadagi amallar uchun.

## Passkey va Mac ilova haqida

- Passkey (WebAuthn, platforma autentifikatori, `userVerification=required`) faqat **`http://localhost:4318`** da ishlaydi:
  brauzer IP manzilni RP ID sifatida qabul qilmaydi. `127.0.0.1` da parol yoki Mac ilova yo'li ishlaydi. RP ID/origin:
  `DASHBOARD_WEBAUTHN_RP_ID`, `DASHBOARD_WEBAUTHN_ORIGINS`, port o'zgarsa `DASHBOARD_PORT`.
- Mac ilovadagi WKWebView: ad-hoc imzolangan ilovada passkey uchun kerakli Apple entitlement (provisioning profile)
  yo'q, shuning uchun ilova alohida yo'ldan foydalanadi: Keychain'dagi ilova siri + LocalAuthentication (Touch ID/tizim
  paroli) -> sessiya cookie'si `WKHTTPCookieStore` ga yoziladi; qayta tasdiq `window.webkit.messageHandlers.commanderAuth`
  (bitta, faqat dashboard origin'ining asosiy freymi) orqali bir martalik 30 soniyalik token bilan.
- Chegara: shu foydalanuvchi ostidagi hujumchi `apps/dashboard/.env.local` dagi center tokenlarini bevosita o'qiy oladi
  (H-01 doirasidan tashqari); bu himoya HTTP orqali "dashboard'ni vosita qilish" yo'lini yopadi. Inson tasdig'i boshqa
  qurilmada (Telegram/telefon) bo'lishi baribir eng kuchli himoya.
