import { AppendTasksBodySchema, TASK_KEY_RE, TASK_SIZE_RE, suggestTaskKeys } from "@commander/contracts";
import type { AppendTasksBody, DailyDay, MachineDto, MdExtractResponse, ProjectTaskDto, TaskBoardColumn, TaskCandidateDto } from "@commander/contracts";
import { commandErrorText, commandHttpErrorText } from "./control-ui";
import { displayKey } from "./parts-view";
import { formatClock, formatDayLabel, formatDuration, formatTokens } from "./format";

/** Loyiha ish maydoni (2.15) ko'rinish modellari: doska, kunlik ko'rinish, md nomzodlari (sof, testlanadi). */

// --- doska -----------------------------------------------------------------------------------------

export const BOARD_COLUMNS: { id: TaskBoardColumn; label: string; color: string }[] = [
  { id: "todo", label: "Qoldi", color: "var(--mu)" },
  { id: "doing", label: "Jarayonda", color: "var(--blue)" },
  { id: "review", label: "Tekshiruvda", color: "var(--yel)" },
  { id: "done", label: "Bajarildi", color: "var(--grn)" },
];

export const LOCKED_REASON = "TASKS.md'da bajarilgan deb belgilangan: doskada boshqa ustunga surib bo'lmaydi (faylni tahrirlang)";

/** TASKS.md `done` vazifa qulflangan (fayl haqiqat manbai). */
export function isLocked(t: Pick<ProjectTaskDto, "columnSource" | "status">): boolean {
  return t.columnSource === "tasks_md" || t.status === "done";
}

export type MoveCheck = { ok: true } | { ok: false; reason: string | null };

/** Ustunlar qoidasi: qulflangan karta ko'chmaydi; o'sha ustunga qaytarish hech narsa qilmaydi (reason=null). */
export function canMove(t: Pick<ProjectTaskDto, "columnSource" | "status" | "column">, to: TaskBoardColumn): MoveCheck {
  if (isLocked(t)) return { ok: false, reason: LOCKED_REASON };
  if (t.column === to) return { ok: false, reason: null };
  return { ok: true };
}

/** Optimistik surish: `pending` (kalit -> ustun) server javobigacha kartani ko'chirilgan ko'rsatadi. */
export function applyPending<T extends Pick<ProjectTaskDto, "key" | "column" | "columnSource">>(tasks: T[], pending: Record<string, TaskBoardColumn>): T[] {
  return tasks.map((t) => (pending[t.key] && pending[t.key] !== t.column ? { ...t, column: pending[t.key], columnSource: "board" as const } : t));
}

/** Xato bo'lsa orqaga qaytarish: `pending`dan o'sha kalitni olib tashlaydi (asl ustun qaytadi). */
export function rollbackPending(pending: Record<string, TaskBoardColumn>, key: string): Record<string, TaskBoardColumn> {
  const { [key]: _drop, ...rest } = pending;
  void _drop;
  return rest;
}

export function groupByColumn<T extends Pick<ProjectTaskDto, "column" | "order">>(tasks: T[]): Record<TaskBoardColumn, T[]> {
  const out: Record<TaskBoardColumn, T[]> = { todo: [], doing: [], review: [], done: [] };
  for (const t of [...tasks].sort((a, b) => a.order - b.order)) out[t.column].push(t);
  return out;
}

export type RatioColor = "mu" | "grn" | "yel" | "red";

/** Reja/haqiqiy nisbati rangi: <=1 yashil, <=1.25 sariq, undan yuqori qizil; reja yo'q = kulrang. */
export function ratioColor(ratio: number | null): RatioColor {
  if (ratio === null) return "mu";
  if (ratio <= 1) return "grn";
  if (ratio <= 1.25) return "yel";
  return "red";
}

export function ratioDelta(ratio: number | null): string | null {
  if (ratio === null) return null;
  const pct = Math.round((ratio - 1) * 100);
  if (pct === 0) return "rejada";
  return pct > 0 ? `rejadan +${pct}% kech` : `rejadan ${Math.abs(pct)}% tez`;
}

