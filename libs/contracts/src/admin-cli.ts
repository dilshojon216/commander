import { z } from 'zod';
import { ClientDeviceKindSchema, ClientPairingKindSchema, ClientTokenScopeSchema } from './identity.js';

/**
 * N1.12: `ops/mac/commander-admin.sh` (`node dist/cli.js ... --json`) buyruqlarining JSON chiqishlari.
 * Native dashboard (`AdminCLI`) chiqishni AYNAN shu generatsiya qilingan tiplar bilan o'qiydi: qo'lda DTO yo'q.
 *
 * Konventsiya:
 *  - MAVJUD chiqishlar (`enroll-code create`, `token create|rotate`, `client pair`, `center-key show`) snake_case bo'lib
 *    qoladi (orqaga moslik: ular allaqachon skriptlar/hujjatlarda ishlatiladi);
 *  - YANGI ro'yxat/holat chiqishlari camelCase (REST `/v1` bilan bir xil);
 *  - SIRLAR (enrollment kodi, token, pairing kodi) faqat yaratuvchi buyruq chiqishida bor (`*Created`/`*Issued`/`*Rotated`/`AdminPairOutput`);
 *    ro'yxat chiqishlarida hech qachon (DB'da faqat xesh, kod/token qayta ko'rsatilmaydi);
 *  - Vaqtlar ISO-8601 satr (`atMs` — epoch ms).
 */

const IsoDate = z.string();

// --- enrollment kodlari -------------------------------------------------------------------------

/** `enroll-code create --json`. `code` FAQAT shu yerda (bir marta). */
export const AdminEnrollCodeOutputSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  kind: z.literal('agentd'),
  machine_name: z.string(),
  expires_at: IsoDate,
});
export type AdminEnrollCodeOutput = z.infer<typeof AdminEnrollCodeOutputSchema>;

export const ADMIN_ENROLL_CODE_STATES = ['pending', 'used', 'expired'] as const;
export const AdminEnrollCodeStateSchema = z.enum(ADMIN_ENROLL_CODE_STATES);
export type AdminEnrollCodeState = z.infer<typeof AdminEnrollCodeStateSchema>;

export const AdminEnrollCodeEntrySchema = z.object({
  id: z.uuid(),
  machineName: z.string(),
  state: AdminEnrollCodeStateSchema,
  createdAt: IsoDate,
  expiresAt: IsoDate,
  usedAt: IsoDate.nullable(),
});
export type AdminEnrollCodeEntry = z.infer<typeof AdminEnrollCodeEntrySchema>;

/** `enroll-code list --json` (oxirgi 50 ta; kod qiymati YO'Q). */
export const AdminEnrollCodeListSchema = z.object({ items: z.array(AdminEnrollCodeEntrySchema) });
export type AdminEnrollCodeList = z.infer<typeof AdminEnrollCodeListSchema>;

// --- klient tokenlari ---------------------------------------------------------------------------

/** `token create --json`. `token` FAQAT shu yerda (bir marta). */
export const AdminTokenIssuedSchema = z.object({
  id: z.uuid(),
  token: z.string(),
  kind: ClientDeviceKindSchema,
  name: z.string(),
  scopes: z.array(ClientTokenScopeSchema),
  expires_at: IsoDate.nullable(),
});
export type AdminTokenIssued = z.infer<typeof AdminTokenIssuedSchema>;

/** `token rotate <id> --json`: yangi token (bir marta) + eski token grace ma'lumoti. */
export const AdminTokenRotatedSchema = AdminTokenIssuedSchema.extend({
  rotated_from: z.uuid(),
  grace_ends_at: IsoDate.nullable(),
  stepup_exempt_inherited: z.boolean(),
});
export type AdminTokenRotated = z.infer<typeof AdminTokenRotatedSchema>;

export const ADMIN_TOKEN_STATES = ['active', 'revoked', 'expired'] as const;
export const AdminTokenStateSchema = z.enum(ADMIN_TOKEN_STATES);
export type AdminTokenState = z.infer<typeof AdminTokenStateSchema>;

export const AdminTokenEntrySchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  name: z.string().nullable(),
  scopes: z.array(z.string()),
  state: AdminTokenStateSchema,
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
  /** `null` = muddatsiz (tavsiya etilmaydi: `token rotate <id> --expires-days 90`). */
  expiresAt: IsoDate.nullable(),
  revokedAt: IsoDate.nullable(),
});
export type AdminTokenEntry = z.infer<typeof AdminTokenEntrySchema>;

/** `token list --json` (agentd qurilmalari YO'Q, ular `device list`da; token qiymati/xeshi YO'Q). */
export const AdminTokenListSchema = z.object({ items: z.array(AdminTokenEntrySchema) });
export type AdminTokenList = z.infer<typeof AdminTokenListSchema>;

