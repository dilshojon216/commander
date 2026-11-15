/**
 * TASKS.md jadvali parseri: yagona manba `@commander/contracts` (`libs/contracts/src/tasks-md.ts`; center ham
 * shuni ishlatadi). Bu fayl dashboard'ning eski `TaskRow` ko'rinishini saqlaydigan yupqa adapter: `unknown`
 * holat bu yerda `todo` ga tushadi (UI uch holat ko'rsatadi).
 */
import { parseTasksMarkdown as parseShared } from "@commander/contracts";

export type TaskStatus = "done" | "doing" | "todo";

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  /** Nearest oldingi `##` sarlavhasi (faza). */
  phase: string | null;
  /** Hajm ustuni (S/M/L), bo'lsa. */
  size: string | null;
}

export interface TasksSummary {
  done: number;
  doing: number;
  todo: number;
  total: number;
  /** 0..100 */
  donePct: number;
  doingPct: number;
}

export function parseTasksMarkdown(md: string): TaskRow[] {
  return parseShared(md).map((t) => ({
    id: t.key,
    title: t.title,
    status: t.status === "done" || t.status === "doing" ? t.status : "todo",
    phase: t.phase,
    size: t.size,
  }));
}

export function summarizeTasks(rows: Pick<TaskRow, "status">[]): TasksSummary {
  const done = rows.filter((r) => r.status === "done").length;
  const doing = rows.filter((r) => r.status === "doing").length;
  const total = rows.length;
  return {
    done,
    doing,
    todo: total - done - doing,
    total,
    donePct: total ? (done / total) * 100 : 0,
    doingPct: total ? (doing / total) * 100 : 0,
  };
}
