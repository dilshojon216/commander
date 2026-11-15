import { detectTableColumns, isTableSeparatorCells, parseTasksMarkdown, phaseOfHeadingLine, splitTableRow } from '@commander/contracts';
import type { AppendTask } from '@commander/contracts';

/**
 * TASKS.md'ga qator qo'shish (sof matn funksiyasi; fayl I/O `project-ops.ts`da).
 *
 * Kafolatlar:
 *  - mavjud mazmun BAYTMA-BAYT saqlanadi, faqat kiritilgan qatorlar qo'shiladi (CRLF/LF aralash, BOM, oxirgi qatorsiz fayl ham);
 *  - qator ajratgichi: jadvalning oxirgi qatoridagi (yo'q bo'lsa fayldagi birinchi) ajratgich;
 *  - qatorlar faza (`##`) jadvalining OXIRIGA qo'shiladi, ustunlar mavjud sarlavhadan (id/title/size) aniqlanadi, qolgan kataklar bo'sh;
 *  - faza topilmasa fayl oxirida yangi `## faza` bo'limi (jadval sarlavhasi fayldagi birinchi mos jadvaldan ko'chiriladi);
 *  - mavjud id'li vazifa qo'shilmaydi (`skippedKeys`).
 */

export interface AppendResultText {
  content: string;
  added: number;
  skippedKeys: string[];
  createdPhase: boolean;
}

interface Line {
  text: string;
  eol: string;
}

function splitLines(content: string): Line[] {
  const out: Line[] = [];
  const re = /([^\r\n]*)(\r\n|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0] === '' && m.index >= content.length) break;
    out.push({ text: m[1]!, eol: m[2]! });
    if (m[2] === '') break;
  }
  return out;
}

const escapeCell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

interface TableBlock {
  headerIdx: number;
  /** Oxirgi jadval qatori (ajratgich yoki ma'lumot). */
  lastIdx: number;
  cols: NonNullable<ReturnType<typeof detectTableColumns>>;
  width: number;
}

/** `[from, to)` oraliqdagi jadvallar: sarlavha + ajratgich + ma'lumot qatorlari. */
function findTables(lines: Line[], from: number, to: number): TableBlock[] {
  const tables: TableBlock[] = [];
  for (let i = from; i < to; i++) {
    if (!lines[i]!.text.trim().startsWith('|')) continue;
    const header = splitTableRow(lines[i]!.text);
    const sep = i + 1 < to ? splitTableRow(lines[i + 1]?.text ?? '') : [];
    if (!lines[i + 1]?.text.trim().startsWith('|') || !isTableSeparatorCells(sep)) {
      // jadval emas yoki sarlavhasiz: o'tkazib yuboramiz
      while (i + 1 < to && lines[i + 1]!.text.trim().startsWith('|')) i++;
      continue;
    }
    const cols = detectTableColumns(header);
    let last = i + 1;
    while (last + 1 < to && lines[last + 1]!.text.trim().startsWith('|')) last++;
    if (cols) tables.push({ headerIdx: i, lastIdx: last, cols, width: header.length });
    i = last;
  }
  return tables;
}

function buildRow(t: AppendTask, cols: TableBlock['cols'], width: number): string {
  const cells = Array<string>(width).fill('');
  cells[cols.id] = t.key;
  cells[cols.title] = escapeCell(t.title);
  if (cols.size !== null && t.size) cells[cols.size] = t.size;
  return `| ${cells.join(' | ')} |`;
}

