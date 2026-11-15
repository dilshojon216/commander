import { z } from 'zod';
import { ProjectDtoSchema, TokenTotalsSchema } from './api.js';
import { EpochMsSchema, envelopeMessage } from './envelope.js';
import { PROJECT_TASK_STATUSES } from './tasks-md.js';
import { PROJECT_OPS_LIMITS } from './project-ops.js';
import { SnapshotPartSchema, PART_LIMITS } from './project-parts.js';
import { TaskBoardColumnSchema, TaskColumnSourceSchema, TaskPlanSchema, TaskScoreRefSchema } from './project-work.js';

/**
 * Loyiha snapshot'i va vazifa atributsiyasi kontrakti (task 2.1, 2.2, 2.8, 2.9).
 *  - agentd -> center: `agent.project_snapshot` (ack'li, outbox);
 *  - center REST: `GET /v1/projects/:id`, `/v1/projects/:id/tasks`, `/v1/projects/:id/commits`, `GET /v1/tasks`;
 *  - center -> klient: `project.updated` (`/ws/client`, `projects` kanali).
 * Sirlar: md matnlari agentd'da `redact()` dan o'tadi (CLAUDE.md qoida 5); commit mualliflarida FAQAT ism (email yo'q);
 * remote URL'da login/token yo'q (`repoKey`).
 */

const IsoDate = z.string();
const UuidOrSlug = z.string().min(1).max(128);

export const PROJECT_SNAPSHOT_LIMITS = {
  maxCommits: 30,
  maxSubjectLen: 200,
  maxAuthorLen: 100,
  /** Har bir md fayl uchun xom bayt chegarasi (agentd o'qiganda). */
  maxMdBytes: 64 * 1024,
  /** Redaktdan keyingi belgi chegarasi (redakt matnni biroz uzaytirishi mumkin). */
  maxMdChars: 80_000,
  /** Bitta WS xabarining (JSON) xavfsiz hajmi: `AGENT_LIMITS.maxMessageBytes` (256 KB) dan past. */
  maxPayloadBytes: 200 * 1024,
} as const;

/** `github.com/org/repo`: kichik harf, login/token/port/protokolsiz. */
export const RepoKeySchema = z
  .string()
  .min(3)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9._~+-]+)+$/);

export const TASKS_MD_PATHS = ['docs/TASKS.md', 'TASKS.md'] as const;

export const ProjectCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  subject: z.string().max(PROJECT_SNAPSHOT_LIMITS.maxSubjectLen),
  /** Faqat ism (email YO'Q). */
  author: z.string().max(PROJECT_SNAPSHOT_LIMITS.maxAuthorLen),
  /** Commit vaqti, epoch ms. */
  ts: EpochMsSchema,
});
export type ProjectCommit = z.infer<typeof ProjectCommitSchema>;

const Md = z.string().max(PROJECT_SNAPSHOT_LIMITS.maxMdChars);

export const ProjectSnapshotPayloadSchema = z.object({
  /** Loyiha ildizi (`ProjectRootResolver` natijasi: hodisa/usage bilan bir xil). */
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
  kind: z.enum(['git', 'dir']),
  repoKey: RepoKeySchema.nullish(),
  branch: z.string().min(1).max(255).nullish(),
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullish(),
  dirty: z.boolean().nullish(),
  dirtyCount: z.number().int().min(0).max(10_000_000).nullish(),
  ahead: z.number().int().min(0).max(10_000_000).nullish(),
  behind: z.number().int().min(0).max(10_000_000).nullish(),
  commits: z.array(ProjectCommitSchema).max(PROJECT_SNAPSHOT_LIMITS.maxCommits),
  todosMd: Md.nullish(),
  changelogMd: Md.nullish(),
  tasksMd: Md.nullish(),
  /** `tasksMd` qaysi fayldan olingan. */
  tasksPath: z.enum(TASKS_MD_PATHS).nullish(),
  /** `*.md` fayllar ro'yxati (ildizga nisbatan, `/`, chuqurlik <= 3, node_modules/.git'siz, <= 200). Eski agentd yubormaydi. */
  mdFiles: z.array(z.string().min(1).max(PROJECT_OPS_LIMITS.mdPathMaxChars)).max(PROJECT_OPS_LIMITS.maxMdFiles).nullish(),
  /**
   * Loyiha qismlari (6.15): papka bo'yicha reja fayllari, agentd'da parse qilingan (katta fayllar: 1.5 MB gacha) bandlar.
   * Eski agentd yubormaydi (`null`/yo'q): markaz mavjud qism vazifalariga tegmaydi. `[]` = qismlar yo'q (eskilari o'chadi).
   */
  parts: z.array(SnapshotPartSchema).max(PART_LIMITS.maxParts).nullish(),
  /** `tasksMd` xom fayl baytlari sha256'i (redaktdan OLDIN): `project.append_tasks` optimistik konkurentligi uchun. */
  tasksMdHash: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
  /** Mazmun xeshi (sha256 hex): agentd faqat o'zgarganda yuboradi; markaz `UNIQUE(project_id, hash)` bilan dedup qiladi. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Snapshot olingan vaqt (epoch ms; agentd soati). */
  takenAt: EpochMsSchema,
});
export type ProjectSnapshotPayload = z.infer<typeof ProjectSnapshotPayloadSchema>;
export const AgentProjectSnapshotMessageSchema = envelopeMessage('agent.project_snapshot', ProjectSnapshotPayloadSchema);
export type AgentProjectSnapshotMessage = z.infer<typeof AgentProjectSnapshotMessageSchema>;