export function hoursText(h: number | null): string {
  if (h === null) return "—";
  if (h === 0) return "0";
  if (h < 1) return `${Math.round(h * 60)} d`;
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min ? `${whole} s ${min} d` : `${whole} s`;
}

export function stars(score: number | null | undefined): string {
  if (!score) return "";
  const n = Math.max(0, Math.min(5, Math.round(score)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export interface CardView {
  key: string;
  title: string;
  phase: string | null;
  column: TaskBoardColumn;
  locked: boolean;
  /** Qism yo'li (`''` = asosiy): "Hammasi" ko'rinishida nishon uchun. */
  part: string;
  planText: string;
  /** Reja, haqiqiy vaqt va token hammasi bo'sh bo'lsa `false`: karta shu qatorni ko'rsatmaydi. */
  hasMeta: boolean;
  /** Reja hajm (S/M/L) dan olingan bo'lsa "taxmin". */
  planEstimated: boolean;
  actualText: string;
  ratioColor: RatioColor;
  delta: string | null;
  tokens: string;
  scoreStars: string;
  scoreReason: string | null;
  /** 0..100 yoki null (reja yo'q). */
  progressPct: number | null;
  branchGuess: boolean;
  sessions: number;
}

export function cardView(t: ProjectTaskDto): CardView {
  const p = t.plan;
  return {
    key: displayKey(t.key),
    title: t.title,
    phase: t.phase,
    column: t.column,
    locked: isLocked(t),
    part: t.part ?? "",
    hasMeta: p.estimateHours !== null || t.stats.activeSeconds > 0 || t.stats.tokens.totalTokens > 0 || t.stats.source === "branch" || t.stats.source === "mixed",
    planText: p.estimateHours === null ? "reja yo'q" : `reja: ${hoursText(p.estimateHours)}`,
    planEstimated: p.estimateSource === "size",
    actualText: t.stats.activeSeconds > 0 ? formatDuration(t.stats.activeSeconds * 1000) : "—",
    ratioColor: ratioColor(p.ratio),
    delta: p.actualHours > 0 ? ratioDelta(p.ratio) : null,
    tokens: t.stats.tokens.totalTokens > 0 ? formatTokens(t.stats.tokens.totalTokens) : "—",
    scoreStars: stars(t.score?.score),
    scoreReason: t.score?.reason ?? null,
    progressPct: p.ratio === null || p.actualHours === 0 ? null : Math.min(100, Math.round(p.ratio * 100)),
    branchGuess: t.stats.source === "branch" || t.stats.source === "mixed",
    sessions: t.stats.sessions,
  };
}

/** KPI qatori: bajarildi, jarayonda, bugun ishlangan, o'rtacha baho, reja aniqligi. */
export function boardKpis(tasks: ProjectTaskDto[]) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.column === "done").length;
  const doing = tasks.filter((t) => t.column === "doing").length;
  const review = tasks.filter((t) => t.column === "review").length;
  const scored = tasks.filter((t) => t.score).map((t) => t.score!.score);
  const avg = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  const planned = tasks.filter((t) => t.plan.ratio !== null && t.plan.actualHours > 0);
  // Aniqlik: har vazifa uchun min(reja,haqiqiy)/max(reja,haqiqiy) o'rtachasi
  const accuracy = planned.length ? planned.reduce((a, t) => a + Math.min(t.plan.ratio!, 1 / Math.max(t.plan.ratio!, 0.0001)), 0) / planned.length : null;
  return { total, done, doing, review, avgScore: avg, accuracy };
}

// --- kunlik ko'rinish --------------------------------------------------------------------------------

/** Asia/Tashkent (UTC+5, DST yo'q) sanasi: YYYY-MM-DD. */
export function tashkentDate(ms: number): string {
  return new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10);
}

export function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) - 5 * 3_600_000;
}

export function dayLabel(date: string, today: string): string {
  const l = formatDayLabel(dayStartMs(date));
  return date === today ? `Bugun, ${l}` : l;
}

/** Oxirgi 5 kun (bugundan boshlab). */
export function dayChoices(todayStr: string, count = 5): { date: string; label: string }[] {
  const base = dayStartMs(todayStr);
  return Array.from({ length: count }, (_, i) => {
    const d = tashkentDate(base - i * 86_400_000 + 12 * 3_600_000);
    return { date: d, label: dayLabel(d, todayStr) };
  });
}

