import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { partForCwd, partTaskKey, planPercent } from '@commander/contracts';
import type { ProjectPartDto, ProjectPartsResponse, ProjectTaskStatus, SnapshotPart, TokenTotals } from '@commander/contracts';
import { toTotals } from '../api/usage.service.js';
import { buildDoneSummary, chooseTaskKey } from './part-logic.js';
import { ACTIVE_INTERVAL_CAP_HOURS, RAW_USAGE_RETENTION_DAYS } from './task-stats.service.js';

type Row = Record<string, unknown>;

const ROOT_NAME = 'asosiy';

export interface PartsOverviewProject {
  id: string;
  name: string;
  parts: Array<{ part: string; done: number; total: number }>;
}

/**
 * Loyiha qismlari (6.15): snapshot'dan `project_parts`, sessiyaga qism biriktirish, qism bo'yicha statistika va
 * "bajarilganlar xulosasi". Vazifalar/doska/span mavjud jadvallarda (kalit nomlar maydoni: `part-logic.ts`).
 */
@Injectable()
export class ProjectPartsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Snapshot qismlari bilan `project_parts` ni almashtiradi (ro'yxatda yo'qlari o'chadi). Chaqiruvchi tranzaksiyasida. */
  async replaceParts(m: EntityManager, projectId: string, parts: readonly SnapshotPart[]): Promise<void> {
    if (parts.length === 0) {
      await m.query(`DELETE FROM project_parts WHERE project_id = $1`, [projectId]);
      return;
    }
    await m.query(
      `INSERT INTO project_parts (project_id, part, name, plan_files, todo, doing, done, "unknown", total, items_truncated, read_truncated, updated_at)
       SELECT $1::uuid, p.part, p.name, p.plan_files::jsonb, p.todo, p.doing, p.done, p.unk, p.total, p.it, p.rt, now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::boolean[], $11::boolean[])
              AS p(part, name, plan_files, todo, doing, done, unk, total, it, rt)
       ON CONFLICT (project_id, part) DO UPDATE SET
         name = EXCLUDED.name, plan_files = EXCLUDED.plan_files, todo = EXCLUDED.todo, doing = EXCLUDED.doing, done = EXCLUDED.done,
         "unknown" = EXCLUDED."unknown", total = EXCLUDED.total, items_truncated = EXCLUDED.items_truncated,
         read_truncated = EXCLUDED.read_truncated, updated_at = now()`,
      [
        projectId,
        parts.map((p) => p.path),
        parts.map((p) => p.name),
        parts.map((p) => JSON.stringify(p.planFiles)),
        parts.map((p) => p.counts.todo),
        parts.map((p) => p.counts.doing),
        parts.map((p) => p.counts.done),
        parts.map((p) => p.counts.unknown),
        parts.map((p) => p.counts.total),
        parts.map((p) => p.itemsTruncated),
        parts.map((p) => p.readTruncated),
      ],
    );
    await m.query(`DELETE FROM project_parts WHERE project_id = $1 AND NOT (part = ANY($2::text[]))`, [projectId, parts.map((p) => p.path)]);
  }

  /**
   * Qismi hali aniqlanmagan sessiyalarga (`sessions.part IS NULL`) qism beradi: start_cwd prefiksi bo'lgan eng uzun qism
   * (yo'q = ildiz ''). Qismlari ma'lum bo'lmagan loyihalarga tegilmaydi (NULL qoladi = ildiz). Bir marta yoziladi.
   */
  async assignPending(m: EntityManager, projectIds: readonly string[]): Promise<number> {
    const ids = [...new Set(projectIds)];
    if (ids.length === 0) return 0;
    const partRows: Array<{ project_id: string; part: string }> = await m.query(`SELECT project_id, part FROM project_parts WHERE project_id = ANY($1::uuid[])`, [ids]);
    if (partRows.length === 0) return 0;
    const byProject = new Map<string, string[]>();
    for (const r of partRows) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r.part]);
    const sessions: Array<{ id: string; project_id: string; start_cwd: string; path: string }> = await m.query(
      `SELECT s.id, s.project_id, s.start_cwd, p.path
         FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE s.project_id = ANY($1::uuid[]) AND s.part IS NULL AND s.start_cwd IS NOT NULL`,
      [[...byProject.keys()]],
    );
    if (sessions.length === 0) return 0;
    const parts = sessions.map((s) => partForCwd(s.start_cwd, s.path, byProject.get(s.project_id) ?? []));
    await m.query(
      `UPDATE sessions s SET part = u.part FROM unnest($1::uuid[], $2::text[]) AS u(id, part) WHERE s.id = u.id AND s.part IS NULL`,
      [sessions.map((s) => s.id), parts],
    );
    return sessions.length;
  }

  /** Sessiyaning qismi (kerak bo'lsa hozir aniqlab yozadi). Qismlari yo'q loyiha = '' (hech narsa yozilmaydi). */
  async sessionPart(m: EntityManager, machineId: string, claudeSessionId: string, projectId: string): Promise<string> {
    const rows: Array<{ id: string; part: string | null; start_cwd: string | null; path: string }> = await m.query(
      `SELECT s.id, s.part, s.start_cwd, p.path FROM sessions s JOIN projects p ON p.id = $3 WHERE s.machine_id = $1 AND s.claude_session_id = $2`,
      [machineId, claudeSessionId, projectId],
    );
    const s = rows[0];
    if (!s) return '';
    if (s.part !== null) return s.part;
    if (!s.start_cwd) return '';
    const parts: Array<{ part: string }> = await m.query(`SELECT part FROM project_parts WHERE project_id = $1`, [projectId]);
    if (parts.length === 0) return '';
    const part = partForCwd(s.start_cwd, s.path, parts.map((p) => p.part));
    await m.query(`UPDATE sessions SET part = $2 WHERE id = $1 AND part IS NULL`, [s.id, part]);
    return part;
  }

  /** Marker kaliti -> samarali kalit (qism sessiyasi uchun nomlar maydoni; `chooseTaskKey`). */
  async effectiveTaskKey(m: EntityManager, projectId: string, part: string, markerKey: string): Promise<string> {
    if (part === '') return markerKey;
    const rows: Array<{ task_key: string }> = await m.query(`SELECT task_key FROM project_tasks WHERE project_id = $1 AND task_key = ANY($2::text[])`, [
      projectId,
      [markerKey, partTaskKey(part, markerKey)],
    ]);
    return chooseTaskKey(part, markerKey, new Set(rows.map((r) => r.task_key)));
  }

  /** Telegram `/p`: qismlari bor loyihalar (arxivlanganlar yashirin, 6.16) va har qism progressi (qisqa; ildiz ham, TASKS.md bo'lsa). */
  async overview(nameFilter: string | null, limit = 10): Promise<PartsOverviewProject[]> {
    const rows: Array<{ id: string; name: string; part: string; done: number; total: number }> = await this.dataSource.query(
      `SELECT p.id, p.name, pp.part, pp.done, pp.total
         FROM project_parts pp JOIN projects p ON p.id = pp.project_id
        WHERE p.archived_at IS NULL AND ($1::text IS NULL OR position(lower($1) in lower(p.name)) > 0)
        ORDER BY p.name, p.id, pp.part`,
      [nameFilter],
    );
    const byProject = new Map<string, PartsOverviewProject>();
    for (const r of rows) {
      let g = byProject.get(r.id);
      if (!g) {
        if (byProject.size >= limit) continue;
        byProject.set(r.id, (g = { id: r.id, name: r.name, parts: [] }));
      }
      g.parts.push({ part: r.part, done: r.done, total: r.total });
    }
    const ids = [...byProject.keys()];
    if (ids.length > 0) {
      const root: Array<{ project_id: string; done: number; total: number }> = await this.dataSource.query(
        `SELECT project_id, count(*) FILTER (WHERE status = 'done')::int AS done, count(*)::int AS total FROM project_tasks WHERE project_id = ANY($1::uuid[]) AND part = '' GROUP BY project_id`,
        [ids],
      );
      for (const r of root) byProject.get(r.project_id)!.parts.unshift({ part: '', done: r.done, total: r.total });
    }
    return [...byProject.values()];
  }

  // --- o'qish ----------------------------------------------------------------------------------

  async list(projectId: string, now: Date = new Date()): Promise<ProjectPartsResponse> {
    const proj: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (proj.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });

    const [partRows, taskRows, doneEvents, sessionRows, tokenRows, activeRows, snap] = await Promise.all([
      this.dataSource.query(
        `SELECT part, name, plan_files, todo, doing, done, "unknown", total, items_truncated, read_truncated, updated_at FROM project_parts WHERE project_id = $1 ORDER BY part`,
        [projectId],
      ) as Promise<Row[]>,
      this.dataSource.query(
        `SELECT task_key, part, title, phase, status, "order", to_char(done_on, 'YYYY-MM-DD') AS done_on FROM project_tasks WHERE project_id = $1`,
        [projectId],
      ) as Promise<Array<{ task_key: string; part: string; title: string; phase: string | null; status: ProjectTaskStatus; order: number; done_on: string | null }>>,
      this.dataSource.query(
        `SELECT DISTINCT ON (task_key) task_key, to_char((ts AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS day
           FROM task_events WHERE project_id = $1 AND to_status = 'done' ORDER BY task_key, ts DESC`,
        [projectId],
      ) as Promise<Array<{ task_key: string; day: string }>>,
      this.dataSource.query(
        `SELECT COALESCE(part, '') AS part, count(*)::int AS sessions, max(last_seen_at) AS last_at FROM sessions WHERE project_id = $1 GROUP BY 1`,
        [projectId],
      ) as Promise<Row[]>,
      this.dataSource.query(
        `SELECT COALESCE(s.part, '') AS part,
                sum(tu.input_tokens)::float8 AS input_tokens, sum(tu.output_tokens)::float8 AS output_tokens,
                sum(tu.cache_read_tokens)::float8 AS cache_read_tokens, sum(tu.cache_creation_tokens)::float8 AS cache_creation_tokens,
                sum(tu.cost_usd)::float8 AS cost_usd, count(*)::float8 AS requests
           FROM token_usage tu JOIN sessions s ON s.machine_id = tu.machine_id AND s.claude_session_id = tu.session_id
          WHERE tu.project_id = $1 GROUP BY 1`,
        [projectId],
      ) as Promise<Row[]>,
      this.dataSource.query(
        `WITH ev AS (
           SELECT e.session_id, e.ts, e.status, lead(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id) AS next_ts
             FROM session_events e WHERE e.session_id IN (SELECT id FROM sessions WHERE project_id = $1)
         )
         SELECT COALESCE(s.part, '') AS part,
                sum(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(ev.next_ts, ev.ts + interval '${ACTIVE_INTERVAL_CAP_HOURS} hours'), ev.ts + interval '${ACTIVE_INTERVAL_CAP_HOURS} hours') - ev.ts))))::float8 AS seconds
           FROM ev JOIN sessions s ON s.id = ev.session_id WHERE ev.status = 'working' GROUP BY 1`,
        [projectId],
      ) as Promise<Row[]>,
      this.dataSource.query(`SELECT tasks_path, taken_at FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC LIMIT 1`, [projectId]) as Promise<
        Array<{ tasks_path: string | null; taken_at: Date }>
      >,
    ]);

    const eventDay = new Map(doneEvents.map((e) => [e.task_key, e.day]));
    const tasksByPart = new Map<string, typeof taskRows>();
    for (const t of taskRows) tasksByPart.set(t.part, [...(tasksByPart.get(t.part) ?? []), t]);
    const sessionBy = new Map(sessionRows.map((r) => [r['part'] as string, r]));
    const tokenBy = new Map(tokenRows.map((r) => [r['part'] as string, r]));
    const activeBy = new Map(activeRows.map((r) => [r['part'] as string, Number(r['seconds'] ?? 0)]));

    const build = (part: string, name: string, planFiles: string[], counts: { todo: number; doing: number; done: number; unknown: number; total: number }, flags: { it: boolean; rt: boolean }, updatedAt: Date | null): ProjectPartDto => {
      const rows = (tasksByPart.get(part) ?? []).map((t) => ({
        taskKey: t.task_key,
        title: t.title,
        phase: t.phase,
        order: t.order,
        status: t.status,
        doneOn: t.done_on,
        eventDay: eventDay.get(t.task_key) ?? null,
      }));
      const summary = buildDoneSummary(rows);
      const sess = sessionBy.get(part);
      const tokens: TokenTotals = toTotals(tokenBy.get(part) as Parameters<typeof toTotals>[0] | undefined);
      return {
        part,
        name,
        planFiles,
        summary: counts,
        percent: planPercent(counts),
        sessions: Number(sess?.['sessions'] ?? 0),
        activeSeconds: Math.round(activeBy.get(part) ?? 0),
        tokens,
        lastActivityAt: sess?.['last_at'] instanceof Date ? (sess['last_at'] as Date).toISOString() : null,
        recentDone: summary.recentDone,
        byPhase: summary.byPhase,
        itemsTruncated: flags.it,
        readTruncated: flags.rt,
        updatedAt: updatedAt ? updatedAt.toISOString() : null,
      };
    };

    const rootRows = tasksByPart.get('') ?? [];
    const rootCounts = { todo: 0, doing: 0, done: 0, unknown: 0, total: rootRows.length };
    for (const r of rootRows) rootCounts[r.status] += 1;
    const latest = snap[0];
    const parts: ProjectPartDto[] = [build('', ROOT_NAME, latest?.tasks_path ? [latest.tasks_path] : [], rootCounts, { it: false, rt: false }, latest?.taken_at ?? null)];
    for (const p of partRows) {
      parts.push(
        build(
          p['part'] as string,
          p['name'] as string,
          Array.isArray(p['plan_files']) ? (p['plan_files'] as string[]) : [],
          { todo: Number(p['todo']), doing: Number(p['doing']), done: Number(p['done']), unknown: Number(p['unknown']), total: Number(p['total']) },
          { it: p['items_truncated'] === true, rt: p['read_truncated'] === true },
          p['updated_at'] as Date,
        ),
      );
    }
    return { projectId, parts, tokensCoveredFrom: new Date(now.getTime() - RAW_USAGE_RETENTION_DAYS * 86_400_000).toISOString() };
  }
}
