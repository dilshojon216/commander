import { z } from 'zod';

/**
 * Loyiha ish maydoni (task 2.15) buyruqlari: `project.refresh | read_md | append_tasks | summarize`.
 * Hammasi mavjud imzolangan buyruq konveyeri orqali (commands jadvali + audit + Ed25519 imzo + agentd lokal siyosati).
 *
 * Maxfiylik (CLAUDE.md qoida 5): `project.summarize` agentga FAQAT tuzilgan statistika yuboradi (vazifa id/sarlavhasi,
 * vaqt, token, commit sarlavhalari: sarlavhalar redakt qilingan). Kod, diff, transcript, prompt matni YO'Q.
 */

export const PROJECT_OPS_LIMITS = {
  rootMaxChars: 4096,
  /** `md-files` ro'yxati chegarasi (snapshot ichida). */
  maxMdFiles: 200,
  mdPathMaxChars: 512,
  /** `project.read_md` o'qish chegarasi (bayt). */
  maxReadBytes: 64 * 1024,
  /** TASKS.md tahrir qilinadigan eng katta hajm (bayt). */
  maxTasksFileBytes: 2 * 1024 * 1024,
  maxAppendTasks: 50,
  taskTitleMaxChars: 200,
  /** Summarize: bitta so'rovdagi vazifa/commit soni. */
  maxSummarizeTasks: 60,
  maxSummarizeCommits: 30,
  summarizeTitleMaxChars: 120,
  summaryMaxChars: 2000,
  scoreReasonMaxChars: 200,
  /** md-extract REST kutish muddati (ms). */
  mdExtractWaitMs: 25_000,
} as const;

export const TASKS_MD_FILES = ['docs/TASKS.md', 'TASKS.md'] as const;
export const TasksMdFileSchema = z.enum(TASKS_MD_FILES);

const Root = z.string().min(1).max(PROJECT_OPS_LIMITS.rootMaxChars);

/** Vazifa id'si (TASKS.md `#` ustuni): kichik harf, raqam, `.`, `_`, `-`; bo'shliqsiz. */
export const TASK_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const TaskKeySchema = z.string().regex(TASK_KEY_RE);
/**
 * Xulosa uchun vazifa kaliti: ildiz `<kalit>` yoki qism `<slug>:<kalit>` (6.15; `project-parts.TASK_KEY_ANY_RE` bilan bir xil,
 * aylanma import bo'lmasligi uchun shu yerda). Qism vazifalari xulosaga (6.18) kiradi.
 */
export const SUMMARY_TASK_KEY_RE = /^(?:[a-z0-9][a-z0-9._~-]{0,127}:)?[a-z0-9][a-z0-9._-]{0,31}$/;
export const SummaryTaskKeySchema = z.string().regex(SUMMARY_TASK_KEY_RE);

/** Hajm: `S|M|L|XL` yoki aniq soat (`3h`, `1.5h`). */
export const TASK_SIZE_RE = /^(?:S|M|L|XL|\d{1,3}(?:\.\d{1,2})?h)$/;
export const TaskSizeSchema = z.string().regex(TASK_SIZE_RE);

/** Sarlavhada bitta qatorli, boshqaruv belgilarisiz matn. */
const SingleLine = z
  .string()
  .min(1)
  .max(PROJECT_OPS_LIMITS.taskTitleMaxChars)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s) && s.trim().length > 0, 'bitta qatorli matn kerak');

export const AppendTaskSchema = z.object({ key: TaskKeySchema, title: SingleLine, size: TaskSizeSchema.optional() }).strict();
export type AppendTask = z.infer<typeof AppendTaskSchema>;

/** Faza sarlavhasi (`## ...` matni, markdown belgilarsiz). */
export const PhaseNameSchema = z
  .string()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s) && s.trim().length > 0, 'bitta qatorli matn kerak');

export const MdRelPathSchema = z
  .string()
  .min(1)
  .max(PROJECT_OPS_LIMITS.mdPathMaxChars)
  .refine((p) => /\.md$/i.test(p) && !p.includes('\0') && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').some((s) => s === '..' || s === '' || s === '.'), 'yaroqsiz md yo\'li');

