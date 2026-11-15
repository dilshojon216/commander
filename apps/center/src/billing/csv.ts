import type { Cell } from './timesheet-rows.js';

/**
 * CSV (RFC 4180) va formula-in'ektsiyadan himoya: katak matni `= + - @` yoki boshqaruv belgisi (TAB/CR/LF) bilan boshlansa
 * (bo'sh joydan keyin ham), oldiga `'` qo'yiladi: jadval dasturi uni formula deb baholamaydi. Raqamlar o'zgarishsiz.
 */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]/;
const CONTROL_START = /^[\t\r\n]/;

/** Formula deb baholanishi mumkin bo'lgan matnni neytrallaydi (oldiga `'`). */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) || CONTROL_START.test(text) ? `'${text}` : text;
}

export function csvEscapeText(text: string): string {
  const safe = neutralizeFormula(text);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvCell(v: Cell): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return csvEscapeText(v);
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  const lines = [headers.map((h) => csvEscapeText(h)).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  // UTF-8 BOM: Excel o'zbekcha belgilarni to'g'ri ochadi
  return `﻿${lines.join('\r\n')}\r\n`;
}