// --- remote URL -> repo_key ------------------------------------------------------------------

/**
 * Git remote URL -> `repo_key` (`github.com/org/repo`). Login/parol/token HECH QACHON kirmaydi:
 *  - `https://user:token@github.com/org/repo.git` -> `github.com/org/repo`;
 *  - `git@github.com:org/repo.git` (scp) va `ssh://git@host:2222/org/repo` -> `host/org/repo`;
 *  - query/hash (`?token=..`) tashlanadi; host va yo'l kichik harf; `.git` va oxirgi `/` olinadi.
 * Lokal yo'l (`/srv/x.git`, `file://`, `../x`) yoki tanib bo'lmaydigan shakl -> `null`.
 */
export function normalizeRepoKey(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s || s.length > 2000 || /[\s\u0000-\u001f]/.test(s)) return null;

  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (proto === 'file') return null;
    s = scheme[2]!;
    const slash = s.indexOf('/');
    if (slash === -1) return null;
    let authority = s.slice(0, slash);
    path = s.slice(slash + 1);
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1); // userinfo (login:parol/token) tashlanadi
    host = authority.replace(/:\d*$/, ''); // port tashlanadi
  } else {
    // scp-uslub: [user@]host:org/repo (":" dan keyin "/" yo'q yoki yo'l nisbiy)
    const m = /^(?:[^@/:]+@)?([^@/:]+):(?!\/\/)(.+)$/.exec(s);
    if (!m) return null;
    host = m[1]!;
    path = m[2]!;
    if (/^[a-zA-Z]$/.test(host)) return null; // Windows disk harfi (`C:\x`)
  }
  path = path.split(/[?#]/)[0]!.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  host = host.toLowerCase();
  if (!host || !path || !host.includes('.') || host.startsWith('.')) return null;
  const key = `${host}/${path}`.toLowerCase();
  const parsed = RepoKeySchema.safeParse(key);
  return parsed.success ? parsed.data : null;
}

// --- REST DTO'lar ----------------------------------------------------------------------------

export const ProjectTaskStatusSchema = z.enum(PROJECT_TASK_STATUSES);

export const TasksSummarySchema = z.object({
  todo: z.number().int(),
  doing: z.number().int(),
  done: z.number().int(),
  unknown: z.number().int(),
  total: z.number().int(),
});

export const ProjectGitInfoSchema = z.object({
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirty: z.boolean().nullable(),
  dirtyCount: z.number().int().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  /** Snapshot olingan vaqt (ISO). */
  takenAt: IsoDate,
});
export type ProjectGitInfo = z.infer<typeof ProjectGitInfoSchema>;

export const ProjectCommitDtoSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  ts: IsoDate,
});
export type ProjectCommitDto = z.infer<typeof ProjectCommitDtoSchema>;

/** `tasksMd` matni detail'da qaytmaydi (vazifalar `/tasks` da): faqat metadata. */
export const TasksMdMetaSchema = z.object({
  path: z.string(),
  bytes: z.number().int(),
  summary: TasksSummarySchema,
  updatedAt: IsoDate,
});
export type TasksMdMeta = z.infer<typeof TasksMdMetaSchema>;

export const ProjectDetailDtoSchema = z.object({
  project: ProjectDtoSchema,
  /** Hali snapshot kelmagan bo'lsa `null` (agentd ulanmagan yoki loyiha faqat usage'dan ma'lum). */
  git: ProjectGitInfoSchema.nullable(),
  commits: z.array(ProjectCommitDtoSchema),
  todosMd: z.string().nullable(),
  changelogMd: z.string().nullable(),
  tasksMd: TasksMdMetaSchema.nullable(),
});
export type ProjectDetailDto = z.infer<typeof ProjectDetailDtoSchema>;

/** 6.16: `POST /v1/projects/:id/archive|unarchive` javobi. `archivedAt` = arxivdan keyin vaqt, qaytarilgandan keyin `null`. */
export const ProjectArchiveResponseSchema = z.object({ id: z.uuid(), archivedAt: z.string().nullable() });
export type ProjectArchiveResponse = z.infer<typeof ProjectArchiveResponseSchema>;

export const ListProjectCommitsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(PROJECT_SNAPSHOT_LIMITS.maxCommits).default(30) }).strict();
export type ListProjectCommitsQuery = z.infer<typeof ListProjectCommitsQuerySchema>;
export const ListProjectCommitsResponseSchema = z.object({
  items: z.array(ProjectCommitDtoSchema),
  /** Snapshot vaqti (ISO) yoki `null`. */
  takenAt: IsoDate.nullable(),
});
export type ListProjectCommitsResponse = z.infer<typeof ListProjectCommitsResponseSchema>;

