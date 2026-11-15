import { z } from 'zod';

/**
 * 6.7 Timesheet va xarajat hisoboti, 6.8 mijoz uchun "faqat ko'rish" hisoboti (PLAN ADR "6.7/6.8").
 *
 *  - Mijoz = nom + izoh + (ixtiyoriy) soatlik stavka; loyiha = `project_key` (repo_key guruhi, mashinalar bo'ylab);
 *  - pul summalari MATN ("12500.50"): float yo'q, hisob markazda BigInt bilan;
 *  - soatlar sekundda (butun son), ko'rsatish klientda.
 */

export const BILLING_CURRENCIES = ['UZS', 'USD'] as const;
export const BillingCurrencySchema = z.enum(BILLING_CURRENCIES);
export type BillingCurrency = z.infer<typeof BillingCurrencySchema>;

export const BILLING_LIMITS = {
  nameMaxChars: 120,
  notesMaxChars: 2000,
  projectKeyMaxChars: 300,
  maxClients: 200,
  maxProjectsPerClient: 100,
  /** Davr chegarasi (kun): katta so'rov DB'ni bo'g'masin. */
  maxPeriodDays: 400,
} as const;

/** Musbat o'nli son matni: `150000`, `12.5`, `0.25` (4 ta kasrgacha; vergul qabul qilinmaydi). */
export const DecimalStringSchema = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/);
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoDate = z.string();

// --- mijozlar -------------------------------------------------------------------------------------

export const ClientDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  notes: z.string(),
  /** Soatlik stavka (`currency` da) yoki `null` (stavka yo'q: summa hisoblanmaydi). */
  hourlyRate: z.string().nullable(),
  currency: BillingCurrencySchema,
  projectKeys: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ClientDto = z.infer<typeof ClientDtoSchema>;

export const ListClientsResponseSchema = z.object({ items: z.array(ClientDtoSchema) });
export type ListClientsResponse = z.infer<typeof ListClientsResponseSchema>;

const NameSchema = z.string().trim().min(1).max(BILLING_LIMITS.nameMaxChars);
const NotesSchema = z.string().trim().max(BILLING_LIMITS.notesMaxChars);

export const CreateClientBodySchema = z
  .object({
    name: NameSchema,
    notes: NotesSchema.optional(),
    hourlyRate: DecimalStringSchema.nullable().optional(),
    currency: BillingCurrencySchema.optional(),
  })
  .strict();
export type CreateClientBody = z.infer<typeof CreateClientBodySchema>;

