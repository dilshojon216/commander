/**
 * TASKS.md jadvalini o'qiydigan sof parser (task 2.8). agentd yubormaydi: markaz `project_tasks`ni shu
 * funksiya bilan yasaydi, dashboard ham xuddi shuni ishlatadi (yagona manba).
 *
 * Standart (commander'ning o'z `docs/TASKS.md`): har faza `## Faza N ...` sarlavhasi ostida jadval
 * `| # | Task | ... | Hajm |`; qator holati task katagi boshidagi belgi (`✅` = bajarilgan, `🚧`/`⏳`/`🔄` = jarayonda).
 * Variantlar: alohida `Holat|Status` ustuni; `- [x] 1.4 Sarlavha` / `- [ ] ...` ro'yxatlari.
 * Holat aniqlab bo'lmasa: ustunsiz/belgisiz qator = `todo`; ustun bor, lekin qiymat tanilmagan = `unknown`.
 */

export const PROJECT_TASK_STATUSES = ['todo', 'doing', 'done', 'unknown'] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export interface ParsedTask {
  /** Kichik harfga keltirilgan id (`1.4`, `1.1a`). */
  key: string;
  title: string;
  /** Eng yaqin oldingi `##` sarlavhasi (faza). */
  phase: string | null;
  status: ProjectTaskStatus;
  /** Holat belgisi yoki ustun matni (≤64 belgi); belgi/ustun bo'lmasa `null`. */
  rawStatus: string | null;
  /** Fayldagi tartib (0 dan). */
  order: number;
  /** Hajm ustuni (S/M/L), bo'lsa. */
  size: string | null;
}

export interface TasksSummary {
  done: number;
  doing: number;
  todo: number;
  unknown: number;
  total: number;
}

const MAX_TASKS = 2000;
const MAX_TITLE = 200;
const MAX_KEY = 32;
const MAX_RAW = 64;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (cells: string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

const DOING_MARK = /^(🚧|⏳|🔄|◐|🟡|\[~\]|\[-\])/u;
const DONE_MARK = /^(✅|✔️?|☑️?|\[x\])/iu;
const TODO_MARK = /^(⬜|☐|\[ \]|🔲)/u;

const DONE_WORDS = /✅|✔|bajarildi|bajarilgan|done|tayyor|complete|finished|closed/iu;
const DOING_WORDS = /jarayon|doing|progress|🚧|⏳|🔄|◐|ishlanmoqda|started|wip/iu;
const TODO_WORDS = /^(?:todo|to do|qoldi|kutilmoqda|kutmoqda|pending|planned|reja|backlog|open|not started|boshlanmagan|⬜|☐|🔲)$/iu;

function statusFromCell(cell: string): ProjectTaskStatus | null {
  const v = cell.trim();
  if (!v) return null;
  if (TODO_WORDS.test(v)) return 'todo';
  if (DONE_WORDS.test(v)) return 'done';
  if (DOING_WORDS.test(v)) return 'doing';
  return 'unknown';
}

function stripMd(s: string): string {
  return s.replace(/`([^`]*)`/g, '$1').replace(/\*\*/g, '').replace(/__/g, '').replace(/\s+/g, ' ').trim();
}

function cleanTitle(cell: string): string {
  let t = cell.replace(DONE_MARK, '').replace(DOING_MARK, '').replace(TODO_MARK, '').trim();
  // Boshidagi `**(2026-11-13 bajarildi ...)**` izohi
  t = t.replace(/^\*\*\((?:(?!\*\*).)*\)\*\*\s*/, '');
  // Katak qalin bo'lak bilan boshlansa, u qisqa sarlavha (`**Spike: ...** — izoh`)
  const bold = /^\*\*([^*]+)\*\*/.exec(t);
  if (bold && bold[1]!.trim() && !bold[1]!.trim().startsWith('(')) t = bold[1]!.trim();
  t = stripMd(t);
  if (t.length > MAX_TITLE) t = `${t.slice(0, MAX_TITLE - 1).trimEnd()}…`;
  return t;
}

/** Id katagi: markdown belgilarsiz, bo'shliqsiz, qisqa. Aks holda `null` (qator vazifa emas). */
function cleanKey(cell: string): string | null {
  const k = stripMd(cell).replace(/^#/, '').trim().toLowerCase();
  if (!k || k.length > MAX_KEY || /\s/.test(k)) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(k) ? k : null;
}

/** Faza nomi: `##` sarlavhasi matni (parser `phase` ga shuni yozadi). agentd tahrirda faza sarlavhasini shu bilan solishtiradi. */
export function phaseFromHeading(headingText: string): string {
  return stripMd(headingText).slice(0, 200);
}

/** Sarlavha qatori (`## Faza 2 ...`) bo'lsa faza nomi (parser qoidasi: `##` va undan chuqur). `#` (1-daraja) faza emas: `null`. */
export function phaseOfHeadingLine(line: string): string | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m || m[1]!.length < 2) return null;
  return phaseFromHeading(m[2]!);
}

