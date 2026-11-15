import { Injectable } from '@nestjs/common';
import { ProjectPartsService } from './project-parts.service.js';
import type { EntityManager } from 'typeorm';
import { decideSessionEnd, decideSpanAction } from './task-spans.js';
import type { OpenSpan, SpanAction, SpanSource } from './task-spans.js';

export interface SpanEventArgs {
  machineId: string;
  /** Claude sessiya id'si (`token_usage.session_id` bilan bir xil). */
  claudeSessionId: string;
  projectId: string | null;
  taskKey?: string | null | undefined;
  taskSource?: SpanSource | null | undefined;
  /** Hodisa holati: `ended` ochiq span'ni yopadi. */
  status: string;
  at: Date;
}

interface OpenRow {
  id: string;
  task_key: string;
  source: SpanSource;
  started_at: Date;
}

/**
 * `session_task_spans` ni agentd hodisalariga ko'ra yuritadi. Chaqiruvchi tranzaksiyani (`m`) ochadi: span o'zgarishi
 * hodisa yozuvi bilan bir COMMIT'da. Bir sessiyada bir vaqtda bitta ochiq span (qisman UNIQUE indeks) poygadan himoya qiladi.
 */
@Injectable()
export class TaskSpansService {
  constructor(private readonly parts: ProjectPartsService) {}

  /** Hodisada marker yoki tugash bo'lmasa DB'ga umuman tegmaydi. */
  async applyEvent(m: EntityManager, a: SpanEventArgs): Promise<void> {
    const hasMarker = a.taskSource !== undefined && a.taskSource !== null;
    const ended = a.status === 'ended';
    if (!hasMarker && !ended) return;

    const rows: OpenRow[] = await m.query(
      `SELECT id, task_key, source, started_at FROM session_task_spans
        WHERE machine_id = $1 AND session_id = $2 AND ended_at IS NULL FOR UPDATE`,
      [a.machineId, a.claudeSessionId],
    );
    const open: OpenSpan | null = rows[0] ? { id: rows[0].id, taskKey: rows[0].task_key, source: rows[0].source, startedAt: rows[0].started_at } : null;

    // Avval marker, keyin tugash (bir hodisada ikkalasi bo'lishi nazariy: marker span'i darhol yopiladi)
    let current = open;
    if (hasMarker) {
      // 6.15: qism sessiyasida marker id'si qismning nomlar maydoniga o'tkaziladi (`<slug>:<id>`)
      let key = a.taskKey ?? null;
      if (key && a.projectId) {
        const part = await this.parts.sessionPart(m, a.machineId, a.claudeSessionId, a.projectId);
        key = await this.parts.effectiveTaskKey(m, a.projectId, part, key);
      }
      const action = decideSpanAction(current, { taskKey: key, source: a.taskSource as SpanSource }, a.at);
      current = await this.execute(m, a, current, action);
    }
    if (ended) {
      const action = decideSessionEnd(current, a.at);
      await this.execute(m, a, current, action);
    }
  }

  private async execute(m: EntityManager, a: SpanEventArgs, open: OpenSpan | null, action: SpanAction): Promise<OpenSpan | null> {
    if (action.kind === 'noop') return open;
    if (action.kind === 'close') {
      if (open) await m.query(`UPDATE session_task_spans SET ended_at = $2 WHERE id = $1`, [open.id, action.at]);
      return null;
    }
    if (action.closeCurrent && open) await m.query(`UPDATE session_task_spans SET ended_at = $2 WHERE id = $1`, [open.id, action.at]);
    const inserted: Array<{ id: string }> = await m.query(
      `INSERT INTO session_task_spans (machine_id, session_id, project_id, task_key, source, started_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [a.machineId, a.claudeSessionId, a.projectId, action.taskKey, action.source, action.at],
    );
    return { id: inserted[0]!.id, taskKey: action.taskKey, source: action.source, startedAt: action.at };
  }
}
