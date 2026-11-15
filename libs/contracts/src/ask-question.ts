import { z } from 'zod';

/**
 * Claude Code `AskUserQuestion` vositasiga masofadan javob (task 6.13).
 *
 * JONLI TEKSHIRILGAN (Claude Code 2.1.304, haiku, tmux, 2026-11-14; to'liq natija PLAN.md "ADR 6.13"):
 *  - `-p` (headless) rejimda vosita umuman yo'q; faqat interaktiv sessiyada bor.
 *  - PreToolUse VA PermissionRequest hook'lari `tool_name: "AskUserQuestion"` bilan chaqiriladi.
 *    `tool_input = { questions: [{ question, header, options: [{label, description, preview?}], multiSelect }] }`.
 *  - PermissionRequest `allow` + `updatedInput = { ...tool_input, answers: { "<savol matni>": "<javob>" } }` ISHLAYDI:
 *    lokal dialog ochilmaydi, vosita "User answered Claude's questions" natijasi bilan hal bo'ladi (reja `allow`idan farqli).
 *    multiSelect javobi "A, B" (vergul + bo'sh joy bilan birlashtirilgan matn); variantda yo'q matn = erkin matn ("Boshqa").
 *
 * Javob INDEKS bilan beriladi (savol matni/yorliq bilan emas): agentd markazga redakt qilingan va kesilgan nusxani yuboradi,
 * shuning uchun kalit sifatida matn ishlatib bo'lmaydi. cc-hook indekslarni O'Z xom `tool_input`ini (asl savol va yorliqlar)
 * bilan `answers` xaritasiga aylantiradi. Tekshiruv bajarilmasa hook hech narsa chiqarmaydi (lokal dialog).
 */

export const QUESTION_TOOL_NAME = 'AskUserQuestion';

export const QUESTION_LIMITS = {
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 8,
  questionChars: 500,
  headerChars: 64,
  labelChars: 200,
  descriptionChars: 500,
  previewChars: 2000,
  /** Erkin matn javobi ("Boshqa"). */
  otherChars: 1000,
} as const;

/** Variant yorlig'ida shu belgi bo'lsa, Claude uni tavsiya etgan (UI "(tavsiya)" belgisini ko'rsatadi, hech qachon o'zi tanlamaydi). */
export const RECOMMENDED_MARK = '(Recommended)';

export const AskOptionSchema = z.object({
  label: z.string().min(1).max(QUESTION_LIMITS.labelChars),
  description: z.string().max(QUESTION_LIMITS.descriptionChars).default(''),
  /** Claude yuborgan ko'rinish (redakt qilingan, kesilgan). Faqat dashboard ko'rsatadi. */
  preview: z.string().max(QUESTION_LIMITS.previewChars).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskQuestionSchema = z.object({
  question: z.string().min(1).max(QUESTION_LIMITS.questionChars),
  header: z.string().max(QUESTION_LIMITS.headerChars).default(''),
  options: z.array(AskOptionSchema).min(QUESTION_LIMITS.minOptions).max(QUESTION_LIMITS.maxOptions),
  multiSelect: z.boolean().default(false),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

export const AskQuestionsSchema = z.array(AskQuestionSchema).min(1).max(QUESTION_LIMITS.maxQuestions);

/**
 * Bitta savolga javob: `picks` = tanlangan variant indekslari (takrorsiz), `other` = erkin matn (ixtiyoriy).
 * Bir tanlovli savol: aniq bitta (`picks` 1 ta YOKI `other`). multiSelect: kamida bittasi.
 */
export const AskAnswerSchema = z
  .object({
    q: z.number().int().min(0).max(QUESTION_LIMITS.maxQuestions - 1),
    picks: z.array(z.number().int().min(0).max(QUESTION_LIMITS.maxOptions - 1)).max(QUESTION_LIMITS.maxOptions),
    other: z.string().min(1).max(QUESTION_LIMITS.otherChars).optional(),
  })
  .strict();
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const AskAnswersSchema = z.array(AskAnswerSchema).min(1).max(QUESTION_LIMITS.maxQuestions);
export type AskAnswers = z.infer<typeof AskAnswersSchema>;

export type AskAnswersCheck = { ok: true; answers: AskAnswer[] } | { ok: false; reason: string };

/**
 * Javoblarni savollarga nisbatan tekshiradi (sof): HAR savolga aniq bitta javob, indekslar chegarada va takrorsiz,
 * bir tanlovli savolda faqat bitta tanlov (variant YOKI erkin matn), multiSelect'da kamida bittasi.
 * Natija savol tartibida normallashtirilgan (picks o'sish tartibida), `other` trim qilingan.
 */
export function validateAskAnswers(questions: readonly AskQuestion[], answers: readonly AskAnswer[]): AskAnswersCheck {
  if (answers.length !== questions.length) return { ok: false, reason: 'every question needs exactly one answer' };
  const byQ = new Map<number, AskAnswer>();
  for (const a of answers) {
    if (a.q >= questions.length) return { ok: false, reason: `question index out of range: ${a.q}` };
    if (byQ.has(a.q)) return { ok: false, reason: `duplicate answer for question ${a.q}` };
    byQ.set(a.q, a);
  }
  const out: AskAnswer[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]!;
    const a = byQ.get(i);
    if (!a) return { ok: false, reason: `missing answer for question ${i}` };
    const picks = [...new Set(a.picks)].sort((x, y) => x - y);
    if (picks.length !== a.picks.length) return { ok: false, reason: `duplicate picks in question ${i}` };
    if (picks.some((p) => p >= q.options.length)) return { ok: false, reason: `option index out of range in question ${i}` };
    const other = a.other?.trim();
    const hasOther = other !== undefined && other.length > 0;
    const count = picks.length + (hasOther ? 1 : 0);
    if (count === 0) return { ok: false, reason: `empty answer for question ${i}` };
    if (!q.multiSelect && count > 1) return { ok: false, reason: `question ${i} accepts a single choice` };
    out.push({ q: i, picks, ...(hasOther ? { other } : {}) });
  }
  return { ok: true, answers: out };
}

/** Variant yorlig'i "(Recommended)" bilan belgilanganmi (UI belgisi uchun; tanlov hech qachon avtomatik emas). */
export function isRecommendedLabel(label: string): boolean {
  return label.includes(RECOMMENDED_MARK);
}

/** Ko'rsatish uchun yorliq: "(Recommended)" -> "(tavsiya)" (javob esa asl yorliq bilan, indeks orqali ketadi). */
export function displayOptionLabel(label: string): string {
  return label.replace(RECOMMENDED_MARK, '(tavsiya)').replace(/\s{2,}/g, ' ').trim();
}
