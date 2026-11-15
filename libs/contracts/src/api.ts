import { z } from 'zod';
import { AgentControlStateSchema, ControlReasonSchema, SessionControlsSchema, SessionResumeSchema } from './commands.js';
import { SessionStatusSchema } from './session-status.js';
import { LimitForecastSchema } from './queue.js';
import { RemoteControlStateSchema } from './remote-control.js';
import { WeeklyPaceSchema } from './limits-pace.js';

/**
 * Klient o'qish API'si (task 1.5/1.6): `GET /v1/machines|sessions|projects|usage|limits` (+ `approvals`
 * `approvals.ts` da). Auth: `Authorization: Bearer cmdr_...`, scope `read`.
 *
 * Konventsiyalar (YANGI sirt):
 *  - JSON kalitlar camelCase (eski v0 `/sessions` va identity REST snake_case bo'lib qoladi);
 *  - vaqtlar ISO-8601 (UTC, `Z`) satr; `/ws/client` push'lari ham AYNAN shu DTO'lardan foydalanadi;
 *  - token sonlari JSON number (bigint emas): bir loyiha uchun 2^53 dan ancha past;
 *  - `costUsd` har doim "API ekvivalenti" (obunada haqiqiy to'lov emas), null bo'lishi mumkin;
 *  - xato: `{ error, message, issues? }` (400 `invalid_request`, 401 `unauthorized`, 403 `insufficient_scope`, 404 `not_found`).
 */

export const TASHKENT_TZ = 'Asia/Tashkent';

const IsoDate = z.string();
const UuidOrSlug = z.string().min(1).max(128);

/** Query'dagi mantiqiy qiymat: '1'|'true' = ha, '0'|'false' = yo'q (Zod transformsiz: JSON Schema codegen uchun). */
export const QueryFlagSchema = z.enum(['1', 'true', '0', 'false']);
export const isQueryFlagTrue = (v: z.infer<typeof QueryFlagSchema> | undefined): boolean => v === '1' || v === 'true';

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// --- machines --------------------------------------------------------------------------------

export const MachineSessionCountsSchema = z.object({
  /** Tugamagan va `STALE_MINUTES` (default 12 soat) ichida ko'rilgan sessiyalar (v0 `active` bilan bir xil ta'rif). */
  open: z.number().int(),
  working: z.number().int(),
  waiting: z.number().int(),
  awaitingApproval: z.number().int(),
  idle: z.number().int(),
  done: z.number().int(),
});
export type MachineSessionCounts = z.infer<typeof MachineSessionCountsSchema>;

export const MachineDtoSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string().nullable(),
  hostname: z.string().nullable(),
  os: z.string().nullable(),
  online: z.boolean(),
  lastSeenAt: IsoDate.nullable(),
  connectedAt: IsoDate.nullable(),
  disconnectedAt: IsoDate.nullable(),
  agentdVersion: z.string().nullable(),
  claudeVersion: z.string().nullable(),
  /** `verified` (enroll qilingan agentd) | `legacy_unverified` (faqat v0 hook ko'ringan). */
  identityStatus: z.string(),
  sessions: MachineSessionCountsSchema,
  /** agentd lokal siyosati (so'nggi heartbeat); `null` = agentd hali e'lon qilmagan (eski versiya yoki hech ulanmagan). */
  control: AgentControlStateSchema.nullable(),
  /** N2.14: arxivlangan vaqt (ISO) yoki `null` (faol). Arxiv = standart ro'yxatdan yashirish; ma'lumot o'chmaydi. */
  archivedAt: IsoDate.nullable().default(null),
});
export type MachineDto = z.infer<typeof MachineDtoSchema>;

/** `GET /v1/machines`: yo'q/`0` = faqat faollar (default); `1` = faqat arxivlanganlar (projects 6.16 bilan bir xil). */
export const ListMachinesQuerySchema = z.object({ archived: QueryFlagSchema.optional() }).strict();
export type ListMachinesQuery = z.infer<typeof ListMachinesQuerySchema>;

