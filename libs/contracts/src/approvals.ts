import { z } from 'zod';
import { AskAnswersSchema, AskQuestionsSchema } from './ask-question.js';
import { EpochMsSchema, envelopeMessage } from './envelope.js';

/**
 * Remote permission (task 1.7, PLAN 6.4). Ikki tomon:
 *  - agentd <-> center (`/ws/agent`): `approval.request`, `approval.cancel` (agent -> center),
 *    `approval.decision`, `approval.expired` (center -> agent);
 *  - klientlar <-> center (REST): `POST /v1/approvals/:id/decision`, `GET /v1/approvals`.
 *
 * Xavfsizlik qoidalari (CLAUDE.md #4, #5):
 *  - center HECH QACHON avtomatik `allow` qilmaydi; qaror yo'q/offline/timeout = agentd lokal promptga qaytadi;
 *  - `toolInputRedacted` agentd tomonida redact() dan o'tgan va `APPROVAL_LIMITS.toolInputMaxChars` bilan
 *    cheklangan MATN; center qo'shimcha redact() qiladi va qayta kesadi; xom (redakt qilinmagan) kiritma
 *    markazga umuman yuborilmaydi va saqlanmaydi (faqat `toolInputFullHash` sha256);
 *  - lockdown yoqilganda masofaviy `allow` rad etiladi (403), `deny` ruxsat.
 */

export const APPROVAL_LIMITS = {
  /** `toolInputRedacted` uzunligi (belgi). Agentd kesadi; center qayta kesadi (Zod esa chegaradan oshganini rad etadi). */
  toolInputMaxChars: 8192,
  toolNameMaxChars: 128,
  /** Qaror izohi (`deny` sababi sifatida Claude'ga boradi). */
  messageMaxChars: 1000,
  /** Center qabul qiladigan eng uzun deadline (so'rov vaqtidan). Oshsa shu qiymatga tushiriladi. */
  maxDeadlineMs: 15 * 60_000,
  /** Reja matni (ExitPlanMode, 2.14): agentd redakt qilib kesadi, center qayta kesadi. */
  planMaxChars: 16_384,
  /** `target.path` uzunligi. */
  targetPathMaxChars: 1024,
} as const;

/**
 * So'rov turi: `tool` (oddiy permission) yoki `plan` (ExitPlanMode: reja matni bilan, 2.14).
 *
 * TEKSHIRILGAN (Claude Code 2.1.304, haiku, 2026-11-13, tmux va `--bg`): ExitPlanMode PermissionRequest hook'ini
 * chaqiradi (`tool_input` = `{plan, planFilePath}`), lekin hook'ning `allow` javobi (oddiy, `updatedPermissions`
 * bilan ham) va PreToolUse `permissionDecision: allow` E'TIBORGA OLINMAYDI: terminal dialogi ochiq qoladi.
 * `deny` + `message` ISHLAYDI: dialog yopiladi, matn Claude'ga boradi va u rejani qayta ko'rib chiqadi.
 * Shu sabab masofadan reja `allow` qilib bo'lmaydi (faqat fikr bilan rad); `allow` yolg'on "tasdiqlandi" holatini
 * yaratmasligi uchun center `plan` turida `allow` ni 422 `plan_approve_unsupported` bilan rad etadi.
 * Kelajakda tmux/pane boshqaruvi (2.6) orqali tasdiqlash mumkin bo'lsa, shu bayroq `true` qilinadi.
 */
export const APPROVAL_KINDS = ['tool', 'plan', 'question'] as const;
export const ApprovalKindSchema = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;
export const PLAN_TOOL_NAME = 'ExitPlanMode';
export const PLAN_REMOTE_APPROVE_SUPPORTED = false;

/**
 * `question` (6.13): AskUserQuestion. Reja'dan farqli, hook `allow` + `updatedInput.answers` jonli tekshirilgan va ISHLAYDI
 * (qarang `ask-question.ts`). Savollar `questions`da (redakt qilingan, strukturali), qaror `allow` + `answers` (indekslar).
 * Javobsiz `allow` (eski agentd'lar `tool` sifatida yuborgan AskUserQuestion ham) center'da 422 `question_answers_required`.
 */

