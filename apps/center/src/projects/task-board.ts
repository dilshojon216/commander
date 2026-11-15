import type { ProjectTaskStatus, TaskBoardColumn, TaskColumnSource } from '@commander/contracts';

/**
 * Doskadagi samarali ustun (sof mantiq):
 *  1. TASKS.md `done` HAR DOIM ustun: `done` (qo'lda boshqa ustunga surib bo'lmaydi: haqiqat manbai fayl);
 *  2. aks holda qo'lda surilgan overlay (`task_board`) bo'lsa shu;
 *  3. aks holda hisoblangan: ochiq span (sessiya hozir shu vazifada) -> `doing`; TASKS.md `doing` -> `doing`; qolgani `todo`.
 */
export interface EffectiveColumnInput {
  mdStatus: ProjectTaskStatus;
  overlay: TaskBoardColumn | null;
  hasActiveSpan: boolean;
}

export interface EffectiveColumn {
  column: TaskBoardColumn;
  source: TaskColumnSource;
}

export function effectiveColumn(i: EffectiveColumnInput): EffectiveColumn {
  if (i.mdStatus === 'done') return { column: 'done', source: 'tasks_md' };
  if (i.overlay) return { column: i.overlay, source: 'board' };
  if (i.hasActiveSpan || i.mdStatus === 'doing') return { column: 'doing', source: 'derived' };
  return { column: 'todo', source: 'derived' };
}
