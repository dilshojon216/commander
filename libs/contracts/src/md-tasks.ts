import type { ParsedTask } from './tasks-md.js';

/**
 * `.md` spec fayldan nomzod vazifalarni ajratish (task 2.15). Deterministik, LLM'siz, sof funksiya.
 * Manba: sarlavhalar (faqat ro'yxatsiz "barg" sarlavhalar), `- [ ]` ro'yxatlari, raqamli ro'yxatlar (`1.`, `1)`).
 * Kod to'siqlari (``` / ~~~) va front matter e'tiborsiz. Faqat yuqori darajadagi (chuqur ichma-ich emas) bandlar.
 */

export type CandidateSource = 'heading' | 'checklist' | 'numbered';

export interface TaskCandidate {
  title: string;
  source: CandidateSource;
  /** Fayldagi qator (1 dan). */
  line: number;
  /** Eng yaqin oldingi sarlavha matni (guruh), bo'lsa. */
  group: string | null;
  /** `- [x]`: allaqachon bajarilgan deb belgilangan (UI default tanlamaydi). */
  checked: boolean;
  /** Loyiha TASKS.md'dagi shu sarlavhali vazifa id'si (dublikat), bo'lmasa `null`. */
  alreadyInTasks: string | null;
}

export const MD_EXTRACT_LIMITS = { maxCandidates: 100, minTitle: 3, maxTitle: 200 } as const;

const GENERIC_HEADINGS = new Set(
  [
    'overview', 'introduction', 'intro', 'background', 'goals', 'goal', 'non-goals', 'summary', 'notes', 'note', 'references', 'appendix', 'table of contents', 'toc', 'contents',
    'context', 'motivation', 'requirements', 'open questions', 'risks', 'timeline', 'glossary', 'faq', 'changelog', 'status', 'license',
    'maqsad', 'kirish', 'izoh', 'izohlar', 'xulosa', 'tarix', 'mundarija', 'xavflar', 'ochiq savollar', 'tushuncha', 'havolalar', 'umumiy', 'umumiy ma\'lumot',
  ].map((s) => s.toLowerCase()),
);

function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(raw: string): string {
  let t = stripInline(raw);
  t = t.replace(/^[-–—:.\s]+/, '').replace(/[\s.:;,]+$/, '');
  if (t.length > MD_EXTRACT_LIMITS.maxTitle) t = `${t.slice(0, MD_EXTRACT_LIMITS.maxTitle - 1).trimEnd()}…`;
  return t;
}

const normTitle = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

interface Raw {
  title: string;
  source: CandidateSource;
  line: number;
  headingIdx: number | null;
  checked: boolean;
  level?: number;
}

export function extractCandidateTasks(md: string, existing: ReadonlyArray<Pick<ParsedTask, 'key' | 'title'>> = []): TaskCandidate[] {
  const lines = md.split(/\r?\n/);
  let i = 0;
  // front matter
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  const headings: Array<{ text: string; level: number; line: number; hasItems: boolean }> = [];
  const raws: Raw[] = [];
  let fence: string | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1]!.startsWith(fence[0]!) && fm[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fm) {
      fence = fm[1]!;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      headings.push({ text: cleanTitle(h[2]!), level: h[1]!.length, line: i + 1, hasItems: false });
      continue;
    }
    const check = /^( {0,1})[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (check) {
      raws.push({ title: check[3]!, source: 'checklist', line: i + 1, headingIdx: headings.length - 1, checked: check[2] !== ' ' });
      continue;
    }
    const num = /^( {0,1})\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (num) {
      raws.push({ title: num[2]!, source: 'numbered', line: i + 1, headingIdx: headings.length - 1, checked: false });
    }
  }

  for (const r of raws) if (r.headingIdx !== null && r.headingIdx >= 0) headings[r.headingIdx]!.hasItems = true;

  const all: Raw[] = [...raws];
  headings.forEach((h, idx) => {
    if (h.level < 2 || h.level > 3 || h.hasItems) return; // 1-daraja = hujjat sarlavhasi; ro'yxatli sarlavha guruh
    if (GENERIC_HEADINGS.has(h.text.toLowerCase())) return;
    all.push({ title: h.text, source: 'heading', line: h.line, headingIdx: idx - 1 >= 0 ? idx - 1 : null, checked: false, level: h.level });
  });
  all.sort((a, b) => a.line - b.line);

  const existingByTitle = new Map(existing.map((t) => [normTitle(t.title), t.key]));
  const seen = new Set<string>();
  const out: TaskCandidate[] = [];
  for (const r of all) {
    const title = cleanTitle(r.title);
    if (title.length < MD_EXTRACT_LIMITS.minTitle || !/[\p{L}\p{N}]/u.test(title)) continue;
    const norm = normTitle(title);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    // guruh: heading manbasi uchun ota sarlavha, aks holda eng yaqin oldingi sarlavha
    const gIdx = r.headingIdx;
    const group = gIdx !== null && gIdx >= 0 ? (headings[gIdx]?.text ?? null) : null;
    out.push({ title, source: r.source, line: r.line, group: group || null, checked: r.checked, alreadyInTasks: existingByTitle.get(norm) ?? null });
    if (out.length >= MD_EXTRACT_LIMITS.maxCandidates) break;
  }
  return out;
}