export interface DailyRowView {
  key: string;
  title: string;
  time: string;
  sessions: number;
  planText: string;
  actualText: string;
  ratioColor: RatioColor;
  tokens: string;
  scoreStars: string;
  scoreReason: string | null;
}

export interface DailyView {
  date: string;
  rows: DailyRowView[];
  closed: number;
  closedTitles: { key: string; title: string | null }[];
  sessionTime: string;
  tokens: string;
  avgScore: string | null;
  summary: { text: string; model: string } | null;
  /** Faollik yo'q kun: xulosa yaratib bo'lmaydi. */
  empty: boolean;
}

export function buildDailyView(day: DailyDay): DailyView {
  const rows = day.tasks.map((t): DailyRowView => ({
    key: t.taskKey,
    title: t.title ?? "(TASKS.md'da yo'q vazifa)",
    time: `${formatClock(Date.parse(t.firstActivityAt))}–${formatClock(Date.parse(t.lastActivityAt))}`,
    sessions: t.sessions,
    planText: t.plan.estimateHours === null ? "—" : hoursText(t.plan.estimateHours),
    actualText: hoursText(t.plan.actualHours || (t.activeSeconds > 0 ? t.activeSeconds / 3600 : 0)),
    ratioColor: ratioColor(t.plan.ratio),
    tokens: formatTokens(t.tokens.totalTokens),
    scoreStars: stars(t.score?.score),
    scoreReason: t.score?.reason ?? null,
  }));
  return {
    date: day.date,
    rows,
    closed: day.totals.tasksDone,
    closedTitles: day.doneTasks.map((d) => ({ key: displayKey(d.taskKey), title: d.title })),
    sessionTime: day.totals.activeSeconds > 0 ? formatDuration(day.totals.activeSeconds * 1000) : "—",
    tokens: formatTokens(day.totals.totalTokens),
    avgScore: day.totals.avgScore === null ? null : day.totals.avgScore.toFixed(1),
    summary: day.summary ? { text: day.summary.summary, model: day.summary.model } : null,
    empty: day.totals.tasksWorked === 0 && day.totals.activeSeconds === 0 && day.totals.totalTokens === 0,
  };
}

// --- md nomzodlari -> TASKS.md ---------------------------------------------------------------------------

export interface CandidateEdit {
  include: boolean;
  key: string;
  title: string;
  /** '' = hajm yo'q. */
  size: string;
  keyTouched: boolean;
  /** TASKS.md'da allaqachon bor (kalit/sarlavha mos): sukut bo'yicha tanlanmaydi. */
  alreadyInTasks: string | null;
  group: string | null;
  source: TaskCandidateDto["source"];
}

export const SIZE_CHOICES = ["", "S", "M", "L", "XL"] as const;

export function initEdits(resp: Pick<MdExtractResponse, "candidates">, keys: string[]): CandidateEdit[] {
  return resp.candidates.map((c, i) => ({
    include: c.alreadyInTasks === null,
    key: keys[i] ?? c.suggestedKey,
    title: c.title,
    size: "",
    keyTouched: false,
    alreadyInTasks: c.alreadyInTasks,
    group: c.group,
    source: c.source,
  }));
}

/** Faza o'zgarganda tanlangan nomzodlar uchun id'lar qayta taklif qilinadi (qo'lda tahrirlanganlari saqlanadi). */
export function resuggestKeys(edits: CandidateEdit[], tasks: Pick<ProjectTaskDto, "key" | "phase">[], phase: string | null): CandidateEdit[] {
  const fresh = suggestTaskKeys(tasks, phase, edits.length);
  return edits.map((e, i) => (e.keyTouched ? e : { ...e, key: fresh[i] ?? e.key }));
}

export interface EditIssue {
  index: number;
  message: string;
}

