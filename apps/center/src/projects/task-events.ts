import type { ParsedTask } from '@commander/contracts';

export interface TaskStatusChange {
  taskKey: string;
  /** `null` = vazifa oldingi snapshot'da yo'q edi. */
  from: string | null;
  to: string;
}

/**
 * Snapshot farqi -> holat o'zgarishlari (sof). Oldingi snapshot'da vazifalar umuman bo'lmasa (birinchi marta) hech narsa qaytmaydi:
 * aks holda birinchi yuklashda barcha bajarilgan vazifalar "bugun yopildi" bo'lib qolardi. Yangi `todo` vazifa (from=null) jurnalga tushmaydi.
 * O'chirilgan vazifalar jurnalga tushmaydi.
 */
export function diffTaskStatuses(prev: ReadonlyMap<string, string>, next: ReadonlyArray<Pick<ParsedTask, 'key' | 'status'>>): TaskStatusChange[] {
  if (prev.size === 0) return [];
  const out: TaskStatusChange[] = [];
  for (const t of next) {
    const before = prev.get(t.key) ?? null;
    if (before === t.status) continue;
    if (before === null && t.status === 'todo') continue;
    out.push({ taskKey: t.key, from: before, to: t.status });
  }
  return out;
}