export const UpdateClientBodySchema = z
  .object({
    name: NameSchema.optional(),
    notes: NotesSchema.optional(),
    hourlyRate: DecimalStringSchema.nullable().optional(),
    currency: BillingCurrencySchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty update' });
export type UpdateClientBody = z.infer<typeof UpdateClientBodySchema>;

export const SetClientProjectsBodySchema = z
  .object({ projectKeys: z.array(z.string().trim().min(1).max(BILLING_LIMITS.projectKeyMaxChars)).max(BILLING_LIMITS.maxProjectsPerClient) })
  .strict();
export type SetClientProjectsBody = z.infer<typeof SetClientProjectsBodySchema>;

/** Mijozga biriktirish uchun loyiha guruhi (`project_key` = repo_key yoki loyiha id). */
export const BillingProjectDtoSchema = z.object({
  projectKey: z.string(),
  name: z.string(),
  repoKey: z.string().nullable(),
  machines: z.number().int(),
  lastActivityAt: IsoDate.nullable(),
  clientId: z.uuid().nullable(),
});
export type BillingProjectDto = z.infer<typeof BillingProjectDtoSchema>;
export const ListBillingProjectsResponseSchema = z.object({ items: z.array(BillingProjectDtoSchema) });
export type ListBillingProjectsResponse = z.infer<typeof ListBillingProjectsResponseSchema>;

// --- timesheet ------------------------------------------------------------------------------------

/** Davr: `from..to` (ikkalasi kiradi, Asia/Tashkent kunlari). `month=YYYY-MM` qisqa yo'l. */
export const TimesheetQuerySchema = z
  .object({
    from: DaySchema.optional(),
    to: DaySchema.optional(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    clientId: z.uuid().optional(),
    /** Ko'rsatiladigan valyuta; mijoz valyutasidan farq qilsa `fxUzsPerUsd` shart. */
    currency: BillingCurrencySchema.optional(),
    /** Qo'lda kurs: 1 USD = N UZS. */
    fxUzsPerUsd: DecimalStringSchema.optional(),
  })
  .strict()
  .refine((q) => (q.month ? !q.from && !q.to : Boolean(q.from) === Boolean(q.to)), { message: 'use month, or from+to' })
  .refine((q) => Boolean(q.month) || Boolean(q.from), { message: 'period is required' });
export type TimesheetQuery = z.infer<typeof TimesheetQuerySchema>;

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export const TimesheetExportQuerySchema = z
  .object({
    from: DaySchema.optional(),
    to: DaySchema.optional(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    clientId: z.uuid().optional(),
    currency: BillingCurrencySchema.optional(),
    fxUzsPerUsd: DecimalStringSchema.optional(),
    format: z.enum(EXPORT_FORMATS),
  })
  .strict()
  .refine((q) => (q.month ? !q.from && !q.to : Boolean(q.from) === Boolean(q.to)), { message: 'use month, or from+to' })
  .refine((q) => Boolean(q.month) || Boolean(q.from), { message: 'period is required' });
export type TimesheetExportQuery = z.infer<typeof TimesheetExportQuerySchema>;

const TokensSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheCreation: z.number() });

export const TimesheetTaskSchema = z.object({
  key: z.string(),
  title: z.string().nullable(),
  status: z.enum(['todo', 'doing', 'done', 'unknown']).nullable(),
  activeSeconds: z.number().int(),
  sessions: z.number().int(),
  /** Faqat xom `token_usage` oynasida (30 kun) hisoblanadi; `taskTokensPartial` ga qarang. */
  tokens: TokensSchema,
  costUsd: z.number().nullable(),
  commits: z.number().int(),
  closedInPeriod: z.boolean(),
  plannedHours: z.number().nullable(),
});
export type TimesheetTask = z.infer<typeof TimesheetTaskSchema>;

export const TimesheetTotalsSchema = z.object({
  /** Birlashma: parallel sessiyalar ikki marta sanalmaydi. */
  activeSeconds: z.number().int(),
  sessions: z.number().int(),
  tasksClosed: z.number().int(),
  commits: z.number().int(),
  /** Kunlik agregatdan: 30 kundan eski davrlar uchun ham to'liq. */
  tokens: TokensSchema,
  costUsd: z.number().nullable(),
  /** Reja vs haqiqiy: faqat o'lchami (size) bor vazifalar. */
  plannedSeconds: z.number().int(),
  plannedActualSeconds: z.number().int(),
});
export type TimesheetTotals = z.infer<typeof TimesheetTotalsSchema>;

export const TimesheetProjectSchema = z.object({
  projectKey: z.string(),
  name: z.string(),
  totals: TimesheetTotalsSchema,
  tasks: z.array(TimesheetTaskSchema),
  /** Vazifasiz (span'ga tushmagan) faol vaqt. */
  unattributedSeconds: z.number().int(),
});
export type TimesheetProject = z.infer<typeof TimesheetProjectSchema>;

export const TimesheetClientSchema = z.object({
  /** `null` = mijozga biriktirilmagan loyihalar. */
  clientId: z.uuid().nullable(),
  name: z.string(),
  hourlyRate: z.string().nullable(),
  rateCurrency: BillingCurrencySchema.nullable(),
  /** Hisoblangan summa (ko'rsatiladigan valyutada, matn) yoki `null`. */
  amount: z.string().nullable(),
  amountCurrency: BillingCurrencySchema.nullable(),
  /** Faturalangan daqiqalar (butun daqiqaga yaxlitlangan jami). */
  billedMinutes: z.number().int(),
  /** Summa hisoblanmagan sababi (stavka yo'q, kurs yo'q ...). */
  amountNote: z.string().nullable(),
  totals: TimesheetTotalsSchema,
  /** Loyihalar yig'indisi - mijoz jami (parallel ishlash; > 0 bo'lsa jami birlashma). */
  overlapSeconds: z.number().int(),
  projects: z.array(TimesheetProjectSchema),
});
export type TimesheetClient = z.infer<typeof TimesheetClientSchema>;

export const TimesheetDtoSchema = z.object({
  period: z.object({ from: DaySchema, to: DaySchema }),
  generatedAt: IsoDate,
  /** So'ralgan ko'rsatish valyutasi; `null` = har mijoz o'z stavka valyutasida. */
  currency: BillingCurrencySchema.nullable(),
  fxUzsPerUsd: z.string().nullable(),
  /** Bitta `working`/`awaiting_approval` oralig'ining chegarasi (soat). */
  activeCapHours: z.number(),
  /** `true`: davr xom `token_usage` retention'idan (30 kun) uzoqroq; vazifa tokenlari to'liq emas (loyiha jami to'liq). */
  taskTokensPartial: z.boolean(),
  /** `true`: davr `session_events` retention'idan (90 kun) uzoqroq; faol soat to'liq emas. */
  activeTimePartial: z.boolean(),
  clients: z.array(TimesheetClientSchema),
  total: TimesheetTotalsSchema,
});
export type TimesheetDto = z.infer<typeof TimesheetDtoSchema>;

/** Eksport javobi: fayl JSON ichida (dashboard proksi faqat JSON); `sizeBytes` <= 8 MB. */
export const ExportFileSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  dataBase64: z.string(),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

// --- 6.8 mijoz uchun statik hisobot ---------------------------------------------------------------

/** Mijoz hisoboti ko'lami: mijoz (barcha loyihalari) yoki bitta loyiha guruhi. */
export const ClientReportQuerySchema = z
  .object({
    clientId: z.uuid().optional(),
    projectKey: z.string().trim().min(1).max(BILLING_LIMITS.projectKeyMaxChars).optional(),
    from: DaySchema,
    to: DaySchema,
    showHours: z.enum(['0', '1']).optional(),
    showSummary: z.enum(['0', '1']).optional(),
  })
  .strict()
  .refine((q) => Boolean(q.clientId) !== Boolean(q.projectKey), { message: 'exactly one of clientId or projectKey' });
export type ClientReportQuery = z.infer<typeof ClientReportQuerySchema>;

export const CreateClientReportBodySchema = z
  .object({
    clientId: z.uuid().optional(),
    projectKey: z.string().trim().min(1).max(BILLING_LIMITS.projectKeyMaxChars).optional(),
    from: DaySchema,
    to: DaySchema,
    showHours: z.boolean().default(false),
    showSummary: z.boolean().default(true),
    /** Fayllarni EGASINING Telegram chatiga yuborish (mijozga emas). */
    sendToOwnerTelegram: z.boolean().default(false),
  })
  .strict()
  .refine((q) => Boolean(q.clientId) !== Boolean(q.projectKey), { message: 'exactly one of clientId or projectKey' });
export type CreateClientReportBody = z.infer<typeof CreateClientReportBodySchema>;

const ReportTaskTitleSchema = z.object({ title: z.string() });
export const ClientReportModelSchema = z.object({
  title: z.string(),
  periodFrom: DaySchema,
  periodTo: DaySchema,
  generatedDay: DaySchema,
  progress: z.object({ done: z.number().int(), inProgress: z.number().int(), remaining: z.number().int(), total: z.number().int(), percentDone: z.number() }),
  groups: z.array(
    z.object({
      name: z.string(),
      done: z.array(ReportTaskTitleSchema),
      inProgress: z.array(ReportTaskTitleSchema),
      remaining: z.array(ReportTaskTitleSchema),
      /** Davr ichida yopilgan vazifalar (sarlavhalar). */
      closedInPeriod: z.array(ReportTaskTitleSchema),
    }),
  ),
  /** Haftalar kesimida yopilgan vazifalar soni (grafik). */
  weekly: z.array(z.object({ weekStart: DaySchema, closed: z.number().int() })),
  summaries: z.array(z.object({ weekStart: DaySchema, lines: z.array(z.string()) })),
  /** Faqat `showHours` yoqilganda. */
  activeSeconds: z.number().int().nullable(),
  truncated: z.boolean(),
});
export type ClientReportModel = z.infer<typeof ClientReportModelSchema>;

export const ClientReportPreviewSchema = z.object({
  model: ClientReportModelSchema,
  /** To'liq o'z-o'zini qamragan HTML (sandbox iframe `srcdoc` uchun). */
  html: z.string(),
});
export type ClientReportPreview = z.infer<typeof ClientReportPreviewSchema>;

export const ClientReportSnapshotDtoSchema = z.object({
  id: z.uuid(),
  createdAt: IsoDate,
  actorKind: z.string(),
  actorDeviceId: z.uuid().nullable(),
  clientName: z.string(),
  projectKeys: z.array(z.string()),
  periodFrom: DaySchema,
  periodTo: DaySchema,
  showHours: z.boolean(),
  showSummary: z.boolean(),
  htmlSha256: z.string(),
  pdfSha256: z.string(),
  htmlBytes: z.number().int(),
  pdfBytes: z.number().int(),
  telegramSentAt: IsoDate.nullable(),
});
export type ClientReportSnapshotDto = z.infer<typeof ClientReportSnapshotDtoSchema>;
export const ListClientReportSnapshotsResponseSchema = z.object({ items: z.array(ClientReportSnapshotDtoSchema) });
export type ListClientReportSnapshotsResponse = z.infer<typeof ListClientReportSnapshotsResponseSchema>;

export const CreateClientReportResponseSchema = z.object({
  snapshot: ClientReportSnapshotDtoSchema,
  html: ExportFileSchema,
  pdf: ExportFileSchema,
  /** Telegram'ga yetkazilgan egasi chatlari soni (`sendToOwnerTelegram` bo'lmasa `null`). */
  telegramDelivered: z.number().int().nullable(),
});
export type CreateClientReportResponse = z.infer<typeof CreateClientReportResponseSchema>;