// --- agent-facing payload'lar (imzolanadi) -------------------------------------------------------

export const RefreshPayloadSchema = z.object({ root: Root }).strict();
export type RefreshPayload = z.infer<typeof RefreshPayloadSchema>;

export const ReadMdPayloadSchema = z.object({ root: Root, path: MdRelPathSchema }).strict();
export type ReadMdPayload = z.infer<typeof ReadMdPayloadSchema>;

export const AppendTasksPayloadSchema = z
  .object({
    root: Root,
    tasksPath: TasksMdFileSchema,
    /** Markaz ko'rgan snapshot'dagi TASKS.md xom baytlari sha256'i. Fayl o'zgargan bo'lsa agentd `tasks_md_changed` bilan rad etadi. */
    baseHash: z.string().regex(/^[0-9a-f]{64}$/),
    phase: PhaseNameSchema,
    tasks: z.array(AppendTaskSchema).min(1).max(PROJECT_OPS_LIMITS.maxAppendTasks),
  })
  .strict();
export type AppendTasksPayload = z.infer<typeof AppendTasksPayloadSchema>;

// --- summarize: FAQAT tuzilgan statistika --------------------------------------------------------

const Title = z.string().min(1).max(PROJECT_OPS_LIMITS.summarizeTitleMaxChars);

export const SummarizeTaskInputSchema = z
  .object({
    key: SummaryTaskKeySchema,
    /** Redakt qilingan, <= 120 belgi. */
    title: Title,
    activeSeconds: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    sessions: z.number().int().min(0),
    /** Reja (soat), TASKS.md hajmidan. */
    estimateHours: z.number().min(0).max(1000).nullable(),
    /** Shu kuni "bajarildi"ga o'tdimi. */
    doneThatDay: z.boolean(),
  })
  .strict();
export type SummarizeTaskInput = z.infer<typeof SummarizeTaskInputSchema>;

export const SummarizeInputSchema = z
  .object({
    /** `YYYY-MM-DD` (Asia/Tashkent). */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tasks: z.array(SummarizeTaskInputSchema).max(PROJECT_OPS_LIMITS.maxSummarizeTasks),
    /** Faqat commit sarlavhalari (redakt qilingan). */
    commitSubjects: z.array(Title).max(PROJECT_OPS_LIMITS.maxSummarizeCommits),
  })
  .strict();
export type SummarizeInput = z.infer<typeof SummarizeInputSchema>;

export const SummarizePayloadSchema = z.object({ root: Root, input: SummarizeInputSchema }).strict();
export type SummarizePayload = z.infer<typeof SummarizePayloadSchema>;

export const TaskScoreSchema = z.object({
  taskKey: SummaryTaskKeySchema,
  score: z.number().int().min(1).max(5),
  reason: z.string().max(PROJECT_OPS_LIMITS.scoreReasonMaxChars),
});
export type TaskScore = z.infer<typeof TaskScoreSchema>;

/** agentd natijasi (va center'da saqlanadigan shakl). */
export const SummarizeResultSchema = z.object({
  summary: z.string().min(1).max(PROJECT_OPS_LIMITS.summaryMaxChars),
  scores: z.array(TaskScoreSchema).max(PROJECT_OPS_LIMITS.maxSummarizeTasks),
  model: z.string().min(1).max(64),
});
export type SummarizeResult = z.infer<typeof SummarizeResultSchema>;

export const SUMMARIZE_SYSTEM_PROMPT =
  'Sen loyiha kunini tahlil qiluvchi qisqa yordamchisan. Faqat berilgan statistikaga tayanasan. Kod yoki fayl yo\'q, hech narsa o\'qima va uydirma. Javobing faqat bitta JSON obyekt.';

/**
 * Haiku'ga beriladigan prompt (sof). Faqat `SummarizeInput` maydonlari ishlatiladi (qo'shimcha maydonlar e'tiborsiz):
 * kod, diff, transcript yoki prompt matni bu yerga HECH QACHON kirmaydi.
 */
