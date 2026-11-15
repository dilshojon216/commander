import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ProjectSnapshotPayload } from '@commander/contracts';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { ProjectPartsService } from './project-parts.service.js';
import { diffTaskGroups, partTaskRows } from './part-logic.js';
import { recordTaskCommits } from './task-commits.js';
import { SNAPSHOT_HISTORY_KEEP, SNAPSHOT_MD_KEEP, clampTakenAt, sanitizeMd, tasksFromMd } from './snapshot-logic.js';

export interface SnapshotResult {
  projectId: string;
  /** Yangi (yoki qayta tiklangan) holat; `false` = allaqachon bor (qayta yuborish). */
  inserted: boolean;
  /** Bu snapshot loyihaning eng yangisi bo'ldi (tasks/projects yangilandi). */
  latest: boolean;
}

/**
 * `agent.project_snapshot` -> `projects` + `project_snapshots` + `project_tasks` (task 2.1/2.2/2.8). Bitta tranzaksiya;
 * ack FAQAT COMMIT'dan keyin. Idempotent: `UNIQUE(project_id, hash)`. A -> B -> A (mazmun eski holatga qaytsa) ham
 * to'g'ri: shu xeshli qator `taken_at` yangilanib eng yangiga aylanadi.
 */
@Injectable()
export class ProjectSnapshotService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bus: RealtimeBus,
    private readonly parts: ProjectPartsService,
  ) {}

  async ingest(machineId: string, p: ProjectSnapshotPayload, now: Date = new Date()): Promise<SnapshotResult> {
    const md = sanitizeMd(p);
    const takenAt = clampTakenAt(p.takenAt, now);
    const tasks = tasksFromMd(md.tasksMd);
    // 6.15: qismlar (eski agentd yubormaydi: `null` = qism vazifalariga tegilmaydi)
    const partRows = p.parts ? partTaskRows(p.parts) : null;

    const result = await this.dataSource.transaction(async (m): Promise<SnapshotResult> => {
      const idRows: Array<{ id: string }> = await m.query(`SELECT upsert_project($1::uuid, $2, $3, $4, $5) AS id`, [machineId, p.path, p.repoKey ?? null, p.name, p.kind]);
      const projectId = idRows[0]!.id;
      // `upsert_project` repo_key bo'lmasa kind'ni o'zgartirmaydi: git repo remote'siz ham `git` bo'lishi kerak
      if (p.kind === 'git') await m.query(`UPDATE projects SET kind = 'git' WHERE id = $1 AND kind <> 'git'`, [projectId]);

      const rows: Array<{ id: string; inserted: boolean }> = await m.query(
        `INSERT INTO project_snapshots
           (project_id, taken_at, hash, branch, head_sha, ahead, behind, dirty_count, commits, todos_md, changelog_md, tasks_md, tasks_path, md_files, tasks_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15)
         ON CONFLICT (project_id, hash) DO UPDATE SET
           taken_at = GREATEST(project_snapshots.taken_at, EXCLUDED.taken_at),
           todos_md = EXCLUDED.todos_md, changelog_md = EXCLUDED.changelog_md, tasks_md = EXCLUDED.tasks_md, tasks_path = EXCLUDED.tasks_path,
           md_files = EXCLUDED.md_files, tasks_hash = EXCLUDED.tasks_hash
         RETURNING id, (xmax = 0) AS inserted`,
        [
          projectId, takenAt, p.hash, p.branch ?? null, p.headSha ?? null, p.ahead ?? null, p.behind ?? null, p.dirtyCount ?? null, JSON.stringify(p.commits),
          md.todosMd, md.changelogMd, md.tasksMd, p.tasksPath ?? null, p.mdFiles ? JSON.stringify(p.mdFiles) : null, p.tasksMdHash ?? null,
        ],
      );
      const snap = rows[0]!;

      const newest: Array<{ id: string }> = await m.query(`SELECT id FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC LIMIT 1`, [projectId]);
      const latest = newest[0]?.id === snap.id;

      if (latest) {
        await m.query(`UPDATE projects SET last_snapshot_at = $2 WHERE id = $1`, [projectId, takenAt]);
        // task_events: oldingi va yangi holat farqi (birinchi snapshot'da yozilmaydi), vazifalar almashtirilishidan OLDIN
        const prevRows: Array<{ task_key: string; status: string; part: string }> = await m.query(`SELECT task_key, status, part FROM project_tasks WHERE project_id = $1`, [projectId]);
        const changes = diffTaskGroups(prevRows, tasks, partRows);
        if (changes.length > 0) {
          await m.query(
            `INSERT INTO task_events (project_id, task_key, from_status, to_status, source, ts)
             SELECT $1::uuid, c.task_key, c.from_status, c.to_status, 'tasks_md', $5::timestamptz
               FROM unnest($2::text[], $3::text[], $4::text[]) AS c(task_key, from_status, to_status)`,
            [projectId, changes.map((c) => c.taskKey), changes.map((c) => c.from), changes.map((c) => c.to), takenAt],
          );
        }
        // Ildiz vazifalari har doim almashtiriladi; qism vazifalari faqat agentd `parts` yuborsa
        await m.query(`DELETE FROM project_tasks WHERE project_id = $1 AND ($2::boolean OR part = '')`, [projectId, partRows !== null]);
        const all = [
          ...tasks.map((t) => ({ taskKey: t.key, part: '', title: t.title, phase: t.phase, status: t.status, rawStatus: t.rawStatus, order: t.order, size: t.size, doneOn: null as string | null })),
          ...(partRows ?? []),
        ];
        if (all.length > 0) {
          await m.query(
            `INSERT INTO project_tasks (project_id, task_key, title, phase, status, raw_status, "order", size, part, done_on)
             SELECT $1::uuid, t.task_key, t.title, t.phase, t.status, t.raw_status, t.ord, t.size, t.part, t.done_on
               FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[], $9::text[], $10::date[])
                    AS t(task_key, title, phase, status, raw_status, ord, size, part, done_on)
             ON CONFLICT (project_id, task_key) DO NOTHING`,
            [projectId, all.map((t) => t.taskKey), all.map((t) => t.title), all.map((t) => t.phase), all.map((t) => t.status), all.map((t) => t.rawStatus), all.map((t) => t.order), all.map((t) => t.size), all.map((t) => t.part), all.map((t) => t.doneOn)],
          );
        }
        if (p.parts) {
          await this.parts.replaceParts(m, projectId, p.parts);
          await this.parts.assignPending(m, [projectId]);
        }
        // 3.5: commitlarni vazifalarga bog'lash (#task:<id> / [id] / branch taxmini)
        await recordTaskCommits(m, { projectId, snapshotId: snap.id, branch: p.branch, commits: p.commits, taskKeys: tasks.map((t) => t.key) });
      }

      // Tarix: oxirgi N ta; md faqat oxirgi M tasida
      await m.query(
        `DELETE FROM project_snapshots WHERE project_id = $1
            AND id IN (SELECT id FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC OFFSET $2)`,
        [projectId, SNAPSHOT_HISTORY_KEEP],
      );
      await m.query(
        `UPDATE project_snapshots SET todos_md = NULL, changelog_md = NULL, tasks_md = NULL
          WHERE project_id = $1 AND (todos_md IS NOT NULL OR changelog_md IS NOT NULL OR tasks_md IS NOT NULL)
            AND id IN (SELECT id FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC OFFSET $2)`,
        [projectId, SNAPSHOT_MD_KEEP],
      );
      await m.query(`UPDATE machines SET last_seen_at = now() WHERE id = $1`, [machineId]);
      return { projectId, inserted: snap.inserted, latest };
    });

    if (result.latest) this.bus.publish({ type: 'project.changed', projectId: result.projectId });
    return result;
  }
}