/** Tanlangan qatorlar tekshiruvi (id formati, takror, mavjud id, sarlavha, hajm). */
export function validateEdits(edits: CandidateEdit[], existingKeys: Iterable<string>): EditIssue[] {
  const existing = new Set([...existingKeys].map((k) => k.toLowerCase()));
  const seen = new Set<string>();
  const issues: EditIssue[] = [];
  edits.forEach((e, index) => {
    if (!e.include) return;
    const key = e.key.trim();
    const title = e.title.trim();
    if (!TASK_KEY_RE.test(key)) issues.push({ index, message: "Id kichik harf/raqam/nuqta/tire, ≤32 belgi bo'lsin" });
    else if (existing.has(key)) issues.push({ index, message: `Id ${key} TASKS.md'da bor` });
    else if (seen.has(key)) issues.push({ index, message: `Id ${key} takrorlangan` });
    seen.add(key);
    if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) issues.push({ index, message: "Sarlavha bo'sh yoki juda uzun (≤200, bir qator)" });
    if (e.size && !TASK_SIZE_RE.test(e.size)) issues.push({ index, message: "Hajm: S, M, L, XL yoki masalan 3h" });
  });
  return issues;
}

/** So'rov tanasi: faqat tanlanganlar; `null` = tanlangan yo'q yoki sxema bo'yicha yaroqsiz. */
export function buildAppendBody(phase: string, edits: CandidateEdit[]): AppendTasksBody | null {
  const tasks = edits
    .filter((e) => e.include)
    .map((e) => ({ key: e.key.trim(), title: e.title.trim(), ...(e.size ? { size: e.size } : {}) }));
  if (tasks.length === 0) return null;
  const parsed = AppendTasksBodySchema.safeParse({ phase: phase.trim(), tasks });
  return parsed.success ? parsed.data : null;
}

// --- yozish huquqi va xatolar -------------------------------------------------------------------------------

/**
 * Loyiha ish maydoni yozuvlari (doska, xulosa, md, yangilash) uchun sabab; mumkin bo'lsa null.
 * Doska (`board`) faqat markaz overlay'i: mashina siyosatiga bog'liq emas.
 */
export function workWriteReason(
  kind: "board" | "agent",
  o: { lockdown: boolean; canControl: boolean; machine: Pick<MachineDto, "online" | "control"> | undefined },
): string | null {
  if (o.lockdown) return "Lockdown yoqiq: yozish amallari o'chirilgan";
  if (!o.canControl) return "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq";
  if (kind === "board") return null;
  const m = o.machine;
  if (!m) return "Mashina topilmadi";
  if (!m.online) return "Mashina oflayn: amal bajarib bo'lmaydi";
  const c = m.control;
  if (!c) return "Mashinadagi agentd eski versiya: loyiha amallarini qo'llamaydi";
  if (!c.enabled) return "Bu mashinada masofaviy boshqaruv o'chiq — yoqish: `agentd policy enable` va `agentd policy allow-root <papka>`";
  if (c.projectOps === false) return "Mashinadagi agentd loyiha amallarini qo'llamaydi (yangilang)";
  return null;
}

/** Ish maydoni REST xatolari (409 no_activity va h.k.) -> o'zbekcha. */
export function workHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  switch (code) {
    case "no_activity":
      return "Bu kunda faollik yo'q: xulosa yaratib bo'lmaydi";
    case "task_not_found":
      return "Vazifa TASKS.md'da topilmadi (yangilab ko'ring)";
    case "md_not_listed":
      return "Bu fayl mashinadagi .md ro'yxatida yo'q (loyihani yangilang)";
    case "md_files_unknown":
      return "Mashina .md fayllar ro'yxatini hali yubormagan: loyihani yangilang";
    case "tasks_md_unknown":
      return "TASKS.md snapshot'i hali yo'q: loyihani yangilang";
    case "task_key_exists":
      return "Ba'zi vazifa id'lari TASKS.md'da allaqachon bor";
    case "tasks_md_changed":
      return commandErrorText("tasks_md_changed");
    default:
      return commandHttpErrorText(status, body);
  }
}

/** Sessiyaga vazifani biriktirish prompti. */
export function taskPrompt(key: string, title: string): string {
  return `#task:${displayKey(key)} ${title}`.slice(0, 16_000);
}
