# ADR-0007: Center Migration Runbook and Disaster Recovery

**Date:** 2026-11-14  
**Status:** Proposed (Faza 4, ko'chirishs uchun tayyor)  
**Authors:** Claude Haiku 4.5  
**Category:** Deployment, Disaster Recovery

---

## Problem

Hozir Commander center Mac'da ishlaydiga. Muammoli qatorlari:
1. **Mac asil xavf:** Laptop o'lsa, Wi-Fi uzilsa, Docker xatosi → butun flotga ulanish uziladi.
2. **Sirni yo'qolish:** center_secrets volume (command-signing.key, queue-prompt.key) yo'qolsa:
   - Barcha agentd qayta pin qilinadi
   - Navbatdagi prompts o'qilmaydi
3. **DNS tiqilmaslik:** Agentd'lar `users-macbook-pro.ts.net` nomiga ulanadi; ko'chirish → nomi boshqa, pairing qayta qilish kerak.

---

## Solution

### 1. DNS Stabilization

MagicDNS nomi (`<mashina>.<tailnet>.ts.net`) node'ga bog'langan; MagicDNS'da ixtiyoriy nomni boshqa node'ga
yo'naltiradigan alias yo'q (tuzatish, 2026-11-14 drill). Variantlar (to'liq: `docs/infra/center-migration.md` §2):

**Variyant A (tavsiya, tailnet qo'llasa):** Tailscale Services: `svc:commander` -> `commander.<tailnet>.ts.net`,
admin console'da tag/grant/approval bilan sozlanadi, host `tailscale serve --service=...` qiladi; ko'chirishda Service host'i
o'zgaradi. Agentd'larda `centerUrl` bir marta shu nomga o'zgartiriladi.
**Variyant B:** markaz uchun alohida doimiy `commander` node nomi (agentd config bir marta o'zgaradi).
**Variyant C:** eski node nomini bo'shatib yangi node'ga berish (config o'zgarmaydi, lekin ikki markaz parallel ishlamaydi).
Kalit ko'chirilgani uchun barcha variantda agentd pin'i o'zgarmaydi.

### 2. Runbook: Qadamlar

Yozilgan 3 ta main script:

1. **ops/migrate/export-center.sh** (Mac'da):
   - pg_dump (custom format, gzip)
   - center_secrets volume (tar)
   - .env (AES-256-CBC encrypted)
   - SHA256 checksums

2. **ops/migrate/import-center.sh** (Ubuntu'da):
   - Checksums tekshirish
   - Decryption
   - Docker volumes restore
   - Database restore (TimescaleDB pre/post hooks)
   - Health checks

3. **ops/migrate/verify-center.sh** (Post-migration):
   - Health endpoints
   - Database integrity
   - Migrations status
   - Machines connectivity (opsional, WS orqali)
   - Audit chain

### 3. Disaster Recovery

**Muammosi:** `backup.sh` faqat DB'ni saqlaydi, secrets yo'q.

**Yechim:** Yangi skriptlar:
- **backup-secrets.sh** — center_secrets (AES-256-CBC, passphrase bilan)
- **backup-offsite.sh** — rsync bu Ubuntu serverga (SSH, strict mode, --dry-run)

---

## Tradeoffs

| Aspect | Choice | Rationale |
|---|---|---|
| Encryption | AES-256-CBC (openssl) | Available on Mac/Ubuntu, simple, well-tested |
| Passphrase mgmt | Manual (user keeps offline) | Avoid storing in code/env; DR scenario requires offline access |
| SSH for sync | BatchMode + StrictHostKeyChecking | Max security; no interactive prompts in launchd |
| Import target | Manual (run on target) | Simpler than auto-sync; less attack surface |

---

## Deployment

### Faza 4'da (Shipping):
1. docs/infra/center-migration.md (451 lines, Uzbek)
2. ops/migrate/{export,import,verify}-center.sh (1K LOC)
3. ops/mac/{backup-secrets,backup-offsite}.sh (400 LOC)
4. Haqiqiy drill (2026-11-14): restore -> export -> import -> verify o'tdi (center-migration.md §9)

### Faza 2'da (Optional):
1. Auto failover: Center ikkalada (Mac + server), Tailscale Service host'ini almashtirish
2. Kubernetes: Docker Compose → k3s/microk8s, persistent volumes

---

## Testing

2026-11-14: haqiqiy drill shu Mac'da, production'dan izolyatsiyalangan compose loyihalarida (production image, alohida
volume'lar, Telegram tokeni bo'sh). Oxirgi zaxira -> restore -> export -> import (boshqa port) -> verify: 19/19 tekshiruv,
migrations 27, kalit fingerprint va secrets sha256 production bilan mos, audit zanjiri OK. `backup-secrets.sh` round-trip va
`backup-offsite.sh` (lokal target, dry-run va haqiqiy) sinaldi. Drill skriptlardagi jiddiy xatolarni topdi va tuzatildi
(openssl `-P` shifrlamasdi, secrets noto'g'ri konteynerdan o'qilardi, argv passphrase, off-site `--delete`, ochiq dump'lar).
Sinalmagan: haqiqiy Ubuntu target, SSH off-site, Tailscale nom o'tkazish. Tafsilot: `docs/infra/center-migration.md` §9.

## Qo'shimcha (5.7, 2026-11-14): imzo kaliti Keychain'da

Imzo kaliti `center_secrets` volume'idan host imzolovchisiga (macOS Keychain) ko'chirildi (PLAN.md ADR "host imzolovchi", H-02).
Oqibatlar: (1) DR uchun `backup-secrets.sh` endi faqat `queue-prompt.key` ni (va egasi volume nusxasini o'chirmaguncha imzo kalitini)
oladi; imzo kaliti zaxirasi alohida egasi-skripti `ops/mac/signer-backup.sh`; (2) `export/verify-center.sh` imzolovchi rejimida volume'da
kalit yo'qligini xato deb hisoblamaydi (ogohlantirish, fingerprint CLI orqali tekshiriladi); (3) Ubuntu'ga ko'chirish uchun fayl-backend
kerak (imzolovchi hozircha faqat macOS): batafsil `docs/infra/center-migration.md` §10.
