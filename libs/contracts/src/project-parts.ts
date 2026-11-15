import { z } from 'zod';
import { TokenTotalsSchema } from './api.js';
import { PLAN_LIMITS } from './plan-md.js';
import { PROJECT_TASK_STATUSES } from './tasks-md.js';

// `projects.ts` shu faylni import qiladi: aylanma import bo'lmasligi uchun holat/sanoq sxemalari shu yerda.
const ProjectTaskStatusSchema = z.enum(PROJECT_TASK_STATUSES);
const TasksSummarySchema = z.object({
  todo: z.number().int(),
  doing: z.number().int(),
  done: z.number().int(),
  unknown: z.number().int(),
  total: z.number().int(),
});

/**
 * Loyiha qismlari (task 6.15): bitta loyiha (masalan monorepo) ichida bir nechta papka, har birining o'z reja fayli
 * (TODO.md, TASKS.md, *_TODO.md). Har qism o'z doskasi, progressi va "bajarilganlar xulosasi"ga ega.
 *
 * Kalit qoidasi: `project_tasks`/`task_board`/`task_events`/`session_task_spans` kaliti (project_id, task_key) o'zgarmaydi,
 * shuning uchun qism vazifalarining kaliti NOMLAR MAYDONI bilan yoziladi: `<slug>:<key>` (`partTaskKey`). Ildiz ('' qism)
 * kaliti o'zgarmaydi. Slug = qism yo'li kichik harf, `/` -> `~`. Oddiy kalitda `:` bo'lmaydi (parser rad etadi): to'qnashuv yo'q.
 */

export const PART_LIMITS = {
  /** Loyihadagi qismlar soni chegarasi. */
  maxParts: 20,
  /** Qismdagi reja fayllari (ro'yxat). */
  maxPlanFiles: 8,
  /** Yo'l chuqurligi: ildizdan <= 2 papka (`web-app`, `apps/center`). */
  maxDepth: 2,
  /** Hamma qismlarning JSON hajmi (bayt): WS xabaridan (256 KB) kichik zaxira. */
  maxPartsBytes: 120 * 1024,
  /** Bitta reja faylini o'qish chegarasi (bayt); undan kattasi kesiladi (`readTruncated`). */
  maxPlanFileBytes: 4 * 1024 * 1024,
  /** "Bajarilganlar xulosasi"dagi oxirgi bandlar soni. */
  recentDone: 10,
} as const;

/** Qism yo'li (ildizga nisbatan, `/`, <= 2 bo'lak). Bo'sh satr = ildiz (bu yerda emas: ildiz alohida). */
export const PART_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
export const PartPathSchema = z.string().regex(PART_PATH_RE);

