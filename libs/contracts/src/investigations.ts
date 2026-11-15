import { z } from 'zod';
import { CommandDtoSchema, MODEL_RE } from './commands.js';
import { SessionStatusSchema } from './session-status.js';

/**
 * Hodisadan tekshiruvga (task 6.4): server hodisasi (3.8) yoki watchdog ogohlantirishi (3.2) uchun O'SHA mashinada
 * `session.start` (plan rejimi: faqat o'qish) ochiladi. Hamma narsa mavjud konveyer orqali: imzo, lokal siyosat, audit
 * va step-up (Telegram inline tasdiq ham hisoblanadi). Tekshiruv sessiyasi hodisaga bog'lanadi (`incident_investigations`).
 *
 * Xavfsizlik:
 *  - ish papkasi (cwd) markazda mashina bo'yicha SOZLANGAN "ops" papka (`allowedRoots` ichida bo'lishi kerak); papka masofadan
 *    YARATILMAYDI (agentd `cwd_invalid` qaytaradi); sozlanmagan bo'lsa tushuntirish bilan rad etiladi;
 *  - prompt markazda yaratiladi va redakt qilinadi: hodisa turi, ob'ekt, raqamlar; sir/env/argument yo'q;
 *  - rejim HAR DOIM `plan`: har qanday o'zgartirish alohida egasi tasdig'ini talab qiladi (mavjud ruxsat oqimi).
 */

export const INVESTIGATION_SUBJECT_KINDS = ['health', 'watchdog'] as const;
export const InvestigationSubjectKindSchema = z.enum(INVESTIGATION_SUBJECT_KINDS);
export type InvestigationSubjectKind = z.infer<typeof InvestigationSubjectKindSchema>;

export const DEFAULT_INVESTIGATION_MODEL = 'sonnet';

export const INVESTIGATION_LIMITS = {
  /** Tekshiruv promptining eng katta uzunligi (belgi). */
  promptMaxChars: 6000,
  /** Prompt'ga qo'shiladigan oxirgi konteyner holat qatorlari. */
  maxContainerLines: 12,
  pathMaxChars: 4096,
  maxOpsFolders: 200,
} as const;

export const InvestigateBodySchema = z
  .object({
    kind: InvestigationSubjectKindSchema,
    /** `health_incidents.id` yoki `watchdog_alerts.id`. */
    id: z.uuid(),
    /** Ixtiyoriy model (default: sozlamadagi, `sonnet`). */
    model: z.string().regex(MODEL_RE).optional(),
  })
  .strict();
export type InvestigateBody = z.infer<typeof InvestigateBodySchema>;

export const INVESTIGATION_STATES = ['awaiting_confirmation', 'starting', 'running', 'finished', 'failed'] as const;
export const InvestigationStateSchema = z.enum(INVESTIGATION_STATES);
export type InvestigationState = z.infer<typeof InvestigationStateSchema>;

