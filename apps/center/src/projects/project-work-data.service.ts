import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_SIZE_HOURS, SizeHoursSettingSchema, TASK_SIZE_HOURS_SETTING, TaskBoardColumnSchema } from '@commander/contracts';
import type { TaskBoardColumn, TaskScoreRef } from '@commander/contracts';

/** Doska/reja/baho uchun o'qish yordamchilari (2.15): overlay, faol span'lar, hajm xaritasi, eng so'nggi baholar. */
@Injectable()
export class ProjectWorkDataService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** `settings['tasks.size_hours']` (jsonb obyekt, masalan `{"S":2,"M":6}`) default xarita ustiga qo'yiladi; yaroqsiz bo'lsa default. */
  async sizeHours(): Promise<Record<string, number>> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [TASK_SIZE_HOURS_SETTING]);
    const parsed = SizeHoursSettingSchema.safeParse(rows[0]?.value);
    return parsed.success ? { ...DEFAULT_SIZE_HOURS, ...parsed.data } : { ...DEFAULT_SIZE_HOURS };
  }

  async overlays(projectId: string): Promise<Map<string, TaskBoardColumn>> {
    const rows: Array<{ task_key: string; board_column: string }> = await this.dataSource.query(`SELECT task_key, board_column FROM task_board WHERE project_id = $1`, [projectId]);
    const out = new Map<string, TaskBoardColumn>();
    for (const r of rows) {
      const c = TaskBoardColumnSchema.safeParse(r.board_column);
      if (c.success) out.set(r.task_key, c.data);
    }
    return out;
  }

  /** Hozir ochiq span'i bor vazifalar (sessiya shu vazifada ishlayapti). */
  async activeSpanKeys(projectId: string): Promise<Set<string>> {
    const rows: Array<{ task_key: string }> = await this.dataSource.query(
      `SELECT DISTINCT task_key FROM session_task_spans WHERE project_id = $1 AND ended_at IS NULL`,
      [projectId],
    );
    return new Set(rows.map((r) => r.task_key));
  }

  /** Vazifa bo'yicha eng so'nggi baho (kunlik xulosalardan; yangi kun va yangi yaratilgan ustun). */
  async latestScores(projectId: string): Promise<Map<string, TaskScoreRef>> {
    const rows: Array<{ day: string; created_at: Date; scores: Array<{ taskKey: string; score: number; reason: string }> }> = await this.dataSource.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, created_at, scores FROM daily_summaries WHERE project_id = $1 ORDER BY day DESC, created_at DESC LIMIT 90`,
      [projectId],
    );
    const out = new Map<string, TaskScoreRef>();
    for (const r of rows) {
      for (const s of Array.isArray(r.scores) ? r.scores : []) {
        if (!out.has(s.taskKey)) out.set(s.taskKey, { score: s.score, reason: s.reason, day: r.day, createdAt: r.created_at.toISOString() });
      }
    }
    return out;
  }
}
