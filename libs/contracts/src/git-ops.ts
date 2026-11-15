import { z } from 'zod';

/**
 * Git/PR integratsiyasi (task 3.5): `project.diff`, `project.open_pr`, `project.ci_status` buyruqlari, ularning natijalari,
 * commit -> vazifa bog'lash (sof parser) va REST DTO'lari. Hammasi mavjud imzolangan buyruq konveyeri orqali (commands jadvali +
 * audit + Ed25519 imzo + agentd lokal siyosati).
 *
 * Maxfiylik (CLAUDE.md qoida 5): diff matni agentd'da `redact()`dan o'tadi va kesiladi; markazda FAQAT xotirada (DB'ga yozilmaydi,
 * `project.read_md` kabi). Maxfiy fayllar (`.env*`, kalitlar) diff'ida matni YO'Q (faqat nomi va +/- soni).
 */

export const GIT_OPS_LIMITS = {
  rootMaxChars: 4096,
  /** Diff matni umumiy chegarasi (bayt). WS xabari 256 KB: JSON qochirishlari uchun zaxira qoldiriladi. */
  diffMaxBytes: 192 * 1024,
  /** Bitta fayl uchun patch chegarasi (bayt). */
  perFileMaxBytes: 24 * 1024,
  maxFiles: 300,
  maxUntracked: 200,
  pathMaxChars: 512,
  titleMaxChars: 256,
  bodyMaxChars: 16_000,
  branchMaxChars: 200,
  maxChecks: 50,
  checkNameMaxChars: 120,
  /** `project.diff` REST kutish muddati (ms). */
  diffWaitMs: 45_000,
  /** CI holati davriy so'rovi (ms): ochiq PR'li loyihalar uchun. */
  ciPollMs: 5 * 60_000,
  /** Bitta sessiya "Diff" natijasi xotirada saqlanish muddati. */
  maxCommitsPerTask: 50,
} as const;

const Root = z.string().min(1).max(GIT_OPS_LIMITS.rootMaxChars);

/** Git/PR buyruqlari (`commands.ts` `PROJECT_COMMAND_TYPES` ning bir qismi). */
export const GIT_COMMAND_TYPES = ['project.diff', 'project.open_pr', 'project.ci_status'] as const;
export type GitCommandType = (typeof GIT_COMMAND_TYPES)[number];
export const isGitCommandType = (t: string): t is GitCommandType => (GIT_COMMAND_TYPES as readonly string[]).includes(t);

// --- xavfsiz git ref nomlari ------------------------------------------------------------------

/**
 * Branch nomi (agentga argument sifatida boradi; shell yo'q, lekin `-` bilan boshlanuvchi ref bayroqqa aylanmasin):
 * lotin harf/raqam bilan boshlanadi; `..`, `//`, `@{`, `.lock`, oxirgi `/` yoki `.` YO'Q; bo'shliq va boshqaruv belgilari YO'Q.
 */
export const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;
export function isSafeBranchName(name: string): boolean {
  if (name.length === 0 || name.length > GIT_OPS_LIMITS.branchMaxChars) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return !name.split('/').some((s) => s === '' || s.startsWith('.') || s.endsWith('.lock'));
}
export const BranchNameSchema = z.string().refine(isSafeBranchName, 'yaroqsiz branch nomi');

export const SHA_RE = /^[0-9a-f]{7,64}$/;

/** Diff bazasi: `HEAD` (ishchi daraxt vs HEAD), commit sha yoki `merge-base:<branch>` (branch'ning ajralgan nuqtasidan). */
export const DiffBaseSchema = z.string().refine((v) => {
  if (v === 'HEAD') return true;
  if (SHA_RE.test(v)) return true;
  return v.startsWith('merge-base:') && isSafeBranchName(v.slice('merge-base:'.length));
}, 'base: HEAD, <sha> yoki merge-base:<branch>');
export type DiffBase = z.infer<typeof DiffBaseSchema>;

