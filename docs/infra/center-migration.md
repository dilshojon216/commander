# Commander Center: ko'chirish va Disaster Recovery (Mac ↔ Ubuntu)

Holat: skriptlar **haqiqiy drill'dan o'tgan** (2026-11-14, §9). Haqiqiy Ubuntu'ga ko'chirish hali qilinmagan.

Skriptlar: `ops/migrate/{export,import,verify}-center.sh` (+ umumiy `ops/migrate/lib.sh`),
`ops/mac/{backup,restore,backup-secrets,backup-offsite}.sh`.

---

## 1. Nima ko'chiriladi

| Ob'ekt | Ichida | Yo'qolsa |
|---|---|---|
| `commander_pgdata_ts` (DB) | sessions, token_usage, devices, commands, audit_log, ... | butun tarix va identity (device tokenlari) |
| `commander_center_secrets` | `queue-prompt.key`; `command-signing.key` (Ed25519) faqat imzolovchi o'rnatilmagan bo'lsa yoki egasi hali o'chirmagan bo'lsa (5.7, §10) | agentd'lar imzoni rad etadi -> har birida `center-key reset` (qayta pin); navbatdagi shifrlangan promptlar o'qilmaydi |
| macOS Keychain (`uz.commander.signer`) + `~/.commander-signer/` | imzo kaliti (5.7, §10), `rotations.json` (ochiq), imzo logi | kalit zaxirasiz yo'qolsa: har agentd'da `center-key reset`; **volume zaxirasiga KIRMAYDI**: `ops/mac/signer-backup.sh` |
| `apps/center/.env` | `AUTH_TOKEN`, `POSTGRES_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `CENTER_PUBLIC_URL`, ... | ulanish/bot ishlamaydi |
| Kod + `docker-compose.yml` | repo | target'da `git clone` / rsync, image o'sha yerda build qilinadi |

`backup.sh` faqat DB'ni oladi. Kalitlar uchun **alohida** `backup-secrets.sh` shart (§7); imzo kaliti Keychain'da bo'lsa uning zaxirasi `signer-backup.sh` (§10).
Mac'da qoladi: LaunchAgent'lar (backup, caffeinate, dashboard), `~/commander-backups/`.

---

## 2. Nom (DNS) masalasi: agentd'lar markazni qanday topadi

Hozir agentd'lar `~/.commander/config.json` dagi `centerUrl` ga ulanadi:
`https://<mac>.<tailnet>.ts.net` (Mac'dagi `tailscale serve` -> `127.0.0.1:4317`).

**Muhim fakt:** MagicDNS nomi (`<mashina>.<tailnet>.ts.net`) **mashinaga (node'ga) bog'langan**. MagicDNS'da
ixtiyoriy nomni (masalan `commander.<tailnet>.ts.net`) boshqa node'ga "yo'naltirib" qo'yadigan CNAME/alias YO'Q,
va `tailscale serve`/`funnel` ham boshqa node nomini egallay olmaydi. Shuning uchun real variantlar:

| Variant | Qanday | agentd config o'zgaradimi |
|---|---|---|
| **A. Tailscale Services (tavsiya, agar tailnet'da mavjud bo'lsa)** | Admin console'da Service yaratiladi (masalan `svc:commander` -> `commander.<tailnet>.ts.net`), host node tag bilan tasdiqlanadi va `tailscale serve --service=svc:commander ...` bilan xizmat ko'rsatadi. Ko'chirishda Service host'i Mac'dan Ubuntu'ga o'tkaziladi. Admin konfiguratsiyasi (tag, ACL/grants, service approval) va yangi Tailscale klienti kerak | Bir marta: `centerUrl` -> `https://commander.<tailnet>.ts.net` |
| **B. Markaz uchun alohida doimiy node nomi** | Center har doim `commander` nomli node'da ishlaydi (masalan Ubuntu'ning machine name'i `commander`). Mac'dan ko'chishda bir marta | Bir marta (shu ko'chirishda) |
| **C. Node nomini qayta ishlatish** | Eski Mac node'i tailnet'dan o'chiriladi/qayta nomlanadi, keyin Ubuntu node'iga admin console'da `users-macbook-pro` nomi beriladi. Nomlar tailnet'da yagona, shuning uchun eski node avval nomni bo'shatishi shart; serve sertifikati yangi node'da qayta olinadi | Yo'q, lekin ikkala markaz bir vaqtda ishlay olmaydi; rollback'da nomni yana qaytarish kerak |
| D. O'z DNS server (Split DNS) | Admin console'da custom nameserver + o'z zonangiz (`commander.example.internal` -> Tailscale IP) | Bir marta; qo'shimcha infratuzilma va TLS masalasi |