export function appendTasksToMd(content: string, phase: string, tasks: readonly AppendTask[]): AppendResultText {
  const existingKeys = new Set(parseTasksMarkdown(content).map((t) => t.key));
  const fresh: AppendTask[] = [];
  const skippedKeys: string[] = [];
  for (const t of tasks) {
    if (existingKeys.has(t.key) || fresh.some((f) => f.key === t.key)) skippedKeys.push(t.key);
    else fresh.push(t);
  }
  if (fresh.length === 0) return { content, added: 0, skippedKeys, createdPhase: false };

  const lines = splitLines(content);
  const eolOf = (preferIdx?: number): string => {
    if (preferIdx !== undefined && lines[preferIdx]?.eol) return lines[preferIdx]!.eol;
    const first = lines.find((l) => l.eol !== '');
    return first?.eol ?? '\n';
  };

  // Faza bo'limi: `phase` sarlavhasi (parser qoidasi bilan bir xil normallashtirish) -> keyingi sarlavhagacha
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (phaseOfHeadingLine(lines[i]!.text) === phase) {
      start = i;
      break;
    }
  }

  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,6}\s+/.test(lines[i]!.text)) {
        end = i;
        break;
      }
    }
    const tables = findTables(lines, start + 1, end);
    const tbl = tables[tables.length - 1];
    if (tbl) {
      const eol = eolOf(tbl.lastIdx);
      const rows = fresh.map((t) => buildRow(t, tbl.cols, tbl.width));
      const lastLine = lines[tbl.lastIdx]!;
      if (lastLine.eol === '') {
        // Fayl oxirigacha qatorsiz tugagan: oxirgi qatorga ajratgich qo'shamiz, yangi qatorlar ajratgichsiz tugaydi
        const eolNew = eolOf();
        lines[tbl.lastIdx] = { text: lastLine.text, eol: eolNew };
        const inserted = rows.map((r, i) => ({ text: r, eol: i === rows.length - 1 ? '' : eolNew }));
        lines.splice(tbl.lastIdx + 1, 0, ...inserted);
      } else {
        lines.splice(tbl.lastIdx + 1, 0, ...rows.map((r) => ({ text: r, eol })));
      }
      return { content: join(lines), added: fresh.length, skippedKeys, createdPhase: false };
    }
    // Bo'lim bor, jadval yo'q: sarlavhadan keyin jadval yaratamiz (sarlavha shablon: fayldagi birinchi mos jadvaldan)
    const eol = eolOf(start);
    const block = newTable(lines, fresh, eol);
    lines.splice(start + 1, 0, { text: '', eol }, ...block);
    return { content: join(lines), added: fresh.length, skippedKeys, createdPhase: false };
  }

  // Faza yo'q: fayl oxirida yangi bo'lim
  const eol = eolOf();
  const block = newTable(lines, fresh, eol);
  const tail = lines[lines.length - 1];
  const out: Line[] = [...lines];
  if (out.length > 0 && tail && tail.eol === '') out[out.length - 1] = { text: tail.text, eol };
  if (out.length > 0 && out[out.length - 1]!.text.trim() !== '') out.push({ text: '', eol });
  out.push({ text: `## ${phase}`, eol }, { text: '', eol }, ...block);
  // oxirgi qator ajratgichi: fayl qatorsiz tugamagan bo'lsa saqlaymiz
  return { content: join(out), added: fresh.length, skippedKeys, createdPhase: true };
}

function newTable(lines: Line[], tasks: AppendTask[], eol: string): Line[] {
  // Shablon: fayldagi birinchi jadval (id + title ustunlari bor): sarlavha va ajratgichni nusxalaymiz
  const tbl = findTables(lines, 0, lines.length)[0];
  let header: string;
  let sep: string;
  let cols: TableBlock['cols'];
  let width: number;
  if (tbl) {
    header = lines[tbl.headerIdx]!.text;
    sep = lines[tbl.headerIdx + 1]!.text;
    cols = tbl.cols;
    width = tbl.width;
  } else {
    header = '| # | Task | Hajm |';
    sep = '|---|---|---|';
    cols = { id: 0, title: 1, status: null, size: 2 };
    width = 3;
  }
  return [{ text: header, eol }, { text: sep, eol }, ...tasks.map((t) => ({ text: buildRow(t, cols, width), eol }))];
}

function join(lines: Line[]): string {
  return lines.map((l) => l.text + l.eol).join('');
}