/** Jadval qatorini katakchalarga bo'ladi (agentd tahrirda ustunlarni aniqlash uchun). */
export function splitTableRow(line: string): string[] {
  return splitRow(line);
}

export function isTableSeparatorCells(cells: string[]): boolean {
  return isSeparator(cells);
}

/** Jadval sarlavhasidan ustunlar: id/title/size indekslari (aniqlanmasa `null`). */
export function detectTableColumns(cells: string[]): { id: number; title: number; status: number | null; size: number | null } | null {
  return detectColumns(cells);
}

const raw = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, MAX_RAW) : null;
};

interface Columns {
  id: number;
  title: number;
  status: number | null;
  size: number | null;
}

function detectColumns(cells: string[]): Columns | null {
  const idIdx = cells.findIndex((c) => /^(#|id|№|no\.?|task ?id|key|raqam)$/i.test(c.trim()));
  if (idIdx === -1) return null;
  let titleIdx = cells.findIndex((c) => /^(task|vazifa|title|name|nom|tavsif|description|ish)/i.test(c.trim()));
  if (titleIdx === -1) titleIdx = idIdx + 1 < cells.length ? idIdx + 1 : -1;
  if (titleIdx === -1 || titleIdx === idIdx) return null;
  const statusIdx = cells.findIndex((c) => /^(holat|status|state|done|bajarildi)/i.test(c.trim()));
  const sizeIdx = cells.findIndex((c) => /^(hajm|size|estimate|baho)/i.test(c.trim()));
  return { id: idIdx, title: titleIdx, status: statusIdx === -1 ? null : statusIdx, size: sizeIdx === -1 ? null : sizeIdx };
}

const CHECKLIST_RE = /^\s*[-*+]\s+\[([ xX~-])\]\s+(.*)$/;
const CHECKLIST_ID_RE = /^\**\s*(?:task\s+)?([0-9]+(?:\.[0-9]+)*[A-Za-z]?|[A-Za-z]{1,6}-[0-9]+)\s*\**(?:[\s.:)—–-]+|$)(.*)$/;

export function parseTasksMarkdown(md: string): ParsedTask[] {
  const lines = md.split(/\r?\n/);
  const out: ParsedTask[] = [];
  const seen = new Set<string>();
  let phase: string | null = null;
  let cols: Columns | null = null;

  const push = (t: Omit<ParsedTask, 'order'>): void => {
    if (seen.has(t.key) || out.length >= MAX_TASKS) return;
    seen.add(t.key);
    out.push({ ...t, order: out.length });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (line.startsWith('##')) phase = stripMd(heading[1]!).slice(0, 200);
      cols = null;
      continue;
    }
    const check = CHECKLIST_RE.exec(line);
    if (check) {
      cols = null;
      const mark = check[1]!;
      const body = check[2]!.trim();
      const m = CHECKLIST_ID_RE.exec(body);
      const key = m ? cleanKey(m[1]!) : null;
      if (m && key) {
        const status: ProjectTaskStatus = mark === ' ' ? 'todo' : mark === '~' || mark === '-' ? 'doing' : 'done';
        push({ key, title: cleanTitle(m[2]!.trim() || body), phase, status, rawStatus: `[${mark}]`, size: null });
      }
      continue;
    }
    if (!line.trim().startsWith('|')) {
      cols = null; // jadval `|` bilan boshlanmagan qatorda tugaydi
      continue;
    }
    const cells = splitRow(line);
    if (!cols) {
      // Sarlavha qatori: keyingi qator ajratgich bo'lishi shart
      const next = lines[i + 1] !== undefined ? splitRow(lines[i + 1]!) : [];
      if (!isSeparator(next)) continue;
      cols = detectColumns(cells);
      if (cols) i++; // ajratgichni o'tkazish
      continue;
    }
    if (isSeparator(cells)) continue;
    const key = cleanKey(cells[cols.id] ?? '');
    const titleCell = cells[cols.title] ?? '';
    if (!key || !titleCell.trim()) continue;

    const t = titleCell.trim();
    let status: ProjectTaskStatus = 'todo';
    let rawStatus: string | null = null;
    const statusCell = cols.status === null ? '' : (cells[cols.status] ?? '').trim();
    const fromCell = statusFromCell(statusCell);
    const markMatch = DONE_MARK.exec(t) ?? DOING_MARK.exec(t) ?? TODO_MARK.exec(t);
    if (fromCell !== null) {
      status = fromCell;
      rawStatus = raw(statusCell);
    } else if (markMatch) {
      status = DONE_MARK.test(t) ? 'done' : DOING_MARK.test(t) ? 'doing' : 'todo';
      rawStatus = raw(markMatch[1]);
    }
    push({
      key,
      title: cleanTitle(t),
      phase,
      status,
      rawStatus,
      size: cols.size === null ? null : raw(cells[cols.size]),
    });
  }
  return out;
}

export function summarizeTasks(rows: ReadonlyArray<Pick<ParsedTask, 'status'>>): TasksSummary {
  const s: TasksSummary = { done: 0, doing: 0, todo: 0, unknown: 0, total: rows.length };
  for (const r of rows) s[r.status] += 1;
  return s;
}
