import { splitPartTaskKey } from "@commander/contracts";
import type { PartDoneItem, ProjectPartDto, ProjectTaskDto } from "@commander/contracts";
import { formatDuration, formatTokens } from "./format";

/** Loyiha qismlari (6.15) ko'rinish modellari: tab'lar, progress, "bajarilganlar xulosasi" (sof, testlanadi). */

/** Qism vazifasi kaliti (`<slug>:<id>`) -> foydalanuvchiga ko'rinadigan oddiy id (`<id>`). */
export function displayKey(key: string): string {
  return splitPartTaskKey(key).key;
}

export interface PartTabView {
  /** `''` = asosiy (ildiz). */
  id: string;
  label: string;
  done: number;
  total: number;
  /** 0..100 yoki null (vazifa yo'q). */
  pct: number | null;
  /** `12/40 · 30%` yoki `—`. */
  progressText: string;
}

const progressText = (done: number, total: number, pct: number | null): string => (total === 0 || pct === null ? "—" : `${done}/${total} · ${pct}%`);

/** "Hammasi" tab'i identifikatori (qism yo'li hech qachon bunday bo'lmaydi: yo'llar `[a-z0-9]` bilan boshlanadi). */
export const ALL_PARTS = "__all";

const pctOf = (done: number, total: number): number | null => (total === 0 ? null : Math.round((done / total) * 100));

/**
 * Tab'lar: "Hammasi" (barcha qismlar birlashgan) birinchi, keyin "Asosiy" (faqat ildizda vazifa bo'lsa) va qismlar.
 * Qism yo'q bo'lsa bo'sh ro'yxat (UI eski bitta doskani ko'rsatadi).
 */
export function partTabs(parts: readonly ProjectPartDto[]): PartTabView[] {
  const others = parts.filter((p) => p.part !== "");
  if (others.length === 0) return [];
  const t = partsTotals(parts);
  const all: PartTabView = { id: ALL_PARTS, label: "Hammasi", done: t.done, total: t.total, pct: t.pct, progressText: progressText(t.done, t.total, t.pct) };
  const rest = parts
    .filter((p) => p.part !== "" || p.summary.total > 0)
    .map((p) => ({ id: p.part, label: p.part === "" ? "Asosiy" : p.name, done: p.summary.done, total: p.summary.total, pct: p.percent, progressText: progressText(p.summary.done, p.summary.total, p.percent) }));
  return [all, ...rest];
}

/** Tanlangan qism vazifalari (`''` = ildiz, `ALL_PARTS` = hammasi). `part` yo'q (eski center) bo'lsa hammasi ildiz hisoblanadi. */
export function tasksForPart(tasks: readonly ProjectTaskDto[], part: string): ProjectTaskDto[] {
  if (part === ALL_PARTS) return [...tasks];
  return tasks.filter((t) => (t.part ?? "") === part);
}

export interface PartsTotals {
  done: number;
  total: number;
  pct: number | null;
  /** Ildizdan tashqari qismlar soni. */
  partCount: number;
}

/** Ildiz + barcha qismlar bo'yicha jami (sarlavha va umumiy progress uchun). */
export function partsTotals(parts: readonly ProjectPartDto[]): PartsTotals {
  let done = 0;
  let total = 0;
  for (const p of parts) {
    done += p.summary.done;
    total += p.summary.total;
  }
  return { done, total, pct: pctOf(done, total), partCount: parts.filter((p) => p.part !== "").length };
}

/** Ish sahifasi sarlavhasidagi vazifalar matni: qismlar bor bo'lsa `7 qism · 471/913 vazifa`, aks holda `TASKS.md · 12 vazifa`. */
export function workTotalsText(parts: readonly ProjectPartDto[], tasksMdPath: string | null, fallbackTotal: number): string {
  const t = partsTotals(parts);
  if (t.partCount > 0) return `${t.partCount} qism · ${t.done}/${t.total} vazifa`;
  return `${tasksMdPath ?? "TASKS.md yo'q"} · ${fallbackTotal} vazifa`;
}

/** Qism yo'lining qisqa nomi (oxirgi bo'lak); ildiz = "Asosiy". */
export function partLabel(part: string): string {
  return part === "" ? "Asosiy" : (part.split("/").pop() ?? part);
}

/**
 * Kunlik xulosa (6.18) so'rov tanasi: `part` bo'sh yoki yo'q = butun loyiha (avvalgidek, tana bo'sh); aks holda faqat shu qism.
 * Markaz '' ni "butun loyiha" deb biladi, shuning uchun asosiy (ildiz) tab ham butun loyiha xulosasini yaratadi.
 */
export function summaryBody(part: string | undefined): { part?: string } {
  return part ? { part } : {};
}

/** Kun xulosasi sarlavhasi: qism tanlangan bo'lsa qism nomi bilan. */
export function summaryHeading(part: string | undefined): string {
  return part ? `Claude'ning kun xulosasi: ${partLabel(part)} qismi` : "Claude'ning kun xulosasi";
}