Variant A yoki B'da agentd config o'zgarishi bir marta: har mashinada `~/.commander/config.json` dagi `centerUrl`
yangilanadi va agentd qayta ishga tushiriladi. Signing kaliti ko'chirilgani uchun pin (fingerprint) o'zgarmaydi,
qayta enrollment kerak emas. `.env` dagi `CENTER_PUBLIC_URL` ham yangi nomga o'zgartiriladi (pairing QR'lari uchun).

---

## 3. Tayyorgarlik

- Target (Ubuntu 24.04): Docker + compose plugin, Tailscale tailnet'da, repo `/opt/commander` da, 10 GB+ bo'sh joy.
- Mac'da yangi zaxiralar: `bash ops/mac/backup.sh` va `bash ops/mac/backup-secrets.sh --passphrase-file ~/.commander/backup.pass`.
- Passphrase fayli: `umask 077; openssl rand -base64 32 > ~/.commander/migrate.pass` (0600). Parol menejerida ham saqlang.
  Passphrase hech qachon buyruq argumenti sifatida berilmaydi (skriptlar `--passphrase` ni rad etadi).
- §2 dagi nom variantini tanlang va agentd'larni oldindan (yoki shu ko'chirishda) yangi `centerUrl` ga tayyorlang.

---

## 4. Eksport (Mac)

```bash
bash ops/migrate/export-center.sh --passphrase-file ~/.commander/migrate.pass --output ~/commander-export
# ixtiyoriy: --project NAME --compose-file FILE --env-file FILE
```

