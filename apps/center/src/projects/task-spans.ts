/**
 * Vazifa span mantig'i (task 2.9): sof qaror funksiyalari (DB'siz, testlanadi). SQL qo'llashni `TaskSpansService` bajaradi.
 *
 * Qoidalar:
 *  - aniq marker (`explicit`) har doim ustun: ochiq span'ni (branch yoki boshqa id) yopib, yangisini ochadi;
 *    xuddi shu id allaqachon ochiq bo'lsa hech narsa qilmaydi;
 *  - branch taxmini (`branch`) FAQAT ochiq aniq span bo'lmaganda ishlaydi; branch o'zgarsa branch-span almashadi;
 *    branch vazifaga mos kelmay qolsa (`taskKey = null`) branch-span yopiladi;
 *  - sessiya tugasa ochiq span yopiladi;
 *  - tartibsiz keluvchi eski hodisa (`at` < ochiq span boshlanishi) e'tiborsiz qoldiriladi.
 */

export type SpanSource = 'explicit' | 'branch';

export interface OpenSpan {
  id: string;
  taskKey: string;
  source: SpanSource;
  startedAt: Date;
}

export interface SpanMarker {
  taskKey: string | null;
  source: SpanSource;
}

export type SpanAction =
  | { kind: 'noop' }
  | { kind: 'close'; at: Date }
  /** `closeCurrent`: avval ochiq span'ni `at` da yopish kerak. */
  | { kind: 'open'; taskKey: string; source: SpanSource; at: Date; closeCurrent: boolean };

const NOOP: SpanAction = { kind: 'noop' };

export function decideSpanAction(open: OpenSpan | null, marker: SpanMarker, at: Date): SpanAction {
  const key = marker.taskKey;
  if (open && at.getTime() < open.startedAt.getTime()) return NOOP; // eski/tartibsiz hodisa

  if (marker.source === 'explicit') {
    if (!key) return NOOP; // aniq marker id'siz ma'nosiz
    if (open && open.source === 'explicit' && open.taskKey === key) return NOOP;
    return { kind: 'open', taskKey: key, source: 'explicit', at, closeCurrent: open !== null };
  }

  // branch taxmini
  if (open?.source === 'explicit') return NOOP; // aniq span ustun
  if (!key) return open ? { kind: 'close', at } : NOOP;
  if (open && open.taskKey === key) return NOOP;
  return { kind: 'open', taskKey: key, source: 'branch', at, closeCurrent: open !== null };
}

/** Sessiya tugadi: ochiq span bo'lsa yopiladi (yopilish vaqti boshlanishdan oldin bo'lmasin). */
export function decideSessionEnd(open: OpenSpan | null, at: Date): SpanAction {
  if (!open) return NOOP;
  return { kind: 'close', at: at.getTime() < open.startedAt.getTime() ? open.startedAt : at };
}
