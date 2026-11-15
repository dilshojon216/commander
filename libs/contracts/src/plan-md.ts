import { parseTasksMarkdown, phaseFromHeading, summarizeTasks } from './tasks-md.js';
import type { ProjectTaskStatus, TasksSummary } from './tasks-md.js';

/**
 * Loyiha QISMI (part) reja faylini o'qiydigan sof parser (task 6.15). Haqiqiy fayllar turlicha:
 *  (a) commander TASKS.md jadvali (`| # | Task | ... |`) va id'li `- [x] 1.4 Sarlavha` ro'yxati (`parseTasksMarkdown` ga topshiriladi);
 *  (b) GitHub checklist `- [ ]` / `- [x]` (ichma-ich ham), id'siz bo'lishi mumkin;
 *  (c) sarlavha bandlari `### [x] 1. Sarlavha — BAJARILDI (2026-08-03)` / `### [ ] 3a. ...`.
 * Aniqlash ustuvorligi: sarlavha bandlari (>= 2 ta) > jadval/id'li checklist > id'siz checklist. Sarlavha bandlari bor faylda
 * ichidagi checklistlar (qabul mezonlari) alohida vazifa EMAS: ular sarlavha bandining tafsiloti.
 *
 * Katta fayllar uchun mustahkam: vazifalar soni, sarlavha/faza uzunligi cheklangan; matn `redact()` dan chaqiruvchida o'tadi
 * (agentd): parser faqat tuzilma beradi. Id'siz band uchun barqaror kalit: `t` + sarlavha xeshi (tartib o'zgarsa ham o'zgarmaydi).
 */

export const PLAN_LIMITS = {
  /** Qism ichidagi saqlanadigan bandlar soni (qolgani `truncated`). */
  maxItems: 1000,
  maxTitle: 120,
  maxPhase: 80,
  maxKey: 32,
  /** Hisoblash chegarasi: shundan ortig'i umuman o'qilmaydi (progress ham shu bilan cheklanadi). */
  hardMaxItems: 5000,
} as const;

export interface PlanItem {
  /** Kichik harf id (`1.4`, `3a`) yoki sarlavha xeshidan `t...`. Faylda takror bo'lsa `-2`, `-3`. */
  key: string;
  title: string;
  phase: string | null;
  status: ProjectTaskStatus;
  rawStatus: string | null;
  order: number;
  size: string | null;
  /** Bajarilgan bandda sarlavhadagi birinchi `YYYY-MM-DD` sana (bo'lmasa `null`). */
  doneOn: string | null;
}

export type PlanFormat = 'table' | 'headings' | 'checklist' | 'none';

export interface PlanParseResult {
  items: PlanItem[];
  format: PlanFormat;
  /** Barcha o'qilgan bandlar bo'yicha (kesishdan OLDIN). */
  counts: TasksSummary;
  /** `maxItems` dan ortiqcha bandlar tashlandi. */
  truncated: boolean;
}

export interface PlanParseOptions {
  maxItems?: number;
}

const HEADING_ITEM_RE = /^(#{2,6})[ \t]+\[([ xX~-])\][ \t]*(.*)$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const CHECKLIST_RE = /^[ \t]*[-*+][ \t]+\[([ xX~-])\][ \t]+(.*)$/;
/** Id: raqamli (`1`, `2.15`, `3a`) yoki `AB-12`; keyin `.`/`)`/`:` yoki ` — `. Faqat bo'shliq yetarli emas (`10 ta test`). */
const ITEM_ID_RE = /^\**#?([0-9]+(?:\.[0-9]+)*[A-Za-z]?|[A-Za-z]{1,6}-[0-9]+)\**(?:[.):][ \t]*|[ \t]+[—–-][ \t]+)(.*)$/;
const DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const STATUS_TAIL_RE = /bajar|tuzat|done|yopil|tasdiq|qisman|hali |eskirgan|tekshirildi|20\d{2}-\d{2}-\d{2}/i;

const markToStatus = (m: string): ProjectTaskStatus => (m === ' ' ? 'todo' : m === '~' || m === '-' ? 'doing' : 'done');

/** FNV-1a 32-bit (brauzer va node uchun bir xil; kripto emas): id'siz bandlarning barqaror kaliti. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function cleanText(s: string): string {
  return s.replace(/`([^`]*)`/g, '$1').replace(/\*\*/g, '').replace(/__/g, '').replace(/\s+/g, ' ').trim();
}

/** Sarlavhadan holat dumi (` — BAJARILDI (2026-08-03)`) ni kesadi: faqat em/en tire va dum holat so'zi/sanasini tutganda. */
function stripStatusTail(s: string): string {
  const m = /\s[—–]\s/.exec(s);
  if (!m) return s;
  return STATUS_TAIL_RE.test(s.slice(m.index + m[0].length)) ? s.slice(0, m.index) : s;
}

