/**
 * Faol vaqt hisobi (6.7), sof mantiq.
 *
 * TA'RIF. "Faol" = sessiya `working` yoki `awaiting_approval` holatida bo'lgan vaqt (egasi kutilayotgan bo'lsa ham Claude
 * ishining bir qismi). Har holat oralig'i `[ts, min(keyingi hodisa, ts + CAP)]`: oxirgi hodisadan keyin indamay qolgan
 * sessiya vaqtni cheksiz o'stirmaydi (CAP = 4 soat). Oraliqlar davr oynasiga `[from, to)` kesiladi (Asia/Tashkent kun
 * chegaralari: chaqiruvchi UTC instantlarini beradi). Guruh ichida (vazifa / loyiha / mijoz) oraliqlar BIRLASHTIRILADI:
 * parallel sessiyalar bir vaqtni ikki marta sanamaydi.
 */

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['working', 'awaiting_approval']);
export const ACTIVE_CAP_MS = 4 * 3_600_000;

export interface Interval {
  start: number;
  end: number;
}

export interface StatusEvent {
  /** Sessiya (ichki) id'si: sessiyalar alohida oqim. */
  sessionId: string;
  ts: number;
  status: string;
  /** Shu sessiyaning keyingi hodisasi vaqti (yo'q = oxirgisi). */
  nextTs: number | null;
}

/** Hodisalardan faol oraliqlar (oynaga kesilgan, bo'sh oraliqlar tashlangan). `now` oxirgi ochiq oraliqni kelajakka cho'zmaydi. */
export function activeIntervals(events: readonly StatusEvent[], window: Interval, now: number, capMs: number = ACTIVE_CAP_MS): Array<Interval & { sessionId: string }> {
  const out: Array<Interval & { sessionId: string }> = [];
  for (const e of events) {
    if (!ACTIVE_STATUSES.has(e.status)) continue;
    const capEnd = e.ts + capMs;
    const natural = e.nextTs === null ? capEnd : Math.min(e.nextTs, capEnd);
    const end = Math.min(natural, window.end, now);
    const start = Math.max(e.ts, window.start);
    if (end > start) out.push({ start, end, sessionId: e.sessionId });
  }
  return out;
}

/** Oraliqlarni birlashtiradi (tartiblab, kesishgan/tegib turganlarni qo'shadi). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  if (list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

export const totalMs = (list: readonly Interval[]): number => list.reduce((s, i) => s + (i.end - i.start), 0);

/** Birlashma uzunligi (soniya, butun songa yaxlitlangan). */
export const unionSeconds = (list: readonly Interval[]): number => Math.round(totalMs(mergeIntervals(list)) / 1000);

/** `a` oraliqlarini `b` oyna(lar)i bilan kesishtiradi (ikkalasi ham birlashtirilgan, tartiblangan bo'lishi shart emas). */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i]!.start, B[j]!.start);
    const end = Math.min(A[i]!.end, B[j]!.end);
    if (end > start) out.push({ start, end });
    if (A[i]!.end < B[j]!.end) i++;
    else j++;
  }
  return out;
}

/** `a` dan `b` ni ayiradi (vazifasiz qism). */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const B = mergeIntervals(b);
  const out: Interval[] = [];
  for (const iv of mergeIntervals(a)) {
    let cur = iv.start;
    for (const x of B) {
      if (x.end <= cur) continue;
      if (x.start >= iv.end) break;
      if (x.start > cur) out.push({ start: cur, end: x.start });
      cur = Math.max(cur, x.end);
    }
    if (cur < iv.end) out.push({ start: cur, end: iv.end });
  }
  return out;
}
