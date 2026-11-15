import type { EntityManager } from 'typeorm';
import { linkCommitsToTasks, taskKeyFromBranch } from '@commander/contracts';
import type { CommitLink, ProjectCommit } from '@commander/contracts';

/** Yangi (oldingi snapshot'larda ko'rinmagan) commitlar. Oldingi snapshot yo'q bo'lsa bo'sh (branch taxmini ishlamaydi). Sof. */
export function freshCommitShas(commits: readonly Pick<ProjectCommit, 'sha'>[], previous: ReadonlyArray<ReadonlyArray<Pick<ProjectCommit, 'sha'>>>): Set<string> {
  if (previous.length === 0) return new Set();
  const seen = new Set<string>();
  for (const list of previous) for (const c of list) seen.add(c.sha);
  return new Set(commits.filter((c) => !seen.has(c.sha)).map((c) => c.sha));
}

/** Snapshot commitlarini vazifalarga bog'laydi (sof qism): `[id]` faqat mavjud vazifa, branch taxmini faqat yangi commitlarga. */
export function computeTaskCommitLinks(args: {
  commits: readonly ProjectCommit[];
  branch: string | null | undefined;
  taskKeys: ReadonlySet<string>;
  previous: ReadonlyArray<ReadonlyArray<Pick<ProjectCommit, 'sha'>>>;
}): CommitLink[] {
  return linkCommitsToTasks(
    args.commits.map((c) => ({ sha: c.sha, subject: c.subject })),
    { knownKeys: args.taskKeys, branchTaskKey: taskKeyFromBranch(args.branch ?? null), freshShas: freshCommitShas(args.commits, args.previous) },
  );
}

/**
 * Snapshot ingest tranzaksiyasi ichida (`latest` snapshot): commit -> vazifa bog'lari `task_commits` ga yoziladi. Idempotent
 * (`PK (project_id, sha, task_key)`; `[id]` / `#task:` aniq bog' branch taxminidan ustun: `source` yangilanadi).
 * Oldingi snapshot'lar `excludeSnapshotId` dan tashqari barcha saqlangan tarix.
 */
export async function recordTaskCommits(
  m: EntityManager,
  args: { projectId: string; snapshotId: string; branch: string | null | undefined; commits: readonly ProjectCommit[]; taskKeys: readonly string[] },
): Promise<number> {
  if (args.commits.length === 0 || args.taskKeys.length === 0) return 0;
  const prev: Array<{ commits: ProjectCommit[] | null }> = await m.query(`SELECT commits FROM project_snapshots WHERE project_id = $1 AND id <> $2`, [args.projectId, args.snapshotId]);
  const links = computeTaskCommitLinks({
    commits: args.commits,
    branch: args.branch,
    taskKeys: new Set(args.taskKeys),
    previous: prev.map((r) => r.commits ?? []),
  });
  if (links.length === 0) return 0;
  const bySha = new Map(args.commits.map((c) => [c.sha, c]));
  await m.query(
    `INSERT INTO task_commits (project_id, sha, task_key, source, subject, author, committed_at)
     SELECT $1::uuid, l.sha, l.task_key, l.source, l.subject, l.author, to_timestamp(l.ts / 1000.0)
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[]) AS l(sha, task_key, source, subject, author, ts)
     ON CONFLICT (project_id, sha, task_key) DO UPDATE SET source = CASE WHEN EXCLUDED.source = 'subject' THEN 'subject' ELSE task_commits.source END`,
    [
      args.projectId,
      links.map((l) => l.sha),
      links.map((l) => l.taskKey),
      links.map((l) => l.source),
      links.map((l) => bySha.get(l.sha)!.subject),
      links.map((l) => bySha.get(l.sha)!.author),
      links.map((l) => bySha.get(l.sha)!.ts),
    ],
  );
  return links.length;
}
