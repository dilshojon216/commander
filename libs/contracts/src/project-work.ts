import { z } from 'zod';
import { TokenTotalsSchema } from './api.js';
import { CommandDtoSchema } from './commands.js';
import { PartPathSchema } from './project-parts.js';
import { MdRelPathSchema, PhaseNameSchema, AppendTaskSchema, PROJECT_OPS_LIMITS, TaskKeySchema, TaskScoreSchema } from './project-ops.js';

/**
 * Loyiha ish maydoni (task 2.15) REST kontrakti:
 *  - `PATCH /v1/projects/:id/tasks/:taskKey/board` (control), `GET /v1/projects/:id/daily` (read),
 *  - `POST /v1/projects/:id/daily/:date/summary` (control), `GET /v1/projects/:id/md-files` (read),
 *  - `POST /v1/projects/:id/md-extract` (control), `POST /v1/projects/:id/tasks/append` (control),
 *  - `POST /v1/projects/:id/refresh` (control).
 * Kunlar Asia/Tashkent (UTC+5, DST yo'q).
 */

const IsoDate = z.string();

// --- doska ------------------------------------------------------------------------------------

export const TASK_BOARD_COLUMNS = ['todo', 'doing', 'review', 'done'] as const;
export const TaskBoardColumnSchema = z.enum(TASK_BOARD_COLUMNS);
export type TaskBoardColumn = z.infer<typeof TaskBoardColumnSchema>;

/** `tasks_md` = TASKS.md `done` (har doim ustun), `board` = qo'lda surilgan, `derived` = faol span / TASKS.md `doing` / `todo`. */
export const TASK_COLUMN_SOURCES = ['tasks_md', 'board', 'derived'] as const;
export const TaskColumnSourceSchema = z.enum(TASK_COLUMN_SOURCES);
export type TaskColumnSource = z.infer<typeof TaskColumnSourceSchema>;

export const PatchBoardBodySchema = z.object({ column: TaskBoardColumnSchema }).strict();
export type PatchBoardBody = z.infer<typeof PatchBoardBodySchema>;

export const PatchBoardResponseSchema = z.object({
  projectId: z.uuid(),
  taskKey: z.string(),
  column: TaskBoardColumnSchema,
  columnSource: TaskColumnSourceSchema,
  /** Surish natijasi doskada ko'rinadigan ustundan farq qilsa (masalan TASKS.md `done` ustun): haqiqiy ustun shu. */
  changed: z.boolean(),
});
export type PatchBoardResponse = z.infer<typeof PatchBoardResponseSchema>;

// --- reja vs haqiqiy ----------------------------------------------------------------------------

export const TASK_SIZE_HOURS_SETTING = 'tasks.size_hours';
export const DEFAULT_SIZE_HOURS: Readonly<Record<string, number>> = { S: 2, M: 6, L: 16, XL: 40 };
export const SizeHoursSettingSchema = z.record(z.string().regex(/^[A-Z]{1,3}$/), z.number().min(0).max(1000));

export type EstimateSource = 'explicit' | 'size';
export interface TaskEstimate {
  hours: number;
  source: EstimateSource;
}

/**
 * Reja (soat): aniq `3h`/`1.5h` yoki hajm `S|M|L|XL` (sozlanadigan xarita `tasks.size_hours`, default S=2 M=6 L=16 XL=40).
 * `S/M`, `S-M` kabi oraliqlarda kattasi olinadi. Taniy olmasa `null`.
 */
export function estimateHours(size: string | null | undefined, map: Readonly<Record<string, number>> = DEFAULT_SIZE_HOURS): TaskEstimate | null {
  if (!size) return null;
  const v = size.trim();
  if (!v) return null;
  const explicit = /^(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:h|hr|hrs|soat)$/i.exec(v);
  if (explicit) return { hours: Number(explicit[1]!.replace(',', '.')), source: 'explicit' };
  const parts = v.toUpperCase().split(/[\s/,\-–]+/).filter(Boolean);
  let best: number | null = null;
  for (const p of parts) {
    const h = map[p];
    if (h !== undefined && (best === null || h > best)) best = h;
  }
  return best === null ? null : { hours: best, source: 'size' };
}