export const InvestigationDtoSchema = z.object({
  id: z.uuid(),
  subjectKind: InvestigationSubjectKindSchema,
  subjectId: z.uuid(),
  machineId: z.uuid(),
  machineName: z.string(),
  commandId: z.uuid(),
  /** Center sessiya uuid'si (buyruq bajarilgach); `null` = hali ochilmagan. */
  sessionId: z.uuid().nullable(),
  state: InvestigationStateSchema,
  /** Sessiyaning oxirgi holati (agar sessiya tugagan bo'lsa tugash holati); `null` = noma'lum. */
  sessionStatus: SessionStatusSchema.nullable(),
  /** Buyruq xatosi (`state=failed`). */
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type InvestigationDto = z.infer<typeof InvestigationDtoSchema>;

export const InvestigateResponseSchema = z.object({ investigation: InvestigationDtoSchema, command: CommandDtoSchema });
export type InvestigateResponse = z.infer<typeof InvestigateResponseSchema>;

export const ListInvestigationsQuerySchema = z
  .object({
    kind: InvestigationSubjectKindSchema.optional(),
    machineId: z.uuid().optional(),
    subjectId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListInvestigationsQuery = z.infer<typeof ListInvestigationsQuerySchema>;
export const ListInvestigationsResponseSchema = z.object({ items: z.array(InvestigationDtoSchema) });
export type ListInvestigationsResponse = z.infer<typeof ListInvestigationsResponseSchema>;

/** Mutlaq yo'l (POSIX yoki Windows), NUL yo'q, `..` segmenti yo'q. */
export const OpsFolderPathSchema = z
  .string()
  .min(1)
  .max(INVESTIGATION_LIMITS.pathMaxChars)
  .refine((p) => !p.includes('\0'), 'NUL')
  .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'absolute path required')
  .refine((p) => !p.split(/[\\/]/).includes('..'), '".." is not allowed');

export const InvestigationSettingsSchema = z.object({
  model: z.string().regex(MODEL_RE),
  /** `machines.id` -> ops papka. */
  opsFolders: z
    .record(z.uuid(), OpsFolderPathSchema)
    .refine((r) => Object.keys(r).length <= INVESTIGATION_LIMITS.maxOpsFolders, 'too many folders'),
});
export type InvestigationSettings = z.infer<typeof InvestigationSettingsSchema>;

export const DEFAULT_INVESTIGATION_SETTINGS: InvestigationSettings = { model: DEFAULT_INVESTIGATION_MODEL, opsFolders: {} };

/** `PUT /v1/investigations/settings`: qisman; `opsFolders[machineId] = null` papkani olib tashlaydi. */
export const PutInvestigationSettingsBodySchema = z
  .object({
    model: z.string().regex(MODEL_RE).optional(),
    opsFolders: z.record(z.uuid(), OpsFolderPathSchema.nullable()).optional(),
  })
  .strict();
export type PutInvestigationSettingsBody = z.infer<typeof PutInvestigationSettingsBodySchema>;

/** "Ops" papka sozlanmagan bo'lsa tushuntirish (Telegram va dashboard shuni ko'rsatadi). */
export const OPS_FOLDER_HOWTO =
  "Tekshiruv sessiyasi mashinadagi maxsus \"ops\" papkada ochiladi. Papka masofadan YARATILMAYDI: mashinada qo'lda yarating (masalan `mkdir -p ~/working/ops-notes`), " +
  "`agentd policy allow-root ~/working/ops-notes` bilan ruxsat bering va dashboard'da (mashina sahifasi -> Tekshiruv sozlamalari) yoki `PUT /v1/investigations/settings` bilan papka yo'lini kiriting.";

/** Xato kodi -> o'zbekcha tushuntirish (`folder` = sozlangan ops papka, bo'lsa). Kod noma'lum bo'lsa umumiy matn. */
export function investigationErrorHint(code: string | null | undefined, folder?: string | null): string {
  const f = folder ? ` (${folder})` : '';
  switch (code) {
    case 'ops_folder_not_configured':
      return OPS_FOLDER_HOWTO;
    case 'cwd_invalid':
      return `Ops papka mashinada mavjud emas${f}. Mashinada qo'lda yarating: \`mkdir -p <papka>\` (masofadan yaratilmaydi).`;
    case 'cwd_not_allowed':
      return `Ops papka agentd siyosatidagi ruxsat etilgan ildizlar ichida emas${f}. Mashinada: \`agentd policy allow-root <papka>\`.`;
    case 'policy_disabled':
      return "Mashinada masofaviy boshqaruv o'chiq (`agentd policy enable`).";
    case 'action_not_allowed':
      return "Lokal siyosat sessiya ochishga ruxsat bermaydi (allowStart).";
    case 'too_many_sessions':
      return "Mashinada ochilgan sessiyalar soni chegaraga yetdi (maxConcurrentStarted).";
    case 'machine_offline':
      return "Mashina offline: agentd ulanmagan.";
    case 'agent_outdated':
      return "agentd eskirgan: yangilang.";
    case 'step_up_unavailable':
      return "Telegram tasdig'i mavjud emas (bot sozlanmagan yoki xabar yetmadi).";
    case 'step_up_expired':
      return "Tasdiq muddati tugadi.";
    case 'step_up_cancelled':
      return 'Bekor qilindi.';
    case 'lockdown':
      return 'Lockdown yoqilgan: buyruqlar bloklangan.';
    case 'signer_unavailable':
      return "Buyruq imzolovchi javob bermadi; buyruq yuborilmadi.";
    default:
      return "Tekshiruv sessiyasi ochilmadi.";
  }
}