// --- yangi vazifa id'larini taklif qilish -------------------------------------------------------

type KeyStyle = 'dotted' | 'prefixed' | 'int';
const DOTTED = /^(\d+)\.(\d+)[a-z]?$/;
const PREFIXED = /^([a-z]{1,6})-(\d+)$/;
const INT = /^\d+$/;

function styleOf(key: string): KeyStyle | null {
  if (DOTTED.test(key)) return 'dotted';
  if (PREFIXED.test(key)) return 'prefixed';
  if (INT.test(key)) return 'int';
  return null;
}

function dominantStyle(keys: string[]): KeyStyle | null {
  const count: Record<KeyStyle, number> = { dotted: 0, prefixed: 0, int: 0 };
  for (const k of keys) {
    const s = styleOf(k);
    if (s) count[s]++;
  }
  const best = (Object.entries(count) as Array<[KeyStyle, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : null;
}

/**
 * Tanlangan fazadagi vazifa id'lari tartibiga ergashib keyingi `count` ta id'ni taklif qiladi (loyihadagi hech bir id bilan to'qnashmaydi):
 *  - `2.15`, `2.16` (nuqtali: faza ichidagi eng ko'p uchraydigan major, minor+1);
 *  - `SW-12` -> `SW-13`; `12` -> `13`.
 * Faza bo'sh/yangi bo'lsa: nuqtali uslubda keyingi major `.1`, boshqa uslubda loyiha bo'yicha keyingi raqam.
 */
export function suggestTaskKeys(tasks: ReadonlyArray<Pick<ParsedTask, 'key' | 'phase'>>, phase: string | null, count: number): string[] {
  const all = new Set(tasks.map((t) => t.key.toLowerCase()));
  const inPhase = tasks.filter((t) => t.phase === phase).map((t) => t.key.toLowerCase());
  const style = dominantStyle(inPhase) ?? dominantStyle([...all]) ?? 'int';
  const out: string[] = [];
  const take = (k: string): boolean => {
    if (all.has(k)) return false;
    all.add(k);
    out.push(k);
    return true;
  };

  if (style === 'dotted') {
    const phaseKeys = inPhase.filter((k) => DOTTED.test(k));
    let major: number;
    let minor: number;
    if (phaseKeys.length > 0) {
      const byMajor = new Map<number, number>();
      for (const k of phaseKeys) {
        const m = DOTTED.exec(k)!;
        byMajor.set(Number(m[1]), Math.max(byMajor.get(Number(m[1])) ?? 0, Number(m[2])));
      }
      const freq = new Map<number, number>();
      for (const k of phaseKeys) freq.set(Number(DOTTED.exec(k)![1]), (freq.get(Number(DOTTED.exec(k)![1])) ?? 0) + 1);
      major = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
      minor = byMajor.get(major)! + 1;
    } else {
      const majors = [...all].map((k) => DOTTED.exec(k)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
      major = (majors.length ? Math.max(...majors) : 0) + 1;
      minor = 1;
    }
    while (out.length < count) take(`${major}.${minor++}`);
  } else if (style === 'prefixed') {
    const src = inPhase.filter((k) => PREFIXED.test(k));
    const pool = src.length > 0 ? src : [...all].filter((k) => PREFIXED.test(k));
    const prefix = PREFIXED.exec(pool[pool.length - 1]!)![1]!;
    let n = Math.max(...[...all].map((k) => PREFIXED.exec(k)).filter((m): m is RegExpExecArray => m !== null && m[1] === prefix).map((m) => Number(m[2])), 0) + 1;
    while (out.length < count) take(`${prefix}-${n++}`);
  } else {
    let n = Math.max(...[...all].filter((k) => INT.test(k)).map(Number), 0) + 1;
    while (out.length < count) take(String(n++));
  }
  return out;
}