export const TaskPlanSchema = z.object({
  /** Reja (soat) yoki `null` (hajm yo'q/tanilmagan). */
  estimateHours: z.number().nullable(),
  estimateSource: z.enum(['explicit', 'size']).nullable(),
  /** Haqiqiy faol vaqt (soat, 0.1 aniqlik). */
  actualHours: z.number(),
  /** `actualHours / estimateHours`; reja bo'lmasa `null`. */
  ratio: z.number().nullable(),
});
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export function buildPlan(estimate: TaskEstimate | null, activeSeconds: number): TaskPlan {
  const actual = Math.round((activeSeconds / 3600) * 10) / 10;
  return {
    estimateHours: estimate?.hours ?? null,
    estimateSource: estimate?.source ?? null,
    actualHours: actual,
    ratio: estimate && estimate.hours > 0 ? Math.round((activeSeconds / 3600 / estimate.hours) * 100) / 100 : null,
  };
}

/** Vazifaning eng so'nggi bahosi (kunlik xulosadan). */
export const TaskScoreRefSchema = z.object({ score: z.number().int().min(1).max(5), reason: z.string(), day: z.string(), createdAt: IsoDate });
export type TaskScoreRef = z.infer<typeof TaskScoreRefSchema>;

// --- kunlik ko'rinish -------------------------------------------------------------------------

export const DateParamSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DAILY_MAX_DAYS = 62;

export const DailyQuerySchema = z
  .object({ from: DateParamSchema.optional(), to: DateParamSchema.optional(), part: z.string().max(130).optional() })
  .strict();
export type DailyQuery = z.infer<typeof DailyQuerySchema>;

/**
 * `POST .../daily/:date/summary` tanasi (6.18): `part` bo'lmasa yoki '' = butun loyiha (avvalgidek); aks holda faqat shu qism
 * vazifalari/sessiyalari/hodisalari bo'yicha xulosa, alohida saqlanadi. Tana ixtiyoriy (bo'sh so'rov = butun loyiha).
 */
export const SummarizeDayBodySchema = z.object({ part: z.union([z.literal(''), PartPathSchema]).optional() }).strict();
export type SummarizeDayBody = z.infer<typeof SummarizeDayBodySchema>;

export const DailyTaskSchema = z.object({
  taskKey: z.string(),
  title: z.string().nullable(),
  /** Kun oynasi bilan kesilgan. */
  firstActivityAt: IsoDate,
  lastActivityAt: IsoDate,
  activeSeconds: z.number().int(),
  tokens: TokenTotalsSchema,
  sessions: z.number().int(),
  plan: TaskPlanSchema,
  score: TaskScoreRefSchema.nullable(),
});
export type DailyTask = z.infer<typeof DailyTaskSchema>;

export const DailyDoneTaskSchema = z.object({
  taskKey: z.string(),
  title: z.string().nullable(),
  /** Qayerdan: TASKS.md snapshot farqi yoki doskada surilgan. */
  source: z.enum(['tasks_md', 'board']),
  ts: IsoDate,
});
export type DailyDoneTask = z.infer<typeof DailyDoneTaskSchema>;

export const DailySummaryDtoSchema = z.object({
  day: z.string(),
  summary: z.string(),
  scores: z.array(TaskScoreSchema),
  model: z.string(),
  createdAt: IsoDate,
});
export type DailySummaryDto = z.infer<typeof DailySummaryDtoSchema>;

export const DailyTotalsSchema = z.object({
  tasksWorked: z.number().int(),
  tasksDone: z.number().int(),
  activeSeconds: z.number().int(),
  sessions: z.number().int(),
  totalTokens: z.number(),
  costUsd: z.number().nullable(),
  /** Token, hech bir vazifaga bog'lanmagan. */
  unattributedTokens: z.number(),
  /** Saqlangan xulosadagi baholar o'rtachasi (bo'lmasa `null`). */
  avgScore: z.number().nullable(),
});
export type DailyTotals = z.infer<typeof DailyTotalsSchema>;

