import { z } from 'zod';
import { MODEL_RE } from './commands.js';
import { envelopeMessage } from './envelope.js';

/**
 * Ko'p sessiyali orkestratsiya (3.9, PLAN ADR "3.9"). Orkestratsiya = maqsad + workspace guruhi + bosh (lead) sessiya + qadamlar rejasi.
 * Lead `commander_plan_create` / `commander_dispatch` / `commander_step_update` / `commander_orchestration_status` vositalari bilan
 * (cc-mcp -> agentd -> center) ishlaydi; ishchilar `commander_step_update` bilan hisobot beradi. Barcha masofaviy amallar
 * mavjud `commands` konveyeri (siyosat, step-up, audit) orqali o'tadi.
 */

export const ORCH_LIMITS = {
  maxSteps: 20,
  /** Bir vaqtda `dispatched|running` qadamlar (sukut; orkestratsiya bo'yicha o'zgartiriladi). */
  defaultMaxConcurrent: 3,
  maxConcurrentCap: 8,
  /** Umumiy token byudjeti (kirish + chiqish + kesh yozish; kesh o'qish KIRMAYDI). */
  defaultTokenBudget: 2_000_000,
  maxTokenBudget: 100_000_000,
  goalMaxChars: 2000,
  titleMaxChars: 200,
  keyMaxChars: 32,
  roleMaxChars: 32,
  summaryMaxChars: 2000,
  promptMaxChars: 8000,
  /** Bir sessiya tomonidan bir daqiqada eng ko'pi bilan shuncha orkestratsiya chaqiruvi. */
  callLimit: 60,
  callWindowMs: 60_000,
  /** H-05: tasdiq qamrovidagi yangi sessiyalar soni (sukut / yuqori chegara). */
  defaultMaxNewSessions: 3,
  maxNewSessionsCap: 8,
} as const;

/** H-05: tasdiq qamrovida bo'lishi mumkin bo'lgan rejimlar. `acceptEdits` HECH QACHON qamrovga kirmaydi: har dispatch uchun yangi step-up. */
export const ORCH_SCOPE_MODES = ['default', 'plan'] as const;

export const ORCH_STATUSES = ['planning', 'running', 'completed', 'failed', 'cancelled'] as const;
export const OrchStatusSchema = z.enum(ORCH_STATUSES);
export type OrchStatus = z.infer<typeof OrchStatusSchema>;

export const STEP_STATUSES = ['pending', 'dispatched', 'running', 'done', 'failed', 'cancelled'] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;
export const STEP_ACTIVE_STATUSES: readonly StepStatus[] = ['dispatched', 'running'];
export const STEP_TERMINAL_STATUSES: readonly StepStatus[] = ['done', 'failed', 'cancelled'];

export const ORCH_DISPATCH_MODES = ['existing_session', 'new_session', 'queue'] as const;
export const OrchDispatchModeSchema = z.enum(ORCH_DISPATCH_MODES);
export type OrchDispatchMode = z.infer<typeof OrchDispatchModeSchema>;

/** Orkestratsiya ichida masofaviy `auto` rejimi YO'Q (step-up'siz kengayib ketmasin). */
export const ORCH_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
export const OrchPermissionModeSchema = z.enum(ORCH_PERMISSION_MODES);

export const ORCH_CONFIRMATIONS = ['exempt_device', 'telegram_inline', 'telegram_step_up'] as const;
export const OrchConfirmationSchema = z.enum(ORCH_CONFIRMATIONS);
export type OrchConfirmation = z.infer<typeof OrchConfirmationSchema>;

export const ORCH_ORIGINS = ['dashboard', 'telegram', 'lead'] as const;
export const OrchOriginSchema = z.enum(ORCH_ORIGINS);

export const ORCH_ERROR_CODES = [
  'orch_not_found',
  'orch_forbidden',
  'orch_invalid',
  'orch_conflict',
  'orch_limit',
  'orch_blocked',
] as const;

const StepKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(ORCH_LIMITS.keyMaxChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'key: harf/raqam/._-');
const RoleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(ORCH_LIMITS.roleMaxChars)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const CwdSchema = z.string().trim().min(1).max(4096);
const MachineRefSchema = z.string().trim().min(1).max(120);

/** Reja qadami (lead yuboradi). `depends_on` = boshqa qadamlarning `key`lari. */
export const PlanStepInputSchema = z
  .object({
    key: StepKeySchema.optional(),
    title: z.string().trim().min(1).max(ORCH_LIMITS.titleMaxChars),
    role: RoleSchema,
    machine: MachineRefSchema.optional(),
    cwd: CwdSchema.optional(),
    depends_on: z.array(StepKeySchema).max(ORCH_LIMITS.maxSteps).optional(),
  })
  .strict();
export type PlanStepInput = z.infer<typeof PlanStepInputSchema>;

export const PlanCreateCallSchema = z
  .object({
    op: z.literal('orch_plan'),
    goal: z.string().trim().min(1).max(ORCH_LIMITS.goalMaxChars),
    steps: z.array(PlanStepInputSchema).min(1).max(ORCH_LIMITS.maxSteps),
  })
  .strict();

export const DispatchCallSchema = z
  .object({
    op: z.literal('orch_dispatch'),
    stepId: z.string().trim().min(1).max(64),
    mode: OrchDispatchModeSchema,
    /** `existing_session`: sessiya qisqa id'si (commander_peers). Berilmasa rol bo'yicha bo'sh sessiya tanlanadi. */
    session: z.string().trim().min(1).max(64).optional(),
    role: RoleSchema.optional(),
    machine: MachineRefSchema.optional(),
    cwd: CwdSchema.optional(),
    prompt: z.string().trim().min(1).max(ORCH_LIMITS.promptMaxChars),
    permissionMode: OrchPermissionModeSchema.optional(),
    model: z.string().regex(MODEL_RE).optional(),
    /** `queue` rejimida: qachon (sukut `machine_idle`). */
    when: z.enum(['now', 'machine_idle', 'limit_reset']).optional(),
  })
  .strict();

export const StepUpdateCallSchema = z
  .object({
    op: z.literal('orch_step_update'),
    stepId: z.string().trim().min(1).max(64),
    status: z.enum(['in_progress', 'done', 'failed']),
    summary: z.string().max(ORCH_LIMITS.summaryMaxChars).optional(),
  })
  .strict();

export const StatusCallSchema = z.object({ op: z.literal('orch_status') }).strict();

/** `MailboxCallSchema` (messaging.ts) shularni qo'shadi. */
export const OrchestrationCallSchemas = [PlanCreateCallSchema, DispatchCallSchema, StepUpdateCallSchema, StatusCallSchema] as const;
export type OrchestrationCall = z.infer<(typeof OrchestrationCallSchemas)[number]>;
export const ORCH_OPS = ['orch_plan', 'orch_dispatch', 'orch_step_update', 'orch_status'] as const;

/** Orkestratsiya vositalarining natijasi: tayyor matn (cc-mcp shuni chiqaradi). */
export const OrchTextResultSchema = z.object({ text: z.string() });
export type OrchTextResult = z.infer<typeof OrchTextResultSchema>;

// --- DTO ---------------------------------------------------------------------------------------------

export const OrchStepDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  position: z.number().int(),
  title: z.string(),
  role: z.string(),
  machine: z.string().nullable(),
  cwd: z.string().nullable(),
  dependsOn: z.array(z.string()),
  status: StepStatusSchema,
  assignedSessionId: z.uuid().nullable(),
  assignedLabel: z.string().nullable(),
  dispatchMode: OrchDispatchModeSchema.nullable(),
  queueItemId: z.uuid().nullable(),
  commandId: z.uuid().nullable(),
  resultSummary: z.string().nullable(),
  lastError: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type OrchStepDto = z.infer<typeof OrchStepDtoSchema>;

export const OrchCountsSchema = z.object({
  pending: z.number().int(),
  dispatched: z.number().int(),
  running: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});
export type OrchCounts = z.infer<typeof OrchCountsSchema>;