export function buildSummarizePrompt(input: SummarizeInput): string {
  const lines: string[] = [];
  lines.push(`Kun: ${input.day} (Asia/Tashkent).`);
  lines.push('');
  lines.push('Vazifalar (id | sarlavha | faol vaqt | token | sessiyalar | reja | kun ichida yopildimi):');
  if (input.tasks.length === 0) lines.push('(vazifa yo\'q)');
  for (const t of input.tasks) {
    const plan = t.estimateHours === null ? 'reja yo\'q' : `${t.estimateHours} soat`;
    lines.push(`- ${t.key} | ${t.title} | ${Math.round(t.activeSeconds / 60)} daqiqa | ${t.totalTokens} token | ${t.sessions} sessiya | ${plan} | ${t.doneThatDay ? 'ha' : 'yo\'q'}`);
  }
  lines.push('');
  lines.push('Shu kungi commit sarlavhalari:');
  if (input.commitSubjects.length === 0) lines.push('(yo\'q)');
  for (const s of input.commitSubjects) lines.push(`- ${s}`);
  lines.push('');
  lines.push(
    [
      'Vazifa:',
      '1) "summary": o\'zbek tilida (lotin) 3-5 gap: nima qilindi, reja va haqiqiy vaqt farqi, ertaga nimaga e\'tibor berish.',
      '2) "scores": har bir vazifa uchun {"taskKey", "score" (1-5 butun son), "reason" (o\'zbekcha, 1 gap, <= 150 belgi)}.',
      '   Baho mezoni: reja bilan haqiqiy vaqt nisbati, yopilganmi, token sarfi ko\'lamga mosligi.',
      'Faqat shu JSON shaklida javob ber, boshqa matn yozma:',
      '{"summary": "...", "scores": [{"taskKey": "...", "score": 4, "reason": "..."}]}',
    ].join('\n'),
  );
  return lines.join('\n');
}

/** Model javobidan JSON'ni ajratadi (``` to'siqlari yoki atrofdagi matn bo'lsa ham) va tekshiradi. Yaroqsiz bo'lsa `null`. */
export function parseSummarizeOutput(text: string, knownKeys: ReadonlySet<string>, model: string): SummarizeResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = z.object({ summary: z.string(), scores: z.array(z.unknown()).default([]) }).safeParse(raw);
  if (!obj.success) return null;
  const seen = new Set<string>();
  const scores: TaskScore[] = [];
  for (const s of obj.data.scores) {
    const p = z
      .object({ taskKey: z.string(), score: z.number(), reason: z.string().default('') })
      .safeParse(s);
    if (!p.success) continue;
    const key = p.data.taskKey.trim().toLowerCase();
    if (!knownKeys.has(key) || seen.has(key)) continue; // noma'lum vazifa uchun baho tashlanadi
    seen.add(key);
    scores.push({ taskKey: key, score: Math.min(5, Math.max(1, Math.round(p.data.score))), reason: p.data.reason.trim().slice(0, PROJECT_OPS_LIMITS.scoreReasonMaxChars) });
  }
  const summary = obj.data.summary.trim().slice(0, PROJECT_OPS_LIMITS.summaryMaxChars);
  if (!summary) return null;
  return { summary, scores, model: model.slice(0, 64) || 'haiku' };
}

// --- natija ma'lumotlari ----------------------------------------------------------------------

/** `project.read_md` natijasi: redakt qilingan matn (markazda faqat xotirada, DB'ga yozilmaydi). */
export const ReadMdResultSchema = z.object({
  path: z.string().max(PROJECT_OPS_LIMITS.mdPathMaxChars),
  content: z.string().max(80_000),
  bytes: z.number().int().min(0),
  truncated: z.boolean(),
});
export type ReadMdResult = z.infer<typeof ReadMdResultSchema>;

export const AppendResultSchema = z.object({
  added: z.number().int().min(0),
  skippedKeys: z.array(z.string().max(32)).max(PROJECT_OPS_LIMITS.maxAppendTasks),
  createdPhase: z.boolean(),
  /** Yangi fayl xeshi (sha256 hex). */
  newHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AppendResult = z.infer<typeof AppendResultSchema>;