/** "Hammasi" xulosasi uchun barcha qismlarni bitta `ProjectPartDto`ga birlashtiradi. */
export function combinePartsDto(parts: readonly ProjectPartDto[]): ProjectPartDto {
  const t = partsTotals(parts);
  const sum = (f: (p: ProjectPartDto) => number) => parts.reduce((a, p) => a + f(p), 0);
  const summary = { todo: sum((p) => p.summary.todo), doing: sum((p) => p.summary.doing), done: t.done, unknown: sum((p) => p.summary.unknown), total: t.total };
  const recentDone = parts
    .flatMap((p) => p.recentDone)
    .sort((a, b) => (b.doneOn ?? "").localeCompare(a.doneOn ?? ""))
    .slice(0, 8);
  const last = parts.map((p) => p.lastActivityAt).filter((x): x is string => !!x).sort();
  const upd = parts.map((p) => p.updatedAt).filter((x): x is string => !!x).sort();
  return {
    part: ALL_PARTS,
    name: "Hammasi",
    planFiles: parts.flatMap((p) => p.planFiles),
    summary,
    percent: t.pct,
    sessions: sum((p) => p.sessions),
    activeSeconds: sum((p) => p.activeSeconds),
    tokens: {
      inputTokens: sum((p) => p.tokens.inputTokens),
      outputTokens: sum((p) => p.tokens.outputTokens),
      cacheReadTokens: sum((p) => p.tokens.cacheReadTokens),
      cacheCreationTokens: sum((p) => p.tokens.cacheCreationTokens),
      totalTokens: sum((p) => p.tokens.totalTokens),
      costUsd: parts.every((p) => p.tokens.costUsd === null) ? null : sum((p) => p.tokens.costUsd ?? 0),
      requests: sum((p) => p.tokens.requests),
    },
    lastActivityAt: last.at(-1) ?? null,
    recentDone,
    byPhase: [],
    itemsTruncated: parts.some((p) => p.itemsTruncated),
    readTruncated: parts.some((p) => p.readTruncated),
    updatedAt: upd.at(-1) ?? null,
  };
}

export interface DoneSummaryView {
  headline: string;
  recent: Array<{ key: string; title: string; date: string | null }>;
  phases: Array<{ label: string; text: string; pct: number }>;
  stats: string;
  notes: string[];
}

/** Qism uchun "Bajarilganlar xulosasi": sanoq, oxirgi bajarilganlar, faza bo'yicha progress, vaqt/token (deterministik). */
export function doneSummaryView(p: ProjectPartDto): DoneSummaryView {
  const { done, doing, todo, total } = p.summary;
  const headline = total === 0 ? "Bu qismda reja bandlari topilmadi." : `${total} bandning ${done} tasi bajarilgan (${p.percent ?? 0}%), ${doing} tasi jarayonda, ${todo} tasi qolgan.`;
  const recent = p.recentDone.map((d: PartDoneItem) => ({ key: d.key, title: d.title, date: d.doneOn }));
  const phases = p.byPhase
    .filter((f) => f.total > 0)
    .map((f) => ({ label: f.phase ?? "Bo'limsiz", text: `${f.done}/${f.total}`, pct: Math.round((f.done / f.total) * 100) }));
  const parts: string[] = [];
  parts.push(`${p.sessions} ta sessiya`);
  parts.push(p.activeSeconds > 0 ? `faol vaqt ${formatDuration(p.activeSeconds * 1000)}` : "faol vaqt yo'q");
  parts.push(p.tokens.totalTokens > 0 ? `${formatTokens(p.tokens.totalTokens)} token` : "token yo'q");
  const notes: string[] = [];
  if (p.itemsTruncated) notes.push("Bandlar ro'yxati hajm sababli qisqartirilgan; sanoq to'liq fayl bo'yicha.");
  if (p.readTruncated) notes.push("Reja fayli juda katta: oxiri o'qilmagan.");
  return { headline, recent, phases, stats: parts.join(" · "), notes };
}

/** Qism ichida yangi sessiya ochish papkasi (loyiha ildizi + qism yo'li). */
export function partCwd(projectPath: string, part: string): string {
  return part === "" || part === ALL_PARTS ? projectPath : `${projectPath.replace(/\/+$/, "")}/${part}`;
}

export interface PartProgressRow {
  /** Qism yo'li (`''` = asosiy). */
  part: string;
  name: string;
  done: number;
  total: number;
  /** 0..100 yoki null (vazifa yo'q). */
  pct: number | null;
  /** Ish maydonidagi shu qism tab'iga havola (`?part=`). */
  hrefSuffix: string;
}

/** Loyiha sahifasidagi ixcham qismlar ro'yxati: ildiz faqat vazifasi bo'lsa; qismlar nom bo'yicha tartiblanadi. */
export function partProgressRows(parts: readonly ProjectPartDto[]): PartProgressRow[] {
  if (!parts.some((p) => p.part !== "")) return [];
  return parts
    .filter((p) => p.part !== "" || p.summary.total > 0)
    .map((p) => ({ part: p.part, name: p.part === "" ? "Asosiy" : p.name, done: p.summary.done, total: p.summary.total, pct: p.percent, hrefSuffix: p.part === "" ? "" : `?part=${encodeURIComponent(p.part)}` }));
}

/** Ildiz + qismlar bo'yicha umumiy xulosa (loyihalar ro'yxati "Reja" ustuni uchun); qism yo'q yoki vazifa yo'q = `null`. */
export function combinedPlanSummary(parts: readonly ProjectPartDto[]): { todo: number; doing: number; done: number; unknown: number; total: number } | null {
  if (!parts.some((p) => p.part !== "")) return null;
  const c = combinePartsDto(parts).summary;
  return c.total > 0 ? c : null;
}