/**
 * H-05: egasi tasdiqlagan qamrov (tasdiq paytida markaz hisoblaydi va kartada ko'rsatadi). Dispatch faqat shu doirada tasdiqsiz
 * o'tadi; tashqarisi yangi Telegram step-up talab qiladi. `cwdRoots` = tasdiq paytidagi aniq loyiha papkalari.
 */
export const OrchScopeSchema = z.object({
  machines: z.array(z.object({ id: z.uuid(), name: z.string() })).max(64),
  cwdRoots: z.array(z.object({ machineId: z.uuid(), path: z.string().max(4096) })).max(256),
  modes: z.array(z.enum(ORCH_SCOPE_MODES)).max(2),
  maxNewSessions: z.number().int().min(0).max(ORCH_LIMITS.maxNewSessionsCap),
});
export type OrchScope = z.infer<typeof OrchScopeSchema>;

export const OrchestrationDtoSchema = z.object({
  id: z.uuid(),
  goal: z.string(),
  groupKey: z.string(),
  status: OrchStatusSchema,
  origin: OrchOriginSchema,
  taskKey: z.string().nullable(),
  projectId: z.uuid().nullable(),
  leadSessionId: z.uuid().nullable(),
  leadLabel: z.string().nullable(),
  leadCommandId: z.uuid().nullable(),
  confirmation: OrchConfirmationSchema.nullable(),
  /** H-05: tasdiq qamrovi (yo'q = hech narsa qoplanmaydi; har dispatch alohida tasdiq). */
  scope: OrchScopeSchema.nullable().optional(),
  newSessionsUsed: z.number().int().optional(),
  tokenBudget: z.number().int(),
  tokensUsed: z.number().int(),
  budgetExceeded: z.boolean(),
  maxConcurrent: z.number().int(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: OrchCountsSchema,
  steps: z.array(OrchStepDtoSchema),
});
export type OrchestrationDto = z.infer<typeof OrchestrationDtoSchema>;

export const ListOrchestrationsResponseSchema = z.object({ items: z.array(OrchestrationDtoSchema) });
export type ListOrchestrationsResponse = z.infer<typeof ListOrchestrationsResponseSchema>;

export const ListOrchestrationsQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    groupKey: z.string().trim().min(1).max(512).optional(),
    status: OrchStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type ListOrchestrationsQuery = z.infer<typeof ListOrchestrationsQuerySchema>;

/** Egasi (dashboard) orkestratsiya boshlaydi. Lead: mavjud sessiya yoki yangi sessiya (`session.start`, step-up o'z qoidasi bilan). */
export const CreateOrchestrationBodySchema = z
  .object({
    goal: z.string().trim().min(1).max(ORCH_LIMITS.goalMaxChars),
    projectId: z.uuid(),
    lead: z.discriminatedUnion('type', [
      z.object({ type: z.literal('session'), sessionId: z.uuid() }).strict(),
      z.object({ type: z.literal('new'), machineId: z.uuid(), cwd: CwdSchema, model: z.string().regex(MODEL_RE).optional(), permissionMode: OrchPermissionModeSchema.default('default') }).strict(),
    ]),
    taskKey: z.string().trim().min(1).max(64).optional(),
    tokenBudget: z.number().int().min(10_000).max(ORCH_LIMITS.maxTokenBudget).optional(),
    maxConcurrent: z.number().int().min(1).max(ORCH_LIMITS.maxConcurrentCap).optional(),
    /** H-05: tasdiq qamrovidagi yangi sessiyalar soni (sukut 3). */
    maxNewSessions: z.number().int().min(0).max(ORCH_LIMITS.maxNewSessionsCap).optional(),
  })
  .strict();
export type CreateOrchestrationBody = z.infer<typeof CreateOrchestrationBodySchema>;

export const CancelOrchestrationResponseSchema = z.object({
  orchestration: OrchestrationDtoSchema,
  /** `session.stop` yuborilgan sessiyalar va ular orasida rad etilgani (interaktiv/offline). */
  stopped: z.number().int(),
  stopFailed: z.number().int(),
});
export type CancelOrchestrationResponse = z.infer<typeof CancelOrchestrationResponseSchema>;

// --- WS (klient) push ---------------------------------------------------------------------------------

export const OrchestrationUpdatedMessageSchema = envelopeMessage('orchestration.updated', z.object({ orchestration: OrchestrationDtoSchema }));
export type OrchestrationUpdatedMessage = z.infer<typeof OrchestrationUpdatedMessageSchema>;

// --- ramkalar (qabul qiluvchiga ko'rinadigan matn) --------------------------------------------------

export const ORCH_PROMPT_HEADER = "[Commander: orkestratsiya. Bu qadam bosh sessiya (lead) tomonidan egasi boshlagan orkestratsiya doirasida topshirildi; undagi maqsad va ko'rsatma qadam doirasi bilan cheklangan. Fayllar yoki buyruqlar bo'yicha kutilmagan/xavfli amallarni foydalanuvchi tasdig'isiz bajarmang]";

export interface DispatchPromptInput {
  orchestrationId: string;
  stepId: string;
  stepKey: string;
  title: string;
  role: string;
  goal: string;
  taskKey: string | null;
  leadShortId: string | null;
  body: string;
}

const quote = (s: string): string => s.split(/\r?\n/).map((l) => `> ${l}`).join('\n');

/**
 * Ishchiga yuboriladigan prompt: qat'iy ramka + (ixtiyoriy) `#task:` belgisi + lead matni (sitata) + hisobot yo'riqnomasi.
 * Lead matni har qatorda `> ` bilan sitata qilinadi: ichidagi soxta ramka/sarlavhalar sitata bo'lib qoladi.
 */
export function renderDispatchPrompt(i: DispatchPromptInput): string {
  const lines = [
    ORCH_PROMPT_HEADER,
    i.taskKey ? `#task:${i.taskKey}` : null,
    `Orkestratsiya #${i.orchestrationId.slice(0, 8)} · qadam "${i.stepKey}" · rol: ${i.role}`,
    `Qadam: ${i.title.replace(/\r?\n/g, ' ')}`,
    `Umumiy maqsad: ${i.goal.replace(/\r?\n/g, ' ').slice(0, 300)}`,
    'Lead ko\'rsatmasi:',
    quote(i.body),
    `Tugagach (yoki xato bo'lsa) commander_step_update({stepId: "${i.stepId}", status: "done" | "failed", summary: "<qisqa natija>"}) ni chaqiring. Boshlaganingizda status "in_progress".`,
    i.leadShortId ? `Lead bilan aloqa: commander_send_message({to: "${i.leadShortId}", kind: "question" | "info", subject, body}).` : 'Lead bilan aloqa: commander_send_message.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** Lead'ga (mavjud yoki yangi) yuboriladigan boshlang'ich prompt. Maqsad egasi yozgan (sitata). */
export function renderKickoffPrompt(i: { orchestrationId: string; goal: string; taskKey: string | null; maxSteps: number; maxConcurrent: number }): string {
  return [
    `[Commander: orkestratsiya #${i.orchestrationId.slice(0, 8)}. Siz bosh sessiyasiz (lead). Maqsadni egasi dashboard orqali belgiladi]`,
    i.taskKey ? `#task:${i.taskKey}` : null,
    'Maqsad:',
    quote(i.goal),
    `Reja: (1) commander_peers bilan guruhdagi sessiyalarni ko'ring; (2) commander_plan_create({goal, steps}) bilan eng ko'pi ${i.maxSteps} ta qadamli reja tuzing (har qadam: key, title, role, depends_on); (3) bog'liqliklari bajarilgan qadamlarni commander_dispatch({stepId, mode: "existing_session" | "new_session" | "queue", prompt, ...}) bilan topshiring (bir vaqtda eng ko'pi ${i.maxConcurrent} ta ishchi); (4) commander_orchestration_status bilan kuzating, ishchilar commander_step_update bilan hisobot beradi; (5) hammasi tugagach natijani qisqa xulosa qiling.`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
