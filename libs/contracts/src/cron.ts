import { QUEUE_LIMITS } from './queue.js';

/**
 * Minimal 5 maydonli cron (daqiqa soat kun-oy oy hafta-kuni), Asia/Tashkent (UTC+5, DST YO'Q).
 * Qo'llab-quvvatlanadi: `*`, `a`, `a-b`, `a,b`, qadam (`*` yoki `a-b` dan keyin `/n`); nomlar yo'q (faqat raqam; hafta 0-7, 0 va 7 = yakshanba).
 * Standart semantika: kun-oy VA hafta-kuni ikkalasi cheklangan bo'lsa YOKI.
 * Eng kichik oraliq 60 daqiqa: daqiqa maydoni aynan bitta qiymatga yechilishi shart (bir soatda ikki marta ishga tushmaydi).
 */

export const TASHKENT_OFFSET_MS = 5 * 3_600_000;

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  domStar: boolean;
  dowStar: boolean;
}

export class CronError extends Error {}

function parseField(raw: string, min: number, max: number, name: string): { values: number[]; star: boolean } {
  const out = new Set<number>();
  let star = false;
  for (const part of raw.split(',')) {
    if (part === '') throw new CronError(`${name}: bo'sh qism`);
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`${name}: noto'g'ri qadam`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) throw new CronError(`${name}: noto'g'ri qadam`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
      if (stepRaw === undefined) star = true;
    } else if (/^\d+$/.test(range ?? '')) {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : max;
    } else if (/^\d+-\d+$/.test(range ?? '')) {
      const [a, b] = (range as string).split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      throw new CronError(`${name}: noto'g'ri qiymat "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`${name}: ${min}-${max} oralig'idan tashqari`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), star };
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('cron 5 ta maydondan iborat bo\'lishi kerak');
  const [mi, ho, dm, mo, dw] = parts as [string, string, string, string, string];
  const minutes = parseField(mi, 0, 59, 'daqiqa').values;
  const hours = parseField(ho, 0, 23, 'soat').values;
  const dom = parseField(dm, 1, 31, 'kun');
  const months = parseField(mo, 1, 12, 'oy').values;
  const dow = parseField(dw, 0, 7, 'hafta kuni');
  const dows = [...new Set(dow.values.map((d) => d % 7))].sort((a, b) => a - b);
  return { minutes, hours, doms: dom.values, months, dows, domStar: dom.star, dowStar: dow.star && dows.length === 7 };
}

/** Xato matni yoki null. */
export function validateCron(expr: string): string | null {
  try {
    const p = parseCron(expr);
    if (p.minutes.length !== 1) return `Eng kichik oraliq ${QUEUE_LIMITS.minCronIntervalMinutes} daqiqa: daqiqa maydoni bitta qiymat bo'lishi kerak`;
    return null;
  } catch (err) {
    if (err instanceof CronError) return err.message;
    throw err;
  }
}

function dayMatches(p: ParsedCron, y: number, m: number, d: number): boolean {
  if (!p.months.includes(m)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = p.doms.includes(d);
  const dowOk = p.dows.includes(dow);
  if (p.domStar && p.dowStar) return true;
  if (p.domStar) return dowOk;
  if (p.dowStar) return domOk;
  return domOk || dowOk;
}

/** `after` dan KEYINGI (qat'iy) birinchi ishga tushish vaqti (UTC Date). 5 yil ichida topilmasa null (masalan 31-fevral). */
export function nextCronRun(expr: string, after: Date): Date | null {
  const p = parseCron(expr);
  // Tashkent "devor soati" = UTC + 5h: hisob UTC maydonlarida (siljitilgan) bajariladi.
  const start = new Date(Math.floor((after.getTime() + TASHKENT_OFFSET_MS) / 60_000) * 60_000 + 60_000);
  const limitY = start.getUTCFullYear() + 5;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  let d = start.getUTCDate();
  const startDay = Date.UTC(y, m - 1, d);
  for (;;) {
    if (y > limitY) return null;
    if (dayMatches(p, y, m, d)) {
      const isStartDay = Date.UTC(y, m - 1, d) === startDay;
      const minOfDay = isStartDay ? start.getUTCHours() * 60 + start.getUTCMinutes() : 0;
      for (const h of p.hours) {
        for (const mi of p.minutes) {
          if (h * 60 + mi >= minOfDay) return new Date(Date.UTC(y, m - 1, d, h, mi) - TASHKENT_OFFSET_MS);
        }
      }
    }
    const nd = new Date(Date.UTC(y, m - 1, d + 1));
    y = nd.getUTCFullYear();
    m = nd.getUTCMonth() + 1;
    d = nd.getUTCDate();
  }
}