/** Vazifa bo'yicha statistika (2.9). Tokenlar: sessiya + span oynasidagi `token_usage` qatorlari. */
export const TaskStatsSchema = z.object({
  tokens: TokenTotalsSchema,
  /** Shu vazifada ishlagan turli sessiyalar soni. */
  sessions: z.number().int(),
  /** `working` holati davomiyligi yig'indisi (span oynalari bilan kesilgan), soniya. */
  activeSeconds: z.number().int(),
  firstActivityAt: IsoDate.nullable(),
  lastActivityAt: IsoDate.nullable(),
  /** `explicit` = `/task` yoki `#task:`; `branch` = TAXMIN (git branch nomidan); `mixed` = ikkalasi; `null` = span yo'q. */
  source: z.enum(['explicit', 'branch', 'mixed']).nullable(),
});
export type TaskStats = z.infer<typeof TaskStatsSchema>;

export const ProjectTaskDtoSchema = z.object({
  key: z.string(),
  /** Qism (6.15): `''` = ildiz; aks holda ildizga nisbiy papka yo'li. `key` qism uchun `<slug>:<id>`. */
  part: z.string(),
  title: z.string(),
  phase: z.string().nullable(),
  status: ProjectTaskStatusSchema,
  rawStatus: z.string().nullable(),
  order: z.number().int(),
  size: z.string().nullable(),
  stats: TaskStatsSchema,
  /** Doskadagi ustun (2.15): TASKS.md `done` har doim ustun; aks holda qo'lda surilgan; aks holda hisoblangan. */
  column: TaskBoardColumnSchema,
  columnSource: TaskColumnSourceSchema,
  /** Reja (TASKS.md hajmidan) va haqiqiy faol vaqt. */
  plan: TaskPlanSchema,
  /** Eng so'nggi "baho" (kunlik Claude xulosasidan) yoki `null`. */
  score: TaskScoreRefSchema.nullable(),
});
export type ProjectTaskDto = z.infer<typeof ProjectTaskDtoSchema>;

/** Hech qanday vazifaga bog'lanmagan tokenlar: UI'da "vazifasiz". */
export const UNATTRIBUTED_TASK_LABEL = 'vazifasiz';
export const UnattributedTasksSchema = z.object({ label: z.literal(UNATTRIBUTED_TASK_LABEL), tokens: TokenTotalsSchema, sessions: z.number().int() });
export type UnattributedTasks = z.infer<typeof UnattributedTasksSchema>;

export const ProjectTasksResponseSchema = z.object({
  projectId: z.uuid(),
  tasks: z.array(ProjectTaskDtoSchema),
  /** Faoliyat bor, lekin TASKS.md'da yo'q vazifa id'lari (masalan marker xato yoki fayl o'zgargan). */
  other: z.array(z.object({ key: z.string(), stats: TaskStatsSchema })),
  unattributed: UnattributedTasksSchema,
  summary: TasksSummarySchema,
  tasksMd: TasksMdMetaSchema.nullable(),
  /** Token statistikasi xom `token_usage`dan (retention 30 kun): undan eski foydalanish kirmaydi. */
  tokensCoveredFrom: IsoDate,
});
export type ProjectTasksResponse = z.infer<typeof ProjectTasksResponseSchema>;

export const ListTasksQuerySchema = z
  .object({
    /** Loyiha uuid yoki aniq nomi. */
    project: UuidOrSlug.optional(),
    /** `repo_key`: bir repo barcha mashinalarda jamlanadi. */
    repo: z.string().min(3).max(300).optional(),
    machine: UuidOrSlug.optional(),
    /** Faqat shu oraliqdagi tokenlar/faollik (ISO-8601). */
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export const TaskSummaryItemSchema = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  taskKey: z.string(),
  /** TASKS.md'dan (bo'lsa). */
  title: z.string().nullable(),
  status: ProjectTaskStatusSchema.nullable(),
  stats: TaskStatsSchema,
});
export type TaskSummaryItem = z.infer<typeof TaskSummaryItemSchema>;

export const ListTasksResponseSchema = z.object({
  items: z.array(TaskSummaryItemSchema),
  unattributed: UnattributedTasksSchema,
  tokensCoveredFrom: IsoDate,
});
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

// --- /ws/client push -------------------------------------------------------------------------

/** Yengil push: to'liq md yuborilmaydi (klient `GET /v1/projects/:id` ni qayta oladi). */
export const ProjectUpdatedPayloadSchema = z.object({
  project: z.object({
    id: z.uuid(),
    machineId: z.uuid(),
    name: z.string(),
    path: z.string(),
    repoKey: z.string().nullable(),
    branch: z.string().nullable(),
    headSha: z.string().nullable(),
    dirty: z.boolean().nullable(),
    takenAt: IsoDate,
    tasks: TasksSummarySchema.nullable(),
  }),
});
export type ProjectUpdatedPayload = z.infer<typeof ProjectUpdatedPayloadSchema>;
export const ProjectUpdatedMessageSchema = envelopeMessage('project.updated', ProjectUpdatedPayloadSchema);