/**
 * - pending   : qaror kutilmoqda;
 * - approved  : `allow` qarori;
 * - denied    : `deny` qarori;
 * - expired   : deadline o'tdi (agentd'ga `approval.expired` yuborildi; sessiya lokal promptga qaytdi);
 * - cancelled : agentd bekor qildi (so'rov lokal hal bo'ldi: foydalanuvchi terminalda javob berdi).
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const APPROVAL_BEHAVIORS = ['allow', 'deny'] as const;
export const ApprovalBehaviorSchema = z.enum(APPROVAL_BEHAVIORS);
export type ApprovalBehavior = z.infer<typeof ApprovalBehaviorSchema>;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Fayl vositalari uchun agentd hisoblagan KICHIK, sirsiz maslahat (xom kiritma emas): `path` = sessiya cwd'siga nisbatan
 * normallashtirilgan posix yo'l (symlink'lar hal qilingan), `insideCwd` = yo'l cwd ichida. Cwd'dan tashqari yoki
 * noaniq yo'l: `{path: null, insideCwd: false}`. Faqat avto-ruxsat qoidalari (2.13) ishlatadi; yo'q bo'lsa avto-ruxsat YO'Q.
 */
export const ApprovalTargetSchema = z.object({
  path: z.string().min(1).max(APPROVAL_LIMITS.targetPathMaxChars).nullable(),
  insideCwd: z.boolean(),
});
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;

// --- agent -> center -------------------------------------------------------------------------

export const ApprovalRequestPayloadSchema = z.object({
  /** agentd yaratadi (uuid): qayta yuborish idempotent (bir xil id = bir xil so'rov). */
  approvalId: z.uuid(),
  claudeSessionId: z.string().min(1).max(255),
  toolName: z.string().min(1).max(APPROVAL_LIMITS.toolNameMaxChars),
  /** Redakt qilingan va kesilgan tool kiritmasi (odatda JSON matn). Xom kiritma YUBORILMAYDI. */
  toolInputRedacted: z.string().max(APPROVAL_LIMITS.toolInputMaxChars),
  /** Xom (to'liq) kiritmaning sha256 xeshi (kichik harfli hex): yaxlitlik/aynanlik belgisi, sir emas. */
  toolInputFullHash: Sha256HexSchema,
  cwd: z.string().min(1).max(4096),
  /** agentd cc-hook deadline'i (epoch ms). Shundan keyin center `expired` qiladi va `approval.expired` yuboradi. */
  deadline: EpochMsSchema,
  /** Eski agentd'lar yubormaydi: `tool`. `plan` bo'lsa `plan` matni majburiy. */
  kind: ApprovalKindSchema.default('tool'),
  /** Redakt qilingan va kesilgan reja matni (faqat `kind: 'plan'`). */
  plan: z.string().min(1).max(APPROVAL_LIMITS.planMaxChars).optional(),
  /** Fayl vositasi maslahati (2.13); yo'q bo'lsa avto-ruxsat qoidalari mos kelmaydi. */
  target: ApprovalTargetSchema.optional(),
  /** Redakt qilingan, kesilgan savollar (faqat `kind: 'question'`, 6.13). */
  questions: AskQuestionsSchema.optional(),
})
  .refine((p) => (p.kind === 'plan') === (p.plan !== undefined), { message: 'plan text is required for (and only for) kind=plan' })
  .refine((p) => (p.kind === 'question') === (p.questions !== undefined), { message: 'questions are required for (and only for) kind=question' });
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;
export const ApprovalRequestMessageSchema = envelopeMessage('approval.request', ApprovalRequestPayloadSchema);
export type ApprovalRequestMessage = z.infer<typeof ApprovalRequestMessageSchema>;

export const ApprovalCancelPayloadSchema = z.object({
  approvalId: z.uuid(),
  /** Masalan `resolved_locally`, `session_ended`, `hook_exited`. */
  reason: z.string().min(1).max(64).optional(),
});
export type ApprovalCancelPayload = z.infer<typeof ApprovalCancelPayloadSchema>;
export const ApprovalCancelMessageSchema = envelopeMessage('approval.cancel', ApprovalCancelPayloadSchema);
export type ApprovalCancelMessage = z.infer<typeof ApprovalCancelMessageSchema>;

// --- center -> agent -------------------------------------------------------------------------

export const ApprovalDecisionPayloadSchema = z.object({
  approvalId: z.uuid(),
  behavior: ApprovalBehaviorSchema,
  /** `deny` uchun Claude'ga ko'rsatiladigan izoh (ixtiyoriy). */
  message: z.string().max(APPROVAL_LIMITS.messageMaxChars).optional(),
  /** `kind: 'question'` + `allow`: javoblar (indekslar; erkin matn center'da redakt qilingan). cc-hook asl savollarga moslaydi. */
  answers: AskAnswersSchema.optional(),
  decidedAt: EpochMsSchema,
});
export type ApprovalDecisionPayload = z.infer<typeof ApprovalDecisionPayloadSchema>;
export const ApprovalDecisionMessageSchema = envelopeMessage('approval.decision', ApprovalDecisionPayloadSchema);
export type ApprovalDecisionMessage = z.infer<typeof ApprovalDecisionMessageSchema>;

