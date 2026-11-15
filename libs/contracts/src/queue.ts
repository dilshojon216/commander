import { z } from 'zod';
import { COMMAND_LIMITS, MODEL_RE, RemotePermissionModeSchema, SESSION_NAME_RE } from './commands.js';
import { envelopeMessage } from './envelope.js';

/**
 * Vazifalar navbati (3.1, PLAN ADR "3.1"). Navbat elementi = kechiktirilgan `session.start`.
 *  - prompt DB'da faqat shifrlangan (AES-256-GCM, markaz kaliti); API'larda faqat redakt qilingan ko'rinish;
 *  - yaratish paytida `session.start` bilan BIR XIL step-up qoidasi (Mac dashboard istisnosi yoki Telegram chat ichidagi tasdiq);
 *  - ishga tushganda CommandsService orqali (lockdown, lokal policy, imzo, audit) `queue.fired` auditi bilan.
 */

export const QUEUE_TIMEZONE = 'Asia/Tashkent' as const;
export const QUEUE_WINDOWS = ['5h', '7d'] as const;
export const QueueWindowSchema = z.enum(QUEUE_WINDOWS);
export type QueueWindow = z.infer<typeof QueueWindowSchema>;

export const QUEUE_STATUSES = ['queued', 'waiting_trigger', 'starting', 'started', 'failed', 'cancelled'] as const;
export const QueueStatusSchema = z.enum(QUEUE_STATUSES);
export type QueueStatus = z.infer<typeof QueueStatusSchema>;
export const QUEUE_TERMINAL_STATUSES: readonly QueueStatus[] = ['started', 'failed', 'cancelled'];

export const QUEUE_LIMITS = {
  /** Takroriy (cron) oraliqning eng kichik qiymati. */
  minCronIntervalMinutes: 60,
  maxItems: 100,
  maxActiveCron: 20,
  maxAttempts: 6,
  /** `at` trigger: eng ko'pi bilan shuncha kun oldinga. */
  maxAtDays: 60,
} as const;

export const QueueTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('now') }).strict(),
  z.object({ type: z.literal('limit_reset'), window: QueueWindowSchema }).strict(),
  z.object({ type: z.literal('at'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ type: z.literal('cron'), cron: z.string().min(9).max(100), timezone: z.literal(QUEUE_TIMEZONE).default(QUEUE_TIMEZONE) }).strict(),
  z.object({ type: z.literal('machine_idle') }).strict(),
]);
export type QueueTrigger = z.infer<typeof QueueTriggerSchema>;

const PromptSchema = z.string().min(1).max(COMMAND_LIMITS.promptMaxChars);

export const CreateQueueItemBodySchema = z
  .object({
    machineId: z.uuid(),
    projectId: z.uuid().optional(),
    cwd: z.string().min(1).max(COMMAND_LIMITS.cwdMaxChars),
    prompt: PromptSchema,
    model: z.string().regex(MODEL_RE).optional(),
    permissionMode: RemotePermissionModeSchema,
    name: z.string().regex(SESSION_NAME_RE).optional(),
    taskKey: z.string().min(1).max(64).optional(),
    trigger: QueueTriggerSchema,
  })
  .strict();
export type CreateQueueItemBody = z.infer<typeof CreateQueueItemBodySchema>;

/** machine/cwd/permissionMode o'zgarmaydi (o'chirib qayta yarating). `prompt` o'zgarsa qayta step-up. */
export const UpdateQueueItemBodySchema = z
  .object({
    prompt: PromptSchema.optional(),
    model: z.string().regex(MODEL_RE).nullable().optional(),
    name: z.string().regex(SESSION_NAME_RE).nullable().optional(),
    trigger: QueueTriggerSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty update' });
export type UpdateQueueItemBody = z.infer<typeof UpdateQueueItemBodySchema>;

export const ListQueueQuerySchema = z.object({
  status: QueueStatusSchema.optional(),
  machine: z.uuid().optional(),
  project: z.uuid().optional(),
  triggerType: z.enum(['now', 'limit_reset', 'at', 'cron', 'machine_idle']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListQueueQuery = z.infer<typeof ListQueueQuerySchema>;

export const QUEUE_CONFIRMATIONS = ['exempt_device', 'telegram_inline'] as const;

export const QueueRunDtoSchema = z.object({
  id: z.uuid(),
  firedAt: z.string(),
  status: z.enum(['starting', 'started', 'failed', 'skipped']),
  commandId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  errorCode: z.string().nullable(),
});
export type QueueRunDto = z.infer<typeof QueueRunDtoSchema>;

export const QueueItemDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  machineId: z.uuid(),
  machineSlug: z.string(),
  cwd: z.string(),
  /** Redakt qilingan, <= 300 belgi. Haqiqiy matn HECH QACHON API'da yo'q. */
  promptPreview: z.string(),
  promptLength: z.number().int(),
  model: z.string().nullable(),
  permissionMode: RemotePermissionModeSchema,
  name: z.string().nullable(),
  taskKey: z.string().nullable(),
  trigger: QueueTriggerSchema,
  status: QueueStatusSchema,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdByDeviceId: z.uuid(),
  confirmation: z.enum(QUEUE_CONFIRMATIONS),
  confirmedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastSessionId: z.uuid().nullable(),
  lastCommandId: z.uuid().nullable(),
  runCount: z.number().int(),
  lastRunAt: z.string().nullable(),
});
export type QueueItemDto = z.infer<typeof QueueItemDtoSchema>;

export const ListQueueResponseSchema = z.object({ items: z.array(QueueItemDtoSchema) });
export type ListQueueResponse = z.infer<typeof ListQueueResponseSchema>;
export const QueueDetailResponseSchema = z.object({ item: QueueItemDtoSchema, runs: z.array(QueueRunDtoSchema) });
export type QueueDetailResponse = z.infer<typeof QueueDetailResponseSchema>;

export const QueueUpdatedMessageSchema = envelopeMessage('queue.updated', z.object({ item: QueueItemDtoSchema }));

/** Cron presetlari (dashboard va Telegram umumiy matn). */
export const CRON_PRESETS = [
  { cron: '0 2 * * *', label: 'Har kecha 02:00' },
  { cron: '0 9 * * 1', label: 'Har dushanba 09:00' },
] as const;

// --- limit bashorati -------------------------------------------------------------------------

export const LimitForecastSchema = z.object({
  /** Oyna 100% ga yetadigan taxminiy vaqt (ISO). Har doim taxmin: "≈". */
  exhaustsAt: z.string(),
  /** `exhaustsAt <= resetsAt`: oyna yangilanishidan OLDIN tugaydi. */
  beforeReset: z.boolean(),
  resetsAt: z.string().nullable(),
  /** Hozirgi sarf tezligi (foiz/soat). */
  ratePctPerHour: z.number(),
  /** Tezlik hisoblangan oraliq (daqiqa) va undagi vaznli tokenlar. */
  basisMinutes: z.number().int(),
  basisWeightedTokens: z.number(),
  confidence: z.enum(['low', 'medium', 'high']),
  /** Asos qiymat manbasi (`LimitWindowView.source`): bashorat o'zi doim taxmin. */
  source: z.enum(['official', 'estimate']),
});
export type LimitForecast = z.infer<typeof LimitForecastSchema>;