// --- agentd qurilmalari -------------------------------------------------------------------------

export const ADMIN_DEVICE_STATES = ['active', 'revoked'] as const;
export const AdminDeviceStateSchema = z.enum(ADMIN_DEVICE_STATES);
export type AdminDeviceState = z.infer<typeof AdminDeviceStateSchema>;

export const AdminDeviceEntrySchema = z.object({
  id: z.uuid(),
  /** N2.15: qurilma <-> mashina moslik (`MachineDto.id`). Olib tashlashda to'g'ri qurilmani revoke qilish uchun. */
  machineId: z.uuid().nullable(),
  name: z.string().nullable(),
  state: AdminDeviceStateSchema,
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
  revokedAt: IsoDate.nullable(),
  /** Markaz kalit aylantirishni talab qilgan va agentd hali bajarmagan. */
  rotationRequired: z.boolean(),
  keyRotatedAt: IsoDate.nullable(),
});
export type AdminDeviceEntry = z.infer<typeof AdminDeviceEntrySchema>;

/** `device list --json` (faqat `kind='agentd'`; public key YO'Q). */
export const AdminDeviceListSchema = z.object({ items: z.array(AdminDeviceEntrySchema) });
export type AdminDeviceList = z.infer<typeof AdminDeviceListSchema>;

// --- klient juftlash (QR) -----------------------------------------------------------------------

/** `client pair --json`. `code` va `url` (QR mazmuni) FAQAT shu yerda (bir marta, sukut 10 daqiqa). */
export const AdminPairOutputSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  url: z.string(),
  expires_at: IsoDate,
  kind: ClientPairingKindSchema,
  scopes: z.array(ClientTokenScopeSchema),
});
export type AdminPairOutput = z.infer<typeof AdminPairOutputSchema>;

// --- lockdown -----------------------------------------------------------------------------------

/** `lockdown status|on|off --json`. */
export const AdminLockdownStatusSchema = z.object({ enabled: z.boolean(), since: IsoDate.nullable() });
export type AdminLockdownStatus = z.infer<typeof AdminLockdownStatusSchema>;

// --- telegram allowlist -------------------------------------------------------------------------

export const ADMIN_TELEGRAM_SOURCES = ['env', 'db'] as const;
export const AdminTelegramSourceSchema = z.enum(ADMIN_TELEGRAM_SOURCES);
export type AdminTelegramSource = z.infer<typeof AdminTelegramSourceSchema>;

export const AdminTelegramEntrySchema = z.object({
  chatId: z.string(),
  /** `env` = `TELEGRAM_ALLOWED_CHAT_IDS` (faqat env + restart bilan o'chadi); `db` = `telegram remove` bilan o'chadi. */
  source: AdminTelegramSourceSchema,
});
export type AdminTelegramEntry = z.infer<typeof AdminTelegramEntrySchema>;

/** `telegram list --json`. */
export const AdminTelegramListSchema = z.object({ items: z.array(AdminTelegramEntrySchema) });
export type AdminTelegramList = z.infer<typeof AdminTelegramListSchema>;

export const AdminTelegramPendingEntrySchema = z.object({
  chatId: z.string(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  /** `/start` yuborilgan vaqt (epoch ms); yozuv 1 soatdan keyin eskiradi. */
  atMs: z.number().int(),
});
export type AdminTelegramPendingEntry = z.infer<typeof AdminTelegramPendingEntrySchema>;

/** `telegram pending --json`. */
export const AdminTelegramPendingSchema = z.object({ items: z.array(AdminTelegramPendingEntrySchema) });
export type AdminTelegramPending = z.infer<typeof AdminTelegramPendingSchema>;

// --- markaz imzo kaliti -------------------------------------------------------------------------

export const AdminCenterKeyOverlapSchema = z.object({
  fromFingerprint: z.string(),
  toFingerprint: z.string(),
  issuedAt: IsoDate,
  expiresAt: IsoDate,
});
export type AdminCenterKeyOverlap = z.infer<typeof AdminCenterKeyOverlapSchema>;

/** `center-key show --json` (public key va fingerprint: sir emas). */
export const AdminCenterKeyShowSchema = z.object({
  public_key: z.string(),
  fingerprint: z.string(),
  overlap: z.array(AdminCenterKeyOverlapSchema),
});
export type AdminCenterKeyShow = z.infer<typeof AdminCenterKeyShowSchema>;

// --- N3.8: salomatlik chegaralari ---------------------------------------------------------------
// `audit list --json` -> `ListAuditResponse` (identity.ts), `health thresholds get|set --json` -> `HealthThresholdsResponse`
// (health.ts); `set --body` esa `PutHealthThresholdsBody`. Bu yerda takror sxema YO'Q (generator bir xil obyektni bitta nom bilan chiqaradi).
