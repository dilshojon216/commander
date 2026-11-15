import { parseTasksMarkdown } from '@commander/contracts';
import type { ParsedTask, ProjectSnapshotPayload } from '@commander/contracts';
import { redactText } from '../common/redact-text.js';

/** Saqlanadigan snapshot tarixi: oxirgi N ta; md matnlari faqat oxirgi M tasida (qolganlarida NULL). */
export const SNAPSHOT_HISTORY_KEEP = 10;
export const SNAPSHOT_MD_KEEP = 3;

export interface SnapshotMd {
  todosMd: string | null;
  changelogMd: string | null;
  tasksMd: string | null;
}

/**
 * XAVFSIZLIK TO'RI (CLAUDE.md qoida 5): agentd md'ni o'zi redakt qiladi, lekin eskirgan/xato agentd'dan kelgan matn ham
 * markazga sir bo'lib tushmasin. Idempotent (`[REDACTED]` qayta maskalanmaydi).
 */
export function sanitizeMd(p: Pick<ProjectSnapshotPayload, 'todosMd' | 'changelogMd' | 'tasksMd'>): SnapshotMd {
  const clean = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : redactText(v));
  return { todosMd: clean(p.todosMd), changelogMd: clean(p.changelogMd), tasksMd: clean(p.tasksMd) };
}

/** TASKS.md -> `project_tasks` qatorlari (TASKS.md yo'q bo'lsa bo'sh: eski vazifalar o'chiriladi). */
export function tasksFromMd(tasksMd: string | null): ParsedTask[] {
  return tasksMd ? parseTasksMarkdown(tasksMd) : [];
}

/** Kelajakdagi `takenAt` serverda hozirgi vaqtga tushiriladi (soat noto'g'ri agentd "eng yangi"ni buzmasin). */
export function clampTakenAt(takenAtMs: number, now: Date): Date {
  return new Date(Math.min(takenAtMs, now.getTime()));
}
