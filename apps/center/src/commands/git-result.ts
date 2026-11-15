import type { EntityManager } from 'typeorm';
import { CiStatusResultSchema, DiffResultSchema, PrResultSchema } from '@commander/contracts';
import type { CommandResultData, DiffResult, GitCommandType } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import type { CiFailureNotice } from '../projects/git-notify.js';

/** `project.diff` natijasi: faqat xotirada (DB'ga yozilmaydi), qisqa muddat. */
export interface TransientDiff {
  diff: DiffResult;
  until: number;
}

export interface GitResultCtx {
  commandId: string;
  type: GitCommandType;
  projectId: string | null;
  result: CommandResultData | undefined;
}

export interface GitResultOutcome {
  /** `commands.result` ga yoziladigan qiymat (diff matni YO'Q). */
  result?: CommandResultData;
  error?: { code: string; message: string };
  notice?: CiFailureNotice;
}

const invalid = (message: string): GitResultOutcome => ({ error: { code: 'invalid_result', message } });
const TRANSIENT_TTL_MS = 2 * 60_000;

/**
 * Git buyruqlari natijalari (3.5), `handleResult` tranzaksiyasi ichida:
 *  - `project.diff`: sxema bo'yicha tekshiriladi, xotiraga qo'yiladi (`takeDiff`); DB'da faqat qisqa `detail`;
 *  - `project.open_pr`: `project_prs` ga yoziladi (sarlavha redakt qilingan);
 *  - `project.ci_status`: `project_ci_status` ga yoziladi; PR holati yangilanadi; Commander ochgan PR uchun YANGI muvaffaqiyatsiz
 *    run bo'lsa `notice` qaytadi (bir run uchun bir marta: `failed_notified_run_id`).
 */
export async function handleGitResult(m: EntityManager, ctx: GitResultCtx, transient: Map<string, TransientDiff>, now: number = Date.now()): Promise<GitResultOutcome> {
  if (!ctx.projectId) return invalid('The command has no project');
  if (ctx.type === 'project.diff') {
    const parsed = DiffResultSchema.safeParse(ctx.result?.diff);
    if (!parsed.success) return invalid('The agent returned an invalid diff');
    transient.set(ctx.commandId, { diff: parsed.data, until: now + TRANSIENT_TTL_MS });
    const d = parsed.data;
    return { result: { detail: `${d.filesTotal} files +${d.totalAdditions} -${d.totalDeletions}` } };
  }

  if (ctx.type === 'project.open_pr') {
    const parsed = PrResultSchema.safeParse(ctx.result?.pr);
    if (!parsed.success) return invalid('The agent returned an invalid PR result');
    const pr = parsed.data;
    const rows: Array<{ payload: { title?: string } | null; requested_by_device_id: string; kind: string | null }> = await m.query(
      `SELECT c.payload, c.requested_by_device_id, d.kind FROM commands c LEFT JOIN devices d ON d.id = c.requested_by_device_id WHERE c.id = $1`,
      [ctx.commandId],
    );
    const row = rows[0];
    await m.query(
      `INSERT INTO project_prs (project_id, number, url, title, branch, base, draft, state, opened_via, opened_by_device_id, command_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)
       ON CONFLICT (project_id, number) DO UPDATE
         SET url = EXCLUDED.url, branch = EXCLUDED.branch, base = EXCLUDED.base, state = 'open', updated_at = now()`,
      [ctx.projectId, pr.number, pr.url, redactAndCap(row?.payload?.title ?? '', 256), pr.branch, pr.base, pr.draft, row?.kind ?? 'unknown', row?.requested_by_device_id ?? null, ctx.commandId],
    );
    return { result: { detail: `PR #${pr.number}${pr.existing ? ' (existing)' : ''}`, pr } };
  }

  // project.ci_status
  const parsed = CiStatusResultSchema.safeParse(ctx.result?.ci);
  if (!parsed.success) return invalid('The agent returned an invalid CI status');
  const ci = parsed.data;
  const runKey = ci.run?.id ?? (ci.pr ? `pr${ci.pr.number}` : null);
  await m.query(
    `INSERT INTO project_ci_status (project_id, branch, state, pr_number, pr_url, checks, run, run_id, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now())
     ON CONFLICT (project_id, branch) DO UPDATE
       SET state = EXCLUDED.state, pr_number = EXCLUDED.pr_number, pr_url = EXCLUDED.pr_url, checks = EXCLUDED.checks,
           run = EXCLUDED.run, run_id = EXCLUDED.run_id, checked_at = now()`,
    [ctx.projectId, ci.branch, ci.state, ci.pr?.number ?? null, ci.pr?.url ?? null, JSON.stringify(ci.checks), ci.run ? JSON.stringify(ci.run) : null, ci.run?.id ?? null],
  );
  if (ci.pr && ci.pr.state !== 'open') {
    await m.query(`UPDATE project_prs SET state = $3, updated_at = now() WHERE project_id = $1 AND number = $2 AND state <> $3`, [ctx.projectId, ci.pr.number, ci.pr.state]);
  }
  const out: GitResultOutcome = { result: { detail: ci.state } };
  if (ci.state === 'failure' && runKey) {
    const open: unknown[] = await m.query(`SELECT 1 FROM project_prs WHERE project_id = $1 AND branch = $2 AND state = 'open' LIMIT 1`, [ctx.projectId, ci.branch]);
    if (open.length > 0) {
      // CTE: TypeORM `UPDATE ... RETURNING` natijasini `[rows, count]` shaklida qaytaradi; shu sabab sanash alohida
      const claimed: Array<{ n: number }> = await m.query(
        `WITH u AS (UPDATE project_ci_status SET failed_notified_run_id = $3 WHERE project_id = $1 AND branch = $2 AND failed_notified_run_id IS DISTINCT FROM $3 RETURNING 1)
         SELECT count(*)::int AS n FROM u`,
        [ctx.projectId, ci.branch, runKey],
      );
      if ((claimed[0]?.n ?? 0) > 0) {
        out.notice = {
          projectId: ctx.projectId,
          branch: ci.branch,
          prNumber: ci.pr?.number ?? null,
          prUrl: ci.pr?.url ?? null,
          runName: ci.run?.name ?? '',
          runUrl: ci.run?.url ?? null,
          failing: ci.checks.filter((c) => c.bucket === 'fail').map((c) => c.name).slice(0, 5),
        };
      }
    }
  }
  return out;
}