function titleOf(raw: string, max: number): string {
  const t = cleanText(stripStatusTail(raw));
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function validKey(id: string): string | null {
  const k = id.toLowerCase().replace(/\.+$/, '');
  return k.length > 0 && k.length <= PLAN_LIMITS.maxKey && /^[a-z0-9][a-z0-9._-]*$/.test(k) ? k : null;
}

function uniqueKey(base: string, seen: Set<string>): string {
  let key = base;
  for (let n = 2; seen.has(key); n++) {
    const suffix = `-${n}`;
    key = `${base.slice(0, PLAN_LIMITS.maxKey - suffix.length)}${suffix}`;
  }
  seen.add(key);
  return key;
}

function doneDate(text: string): string | null {
  const m = DATE_RE.exec(text);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function headingItems(lines: string[]): PlanItem[] {
  const out: PlanItem[] = [];
  const seen = new Set<string>();
  /** daraja -> eng so'nggi oddiy (band bo'lmagan) sarlavha matni. */
  const stack = new Map<number, string>();
  for (const line of lines) {
    if (out.length >= PLAN_LIMITS.hardMaxItems) break;
    const item = HEADING_ITEM_RE.exec(line);
    if (item) {
      const level = item[1]!.length;
      const body = item[3]!.trim();
      if (!body) continue;
      const mark = item[2]!;
      const status = markToStatus(mark);
      let phase: string | null = null;
      for (let l = level - 1; l >= 1; l--) {
        const h = stack.get(l);
        if (h) {
          phase = phaseFromHeading(h).slice(0, PLAN_LIMITS.maxPhase);
          break;
        }
      }
      const idm = ITEM_ID_RE.exec(body);
      const id = idm ? validKey(idm[1]!) : null;
      const rest = idm && id ? idm[2]!.trim() || body : body;
      const title = titleOf(rest, PLAN_LIMITS.maxTitle);
      if (!title) continue;
      const key = uniqueKey(id ?? `t${fnv1a(title.toLowerCase())}`, seen);
      out.push({ key, title, phase, status, rawStatus: `[${mark}]`, order: out.length, size: null, doneOn: status === 'done' ? doneDate(body) : null });
      for (const k of [...stack.keys()]) if (k >= level) stack.delete(k);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1]!.length;
      for (const k of [...stack.keys()]) if (k >= level) stack.delete(k);
      stack.set(level, h[2]!.trim());
    }
  }
  return out;
}

function checklistItems(lines: string[]): PlanItem[] {
  const out: PlanItem[] = [];
  const seen = new Set<string>();
  const stack = new Map<number, string>();
  let inFence = false;
  for (const line of lines) {
    if (out.length >= PLAN_LIMITS.hardMaxItems) break;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1]!.length;
      for (const k of [...stack.keys()]) if (k >= level) stack.delete(k);
      stack.set(level, h[2]!.trim());
      continue;
    }
    const c = CHECKLIST_RE.exec(line);
    if (!c) continue;
    const mark = c[1]!;
    const body = c[2]!.trim();
    const idm = ITEM_ID_RE.exec(body);
    const id = idm ? validKey(idm[1]!) : null;
    const title = titleOf(id && idm ? idm[2]!.trim() || body : body, PLAN_LIMITS.maxTitle);
    if (!title) continue;
    const status = markToStatus(mark);
    let phase: string | null = null;
    const levels = [...stack.keys()].sort((a, b) => b - a);
    if (levels.length > 0) phase = phaseFromHeading(stack.get(levels[0]!)!).slice(0, PLAN_LIMITS.maxPhase);
    const key = uniqueKey(id ?? `t${fnv1a(title.toLowerCase())}`, seen);
    out.push({ key, title, phase, status, rawStatus: `[${mark}]`, order: out.length, size: null, doneOn: status === 'done' ? doneDate(body) : null });
  }
  return out;
}

/** Reja faylini bandlarga ajratadi. Bo'sh/tanilmagan fayl: `format: 'none'`, bo'sh ro'yxat. */
export function parsePlanMarkdown(md: string, options: PlanParseOptions = {}): PlanParseResult {
  const opts: Required<PlanParseOptions> = { maxItems: options.maxItems ?? PLAN_LIMITS.maxItems };
  const lines = md.split(/\r?\n/);

  let items: PlanItem[] = [];
  let format: PlanFormat = 'none';

  const headings = headingItems(lines);
  if (headings.length >= 2) {
    items = headings;
    format = 'headings';
  } else {
    const base = parseTasksMarkdown(md);
    if (base.length > 0) {
      items = base.slice(0, PLAN_LIMITS.hardMaxItems).map((t, i) => ({
        key: t.key,
        title: t.title.length > PLAN_LIMITS.maxTitle ? `${t.title.slice(0, PLAN_LIMITS.maxTitle - 1).trimEnd()}…` : t.title,
        phase: t.phase ? t.phase.slice(0, PLAN_LIMITS.maxPhase) : null,
        status: t.status,
        rawStatus: t.rawStatus,
        order: i,
        size: t.size,
        doneOn: null,
      }));
      format = items.every((t) => t.rawStatus?.startsWith('[')) ? 'checklist' : 'table';
    } else {
      const lists = checklistItems(lines);
      if (lists.length > 0) {
        items = lists;
        format = 'checklist';
      } else if (headings.length === 1) {
        items = headings;
        format = 'headings';
      }
    }
  }

  const counts = summarizeTasks(items);
  const cap = Math.max(0, opts.maxItems);
  const truncated = items.length > cap;
  return { items: truncated ? items.slice(0, cap) : items, format, counts, truncated };
}

/** Bajarilganlar ulushi (0..100, butun); bandlar yo'q bo'lsa `null`. */
export function planPercent(c: Pick<TasksSummary, 'done' | 'total'>): number | null {
  return c.total > 0 ? Math.round((c.done / c.total) * 100) : null;
}