// --- project.diff -----------------------------------------------------------------------------

export const DiffPayloadSchema = z
  .object({
    root: Root,
    base: DiffBaseSchema.optional(),
    maxBytes: z.number().int().min(1024).max(GIT_OPS_LIMITS.diffMaxBytes).optional(),
    /** Faqat fayllar ro'yxati va +/- sonlari (patch matni yo'q): Telegram uchun. */
    statOnly: z.boolean().optional(),
  })
  .strict();
export type DiffPayload = z.infer<typeof DiffPayloadSchema>;

export const DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange'] as const;
export const DIFF_HIDDEN_REASONS = ['secret', 'binary', 'budget', 'stat_only'] as const;

export const DiffFileSchema = z.object({
  path: z.string().max(GIT_OPS_LIMITS.pathMaxChars),
  oldPath: z.string().max(GIT_OPS_LIMITS.pathMaxChars).nullable(),
  status: z.enum(DIFF_FILE_STATUSES),
  additions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
  binary: z.boolean(),
  /** Redakt qilingan unified patch (faqat shu fayl). `null` = matn ko'rsatilmaydi (`hidden` sababi bilan). */
  patch: z.string().nullable(),
  truncated: z.boolean(),
  hidden: z.enum(DIFF_HIDDEN_REASONS).nullable(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffResultSchema = z.object({
  /** So'ralgan baza (`HEAD` | sha | `merge-base:<b>`). */
  base: z.string().max(GIT_OPS_LIMITS.branchMaxChars + 16),
  baseSha: z.string().regex(SHA_RE).nullable(),
  headSha: z.string().regex(SHA_RE).nullable(),
  branch: z.string().max(GIT_OPS_LIMITS.branchMaxChars).nullable(),
  files: z.array(DiffFileSchema).max(GIT_OPS_LIMITS.maxFiles),
  /** Barcha o'zgargan fayllar soni (ro'yxat `maxFiles` ga kesilgan bo'lishi mumkin). */
  filesTotal: z.number().int().min(0),
  totalAdditions: z.number().int().min(0),
  totalDeletions: z.number().int().min(0),
  /** Kuzatilmayotgan (untracked) fayllar: FAQAT nomlari (kontent va binar HECH QACHON). */
  untracked: z.array(z.string().max(GIT_OPS_LIMITS.pathMaxChars)).max(GIT_OPS_LIMITS.maxUntracked),
  untrackedTotal: z.number().int().min(0),
  bytes: z.number().int().min(0),
  truncated: z.boolean(),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

// --- project.open_pr --------------------------------------------------------------------------

/** Sarlavha: bitta qator, boshqaruv belgilarisiz. */
const PrTitle = z
  .string()
  .min(1)
  .max(GIT_OPS_LIMITS.titleMaxChars)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s) && s.trim().length > 0, 'bitta qatorli sarlavha kerak');
/** Tana: ko'p qatorli matn; NUL va boshqa boshqaruv belgilari (\n, \t, \r dan tashqari) YO'Q. */
const PrBody = z
  .string()
  .max(GIT_OPS_LIMITS.bodyMaxChars)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), 'yaroqsiz belgilar');

export const OpenPrFieldsSchema = z.object({
  title: PrTitle,
  body: PrBody,
  base: BranchNameSchema,
  /** Berilmasa agentd joriy branch'ni oladi. */
  head: BranchNameSchema.optional(),
  draft: z.boolean(),
});
export const OpenPrPayloadSchema = OpenPrFieldsSchema.extend({ root: Root }).strict();
export type OpenPrPayload = z.infer<typeof OpenPrPayloadSchema>;

export const PrResultSchema = z.object({
  url: z.string().url().max(500),
  number: z.number().int().min(1),
  /** `true` = shu branch uchun PR allaqachon bor edi (yangisi ochilmadi). */
  existing: z.boolean(),
  branch: BranchNameSchema,
  base: BranchNameSchema,
  draft: z.boolean(),
  /** Branch `git push -u origin` bilan yuborildimi. */
  pushed: z.boolean(),
});
export type PrResult = z.infer<typeof PrResultSchema>;

// --- project.ci_status ------------------------------------------------------------------------

export const CiStatusPayloadSchema = z.object({ root: Root, branch: BranchNameSchema.optional() }).strict();
export type CiStatusPayload = z.infer<typeof CiStatusPayloadSchema>;

export const CI_STATES = ['success', 'failure', 'pending', 'none', 'unknown'] as const;
export const CiStateSchema = z.enum(CI_STATES);
export type CiState = z.infer<typeof CiStateSchema>;
export const CI_CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const;

export const CiCheckSchema = z.object({
  name: z.string().max(GIT_OPS_LIMITS.checkNameMaxChars),
  bucket: z.enum(CI_CHECK_BUCKETS),
  /** Faqat `https://` havola. */
  link: z.string().max(500).nullable(),
});
export type CiCheck = z.infer<typeof CiCheckSchema>;

export const CiRunSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().max(GIT_OPS_LIMITS.checkNameMaxChars),
  status: z.string().max(32),
  conclusion: z.string().max(32).nullable(),
  url: z.string().max(500).nullable(),
  headSha: z.string().regex(SHA_RE).nullable(),
});
export type CiRun = z.infer<typeof CiRunSchema>;

