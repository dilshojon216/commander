/** Asia/Tashkent = UTC+5, DST yo'q (1991 yildan): kun chegaralari qat'iy 5 soatga siljigan UTC yarim kecha. */
export const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

export const isValidDay = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(d);
};

/** `YYYY-MM-DD` (Toshkent) kunining boshlanishi (UTC instant). */
export function tashkentDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - TASHKENT_OFFSET_MS);
}

/** Kun oralig'i `[start, end)`. */
export function tashkentDayRange(day: string): { start: Date; end: Date } {
  const start = tashkentDayStart(day);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Berilgan instant qaysi Toshkent kuniga tushadi (`YYYY-MM-DD`). */
export function tashkentDayOf(at: Date): string {
  return new Date(at.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** `from..to` (ikkalasi ham kiradi) kunlar ro'yxati. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
