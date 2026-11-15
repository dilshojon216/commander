import { PART_LIMITS, partTaskKey, planPercent, splitPartTaskKey } from '@commander/contracts';
import type { PartDoneItem, PartPhaseProgress, ProjectTaskStatus, SnapshotPart } from '@commander/contracts';
import { redactText } from '../common/redact-text.js';
import { diffTaskStatuses } from './task-events.js';
import type { TaskStatusChange } from './task-events.js';

/** Qism vazifalari (6.15): sof mantiq (DB'siz, testlanadi). */

export interface PartTaskRow {
  /** Nomlar maydonli kalit: `<slug>:<id>`. */
  taskKey: string;
  part: string;
  title: string;
  phase: string | null;
  status: ProjectTaskStatus;
  rawStatus: string | null;
  order: number;
  size: string | null;
  doneOn: string | null;
}

/** Snapshot qismlari -> `project_tasks` qatorlari. Sarlavhalar markazda yana redakt qilinadi (xavfsizlik to'ri, qoida 5). */
export function partTaskRows(parts: readonly SnapshotPart[]): PartTaskRow[] {
  const out: PartTaskRow[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    p.items.forEach((it, i) => {
      const taskKey = partTaskKey(p.path, it.key);
      if (seen.has(taskKey)) return;
      seen.add(taskKey);
      out.push({
        taskKey,
        part: p.path,
        title: redactText(it.title),
        phase: it.phase ? redactText(it.phase) : null,
        status: it.status,
        rawStatus: it.rawStatus ?? null,
        order: i,
        size: it.size ?? null,
        doneOn: it.doneOn ?? null,
      });
    });
  }
  return out;
}

export interface PrevTaskRow {
  task_key: string;
  status: string;
  part: string;
}

/**
 * Holat o'zgarishlari, har guruh (ildiz va har qism) ALOHIDA: yangi paydo bo'lgan qismning mavjud bajarilgan bandlari
 * "bugun yopildi" bo'lib ketmasin (guruhning oldingi qatorlari yo'q = baseline, `diffTaskStatuses` qoidasi). `partNext = null`
 * (eski agentd) qismlarga tegmaydi.
 */
export function diffTaskGroups(
  prev: readonly PrevTaskRow[],
  rootNext: ReadonlyArray<{ key: string; status: ProjectTaskStatus }>,
  partNext: readonly PartTaskRow[] | null,
): TaskStatusChange[] {
  const prevBy = new Map<string, Map<string, string>>();
  for (const r of prev) {
    let g = prevBy.get(r.part);
    if (!g) prevBy.set(r.part, (g = new Map()));
    g.set(r.task_key, r.status);
  }
  const out = diffTaskStatuses(prevBy.get('') ?? new Map(), rootNext);
  if (partNext) {
    const nextBy = new Map<string, Array<{ key: string; status: ProjectTaskStatus }>>();
    for (const t of partNext) {
      let g = nextBy.get(t.part);
      if (!g) nextBy.set(t.part, (g = []));
      g.push({ key: t.taskKey, status: t.status });
    }
    for (const [part, next] of nextBy) out.push(...diffTaskStatuses(prevBy.get(part) ?? new Map(), next));
  }
  return out;
}

export interface DoneSourceRow {
  taskKey: string;
  title: string;
  phase: string | null;
  order: number;
  /** Fayl sarlavhasidagi sana. */
  doneOn: string | null;
  /** "Bajarildi" hodisasi sanasi (Asia/Tashkent), fayl sanasi yo'q bo'lsa zaxira. */
  eventDay: string | null;
}

/**
 * "Bajarilganlar xulosasi" (deterministik): oxirgi N bajarilgan band (sanasi borlar sana kamayish tartibida, keyin sanasizlar fayl
 * tartibining oxiridan) va faza bo'yicha done/total.
 */
export function buildDoneSummary(
  rows: ReadonlyArray<DoneSourceRow & { status: ProjectTaskStatus }>,
  limit: number = PART_LIMITS.recentDone,
): { recentDone: PartDoneItem[]; byPhase: PartPhaseProgress[] } {
  const done = rows.filter((r) => r.status === 'done');
  const dateOf = (r: DoneSourceRow): string | null => r.doneOn ?? r.eventDay;
  const sorted = [...done].sort((a, b) => {
    const da = dateOf(a);
    const db = dateOf(b);
    if (da && db) return da < db ? 1 : da > db ? -1 : b.order - a.order;
    if (da) return -1;
    if (db) return 1;
    return b.order - a.order;
  });
  const recentDone = sorted.slice(0, limit).map((r) => ({ key: splitPartTaskKey(r.taskKey).key, title: r.title, phase: r.phase, doneOn: dateOf(r) }));

  const phases = new Map<string, PartPhaseProgress>();
  for (const r of rows) {
    const k = r.phase ?? '';
    let g = phases.get(k);
    if (!g) phases.set(k, (g = { phase: r.phase, done: 0, total: 0 }));
    g.total += 1;
    if (r.status === 'done') g.done += 1;
  }
  const byPhase = [...phases.values()].slice(0, 12);
  return { recentDone, byPhase };
}

/** Qism uchun foiz (done/total, butun). */
export const percentOf = planPercent;

/**
 * Sessiya markeri uchun samarali vazifa kaliti. Ildiz sessiyasi: o'zgarmas. Qism sessiyasi: avval qismning o'z vazifasi
 * (`<slug>:<id>`), bo'lmasa ildizda shu id bor bo'lsa u, ikkalasi ham yo'q bo'lsa qismniki (keyin fayl yangilanishi mumkin).
 */
export function chooseTaskKey(part: string, markerKey: string, existing: ReadonlySet<string>): string {
  if (part === '') return markerKey;
  const ns = partTaskKey(part, markerKey);
  if (existing.has(ns)) return ns;
  if (existing.has(markerKey)) return markerKey;
  return ns;
}
