import { createHash } from 'node:crypto';
import { basename } from 'node:path/posix';
import { PART_LIMITS, PROJECT_SNAPSHOT_LIMITS, ProjectSnapshotPayloadSchema, type ProjectSnapshotPayload } from '@commander/contracts';
import { collectGitInfo, isGitRoot, type GitInfo, type GitRunner } from './git-info.js';
import { hashTasksFile, listProjectMd, readProjectMd, readTasksMd } from './project-files.js';
import { collectParts, fitParts } from './project-parts.js';

/** Snapshot mazmuni xeshi (sha256 hex): `takenAt` kirmaydi, shuning uchun faqat haqiqiy o'zgarishda yangi. */
export function snapshotHash(p: Omit<ProjectSnapshotPayload, 'hash' | 'takenAt'>): string {
  const canonical = JSON.stringify([
    p.path,
    p.name,
    p.kind,
    p.repoKey ?? null,
    p.branch ?? null,
    p.headSha ?? null,
    p.dirtyCount ?? null,
    p.ahead ?? null,
    p.behind ?? null,
    p.commits.map((c) => [c.sha, c.subject, c.author, c.ts]),
    p.todosMd ?? null,
    p.changelogMd ?? null,
    p.tasksMd ?? null,
    p.tasksPath ?? null,
    p.mdFiles ?? null,
    // 6.15: qismlar (band tarkibi o'zgarsa yangi xesh; `parts` yo'q eski snapshotlar uchun `null`)
    (p.parts ?? null)?.map((x) => [x.path, x.planFiles, x.counts, x.itemsTruncated, x.readTruncated, x.items.map((i) => [i.key, i.title, i.phase ?? null, i.status, i.doneOn ?? null])]) ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * WS xabari hajmiga sig'dirish: umumiy JSON `maxPayloadBytes` dan oshsa, avval CHANGELOG, so'ng TODOS, oxirida TASKS
 * kichraytiriladi (eng kam muhimidan). JSON'dagi `\n`/`"` qochirishlari xom baytdan ko'p joy olishi mumkin.
 */
export function fitPayload<T extends { changelogMd?: string | null | undefined; todosMd?: string | null | undefined; tasksMd?: string | null | undefined }>(
  p: T,
  maxBytes: number = PROJECT_SNAPSHOT_LIMITS.maxPayloadBytes,
): T {
  const out = { ...p };
  for (const key of ['changelogMd', 'todosMd', 'tasksMd'] as const) {
    let size = jsonBytes(out);
    while (size > maxBytes) {
      const cur = out[key];
      if (!cur) break;
      const over = size - maxBytes;
      // Kesish: ortiqcha bayt + zaxira; matn uzunligi kamida 1/2 ga qisqarishi mumkin
      const next = cur.length > over + 1024 ? cur.slice(0, cur.length - over - 1024) : '';
      out[key] = next ? next.replace(/�+$/, '') : null;
      size = jsonBytes(out);
    }
  }
  return out;
}

export interface BuildSnapshotOptions {
  git?: GitRunner;
  /** Sinov uchun: qismlarni topishda maxfiy papkalar. */
  sensitive?: readonly string[];
  skipStatus?: boolean;
  now?: () => number;
}

export interface BuiltSnapshot {
  payload: ProjectSnapshotPayload;
  /** `git status` taymaut berdi (chaqiruvchi backoff qo'llaydi). */
  statusTimedOut: boolean;
}

/** Bitta loyiha ildizi uchun snapshot (ildizdan tashqariga chiqmaydi). Yaroqsiz bo'lsa `null` (kontraktga mos kelmadi). */
export async function buildSnapshot(root: string, opts: BuildSnapshotOptions = {}): Promise<BuiltSnapshot | null> {
  const isGit = isGitRoot(root);
  const gitInfo: GitInfo | null = isGit ? await collectGitInfo(root, { ...(opts.git ? { git: opts.git } : {}), ...(opts.skipStatus ? { skipStatus: true } : {}) }) : null;
  const todosMd = readProjectMd(root, 'TODOS.md');
  const changelogMd = readProjectMd(root, 'CHANGELOG.md');
  const tasks = readTasksMd(root);

  // Qismlar (6.15): ildiz md matnlari ustun, qismlar qolgan joyga sig'adi (progress sanoqlari saqlanadi)
  const rawParts = collectParts(root, opts.sensitive ? { sensitive: opts.sensitive } : {});
  const rootBytes = jsonBytes({ todosMd, changelogMd, tasksMd: tasks?.content ?? null, mdFiles: null });
  const partsBudget = Math.min(PART_LIMITS.maxPartsBytes, Math.max(32 * 1024, PROJECT_SNAPSHOT_LIMITS.maxPayloadBytes - 16 * 1024 - rootBytes));
  const parts = fitParts(rawParts, partsBudget);

  const draft = fitPayload({
    path: root,
    name: basename(root.replace(/\/+$/, '')) || root,
    kind: isGit ? ('git' as const) : ('dir' as const),
    repoKey: gitInfo?.repoKey ?? null,
    branch: gitInfo?.branch ?? null,
    headSha: gitInfo?.headSha ?? null,
    dirty: gitInfo?.dirtyCount != null ? gitInfo.dirtyCount > 0 : null,
    dirtyCount: gitInfo?.dirtyCount ?? null,
    ahead: gitInfo?.ahead ?? null,
    behind: gitInfo?.behind ?? null,
    commits: gitInfo?.commits ?? [],
    todosMd,
    changelogMd,
    tasksMd: tasks?.content ?? null,
    tasksPath: tasks?.path ?? null,
    mdFiles: listProjectMd(root),
    parts,
    tasksMdHash: tasks ? hashTasksFile(root, tasks.path) : null,
  });
  const takenAt = (opts.now ?? Date.now)();
  const candidate = { ...draft, hash: snapshotHash(draft), takenAt };
  const parsed = ProjectSnapshotPayloadSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return { payload: parsed.data, statusTimedOut: gitInfo?.statusTimedOut ?? false };
}