export const DailyDaySchema = z.object({
  /** `YYYY-MM-DD` (Asia/Tashkent). */
  date: z.string(),
  tasks: z.array(DailyTaskSchema),
  doneTasks: z.array(DailyDoneTaskSchema),
  totals: DailyTotalsSchema,
  summary: DailySummaryDtoSchema.nullable(),
});
export type DailyDay = z.infer<typeof DailyDaySchema>;

export const DailyResponseSchema = z.object({
  projectId: z.uuid(),
  timezone: z.literal('Asia/Tashkent'),
  /** Eskidan yangiga emas: `from` dan `to` gacha o'sish tartibida. */
  days: z.array(DailyDaySchema),
  /** Token statistikasi xom `token_usage`dan (retention 30 kun). */
  tokensCoveredFrom: IsoDate,
});
export type DailyResponse = z.infer<typeof DailyResponseSchema>;

// --- xulosa buyrug'i ----------------------------------------------------------------------------

/** `POST .../daily/:date/summary` va boshqa project buyruqlari: buyruq DTO'si (holat `command.updated` bilan keladi). */
export const ProjectCommandResponseSchema = z.object({ command: CommandDtoSchema, idempotent: z.boolean() });
export type ProjectCommandResponse = z.infer<typeof ProjectCommandResponseSchema>;

// --- md fayllar ----------------------------------------------------------------------------------

export const MdFilesResponseSchema = z.object({
  projectId: z.uuid(),
  /** Loyiha ildiziga nisbatan, `/` bilan; chuqurlik <= 3, <= 200 ta. */
  files: z.array(z.string()).max(PROJECT_OPS_LIMITS.maxMdFiles),
  /** Snapshot olingan vaqt (ISO) yoki `null` (hali yo'q / eski agentd). */
  takenAt: IsoDate.nullable(),
});
export type MdFilesResponse = z.infer<typeof MdFilesResponseSchema>;

export const MdExtractBodySchema = z.object({ path: MdRelPathSchema, phase: PhaseNameSchema.optional() }).strict();
export type MdExtractBody = z.infer<typeof MdExtractBodySchema>;

export const TaskCandidateSchema = z.object({
  title: z.string(),
  source: z.enum(['heading', 'checklist', 'numbered']),
  line: z.number().int(),
  group: z.string().nullable(),
  checked: z.boolean(),
  alreadyInTasks: z.string().nullable(),
  /** Tanlangan fazadagi tartibga ko'ra taklif (UI o'zgartirishi mumkin). */
  suggestedKey: z.string(),
});
export type TaskCandidateDto = z.infer<typeof TaskCandidateSchema>;

export const MdExtractResponseSchema = z.object({
  projectId: z.uuid(),
  path: z.string(),
  bytes: z.number().int(),
  truncated: z.boolean(),
  /** TASKS.md'dagi mavjud fazalar (aniq sarlavha matni); `append` shulardan birini yoki yangi nomni oladi. */
  phases: z.array(z.string()),
  /** Id'lar shu faza uchun taklif qilindi (so'ralgan yoki oxirgi mavjud faza; TASKS.md bo'lmasa `null`). */
  suggestedPhase: z.string().nullable(),
  candidates: z.array(TaskCandidateSchema),
  commandId: z.uuid(),
});
export type MdExtractResponse = z.infer<typeof MdExtractResponseSchema>;

export const AppendTasksBodySchema = z
  .object({
    phase: PhaseNameSchema,
    tasks: z.array(AppendTaskSchema).min(1).max(PROJECT_OPS_LIMITS.maxAppendTasks),
  })
  .strict()
  .refine((b) => new Set(b.tasks.map((t) => t.key)).size === b.tasks.length, { message: 'vazifa id\'lari takrorlanmasin', path: ['tasks'] });
export type AppendTasksBody = z.infer<typeof AppendTasksBodySchema>;

export const TaskKeyParamSchema = TaskKeySchema;
export { TaskScoreSchema };