Nima qiladi: app'dan kalit fingerprint'ini oladi -> `app` ni to'xtatadi (DB yozilmasin) -> `pg_dump --format=custom | gzip`
(`pg_restore --list` bilan tekshiradi) -> sanoqlar va kalit sha256'larini `manifest.txt` ga yozadi -> secrets volume'ni
faqat o'qish uchun ulab, tar oqimini to'g'ridan-to'g'ri shifrlaydi (ochiq tar diskka tushmaydi) -> `.env` ni shifrlaydi ->
`app` ni qayta ishga tushiradi (xato bo'lsa ham, `trap`) -> `checksums.txt`.

Natija (katalog 0700, fayllar 0600): `db.sql.gz` (**shifrlanmagan**), `secrets.tar.enc`, `env.enc`, `manifest.txt`,
`checksums.txt`, `EXPORT_INFO.txt`. Shifr: `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt` (macOS LibreSSL bilan
shifrlangani Linux OpenSSL 3 da ochilishi tekshirilgan).

Downtime: faqat dump vaqti (drill'da 3 s). Agentd'lar outbox orqali qayta ulanadi.

Uzatish (faqat Tailscale/SSH ichida, `db.sql.gz` ochiq):
```bash
rsync -a ~/commander-export/ user@ubuntu:/opt/commander/import/
ssh user@ubuntu 'chmod 700 /opt/commander/import && chmod 600 /opt/commander/import/*'
```
(macOS `rsync` = openrsync, `--chmod` ni qo'llamaydi; manba fayllar 0600 va `-a` ularni saqlaydi.)

---

## 5. Import (Ubuntu)

```bash
cd /opt/commander
bash ops/migrate/import-center.sh --export-dir /opt/commander/import --passphrase-file ~/.commander/migrate.pass
# ixtiyoriy: --project NAME --compose-file FILE --env-file DEST --port N --db-only --force
```

Tartib: checksumlar (mos kelmasa to'xtaydi) -> loyihada konteyner/volume yoki `.env` bor bo'lsa to'xtaydi (`--force`siz)
-> `.env` ni 0600 bilan o'rnatadi (`--port` bilan host portini almashtirish mumkin) -> `docker compose create`
(to'g'ri label'li volume'lar) -> secrets: shifrlangan oqim -> volume ichida `tar -x`, sha256 manifest bilan solishtiriladi ->
`compose up db` (`.env` dagi `POSTGRES_PASSWORD` bilan initdb) -> `ops/mac/restore.sh --container` (TimescaleDB
`pre_restore`/`post_restore`) -> migrations soni va qatorlar manifest bilan solishtiriladi -> `compose up`, app healthy kutiladi.

**Telegram:** bot long-polling qiladi; ikki markazda bir token = 409 to'qnashuv. Import `.env` da token bo'lsa ogohlantiradi:
manba markazni to'xtating yoki targetda tokenni vaqtincha bo'shating.

---

## 6. Tekshiruv va o'tkazish

```bash
bash ops/migrate/verify-center.sh --export-dir /opt/commander/import   # + --project/--compose-file/--env-file/--center-url
```
Tekshiradi (faqat o'qish): db/app healthy, `GET /health` 200 `{"ok":true}`, jadvallar, timescaledb versiyasi, hypertable'lar,
migrations va qator sonlari (manifest bilan; audit_log >= manifest), kalit fayllar mavjudligi/0600/sha256, `center-key show`
fingerprint, `audit verify` zanjiri, `.env` kalitlari (qiymatlar chop etilmaydi). Chiqish kodi 0 = hammasi o'tdi.

So'ng:
1. Mac: `docker compose -p commander stop app` (Telegram poller va eski markaz to'xtaydi), `tailscale serve --https=443 off`.
2. Ubuntu: `tailscale serve --bg --https=443 http://127.0.0.1:4317` (Variant A'da `--service=svc:commander` bilan).
3. §2 bo'yicha nom: Service host'ini o'tkazish / agentd `centerUrl` ni yangilash / node nomini o'tkazish.
4. `CENTER_PUBLIC_URL` (.env) yangi nomga, `docker compose up -d app`.
5. 1-2 daqiqada mashinalar `online`: dashboard yoki `GET /api/c/machines`. Kalit bir xil, shuning uchun agentd pin'i o'zgarmaydi.
6. Telegram'da bitta xabar, dashboard `.env.local` dagi center URL.

## 7. Rollback

- Ubuntu'da muammo: Ubuntu app'ni to'xtating, Mac'da `docker compose -p commander start app`, `tailscale serve` ni qaytaring,
  nom/`centerUrl` ni qaytaring. Mac DB'si eksport paytidagi holatda qolgan (ko'chirish orasidagi yangi yozuvlar Ubuntu'da qoladi).
- Ubuntu'da DB buzilgan bo'lsa: `import-center.sh ... --force` (loyiha volume'lari ustidan yoziladi; avval zaxira oling).

---

## 8. Disaster Recovery: zaxiralar

| Skript | Nima | Qayerga | Shifr |
|---|---|---|---|
| `ops/mac/backup.sh` (launchd, har kecha) | `pg_dump` custom+gzip, `pg_restore --list` tekshiruvi | `~/commander-backups/commander-*.sql.gz` (0600, katalog 0700), 14 kun | yo'q (lokal) |
| `ops/mac/backup-secrets.sh --passphrase-file F` | center_secrets volume (faqat o'qish) | `center-secrets-*.tar.enc` + `.sha256` (0600), 30 kun | aes-256-cbc/pbkdf2 600k; yaratilgach qayta ochib volume bilan solishtiriladi |
| `ops/mac/backup-secrets.sh --verify FILE --passphrase-file F` | zaxirani ochib sha256 ni joriy volume bilan solishtirish | - | ochiq nusxa faqat konteyner ichida |
| `ops/mac/backup-offsite.sh <user@host or /path> --passphrase-file F [--dry-run]` | dump'larni **jo'natishdan oldin shifrlaydi** (`offsite/*.sql.gz.enc`, keshlanadi), secrets `.enc` bilan rsync | SSH (`~/backups/commander/`) yoki lokal/mount qilingan katalog | ochiq dump off-site'ga chiqmaydi; `--delete` yo'q; off-site rotatsiya 30 kun |

Tiklash: DB -> `bash ops/mac/restore.sh FILE.sql.gz --confirm [--container NAME]`; secrets ->
`openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:F -in X.tar.enc | docker run --rm -i -v commander_center_secrets:/v timescale/timescaledb:2.32.0-pg16 tar -xpf - -C /v`.
Off-site dump: `openssl enc -d ... -in X.sql.gz.enc -out X.sql.gz`, keyin `restore.sh`.
Off-site uchun launchd job hali yo'q (qo'lda yoki keyinroq plist).

---

## 9. Drill natijalari (2026-11-14, shu Mac, production'dan izolyatsiya qilingan)

Sozlama: production image (`commander-app` e93c3cdfee40, qayta build qilinmagan), alohida compose loyihalari
`cmdrill-a` (127.0.0.1:54317) va `cmdrill-b` (127.0.0.1:54318), har biri o'z volume'lari bilan; `.env` nusxasida
`TELEGRAM_BOT_TOKEN` bo'sh. Production volume'lari faqat `:ro` ulanib nusxalandi; production'ga faqat o'qish so'rovlari.

| Qadam | Natija | Vaqt |
|---|---|---|
| Oxirgi zaxira (`commander-20261114-095821.sql.gz`, 1.5 MB) -> drill-a, `restore.sh --container` | OK, 52 jadval, timescaledb 2.32.0 | 2 s |
| drill-a app | healthy, `/health` 200 | 6 s |
| `export-center.sh` (drill-a) | OK, 439 dump obyekti, 2 secrets fayl, 6 env kaliti, hammasi 0600 | 4 s (app downtime 3 s) |
| `import-center.sh` -> drill2 (`--port 54318`) | OK, secrets sha256 mos, migrations/qatorlar mos, app healthy | 15 s |
| `verify-center.sh` (drill2) | 19 o'tdi, 0 yiqildi | 5 s |

Tasdiqlar: drill2 `/health` 200; migrations 27 = production 27; sessions 105 / token_usage 2210 / devices 32 / commands 26 /
audit_log 1010 = zaxira; center-key fingerprint `43e929748ff1b5b8` = production; `command-signing.key` sha256 `413e23b9…` va
`queue-prompt.key` sha256 `36498fdc…` = production; `audit verify`: OK, 1010 qator.
(Production token_usage/audit_log zaxiradan keyin o'sgan, bu kutilgan.)

Salbiy holatlar (hammasi xavfsiz to'xtadi, hech narsa yaratilmadi): noto'g'ri passphrase, buzilgan `db.sql.gz` (checksum),
mavjud loyihaga `--force`siz import, `--passphrase` argv'da, 0644 passphrase fayli, TTY'siz passphrase'siz ishga tushirish.

`backup-secrets.sh`: production volume'idan 3616 baytli `.tar.enc` (0600), `--verify` bilan ochildi, 2/2 sha256 mos; qo'lda
`openssl -d` bilan ham mos; noto'g'ri passphrase rad etildi. `backup-offsite.sh` (lokal katalog target): dry-run 16 dump
shifrlandi (vaqtinchalik), hech narsa yozilmadi; haqiqiy ishga tushirish 4 ta `.enc` (0600), takroriy ishga tushirish 0 uzatish,
ochilgan dump sha256 manba bilan mos, lokal o'chirilgan dump off-site'da qoldi. SSH target bu drill'da sinalmagan (server yo'q).

Drill'da tuzatilgan xatolar: secrets db konteyneridan o'qilardi (u yerda volume yo'q); `openssl enc -P` shifrlamasdan
kalit/IV'ni chop etardi va 0 baytli fayl qoldirib ochiq arxivni o'chirardi; import `--passphrase` argv'da va `-d -P` hech narsa
ochmasdi; vaqtinchalik DB `POSTGRES_PASSWORD=commander` bilan yaratilardi (.env'dagi parol bilan mos kelmaydi); verify
ishlamayotgan volume'ga psql qilardi va `typeorm_metadata` (aslida `migrations`) jadvalini so'rardi; checksum xatosi
faqat ogohlantirish edi; `sha256sum`/GNU `stat` taxmini; xatoda app to'xtagan holda qolardi; `.env.enc` yashirin fayl
`scp *` da tushib qolardi; off-site `rsync --delete` lokal o'chirishni off-site'ga ham tarqatardi va dump'lar ochiq ketardi;
dump'lar 0644 edi (mavjud 16 tasi 0600 ga o'zgartirildi).

Tozalash: ikkala drill loyihasi `down -v`, volume/tarmoq/teg/vaqtinchalik fayllar va passphrase o'chirildi; production
app/db healthy, 8 mashinadan 7 tasi online.

---

## 10. Imzo kaliti Keychain'da: o'rnatish, zaxira, ko'chirish (5.7, H-02)

Arxitektura: PLAN.md ADR "host imzolovchi". Markaz imzoni `uz.commander.signer` (host, `127.0.0.1:4320`) dan so'raydi; kalit Keychain'da.

**O'rnatish / kalitni ko'chirish (bir marta, Mac):**
```bash
bash ops/mac/commander-admin.sh center-key show          # joriy fingerprint (o'zgarmasligi shart)
bash ops/mac/signer-install.sh --expect-fingerprint <FP> # volume'dan O'QISH rejimida import + tekshiruv + launchd
cd apps/center && docker compose -p commander up -d --build app   # SIGNER_SOCKET/SIGNER_REQUIRED/run-katalog mount (compose'da)
bash ops/mac/commander-admin.sh center-key show          # fingerprint o'sha, markaz logida "Command signer ready (fingerprint ...)"
```
Import fingerprint mos kelmasa hech narsa saqlanmaydi. Skript volume'dagi kalitga TEGMAYDI.

**DR zaxirasi (egasi, qo'lda):** `bash ops/mac/signer-backup.sh` (Touch ID/parol + passphrase, terminal shart) -> `~/commander-backups/signer-key-*.json` (AES-256-GCM, 0600). Tekshirish: `bash ops/mac/signer-backup.sh --verify FILE`. Faylni va passphrase'ni alohida (oflayn / parol menejeri) saqlang. Keychain'dan `security export` ishlamaydi (kalit eksport qilinmaydi): shu sabab zaxira imzolovchining o'zi orqali. Tiklash (yangi/tozalangan Mac): `bash ops/mac/signer-install.sh` (binary o'rnatiladi va imzolanadi, so'ng "Keychain'da kalit yo'q" xatosi bilan to'xtaydi: `--generate` BERMANG), `~/.commander-signer/bin/commander-signer restore-backup --in FILE` (egasi tasdig'i + passphrase), so'ng `bash ops/mac/signer-install.sh --expect-fingerprint <FP>` (launchd) va markazni ishga tushiring.

**Volume nusxasini o'chirish (FAQAT egasi, zaxiradan keyin):** `bash ops/mac/signer-install.sh --expect-fingerprint <FP> --remove-volume-key`. Shartlar skriptda: imzolovchi shu kalit bilan ishlayapti, markaz imzolovchida, `signer-key-*.json` mavjud, fingerprint qo'lda yoziladi. `queue-prompt.key` tegilmaydi. Shundan keyin `backup-secrets.sh` ogohlantiradi (xato emas), `export-center.sh`/`verify-center.sh` ogohlantiradi.

**Boshqa mashinaga ko'chirish:**
- Target = Mac: eski Mac'da `signer-backup.sh`, faylni ko'chiring, yangisida `restore-backup`, keyin `import-center.sh` (DB + queue-prompt.key). Yangi Mac'da `signer-install.sh`.
- Target = Ubuntu: imzolovchi hozircha FAQAT macOS (Keychain). Ubuntu fayl-backend (`SIGNER_REQUIRED=0`, `SIGNER_SOCKET` bo'sh, `command-signing.key` volume'da) bilan ishlaydi: shu sababli Ubuntu'ga ko'chirishni rejalashtirgan bo'lsangiz `--remove-volume-key` ni BAJARMANG (yoki Ubuntu'da yangi kalit + barcha agentd'larda `center-key reset`). Linux imzolovchi (TPM/systemd-creds) alohida ish.
- Mac qayta o'rnatilsa: Keychain bo'sh -> `restore-backup`; zaxira yo'q -> yangi kalit (`signer-install.sh --generate`) + 7 mashinada `agentd center-key reset`.

**Binary qayta qurilsa:** Keychain ACL `cdhash` ga bog'langan; yangi build tanilmaydi (demon fail-closed, markazda "Markaz jarayoni" critical). Tiklash: `bash ops/mac/signer-install.sh --expect-fingerprint <FP> --reimport` (kalit volume'da bo'lsa) yoki `restore-backup`. Kod imzosi sertifikati bilan (`--identity`) bu shart bo'lmaydi. Imzolovchi kodini keraksiz o'zgartirmang.

**Kundalik:** log `~/.commander-signer/log/signatures.log` (`commander-signer verify-log` zanjirni tekshiradi, qator har imzo/rad etish); kill-switch `commander-signer lock` / `unlock` (yoki `touch ~/.commander-signer/LOCK`): markaz buyruqlari `signer_locked` bilan to'xtaydi, dashboard "Markaz holati" warn; to'xtatish: `bash ops/mac/signer-uninstall.sh`.