export const partSlug = (part: string): string => part.toLowerCase().replace(/\//g, '~');

/** Vazifa kaliti: ildiz uchun o'zgarmas; qism uchun `<slug>:<key>`. */
export function partTaskKey(part: string, key: string): string {
  return part === '' ? key : `${partSlug(part)}:${key}`;
}

/** Samarali kalit -> `{slug, key}` (`slug = ''` = ildiz). */
export function splitPartTaskKey(effectiveKey: string): { slug: string; key: string } {
  const i = effectiveKey.indexOf(':');
  return i === -1 ? { slug: '', key: effectiveKey } : { slug: effectiveKey.slice(0, i), key: effectiveKey.slice(i + 1) };
}

/** REST yo'l parametri uchun: oddiy kalit yoki `<slug>:<kalit>`. */
export const TASK_KEY_ANY_RE = /^(?:[a-z0-9][a-z0-9._~-]{0,127}:)?[a-z0-9][a-z0-9._-]{0,31}$/;
export const TaskKeyAnySchema = z.string().regex(TASK_KEY_ANY_RE);

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Sessiyaning BOSHLANG'ICH cwd'idan qism: loyiha ildizi ichida bo'lib, yo'li cwd'ning prefiksi (papka chegarasida) bo'lgan
 * ENG UZUN qism. Hech biri mos kelmasa (yoki cwd ildizning o'zi/tashqarisida) `''` (ildiz).
 */
export function partForCwd(startCwd: string, projectPath: string, parts: readonly string[]): string {
  const root = trimSlash(projectPath);
  const cwd = trimSlash(startCwd);
  if (!cwd.startsWith(`${root}/`)) return '';
  const rel = cwd.slice(root.length + 1);
  let best = '';
  for (const p of parts) {
    if (p === '' || p.length <= best.length) continue;
    if (rel === p || rel.startsWith(`${p}/`)) best = p;
  }
  return best;
}

// --- agentd -> markaz (snapshot ichida) ----------------------------------------------------------

export const SnapshotPlanItemSchema = z.object({
  key: z.string().min(1).max(PLAN_LIMITS.maxKey),
  title: z.string().max(PLAN_LIMITS.maxTitle + 1),
  phase: z.string().max(PLAN_LIMITS.maxPhase).nullish(),
  status: ProjectTaskStatusSchema,
  rawStatus: z.string().max(64).nullish(),
  size: z.string().max(64).nullish(),
  /** `YYYY-MM-DD` */
  doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
export type SnapshotPlanItem = z.infer<typeof SnapshotPlanItemSchema>;

export const SnapshotPartSchema = z.object({
  /** Ildizga nisbiy yo'l (`web-app`). */
  path: PartPathSchema,
  /** Papka nomi. */
  name: z.string().min(1).max(64),
  /** Shu qismning reja fayllari (qism papkasiga nisbatan emas: LOYIHA ILDIZIGA nisbatan). */
  planFiles: z.array(z.string().min(1).max(512)).max(PART_LIMITS.maxPlanFiles),
  /** Barcha o'qilgan bandlar bo'yicha (items kesilgan bo'lsa ham to'g'ri progress). */
  counts: TasksSummarySchema,
  items: z.array(SnapshotPlanItemSchema).max(PLAN_LIMITS.maxItems),
  /** `items` hajm/chegara sababli `counts.total` dan kam. */
  itemsTruncated: z.boolean(),
  /** Reja fayli `maxPlanFileBytes` dan katta: oxiri o'qilmagan. */
  readTruncated: z.boolean(),
});
export type SnapshotPart = z.infer<typeof SnapshotPartSchema>;

// --- REST DTO'lar --------------------------------------------------------------------------------

export const PartDoneItemSchema = z.object({
  /** Fayldagi oddiy kalit (nomlar maydonisiz). */
  key: z.string(),
  title: z.string(),
  phase: z.string().nullable(),
  /** Sana (YYYY-MM-DD): fayl sarlavhasidan, bo'lmasa "bajarildi" hodisasidan; bo'lmasa `null`. */
  doneOn: z.string().nullable(),
});
export type PartDoneItem = z.infer<typeof PartDoneItemSchema>;

export const PartPhaseProgressSchema = z.object({ phase: z.string().nullable(), done: z.number().int(), total: z.number().int() });
export type PartPhaseProgress = z.infer<typeof PartPhaseProgressSchema>;

export const ProjectPartDtoSchema = z.object({
  /** `''` = ildiz ("asosiy"). */
  part: z.string(),
  name: z.string(),
  planFiles: z.array(z.string()),
  summary: TasksSummarySchema,
  /** done/total, 0..100; vazifa yo'q = `null`. */
  percent: z.number().int().min(0).max(100).nullable(),
  /** Qism sessiyalari (sessiya boshlangan cwd bo'yicha) va ularning tokeni/faol vaqti. */
  sessions: z.number().int(),
  activeSeconds: z.number().int(),
  tokens: TokenTotalsSchema,
  lastActivityAt: z.string().nullable(),
  /** Deterministik xulosa: oxirgi bajarilgan bandlar va faza bo'yicha progress. */
  recentDone: z.array(PartDoneItemSchema),
  byPhase: z.array(PartPhaseProgressSchema),
  itemsTruncated: z.boolean(),
  readTruncated: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type ProjectPartDto = z.infer<typeof ProjectPartDtoSchema>;

export const ProjectPartsResponseSchema = z.object({
  projectId: z.uuid(),
  /** Birinchisi har doim ildiz (`part: ''`). */
  parts: z.array(ProjectPartDtoSchema),
  /** Token statistikasi xom `token_usage`dan (retention 30 kun). */
  tokensCoveredFrom: z.string(),
});
export type ProjectPartsResponse = z.infer<typeof ProjectPartsResponseSchema>;