export const CiPrSchema = z.object({
  number: z.number().int().min(1),
  url: z.string().max(500),
  state: z.enum(['open', 'closed', 'merged']),
  title: z.string().max(GIT_OPS_LIMITS.titleMaxChars),
  draft: z.boolean(),
});
export type CiPr = z.infer<typeof CiPrSchema>;

export const CiStatusResultSchema = z.object({
  branch: BranchNameSchema,
  state: CiStateSchema,
  pr: CiPrSchema.nullable(),
  checks: z.array(CiCheckSchema).max(GIT_OPS_LIMITS.maxChecks),
  /** Eng so'nggi workflow run (`gh run list --branch`); PR yo'q bo'lsa asosiy ma'lumot shu. */
  run: CiRunSchema.nullable(),
});
export type CiStatusResult = z.infer<typeof CiStatusResultSchema>;

// --- commit -> vazifa bog'lash (sof) ----------------------------------------------------------

const TASK_ID = String.raw`[0-9]{1,6}(?:\.[0-9]{1,6}){0,4}[A-Za-z]?`;
/** `#task:1.4` (matn boshi yoki bo'shliq/tinish belgisidan keyin). */
const EXPLICIT_RE = new RegExp(String.raw`(?:^|[\s(\[{,;"'])#task:(${TASK_ID})(?![A-Za-z0-9]|\.[0-9])`, 'gi');
/** `[1.4]` yoki `[1.4] Matn` (kvadrat qavs ichida faqat id). */
const BRACKET_RE = new RegExp(String.raw`\[(${TASK_ID})\](?!\()`, 'g');

export const COMMIT_TASK_SOURCES = ['subject', 'branch'] as const;
export type CommitTaskSource = (typeof COMMIT_TASK_SOURCES)[number];

export interface CommitTaskRef {
  taskKey: string;
  /** `subject` = sarlavhada `#task:<id>` / `[<id>]`; `branch` = branch nomidan TAXMIN. */
  source: CommitTaskSource;
  /** `[id]` shakli (yolg'on ijobiy ehtimoli yuqori): chaqiruvchi id vazifalar ro'yxatida bor-yo'qligini tekshiradi. */
  bracket: boolean;
}

/**
 * Commit sarlavhasidan vazifa id'lari. `#task:<id>` aniq marker; `[<id>]` kvadrat qavs (loyihada shunday id bor bo'lsa
 * chaqiruvchi tasdiqlaydi). Takrorlar olib tashlanadi, tartib saqlanadi. Sarlavha 2000 belgigacha skanerlanadi.
 */