export const ApprovalExpiredPayloadSchema = z.object({
  approvalId: z.uuid(),
  expiredAt: EpochMsSchema,
});
export type ApprovalExpiredPayload = z.infer<typeof ApprovalExpiredPayloadSchema>;
export const ApprovalExpiredMessageSchema = envelopeMessage('approval.expired', ApprovalExpiredPayloadSchema);
export type ApprovalExpiredMessage = z.infer<typeof ApprovalExpiredMessageSchema>;

// --- REST DTO (klientlar) --------------------------------------------------------------------

const IsoDate = z.string();

/** Bitta approval (REST va `/ws/client` `approval.created|resolved`). Xom kiritma hech qachon yo'q. */
export const ApprovalDtoSchema = z.object({
  id: z.uuid(),
  machineId: z.uuid(),
  machineSlug: z.string(),
  sessionId: z.uuid().nullable(),
  claudeSessionId: z.string(),
  projectName: z.string().nullable(),
  cwd: z.string(),
  toolName: z.string(),
  toolInputRedacted: z.string(),
  toolInputFullHash: z.string(),
  status: ApprovalStatusSchema,
  /** `approved` -> allow, `denied` -> deny, aks holda null. */
  behavior: ApprovalBehaviorSchema.nullable(),
  decisionMessage: z.string().nullable(),
  decidedByDeviceId: z.uuid().nullable(),
  decidedAt: IsoDate.nullable(),
  /** Qaror agentd'ga yetkazildimi (ulanish yopiq bo'lsa false; qayta ulanganda qayta yuboriladi). null = hali qaror yo'q. */
  delivered: z.boolean().nullable(),
  requestedAt: IsoDate,
  deadline: IsoDate,
  resolvedAt: IsoDate.nullable(),
  /** `plan`: `plan` matni bor (30 kundan keyin tozalanadi: null). */
  kind: ApprovalKindSchema.default('tool'),
  plan: z.string().nullable().default(null),
  /** Avto-ruxsat qoidasi (2.13) hal qilgan bo'lsa qoida id'si; qaror `system` aktyoridan. */
  autoRuleId: z.number().int().nullable().default(null),
  /** `question` (6.13): savollar (redakt qilingan) va berilgan javoblar (qaror bo'lgach; erkin matn redakt qilingan). */
  questions: AskQuestionsSchema.nullable().default(null),
  answers: AskAnswersSchema.nullable().default(null),
});
export type ApprovalDto = z.infer<typeof ApprovalDtoSchema>;

/** `POST /v1/approvals/:id/decision` tanasi (`approve` scope). */
export const ApprovalDecisionBodySchema = z
  .object({
    behavior: ApprovalBehaviorSchema,
    message: z.string().max(APPROVAL_LIMITS.messageMaxChars).optional(),
    /** `kind: 'question'` uchun `allow` bilan MAJBURIY (har savolga bittadan); boshqa turlarda 422. */
    answers: AskAnswersSchema.optional(),
  })
  .strict();
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>;

/**
 * Javob. 200: qaror qabul qilindi. `idempotent=true`: SHU qurilma xuddi shu qarorni allaqachon bergan
 * (xavfsiz qayta urinish; yangi audit/dispatch yo'q). Boshqa qaror yoki boshqa qurilma: 409 `approval_conflict`;
 * deadline o'tgan: 409 `approval_expired`; allaqachon cancelled/expired: 409.
 */
export const ApprovalDecisionResponseSchema = z.object({
  approval: ApprovalDtoSchema,
  /** Qaror agentd ulanishiga yuborildimi (false: agent offline, qayta ulanganda yetkaziladi). */
  delivered: z.boolean(),
  idempotent: z.boolean(),
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;

export const ListApprovalsQuerySchema = z
  .object({
    /** Mashina uuid yoki slug. */
    machine: z.string().min(1).max(128).optional(),
    /** `recent` ro'yxati hajmi (resolved: approved/denied/expired/cancelled, yangidan eskiga). */
    recentLimit: z.coerce.number().int().min(0).max(100).default(20),
  })
  .strict();
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuerySchema>;

export const ListApprovalsResponseSchema = z.object({
  /** Barcha pending (eng eskisi birinchi: avval qaror kutayotgani). */
  pending: z.array(ApprovalDtoSchema),
  recent: z.array(ApprovalDtoSchema),
});
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponseSchema>;
