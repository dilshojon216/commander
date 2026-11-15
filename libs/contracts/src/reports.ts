import { z } from 'zod';

/** Kunlik/haftalik hisobotlar (task 3.3). Hammasi deterministik: LLM yo'q. Narx = API-ekvivalent (obuna to'lovi emas). */

export const REPORT_KINDS = ['daily', 'weekly'] as const;
export const ReportKindSchema = z.enum(REPORT_KINDS);
export type ReportKind = z.infer<typeof ReportKindSchema>;

const TokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
  /** `weightedTokens` (limits-logic) bilan hisoblangan vaznli yig'indi. */
  weighted: z.number(),
});

export const ReportModelShareSchema = z.object({
  model: z.string(),
  requests: z.number(),
  weighted: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  /** 0..1: vaznli tokenlar ulushi. */
  share: z.number(),
});
export type ReportModelShare = z.infer<typeof ReportModelShareSchema>;

export const ReportSectionSchema = z.object({
  projectId: z.uuid().nullable(),
  name: z.string(),
  tasksClosed: z.array(z.object({ key: z.string(), title: z.string().nullable() })),
  commits: z.number().int(),
  tokens: TokensSchema,
  costUsd: z.number().nullable(),
  activeSeconds: z.number(),
  sessions: z.number().int(),
  topTasks: z.array(z.object({ key: z.string(), title: z.string().nullable(), weighted: z.number(), costUsd: z.number().nullable() })),
  /** Rejalangan (taxminiy soat) vs haqiqiy faol vaqt; reja yo'q bo'lsa null. */
  planVsActual: z.object({ plannedHours: z.number(), actualHours: z.number(), tasks: z.number().int() }).nullable(),
  /** Jami vaznli sarfdagi ulush (0..1). */
  limitShare: z.number(),
  models: z.array(ReportModelShareSchema),
  /** `project.summarize` kunlik xulosalari (bo'lsa). */
  summaries: z.array(z.string()),
});
export type ReportSection = z.infer<typeof ReportSectionSchema>;

export const ReportDataSchema = z.object({
  kind: ReportKindSchema,
  /** `YYYY-MM-DD` (Asia/Tashkent), ikkalasi ham kiradi. */
  from: z.string(),
  to: z.string(),
  total: ReportSectionSchema,
  projects: z.array(ReportSectionSchema),
  recommendations: z.array(z.string()),
  /** Rasmiy limit oynasi (bo'lsa): faqat `source` bilan ko'rsatiladi (CLAUDE.md #6). */
  limits: z.object({ fiveHourPct: z.number().nullable(), sevenDayPct: z.number().nullable(), source: z.enum(['official', 'estimate']).nullable() }).nullable(),
});
export type ReportData = z.infer<typeof ReportDataSchema>;

export const ReportSummaryDtoSchema = z.object({
  id: z.uuid(),
  kind: ReportKindSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  generatedAt: z.string(),
  sentAt: z.string().nullable(),
  tasksClosed: z.number().int(),
  totalTokens: z.number(),
  costUsd: z.number().nullable(),
});
export type ReportSummaryDto = z.infer<typeof ReportSummaryDtoSchema>;
export const ReportDtoSchema = ReportSummaryDtoSchema.extend({ data: ReportDataSchema, textHtml: z.string() });
export type ReportDto = z.infer<typeof ReportDtoSchema>;

export const ListReportsQuerySchema = z.object({ kind: ReportKindSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export type ListReportsQuery = z.infer<typeof ListReportsQuerySchema>;
export const ListReportsResponseSchema = z.object({ items: z.array(ReportSummaryDtoSchema) });
export type ListReportsResponse = z.infer<typeof ListReportsResponseSchema>;

export const REPORT_SCHEDULE_DEFAULTS = { dailyTime: '21:00', weeklyTime: '20:00', weeklyDay: 0 } as const;

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const ReportSettingsSchema = z.object({
  dailyEnabled: z.boolean(),
  weeklyEnabled: z.boolean(),
  /** Asia/Tashkent, `HH:MM`. */
  dailyTime: TimeSchema,
  weeklyTime: TimeSchema,
  /** 0 = yakshanba. */
  weeklyDay: z.number().int().min(0).max(6),
});
export type ReportSettings = z.infer<typeof ReportSettingsSchema>;
export const DEFAULT_REPORT_SETTINGS: ReportSettings = { dailyEnabled: true, weeklyEnabled: true, ...REPORT_SCHEDULE_DEFAULTS };

export const GenerateReportBodySchema = z.object({ kind: ReportKindSchema, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), send: z.boolean().default(false) });
export type GenerateReportBody = z.infer<typeof GenerateReportBodySchema>;
