# commander-signer (TASKS 5.7, review H-02)

Markazning buyruq-imzo kaliti (Ed25519) macOS Keychain'da; Docker'dagi markaz kalitni ko'rmaydi, faqat imzo so'raydi.
Qaror, variantlar va qoldiq xavf: `docs/PLAN.md`, ADR "host imzolovchi". Amaliy ko'rsatmalar: `docs/infra/center-migration.md` §10, `docs/infra/key-rotation.md`.

Nega Swift: Keychain'da "faqat shu binary o'qiydi" ACL (`SecAccess` + `SecTrustedApplication`, cdhash talabi) Node'dan mumkin emas
(`security` CLI elementni o'zining ACL'i bilan yaratadi: uni chaqirgan har kim o'qiydi). P-256/Secure Enclave rad etildi: ad-hoc imzoda
entitlement yo'q va simni (barcha agentd verifikatorlari) o'zgartirardi.

```
Sources/SignerCore/      Policy (kanonik satr, tekshiruv), RateLimiter, AuditLog (xesh zanjiri), KeyStore (Keychain/test),
                         Signer (imzo, aylantirish, JSON qatlami), Server (soket, HMAC handshake), KeyImport/Backup, OwnerAuth
Sources/commander-signer CLI: serve | show | generate | import | import-rotations | export-backup | verify-backup | restore-backup |
                         delete-key | lock | unlock | status | verify-log
Tests/SignerCoreTests/   31 test (swift test)
ops/mac/                 signer-install.sh, signer-uninstall.sh, signer-backup.sh, uz.commander.signer.plist.template
```

## Protokol (yangi qator bilan ajratilgan JSON, `127.0.0.1:4320` yoki `--unix PATH`)

1. server -> `{"t":"challenge","nonce":S}`; klient -> `{"t":"auth","nonce":C,"mac":HMAC(secret,"COMMANDER-SIGNER-V1:client\nS\nC")}`;
   server -> `{"t":"ready","mac":HMAC(secret,"COMMANDER-SIGNER-V1:server\nS\nC")}`. `secret` = `~/.commander-signer/run/auth.secret` (har ishga tushishda yangilanadi).
2. So'rovlar: `info` (public key, fingerprint, e'lonlar), `status`, `sign_command {deviceId, commandId, type, nonce, expiresAt, payloadSha256}`, `rotate {overlapDays}`.
   Javob `{"ok":true,...}` yoki `{"ok":false,"code":...}` (`locked`, `rate_limited`, `policy_violation`, `key_missing`, `key_unavailable`, `log_failed`, `bad_request`).

## Fayllar (`~/.commander-signer`, 0700)

`bin/commander-signer` (ad-hoc imzolangan), `run/auth.secret` (0600; markazga `:ro` ulanadi), `rotations.json` (ochiq), `log/signatures.log` (append-only, xesh zanjiri), `LOCK` (kill-switch).

## Sinov

```bash
swift test                                   # 31 unit/protokol testi
swift build                                  # keyin: cd ../center && npx vitest run src/commands/signer-binary.spec.ts (haqiqiy binary bilan)
```
`COMMANDER_SIGNER_TEST_KEYSTORE=/path` (faqat testlar) Keychain o'rniga fayl ishlatadi. Production'da bu o'zgaruvchi o'rnatilmaydi.

## Muhim cheklovlar

- Binary qayta qurilsa Keychain ACL (cdhash) uni tanimaydi: demon fail-closed. Tiklash: `signer-install.sh --reimport` yoki `restore-backup`.
- `auth.secret` ni shu foydalanuvchining istalgan jarayoni (va `docker` huquqi) o'qiy oladi: himoya = siyosat + rate limit + audit + LOCK, kalit olib ketish yopilgan, lekin onlayn imzo so'rash yopilmagan.
- Unix soket bind-mount Docker Desktop'da ishlamaydi (ENOTSUP), shu sabab markaz uchun loopback TCP.