export function parseCommitTaskRefs(subject: string): CommitTaskRef[] {
  const text = subject.length > 2000 ? subject.slice(0, 2000) : subject;
  const out: CommitTaskRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(EXPLICIT_RE)) {
    const id = m[1]!.toLowerCase();
    if (id.length > 32 || seen.has(id)) continue;
    seen.add(id);
    out.push({ taskKey: id, source: 'subject', bracket: false });
  }
  for (const m of text.matchAll(BRACKET_RE)) {
    const id = m[1]!.toLowerCase();
    if (id.length > 32 || seen.has(id)) continue;
    seen.add(id);
    out.push({ taskKey: id, source: 'subject', bracket: true });
  }
  return out;
}

export interface CommitInput {
  sha: string;
  subject: string;
}

export interface CommitLink {
  sha: string;
  taskKey: string;
  source: CommitTaskSource;
}

/**
 * Snapshot commitlarini vazifalarga bog'laydi.
 *  - `[id]` faqat `knownKeys` ichida bo'lsa; `#task:<id>` har doim;
 *  - aniq ishora yo'q commit `branchTaskKey` (snapshot branch nomidan) ga bog'lanadi, FAQAT `freshShas` ichida bo'lsa
 *    (oldingi snapshot'da ko'rinmagan = shu branch'da yangi yozilgan commit). Birinchi snapshot'da `freshShas` bo'sh.
 * Natija takrorsiz.
 */