/** N2.13: `PATCH /v1/machines/:id`. `displayName: null` = ko'rsatiladigan nomni tozalash (slug'ga qaytadi). */
export const MachineDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters not allowed');
export const UpdateMachineBodySchema = z.object({ displayName: MachineDisplayNameSchema.nullable() }).strict();
export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>;

/** N2.14: `POST /v1/machines/:id/archive|unarchive` javobi. `archivedAt` = arxivdan keyin vaqt, qaytarilgandan keyin `null`. */
export const MachineArchiveResponseSchema = z.object({ id: z.uuid(), archivedAt: z.string().nullable() });
export type MachineArchiveResponse = z.infer<typeof MachineArchiveResponseSchema>;

export const ListMachinesResponseSchema = z.object({
  items: z.array(MachineDtoSchema),
  /** Hozir online mashinalar soni (`items` ichida `online=true`). */
  onlineCount: z.number().int(),
});
export type ListMachinesResponse = z.infer<typeof ListMachinesResponseSchema>;

// --- sessions --------------------------------------------------------------------------------

export const SessionDtoSchema = z.object({
  /** Ichki uuid (REST yo'llarda ishlatiladi). */
  id: z.uuid(),
  claudeSessionId: z.string(),
  machineId: z.uuid(),
  machineSlug: z.string(),
  /** `displayName ?? hostname ?? slug`. */
  machineName: z.string(),
  projectId: z.uuid().nullable(),
  /** `projects.name` (bo'lmasa cwd'ning oxirgi segmenti). */
  projectName: z.string(),
  cwd: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  status: SessionStatusSchema,
  message: z.string().nullable(),
  notificationType: z.string().nullable(),
  model: z.string().nullable(),
  /** Hook'dagi oxirgi `permission_mode` (`default`, `acceptEdits`, `plan`, `bypassPermissions`, ...); noma'lum = null. */
  permissionMode: z.string().nullable(),
  startedAt: IsoDate,
  statusSince: IsoDate,
  lastSeenAt: IsoDate,
  endedAt: IsoDate.nullable(),
  endReason: z.string().nullable(),
  /** Mashina offline bo'lgandan beri (null = stale emas). `status` o'zgarmaydi. */
  staleSince: IsoDate.nullable(),
  /** Hozir qaror kutayotgan approval'lar soni. */
  pendingApprovals: z.number().int(),
  /**
   * Prompt yuborish mumkinmi (UI prompt-box holati). `false` bo'lsa `controlReason` sababni beradi
   * (`interactive` = "faqat ko'rish"); `true` bo'lsa `null`. Siyosat markazdan o'zgartirilmaydi: bu agentd e'lon qilgan holat,
   * oxirgi so'z baribir agentdniki (buyruq `rejected` bo'lishi mumkin).
   */
  controllable: z.boolean(),
  controlReason: ControlReasonSchema.nullable(),
  /** Alohida tugmalar: `setMode` boshqariladigan (bg) sessiyalarda ham hozir `false` (qarang PLAN ADR 2.3-2.7). */
  controls: SessionControlsSchema,
  /** 6.14: tugagan terminal sessiyani tmux'da davom ettirish mumkinmi (eski klientlar uchun ixtiyoriy). */
  resume: SessionResumeSchema.optional(),
  /** Remote Control holati (3.10): oxirgi muvaffaqiyatli `session.remote_control` / RC bilan ochish natijasi; yo'q = noma'lum. */
  remoteControl: RemoteControlStateSchema.nullish(),
  /** Joriy (yoki oxirgi) vazifa id'si (task 2.9); atributsiya yo'q = null. Eski klientlar uchun ixtiyoriy. */
  taskKey: z.string().nullish(),
  /** `explicit` = `/task`/`#task:`; `branch` = git branch nomidan TAXMIN. */
  taskSource: z.enum(['explicit', 'branch']).nullish(),
});
export type SessionDto = z.infer<typeof SessionDtoSchema>;

