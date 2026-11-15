# Kalit aylantirish, revoke va markaz o'z-o'zini kuzatishi (Faza 5: 5.1, 5.2, 5.5)

Arxitektura qarori: `docs/PLAN.md`, "Qarorlar (Faza 5: 5.1 ...)". Bu yerda faqat buyruqlar va amaliy qoidalar.
Admin buyruqlari konteyner ichida: `bash ops/mac/commander-admin.sh <buyruq>` (yoki `docker compose exec app node dist/cli.js <buyruq>`).

## Qurilma (agentd) kalitini aylantirish

```bash
agentd rotate-key                              # shu mashinada; agentd ishlab turishi va center'ga ulangan bo'lishi shart
commander-admin.sh device require-rotation <deviceId>   # markaz so'raydi; agentd o'zi bajaradi (ulangan bo'lsa darhol)
```
- Natija: markazda `devices.public_key` atomik almashadi, audit `device.key_rotated`; eski kalit bilan yangi ulanish 4001 oladi.
- agentd `~/.commander/device.key.next` ni vaqtincha ushlaydi. Aylantirish yarim qolsa (uzilish) keyingi ulanishda o'zi tiklanadi. Qo'lda aralashmang.
- Rad kodlari (`agentd` logida): `rate_limited` (10 daqiqada 10 urinish), `stale_timestamp` (soat farqi > 60 s), `revoked`, `conflict`.
- **Production kalitlarini sinov uchun aylantirmang.** Sinov: throwaway center + agentd (`apps/center/test/db/key-rotation.db-spec.ts`, `apps/agentd/test/key-rotation.integration.spec.ts`).

## Markaz buyruq-imzo kalitini aylantirish

```bash
commander-admin.sh center-key show                       # joriy fingerprint + ustma-ust tushish oynasi
commander-admin.sh center-key rotate --overlap-days 30   # yangi kalit; eski kalit imzolagan e'lon agentlarga yetkaziladi
```
- Ulangan agentlar pin'ni TOFUsiz yangilaydi (e'lon ESKI kalit bilan imzolangan). Oyna tugaguncha ulanmagan agent: `agentd center-key reset --key <yangi public key>` (qiymat va fingerprint `center-key show`da).
- Server jarayoni kalitni NOTIFY orqali qayta yuklaydi (restart shart emas).
- **Imzolovchi rejimi (5.7, production):** yangi kalit IMZOLOVCHI ICHIDA yaratiladi (Keychain'dagi element yangilanadi), e'lon eski kalit bilan imzolanadi va `~/.commander-signer/rotations.json` ga yoziladi; markaz maxfiy kalitni ko'rmaydi. Buyruq o'sha (`center-key rotate`), imzolovchi ishlab turishi shart, LOCK bo'lsa rad etiladi, soatiga 2 martadan oshmaydi. Aylantirishdan KEYIN yangi DR zaxirasini oling: `bash ops/mac/signer-backup.sh` (eski zaxira ESKI kalitni saqlaydi: u bilan tiklansa agentlar e'lon zanjiri orqali yetib boradi, oyna ichida bo'lsa). `backup-secrets.sh` imzo kalitini endi qamramaydi.
- Fayl-backend (imzolovchisiz dev/Ubuntu): kalit fayli (`center_secrets` volume) zaxirasi `bash ops/mac/backup-secrets.sh` aylantirishdan KEYIN qayta oling.
- Jonli production kalitini sinov uchun aylantirmang: sinov `signer-backend.spec`, `signer-binary.spec` (haqiqiy Swift binary, fayl keystore) va `test/db/signer-commands.db-spec.ts` da.

## Imzolovchi (5.7, H-02)

```bash
~/.commander-signer/bin/commander-signer show        # fingerprint + public key (sir emas)
~/.commander-signer/bin/commander-signer lock|unlock # kill-switch: imzo/aylantirish rad etiladi, markaz buyruqlari signer_locked
~/.commander-signer/bin/commander-signer verify-log  # imzo logi xesh zanjiri
bash ops/mac/signer-backup.sh [--verify FILE]        # egasi: shifrlangan DR zaxirasi
bash ops/mac/signer-install.sh --expect-fingerprint FP [--reimport | --remove-volume-key]
```
Markazda: `SIGNER_SOCKET` (`tcp://host.docker.internal:4320` yoki soket yo'li), `SIGNER_AUTH_FILE`, `SIGNER_REQUIRED=1`. Buyruq xato kodlari: `signer_unavailable` (yetib bo'lmadi), `signer_locked`, `signer_rate_limited`, `signer_policy_violation`, `signer_key_missing`, `signer_bad_signature`. "Markaz jarayoni" kartasi: 2 daqiqa yetib bo'lmasa critical, LOCK = warn.

## Revoke

`device revoke <id>`, `token revoke <id>`, `telegram remove <chatId>`, klientning o'zini revoke qilishi: ochiq WS ulanishi zudlik bilan 4010 bilan uziladi (DB trigger + LISTEN/NOTIFY; sweep zaxira).

## Klient tokenini aylantirish

```bash
commander-admin.sh token rotate <id> --grace-hours 24 [--expires-days 90] [--inherit-stepup-exempt]
```
Yangi token bir marta ko'rsatiladi. Eski token grace tugaguncha ishlaydi, keyin yaroqsiz (`--grace-hours 0` = darhol revoke). Mac dashboard tokeni uchun `.env.local` ni yangilab `bash ops/mac/dashboard-redeploy.sh`; step-up istisnosi faqat `--inherit-stepup-exempt` bilan o'tadi.

## Retention / compression

```bash
commander-admin.sh retention status      # siyosatlar, qatorlar soni, siqilgan/jami chunk; muammo bo'lsa chiqish kodi 3
```
Siyosat jadvali: PLAN.md ADR. **Qo'lda `drop_chunks` yoki `refresh_continuous_aggregate` ni faqat `older_than/start >= 30 kun` bilan ishlating**: aks holda kunlik/umrbod token statistikasi yo'qoladi.

## Markaz holati (5.5)

Dashboard Umumiy sahifasida "Markaz holati"; Telegram'ga hodisa (bir marta) va "Tiklandi". Sozlash (`apps/center/docker-compose.yml`): `DASHBOARD_PROBE_URL` (bo'sh = o'chiq), `TAILSCALE_PROBE_URL` (default `CENTER_PUBLIC_URL/health`), `CENTER_DISK_PATH`, `CENTER_HEALTH_DISABLED=1`.
Zaxira ogohlantirishi `ops/mac/backup.sh` yozadigan `settings['backup.last_success']` ga tayanadi: skriptni launchd o'zgartirmasdan ishlatishda ham ishlaydi.
