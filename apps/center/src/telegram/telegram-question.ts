import { displayOptionLabel, validateAskAnswers } from '@commander/contracts';
import type { AskAnswer, AskQuestion } from '@commander/contracts';

/**
 * Telegram'da AskUserQuestion (6.13): savollar ketma-ket beriladi, javoblar xotirada yig'iladi va oxirgi savoldan keyin
 * bitta `decide(allow, answers)` bilan yuboriladi. Sof mantiq (I/O yo'q): holat mashinasi, tugma modeli, javoblarni yig'ish.
 * Hech narsa avtomatik tanlanmaydi: "(tavsiya)" faqat belgi. Restartdan keyin holat yo'qoladi: savol qaytadan boshlanadi
 * (hali hech narsa yuborilmagan, shuning uchun xavfsiz).
 */

export interface QuestionFlow {
  /** Hozirgi savol indeksi (== savollar soni bo'lsa hammasi javoblangan). */
  current: number;
  /** Savol bo'yicha tasdiqlangan javob (null = hali yo'q). */
  answers: Array<{ picks: number[]; other?: string } | null>;
  /** Hozirgi (multiSelect) savolda belgilangan variantlar. */
  toggled: number[];
}

export const newFlow = (count: number): QuestionFlow => ({ current: 0, answers: Array.from({ length: count }, () => null), toggled: [] });

export type FlowEvent =
  | { kind: 'pick'; q: number; o: number }
  | { kind: 'submit'; q: number }
  | { kind: 'other'; q: number; text: string };

/**
 * - stale   : tugma hozirgi savolga tegishli emas (eski xabar) yoki indeks noto'g'ri: hech narsa o'zgarmaydi;
 * - empty   : multiSelect'da hech narsa belgilanmay "Yuborish";
 * - toggled : multiSelect variant belgisi almashdi;
 * - next    : savol javoblandi, keyingisiga o'tildi;
 * - done    : oxirgi savol javoblandi (chaqiruvchi `flowAnswers` bilan yuboradi).
 */
export type FlowStatus = 'stale' | 'empty' | 'toggled' | 'next' | 'done';

const advance = (f: QuestionFlow, q: number, answer: { picks: number[]; other?: string }): { flow: QuestionFlow; status: 'next' | 'done' } => {
  const answers = f.answers.slice();
  answers[q] = answer;
  const current = q + 1;
  return { flow: { current, answers, toggled: [] }, status: current >= answers.length ? 'done' : 'next' };
};

export function applyEvent(flow: QuestionFlow, questions: readonly AskQuestion[], ev: FlowEvent): { flow: QuestionFlow; status: FlowStatus } {
  const q = questions[ev.q];
  if (!q || ev.q !== flow.current) return { flow, status: 'stale' };
  if (ev.kind === 'pick') {
    if (!Number.isInteger(ev.o) || ev.o < 0 || ev.o >= q.options.length) return { flow, status: 'stale' };
    if (!q.multiSelect) return advance(flow, ev.q, { picks: [ev.o] });
    const toggled = flow.toggled.includes(ev.o) ? flow.toggled.filter((x) => x !== ev.o) : [...flow.toggled, ev.o].sort((a, b) => a - b);
    return { flow: { ...flow, toggled }, status: 'toggled' };
  }
  if (ev.kind === 'submit') {
    if (!q.multiSelect) return { flow, status: 'stale' };
    if (flow.toggled.length === 0) return { flow, status: 'empty' };
    return advance(flow, ev.q, { picks: flow.toggled });
  }
  const other = ev.text.trim();
  if (other === '') return { flow, status: 'stale' };
  // multiSelect'da avval belgilangan variantlar erkin matn bilan birga ketadi; bir tanlovli savolda faqat matn.
  return advance(flow, ev.q, { picks: q.multiSelect ? flow.toggled : [], other });
}

/** Barcha savol javoblangan bo'lsa tekshirilgan javoblar, aks holda null. */
export function flowAnswers(flow: QuestionFlow, questions: readonly AskQuestion[]): AskAnswer[] | null {
  if (flow.answers.some((a) => a === null)) return null;
  const check = validateAskAnswers(
    questions,
    flow.answers.map((a, q) => ({ q, picks: a!.picks, ...(a!.other !== undefined ? { other: a!.other } : {}) })),
  );
  return check.ok ? check.answers : null;
}

export type QuestionAction = 'qopt' | 'qsubmit' | 'qother' | 'deny';
export interface ButtonSpec {
  text: string;
  action: QuestionAction;
  /** `qopt`: `<savol><variant base36>`; `qsubmit|qother`: `<savol>`. */
  arg?: string;
}

const BUTTON_CHARS = 48;
const clip = (s: string): string => {
  const chars = Array.from(s);
  return chars.length <= BUTTON_CHARS ? s : `${chars.slice(0, BUTTON_CHARS - 1).join('')}…`;
};

export const encodeOptionArg = (q: number, o: number): string => `${q}${o.toString(36)}`;
export function decodeOptionArg(arg: string): { q: number; o: number } | null {
  const m = /^(\d)([0-9a-z])$/.exec(arg);
  return m ? { q: Number(m[1]), o: parseInt(m[2]!, 36) } : null;
}

/** Hozirgi savol uchun tugmalar (qator-qator): variantlar, "Boshqa…", multiSelect "Yuborish", "Rad". */
export function questionButtons(questions: readonly AskQuestion[], flow: QuestionFlow): ButtonSpec[][] {
  const q = questions[flow.current];
  if (!q) return [];
  const rows: ButtonSpec[][] = q.options.map((o, i) => {
    const label = clip(displayOptionLabel(o.label));
    const text = q.multiSelect ? `${flow.toggled.includes(i) ? '☑' : '☐'} ${label}` : label;
    return [{ text, action: 'qopt' as const, arg: encodeOptionArg(flow.current, i) }];
  });
  rows.push([{ text: '✍️ Boshqa…', action: 'qother', arg: String(flow.current) }]);
  if (q.multiSelect) rows.push([{ text: `✅ Yuborish${flow.toggled.length > 0 ? ` (${flow.toggled.length})` : ''}`, action: 'qsubmit', arg: String(flow.current) }]);
  rows.push([{ text: '❌ Rad', action: 'deny' }]);
  return rows;
}

/** Berilgan javoblarning qisqa matni (xabar yakuniy holatida): "Savol: javob". Maxfiy javob matni redakt qilingan keladi. */
export function answerSummaryLines(questions: readonly AskQuestion[], answers: readonly AskAnswer[]): Array<{ question: string; answer: string }> {
  return questions.map((q, i) => {
    const a = answers.find((x) => x.q === i);
    const parts = a ? [...a.picks.map((p) => q.options[p]?.label ?? '?'), ...(a.other !== undefined ? [a.other] : [])] : [];
    return { question: q.header || q.question, answer: parts.map((p) => displayOptionLabel(p)).join(', ') || '—' };
  });
}