export const ListSessionsQuerySchema = z
  .object({
    /** Mashina uuid yoki slug. */
    machine: UuidOrSlug.optional(),
    /** Loyiha uuid yoki aniq nomi (registrsiz). */
    project: UuidOrSlug.optional(),
    status: SessionStatusSchema.optional(),
    /** `1`: tugamagan va (STALE_MINUTES, default 12 soat) ichida ko'ringan sessiyalar. */
    active: QueryFlagSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    /** Oldingi javobdagi `nextCursor` (ko'rinmas satr). */
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export const ListSessionsResponseV1Schema = z.object({
  items: z.array(SessionDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ListSessionsResponseV1 = z.infer<typeof ListSessionsResponseV1Schema>;

export const SessionEventDtoSchema = z.object({
  id: z.string(),
  ts: IsoDate,
  event: z.string(),
  status: z.string(),
  message: z.string().nullable(),
  notificationType: z.string().nullable(),
});
export type SessionEventDto = z.infer<typeof SessionEventDtoSchema>;

export const ListSessionEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ListSessionEventsQuery = z.infer<typeof ListSessionEventsQuerySchema>;

export const ListSessionEventsResponseV1Schema = z.object({
  /** Eng yangisi birinchi. */
  items: z.array(SessionEventDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ListSessionEventsResponseV1 = z.infer<typeof ListSessionEventsResponseV1Schema>;

// --- tokens / usage --------------------------------------------------------------------------

export const TokenTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  /** input + output + cacheRead + cacheCreation. */
  totalTokens: z.number(),
  /** API ekvivalenti (haqiqiy to'lov emas). */
  costUsd: z.number().nullable(),
  requests: z.number(),
});
export type TokenTotals = z.infer<typeof TokenTotalsSchema>;

export const ProjectDtoSchema = z.object({
  id: z.uuid(),
  machineId: z.uuid(),
  machineSlug: z.string(),
  name: z.string(),
  path: z.string(),
  repoKey: z.string().nullable(),
  kind: z.enum(['git', 'dir']),
  /** Bugun (Asia/Tashkent kuni): kunlik cagg'dan (real-time). */
  today: TokenTotalsSchema,
  /** Umrbod: `project_token_totals` view'idan. */
  allTime: TokenTotalsSchema,
  firstUsedAt: IsoDate.nullable(),
  lastUsedAt: IsoDate.nullable(),
  openSessions: z.number().int(),
  /** 6.16: arxivlangan vaqt (ISO) yoki `null` (faol). Arxiv = ro'yxatlardan yashirish; ma'lumot o'chmaydi. */
  archivedAt: IsoDate.nullable().default(null),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

export const ListProjectsQuerySchema = z
  .object({
    machine: UuidOrSlug.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    /** 6.16: yo'q/`0` = faqat faollar; `1` = faqat arxivlanganlar. */
    archived: QueryFlagSchema.optional(),
  })
  .strict();
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

/** 6.16: arxivlangan loyihalar yig'indisi (tokenlar haqiqiy: jami hisobga kiradi, ro'yxatda ko'rinmaydi). */
export const ArchivedProjectsSummarySchema = z.object({
  count: z.number().int(),
  today: TokenTotalsSchema,
  allTime: TokenTotalsSchema,
  /** Mashina bo'yicha bugungi tokenlar (mashina jami qiymatini to'g'ri ko'rsatish uchun). */
  todayByMachine: z.array(z.object({ machineId: z.uuid(), totalTokens: z.number() })),
});
export type ArchivedProjectsSummary = z.infer<typeof ArchivedProjectsSummarySchema>;

const ZERO_TOTALS = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };

export const ListProjectsResponseSchema = z.object({
  /** Bugungi tokenlar kamayish tartibida, keyin umrbod bo'yicha. */
  items: z.array(ProjectDtoSchema),
  /** `project_id IS NULL` (cwd noma'lum) tokenlari. */
  unattributed: z.object({ today: TokenTotalsSchema, allTime: TokenTotalsSchema }),
  /** 6.16: arxivlanganlar (eski center'da yo'q = 0). */
  archived: ArchivedProjectsSummarySchema.default(() => ({ count: 0, today: { ...ZERO_TOTALS }, allTime: { ...ZERO_TOTALS }, todayByMachine: [] })),
  /** "Bugun" chegarasi (Asia/Tashkent yarim kechasi), ISO. */
  todayStart: IsoDate,
  timezone: z.literal(TASHKENT_TZ),
});
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

export const USAGE_BUCKETS = ['5m', '1h', '1d'] as const;
export const UsageBucketSchema = z.enum(USAGE_BUCKETS);
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

export const USAGE_GROUP_BY = ['none', 'project', 'machine', 'model'] as const;
export const UsageGroupBySchema = z.enum(USAGE_GROUP_BY);
export type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

/** Bucket boshiga ruxsat etilgan eng uzun oraliq (ms) va default oraliq. */
export const USAGE_RANGE_LIMITS_MS: Record<UsageBucket, { max: number; default: number }> = {
  '5m': { max: 3 * 24 * 3_600_000, default: 6 * 3_600_000 },
  '1h': { max: 31 * 24 * 3_600_000, default: 24 * 3_600_000 },
  '1d': { max: 366 * 24 * 3_600_000, default: 30 * 24 * 3_600_000 },
};

export const UsageQuerySchema = z
  .object({
    bucket: UsageBucketSchema.default('1h'),
    /** Boshlanish (ISO-8601, offset bilan ham bo'ladi). Default: `to - default oraliq`. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Tugash (ISO-8601). Default: hozir. */
    to: z.iso.datetime({ offset: true }).optional(),
    groupBy: UsageGroupBySchema.default('none'),
    /** Filtr: mashina uuid yoki slug. */
    machine: UuidOrSlug.optional(),
    /** Filtr: loyiha uuid. */
    project: z.uuid().optional(),
  })
  .strict();
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const UsagePointSchema = z.object({
  /** Bucket boshi (ISO). 1d: Asia/Tashkent yarim kechasi. */
  t: IsoDate,
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  costUsd: z.number().nullable(),
  requests: z.number(),
});
export type UsagePoint = z.infer<typeof UsagePointSchema>;

export const UsageSeriesSchema = z.object({
  /** `groupBy=none`: null. Aks holda: project uuid | machine uuid | model nomi (loyiha uchun noma'lum = 'unknown'). */
  key: z.string().nullable(),
  label: z.string(),
  /** Faqat ma'lumot bor bucket'lar (siyrak): bo'shliqlarni klient 0 bilan to'ldiradi. */
  points: z.array(UsagePointSchema),
  total: TokenTotalsSchema,
});
export type UsageSeries = z.infer<typeof UsageSeriesSchema>;

export const UsageResponseSchema = z.object({
  bucket: UsageBucketSchema,
  from: IsoDate,
  to: IsoDate,
  groupBy: UsageGroupBySchema,
  timezone: z.literal(TASHKENT_TZ),
  /** Qaysi manba ishlatilgani (nosozlikni topish uchun): continuous aggregate yoki raw `token_usage` (30 kun). */
  source: z.enum(['usage_5m', 'usage_1h', 'daily_by_project', 'raw']),
  series: z.array(UsageSeriesSchema),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

export const UsageSummaryPeriodSchema = z.object({
  /** Davr boshi (Asia/Tashkent yarim kechasi), allTime uchun null. */
  from: IsoDate.nullable(),
  totals: TokenTotalsSchema,
});
export type UsageSummaryPeriod = z.infer<typeof UsageSummaryPeriodSchema>;

export const UsageSummaryResponseSchema = z.object({
  /** Bugun (Asia/Tashkent). */
  today: UsageSummaryPeriodSchema,
  /** Oxirgi 7 kun (bugun bilan, Tashkent kunlari). */
  last7d: UsageSummaryPeriodSchema,
  last30d: UsageSummaryPeriodSchema,
  allTime: UsageSummaryPeriodSchema,
  timezone: z.literal(TASHKENT_TZ),
  costKind: z.literal('api_equivalent'),
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;

// --- limits ----------------------------------------------------------------------------------

export const LIMIT_SOURCES_V1 = ['official', 'estimate'] as const;
export const LimitSourceSchema = z.enum(LIMIT_SOURCES_V1);
export type LimitSourceV1 = z.infer<typeof LimitSourceSchema>;

/** Taxmin kalibrlash holati (PLAN 6.3). `coefficient`: 1 vaznli token uchun foiz. */
export const LimitCalibrationSchema = z.object({
  /** Foiz / vaznli token (null: hali yetarli juft kuzatuv yo'q, taxmin qilib bo'lmaydi). */
  coefficient: z.number().nullable(),
  /** Kalibrlashda ishlatilgan kuzatuv juftlari soni. */
  samples: z.number().int(),
});
export type LimitCalibration = z.infer<typeof LimitCalibrationSchema>;

export const LimitWindowViewSchema = z.object({
  /** 0..1000 (100 dan oshishi mumkin). `source='estimate'` bo'lsa "≈" bilan ko'rsating. */
  usedPct: z.number(),
  /** Oyna yangilanish vaqti (ISO). Reset'dan keyin taxminiy bo'lishi mumkin; null = noma'lum. */
  resetsAt: IsoDate.nullable(),
  /** Oxirgi RASMIY kuzatuv vaqti (taxmin ham shunga tayanadi); rasmiy kuzatuv bo'lmasa null. */
  observedAt: IsoDate.nullable(),
  /** CLAUDE.md #6: taxminni rasmiy raqamdek ko'rsatmang. */
  source: LimitSourceSchema,
  /** Rasmiy kuzatuv `freshSeconds` dan eski. */
  stale: z.boolean(),
  /** Rasmiy kuzatuvdan beri o'tgan soniyalar. */
  ageSeconds: z.number().int().nullable(),
  /** Rasmiy kuzatuvdagi oyna tugagan (`resetsAt <= now`): qiymat YANGI oyna uchun taxmin. */
  reset: z.boolean(),
  /** Rasmiy kuzatuv qaysi mashinadan kelgan (null = ma'lum emas). */
  observedByMachineId: z.uuid().nullable(),
  /** Rasmiy kuzatuvning o'zi (taxmin uchun asos): usedPct va resetsAt. Taxmin bo'lmasa `usedPct` bilan bir xil. */
  anchor: z.object({ usedPct: z.number(), resetsAt: IsoDate.nullable(), observedAt: IsoDate }).nullable(),
  calibration: LimitCalibrationSchema.nullable(),
  /** 3.1: tugash vaqti bashorati (null/yo'q = yetarli ma'lumot yo'q). Additiv. */
  forecast: LimitForecastSchema.nullable().optional(),
});
export type LimitWindowView = z.infer<typeof LimitWindowViewSchema>;

export const LimitsResponseSchema = z.object({
  computedAt: IsoDate,
  /** Rasmiy kuzatuv shu soniyadan eski bo'lsa `stale=true`. */
  freshSeconds: z.number().int(),
  /** null = bu oyna uchun hech qachon kuzatuv bo'lmagan. */
  fiveHour: LimitWindowViewSchema.nullable(),
  sevenDay: LimitWindowViewSchema.nullable(),
  /** 6.12: haftalik limit tezligi (kunlik ulush). Additiv; rasmiy kuzatuv/oyna yo'q bo'lsa null/yo'q. */
  pace: WeeklyPaceSchema.nullable().optional(),
});
export type LimitsResponse = z.infer<typeof LimitsResponseSchema>;