export function linkCommitsToTasks(
  commits: readonly CommitInput[],
  opts: { knownKeys: ReadonlySet<string>; branchTaskKey: string | null; freshShas: ReadonlySet<string> },
): CommitLink[] {
  const links: CommitLink[] = [];
  const seen = new Set<string>();
  const push = (sha: string, taskKey: string, source: CommitTaskSource): void => {
    const k = `${sha}|${taskKey}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ sha, taskKey, source });
  };
  for (const c of commits) {
    const refs = parseCommitTaskRefs(c.subject).filter((r) => !r.bracket || opts.knownKeys.has(r.taskKey));
    for (const r of refs) push(c.sha, r.taskKey, 'subject');
    if (refs.length === 0 && opts.branchTaskKey && opts.knownKeys.has(opts.branchTaskKey) && opts.freshShas.has(c.sha)) push(c.sha, opts.branchTaskKey, 'branch');
  }
  return links;
}

// --- REST (markaz <-> klient) -----------------------------------------------------------------

/** `POST /v1/projects/:id/diff` tanasi. */
export const ProjectDiffBodySchema = z.object({ base: DiffBaseSchema.optional(), statOnly: z.boolean().optional() }).strict();
export type ProjectDiffBody = z.infer<typeof ProjectDiffBodySchema>;

export const DiffResponseSchema = z.object({
  projectId: z.uuid(),
  sessionId: z.uuid().nullable(),
  commandId: z.uuid(),
  /** Sessiya diff'i uchun baza qayerdan olingani: `session_start` (SessionStart'da saqlangan HEAD) | `snapshot` (taxminiy) | `head`. */
  baseSource: z.enum(['session_start', 'snapshot', 'head', 'explicit']),
  diff: DiffResultSchema,
});
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

/** `POST /v1/projects/:id/pr` tanasi. */
export const OpenPrBodySchema = OpenPrFieldsSchema.strict();
export type OpenPrBody = z.infer<typeof OpenPrBodySchema>;

/** `POST /v1/projects/:id/ci/refresh` tanasi. */
export const CiRefreshBodySchema = z.object({ branch: BranchNameSchema.optional() }).strict();
export type CiRefreshBody = z.infer<typeof CiRefreshBodySchema>;

export const ProjectPrDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  branch: z.string(),
  base: z.string(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed', 'merged']),
  openedVia: z.string(),
  createdAt: z.string(),
});
export type ProjectPrDto = z.infer<typeof ProjectPrDtoSchema>;

export const ProjectCiDtoSchema = z.object({
  branch: z.string(),
  state: CiStateSchema,
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  checks: z.array(CiCheckSchema),
  run: CiRunSchema.nullable(),
  checkedAt: z.string(),
});
export type ProjectCiDto = z.infer<typeof ProjectCiDtoSchema>;

export const TaskCommitDtoSchema = z.object({
  sha: z.string(),
  taskKey: z.string(),
  source: z.enum(COMMIT_TASK_SOURCES),
  subject: z.string(),
  author: z.string(),
  ts: z.string(),
});
export type TaskCommitDto = z.infer<typeof TaskCommitDtoSchema>;

/** `GET /v1/projects/:id/git`: CI holati, PR'lar va vazifaga bog'langan commitlar. */
export const ProjectGitResponseSchema = z.object({
  projectId: z.uuid(),
  ci: z.array(ProjectCiDtoSchema),
  prs: z.array(ProjectPrDtoSchema),
  taskCommits: z.array(TaskCommitDtoSchema),
});
export type ProjectGitResponse = z.infer<typeof ProjectGitResponseSchema>;

// --- PR sarlavhasi/tanasi default'lari (sof; dashboard va Telegram bir xil) ---------------------

export interface PrDefaultsInput {
  branch: string | null;
  taskKey?: string | null | undefined;
  taskTitle?: string | null | undefined;
  sessionName?: string | null | undefined;
  /** Eng yangi commit sarlavhalari (yangidan eskiga). */
  commitSubjects: readonly string[];
  /** Ixtiyoriy tana shabloni (matn); berilmasa o'rnatilgan shablon. `{{task}}` o'rniga vazifa qatori qo'yiladi. */
  bodyTemplate?: string | null | undefined;
}

// eslint-disable-next-line no-control-regex
const CTRL_ALL_RE = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CTRL_BODY_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const DEFAULT_PR_BODY_TEMPLATE = '## Vazifa\n{{task}}\n\n## O\'zgarishlar\n{{commits}}\n\n---\nCommander orqali ochildi.';

/** Sarlavha: vazifa bo'lsa `[id] sarlavha`; aks holda sessiya nomi, oxirgi commit yoki branch. Bitta qator, <= 256. */
export function buildPrDefaults(i: PrDefaultsInput): { title: string; body: string } {
  const one = (s: string): string => s.replace(CTRL_ALL_RE, ' ').replace(/\s+/g, ' ').trim();
  const taskTitle = i.taskTitle ? one(i.taskTitle) : '';
  const raw = i.taskKey && taskTitle ? `[${i.taskKey}] ${taskTitle}` : one(i.sessionName ?? '') || one(i.commitSubjects[0] ?? '') || one(i.branch ?? '') || 'Yangi o\'zgarishlar';
  const title = raw.slice(0, GIT_OPS_LIMITS.titleMaxChars);
  const taskLine = i.taskKey ? `${i.taskKey}${taskTitle ? ` ${taskTitle}` : ''}` : '(vazifa belgilanmagan)';
  const subjects = i.commitSubjects.map(one).filter((s) => s.length > 0).slice(0, 10);
  const commits = subjects.length > 0 ? subjects.map((s) => `- ${s}`).join('\n') : '- (commitlar ro\'yxati mavjud emas)';
  const template = (i.bodyTemplate && i.bodyTemplate.trim().length > 0 ? i.bodyTemplate : DEFAULT_PR_BODY_TEMPLATE).replace(CTRL_BODY_RE, '');
  const withCommits = template.includes('{{commits}}') ? template.replaceAll('{{commits}}', commits) : `${template}\n\n${commits}`;
  const body = withCommits.replaceAll('{{task}}', taskLine).slice(0, GIT_OPS_LIMITS.bodyMaxChars);
  return { title, body };
}
