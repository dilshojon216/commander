# Commander mobil (Flutter)

Commander markazining telefon klienti: sessiyalar, ruxsat (approve/deny), limitlar, tokenlar, loyihalar, navbat va
masofaviy boshqaruv (yangi sessiya, prompt, to'xtatish, Remote Control). **Android birinchi**, iOS ham yig'iladi.

> Markaz faqat **Tailscale** orqali ochiladi (`https://<mac>.<tailnet>.ts.net`). Telefonda Tailscale ilovasi
> yoqilgan va tarmoqqa ulangan bo'lishi SHART; aks holda ilova "Markazga ulanib bo'lmadi" deb ko'rsatadi.
> Ilova faqat ochiq turganda jonli ulanadi (fonda WebSocket yo'q).

## O'rnatish (Android)

Talab: Flutter 3.47+, Android SDK (`flutter doctor`).

```bash
cd apps/mobile
flutter pub get
flutter build apk --debug          # build/app/outputs/flutter-apk/app-debug.apk
# telefon USB orqali ulangan (USB debugging yoqilgan; Xiaomi: "Install via USB" ham):
flutter install                    # yoki: adb install -r build/app/outputs/flutter-apk/app-debug.apk
# ishlab chiqish:
flutter run
```

Release uchun o'z imzo kalitingizni `android/app/build.gradle.kts` ga qo'shing (hozir debug kaliti). iOS:
`flutter build ios --no-codesign` (haqiqiy qurilma uchun Xcode'da Team tanlang).

## Juftlash (pairing)

1. Mac'da juftlash kodini yarating (terminalga QR va havola chiqadi; `CENTER_PUBLIC_URL` center `.env`'da bo'lishi kerak):
   ```bash
   ops/mac/commander-admin.sh client pair --kind mobile --name telefon --scopes read,approve,control
   ```
   `control` ni faqat telefondan sessiya ochish/prompt yuborish kerak bo'lsa bering; faqat ko'rish va ruxsat uchun
   `--scopes read,approve` yetarli.
2. Telefonda Tailscale'ni yoqing, Commander'ni oching.
3. **QR kodni skanerlash** (kamera ruxsati kerak), yoki `commander://pair?c=...&code=...` havolani maydonga qo'ying,
   yoki "qo'lda" bo'limiga markaz manzili (`https://...ts.net`) va kodni (`XXXXX-XXXXX`) kiriting.
4. Kod bir martalik, 10 daqiqa yashaydi. Xato bo'lsa yangi kod yarating.

Token Android Keystore / iOS Keychain'da saqlanadi (90 kun), logga yozilmaydi. **Sozlamalar -> Qurilmani ajratish**
tokenni markazda bekor qiladi va telefondan o'chiradi.

## Xavfsizlik va xatti-harakat

- **Ruxsat** tugmasi qurilma tasdig'ini (barmoq izi/yuz/PIN) so'raydi; tasdiqlanmasa so'rov yuborilmaydi. **Rad** tasdiqsiz.
- **Yangi sessiya ochish** Telegram'da ikkinchi tasdiq talab qiladi (mobil qurilma step-up istisnosida emas): ilova
  "Telegram'da tasdiqlang" holatini ko'rsatadi, tasdiqdan keyin sessiya o'zi ochiladi.
- Lockdown yoqiq bo'lsa tepada qizil banner chiqadi, "Ruxsat" va boshqaruv yopiladi, faqat "Rad" ishlaydi.
- Maxfiy qiymatlar `[REDACTED]` bo'lib keladi; chat markdown'ida xom HTML, rasm va havolalar ishlamaydi.
- Android: cleartext (http) yopiq, zaxira nusxa (`allowBackup`) o'chirilgan.

## Tuzilma

```
lib/
  core/          tema tokenlari (DESIGN-BRIEF), ApiClient, secure storage, format yordamchilari
  data/          CenterApi (REST), RealtimeClient (/ws/client), repository'lar, biometrik darvoza
  domain/        sof mantiq: limit kartasi, prompt maydoni holati, chat timeline, buyruq holati, ruxsat qoidalari
  presentation/  cubit'lar va ekranlar (Umumiy, Sessiyalar, Sessiya, Ruxsat, Loyihalar, Tokenlar, Navbat, Yangi sessiya, Sozlamalar)
test/            birlik (domain, repository, cubit, WS) va vidjet testlari; fixture'lar clients/fixtures dan
```

Tiplar `clients/dart/commander_contracts` (path dependency, `libs/contracts` dan generatsiya qilingan) dan olinadi;
qo'lda DTO yozilmaydi. Kontrakt o'zgarsa: `npm run -w libs/contracts gen:schema`, so'ng `flutter test`.

## Tekshiruv

```bash
flutter analyze
flutter test
```
