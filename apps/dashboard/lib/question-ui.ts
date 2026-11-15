import { QUESTION_LIMITS, validateAskAnswers } from "@commander/contracts";
import type { AskAnswer, AskQuestion } from "@commander/contracts";

/**
 * AskUserQuestion kartasi holati (6.13; sof, testlanadi). Hech narsa oldindan tanlanmaydi: "(tavsiya)" faqat belgi.
 * Javob INDEKS bilan ketadi (center asl savollarga nisbatan tekshiradi).
 */

export interface QuestionDraftItem {
  /** Tanlangan variant indekslari (bir tanlovli savolda ko'pi bilan bitta). */
  picks: number[];
  /** "Boshqa" tanlanganmi (erkin matn). */
  useOther: boolean;
  other: string;
}

export type QuestionDraft = QuestionDraftItem[];

export const emptyDraft = (questions: readonly AskQuestion[]): QuestionDraft => questions.map(() => ({ picks: [], useOther: false, other: "" }));

/** Variantni bosish: bir tanlovli (radio) savolda faqat shu variant (erkin matn o'chadi); multiSelect'da almashtiriladi. */
export function togglePick(draft: QuestionDraft, questions: readonly AskQuestion[], q: number, o: number): QuestionDraft {
  const question = questions[q];
  const cur = draft[q];
  if (!question || !cur || o < 0 || o >= question.options.length) return draft;
  const next: QuestionDraftItem = question.multiSelect
    ? { ...cur, picks: cur.picks.includes(o) ? cur.picks.filter((x) => x !== o) : [...cur.picks, o].sort((a, b) => a - b) }
    : { picks: [o], useOther: false, other: cur.other };
  return draft.map((d, i) => (i === q ? next : d));
}

/** "Boshqa" belgisini almashtirish: bir tanlovli savolda variantlar tozalanadi. */
export function toggleOther(draft: QuestionDraft, questions: readonly AskQuestion[], q: number): QuestionDraft {
  const question = questions[q];
  const cur = draft[q];
  if (!question || !cur) return draft;
  const useOther = !cur.useOther;
  const next: QuestionDraftItem = question.multiSelect ? { ...cur, useOther } : { picks: useOther ? [] : cur.picks, useOther, other: cur.other };
  return draft.map((d, i) => (i === q ? next : d));
}

export function setOtherText(draft: QuestionDraft, q: number, text: string): QuestionDraft {
  const cur = draft[q];
  if (!cur) return draft;
  return draft.map((d, i) => (i === q ? { ...d, other: text.slice(0, QUESTION_LIMITS.otherChars) } : d));
}

/** Hamma savol to'g'ri javoblangan bo'lsa tekshirilgan javoblar, aks holda null (yuborish tugmasi o'chiq). */
export function draftAnswers(questions: readonly AskQuestion[], draft: QuestionDraft): AskAnswer[] | null {
  if (draft.length !== questions.length) return null;
  const raw: AskAnswer[] = draft.map((d, q) => {
    const other = d.useOther ? d.other.trim() : "";
    return { q, picks: d.picks, ...(other !== "" ? { other } : {}) };
  });
  const r = validateAskAnswers(questions, raw);
  return r.ok ? r.answers : null;
}

/** Nechta savol javoblangan (ko'rsatkich uchun). */
export function answeredCount(questions: readonly AskQuestion[], draft: QuestionDraft): number {
  return draft.filter((d, q) => {
    if (!questions[q]) return false;
    return d.picks.length > 0 || (d.useOther && d.other.trim() !== "");
  }).length;
}
