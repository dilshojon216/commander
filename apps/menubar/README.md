# Commander menu-bar (macOS) + "Navbatchi" maskoti

TASKS 4.2 va 4.6. SwiftUI `MenuBarExtra` (`.window`) ilovasi: sessiyalar holati, limitlar (bashorat bilan),
ruxsat so'rovlari (Ruxsat/Rad), server salomatligi, ogohlantirishlar, navbat; bildirishnomalar va
burchakdan chiqadigan maskot. Faqat **o'qiydi va approve qiladi** (PLAN §4.4): prompt/start/stop yo'q.

- macOS 14+, Swift 6.4 / Xcode 27. Odatda Dock ikonkasi yo'q (`LSUIElement`); "Commander" oynasi ochiq
  paytda Dock'da ko'rinadi (pastga qarang).
- API modellari faqat `clients/swift/CommanderContracts` dan (generatsiya; qo'lda yozilmaydi).
- Token faqat Keychain'da (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), log/faylga yozilmaydi.

## Tuzilma

```
Package.swift                 SwiftPM: MenuBarCore (sof mantiq) + CommanderMenuBar (ilova) + testlar
Sources/MenuBarCore/          holat reduktori, formatlash, approval oqimi, qayta ulanish, pairing, REST klient
Sources/CommanderMenuBar/     SwiftUI: panel, maskot, pop-up, Keychain, bildirishnomalar, WS
Tests/MenuBarCoreTests/       unit testlar (clients/fixtures dagi jonli fixture'lar bilan)
scripts/build-app.sh          release build -> build/Commander.app (ad-hoc imzo)
```

## Yig'ish va o'rnatish

```bash
cd apps/menubar
swift test                       # unit testlar
./scripts/build-app.sh           # -> build/Commander.app
./scripts/build-app.sh --install # -> /Applications/Commander.app (+ commander:// sxemasini ro'yxatdan o'tkazadi)
open /Applications/Commander.app
```

Ilova ad-hoc imzolangan (Developer ID emas). Birinchi ochishda Gatekeeper so'rasa: Finder'da o'ng tugma -> "Open".
Ishlab chiqishda `swift run CommanderMenuBar` ham ishlaydi, lekin bildirishnoma va "Login'da ishga tushirish"
faqat `.app` ichida ishlaydi.

## Ulash (pairing)

1. Center turgan Mac'da bir martalik kod yarating (10 daqiqa amal qiladi):

   ```bash
   ops/mac/commander-admin.sh client pair --kind menubar --name mac-menubar --scopes read,approve
   ```

   Terminalda QR va `commander://pair?c=https://<mac>.<tailnet>.ts.net&code=XXXXX-XXXXX` havolasi chiqadi.
   (Center `CENTER_PUBLIC_URL` env'ini bilishi kerak; yo'q bo'lsa `--center-url https://...` qo'shing.)
   Faqat ko'rish uchun `--scopes read` bering: unda Ruxsat/Rad tugmalari yashiriladi.
2. Ulash usullari (birinchi ishga tushishda "Commander'ni ulash" oynasi o'zi ochiladi; keyin panel -> Sozlamalar -> Ulash):
   - havolani bosing (Terminal'da `Cmd`+bosish) yoki `open 'commander://pair?...'` — oyna to'ldirilgan holda ochiladi;
   - havolani nusxalab "Clipboard'dan qo'yish";
   - QR skrinshotini "QR rasmdan o'qish…";
   - yoki center manzili + kodni qo'lda kiriting.
3. "Ulash" -> `POST /v1/clients/pair` (`deviceName` = Mac nomi, `platform: macos`). Token Keychain'ga tushadi,
   ilova `/ws/client` ga ulanadi.

Havola bosilganda ilova avtomatik ulanmaydi: siz "Ulash" ni bosasiz (begona havola sizni boshqa center'ga ulamasligi uchun).

**Uzish:** panel -> Sozlamalar -> "Ulanishni uzish" (`POST /v1/devices/me/revoke` + Keychain'dan o'chirish).
Markazga yetib bo'lmasa token lokal o'chiriladi va ogohlantirish chiqadi — markazda revoke qiling
(`ops/mac/commander-admin.sh --help`, token revoke buyrug'i).

## Ishlash tartibi

- **Ma'lumot:** `/ws/client` (subprotocol `commander.v1, cmdr-token.<token>`; query string'da token YO'Q) ->
  `auth.ok` -> `subscribe` (sessions, machines, limits, approvals, alerts, health, queue) -> `subscribed` -> REST snapshot
  (`/v1/sessions?active=true`, `/v1/machines`, `/v1/limits`, `/v1/approvals`, `/v1/alerts`, `/v1/health/summary`, `/v1/queue`).
- **Qayta ulanish:** eksponensial backoff (1 s -> 60 s, ±20% jitter); 1001 darhol; 4003 5 daqiqa; 4001/4010/401 —
  to'xtaydi, "Token rad etildi: qayta ulang" banneri. 25 s da `ping`, 70 s sukut = uzilgan. Aloqa yo'qligida sariq
  banner va menu-bar'da `⚠`.
- **Menu-bar:** maskot boshi + matn (Sozlamalar: "3▶ 1⏳ 2! 8%" / faqat sessiyalar / faqat limit / faqat ikonka;
  limit oynasi: haftalik / 5 soat / eng yuqorisi). Taxminiy limit doim `≈` bilan (CLAUDE.md #6).
  Chiroq rangi: kulrang tinch, ko'k ishlamoqda, sariq javob kutmoqda, to'q sariq ruxsat, yashil tugatdi, qizil aloqa yo'q.
- **Ruxsat so'rovlari:** "Ruxsat…" -> inline tasdiq "Ha, ruxsat". Reja (`kind: plan`): matn (qisqartirilgan) +
  "Rad" / "Fikr bilan rad" (masofadan reja tasdig'i yo'q, PLAN 2.14). Lockdown: Ruxsat o'chiq, Rad ishlaydi (403 `lockdown`).
  409: "Allaqachon hal qilingan (terminalda javob berildi)". `approve` scope bo'lmasa faqat ko'rish.
- **Bildirishnomalar:** ruxsat so'rovi ("Ruxsat" — qurilma qulfdan chiqarilgan bo'lishi shart, "Rad"),
  javob kutish / watchdog ogohlantirishi, limit bashorati (yangilanishdan oldin 1 soat ichida tugasa, oyna uchun bir marta),
  server jiddiy/oflayn holatga o'tganda. Bosilsa tegishli sahifa "Commander" oynasida ochiladi (sahifasiz bo'lsa panel).
- **Maskot "Navbatchi":** 4 poza (kutmoqda / ruxsat / tugatdi / mudrayapti), SwiftUI Canvas'da chizilgan.
  Muhim hodisada ekranning o'ng yuqori burchagidan sirpanib chiqadi (javob kutish va tugatish: 8 s; ruxsat so'rovi: hal
  bo'lguncha, ko'pi bilan 90 s), "Ko'rish/Ochish" bosilsa tegishli dashboard sahifasi oynada ochiladi.
  Reduce Motion'da animatsiyasiz. Sozlamalarda o'chiriladi va sinaladi.

## "Commander" oynasi (to'liq web dashboard)

Panel -> **"Dashboard'ni ochish"** (`⌘D`) ilova ichida oddiy oyna ochadi: WKWebView `http://127.0.0.1:4318`
(Sozlamalar -> "Dashboard" bo'limida o'zgartiriladi; faqat `http(s)://host[:port]`). "Brauzerda ochish" — ikkilamchi.

- **Qayerdan ochiladi:** panel tugmasi va `⌘D`, Dock ikonkasini bosish (yoki ishlab turgan ilovani qayta `open`
  qilish), bildirishnoma bosilishi va maskot pop-up'idagi "Ko'rish/Ochish" — chuqur havola bilan:
  ruxsat so'rovi / javob kutish / tugatish / watchdog -> `/sessions/<id>` (sessiyasiz ruxsat -> `/`),
  server salomatligi -> `/machines/<id>`, limit bashorati -> `/usage`. Yo'l `userInfo`dan qayta tekshiriladi
  (faqat ma'lum marshrutlar, id `[A-Za-z0-9_-]`); yaroqsiz bo'lsa panel ochiladi.
- **Dock:** oyna ochiq paytda `NSApp.setActivationPolicy(.regular)` (Dock'da maskot ikonkasi), yopilsa `.accessory`.
  Oyna o'lchami/joyi eslab qolinadi (`CommanderDashboardWindow`).
- **Toolbar:** orqaga / oldinga / yangilash + sahifada qidirish; manzil satri yo'q, sarlavha sahifa sarlavhasidan.
- **Klaviatura:** `⌘R` yangilash, `⌘[` / `⌘]` orqaga/oldinga, `⌘W` yopish, `⌘F` qidirish (Enter keyingi,
  Shift+Enter oldingi, Esc tozalash), `⌘+` / `⌘-` / `⌘0` masshtab, `⌘C/V/X/A/Z` tahrir.
- **Xavfsizlik:** navigatsiya faqat sozlangan dashboard origin'i ichida (`127.0.0.1` <-> `localhost` bir xil port);
  boshqa http(s)/mailto havolalar (claude.ai, GitHub PR...) tizim brauzerida; `file:`, `javascript:`, `data:`,
  `commander:` va begona `blob:` bloklanadi; iframe'dagi begona manzil brauzerni ochmaydi. `target=_blank` /
  `window.open` yangi oyna yaratmaydi. **Bitta JS ko'prik:** `commanderAuth` (faqat dashboard origin'ining asosiy freymi; Touch ID bilan kirish/qayta tasdiq, sir sahifaga berilmaydi), boshqa script message handler yo'q. Ma'lumot ombori
  doimiy (`WKWebsiteDataStore.default()`: mavzu tanlovi localStorage'da saqlanadi). ATS: faqat
  `NSAllowsLocalNetworking`. Tokenlar dashboard serverida qoladi (`apps/dashboard/.env.local`), oynaga o'tmaydi.
- **Kirish (H-01):** dashboard sessiyasiz yopiq. Birinchi marta: terminalda `bash ops/mac/dashboard-auth.sh setup`, keyin
  oynada "Birinchi marta sozlash" -> kod -> "Mac ilovani juftlash" (ilova siri Keychain'da, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
  Keyin har oyna ochilishida Touch ID/tizim paroli so'raladi va sessiya cookie'si `WKHTTPCookieStore`ga yoziladi; xavfli amal
  (ruxsatni allow qilish, buyruq yuborish...) 5 daqiqalik yangi tasdiq so'raydi (Touch ID oynasi o'zi chiqadi). Tafsilot:
  `apps/dashboard/README.md`, PLAN ADR "dashboard lokal autentifikatsiya".
- **Dashboard ishlamasa:** native "Dashboard ishlamayapti" sahifasi, "Qayta urinish" (`⌘R`) va har 5 s avtomatik
  urinish; maslahat: `bash ops/mac/dashboard-install.sh`.

Dashboard serveri doimiy launchd xizmati (`uz.commander.dashboard`, production `next start`, 127.0.0.1:4318):

```bash
bash ops/mac/dashboard-install.sh     # o'rnatish (build yo'q bo'lsa build qiladi), HTTP 200 ni kutadi
bash ops/mac/dashboard-redeploy.sh    # yangilash: build + kickstart -k + 200 tekshiruvi
bash ops/mac/dashboard-uninstall.sh   # o'chirish
tail -f ~/Library/Logs/commander/dashboard.log
```

## Tekshiruv

```bash
swift test
./scripts/build-app.sh
open --env COMMANDER_MENUBAR_SMOKE=1 build/Commander.app   # tutun sinovi: dialog/ulash oynasisiz
# + dashboard oynasini ham ochib ko'rish:
open --env COMMANDER_MENUBAR_SMOKE=1 --env COMMANDER_MENUBAR_OPEN_DASHBOARD=1 build/Commander.app
pgrep -lx Commander && osascript -e 'tell application id "uz.commander.menubar" to quit'
```

## Cheklovlar

- Ad-hoc imzoda Data Protection keychain entitlement'i yo'q: token login keychain'ga
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` bilan) yoziladi; Developer ID bilan imzolansa avtomatik
  Data Protection keychain ishlatiladi.
- Panelni dasturiy ochish uchun ommaviy API yo'q: status bar tugmasi topilib bosiladi.
- Menu-bar ikonkasi rangli holatda tizim mavzusiga (qorong'i/yorug') qarab chiziladi.
- Sessiya/prompt boshqaruvi (3.10 Remote Control, prompt yuborish) panelda yo'q: "Commander" oynasidagi
  dashboard/Telegram/mobil orqali.
- Dashboard oynasida fayl yuklab olish (download) qo'llab-quvvatlanmaydi.
