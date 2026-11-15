import { describe, expect, it } from 'vitest';
import {
  ApprovalDecisionBodySchema,
  ApprovalDecisionPayloadSchema,
  ApprovalRequestPayloadSchema,
  AskQuestionsSchema,
  displayOptionLabel,
  isRecommendedLabel,
  validateAskAnswers,
} from './index.js';

const questions = AskQuestionsSchema.parse([
  { question: 'Qaysi rang?', header: 'Rang', options: [{ label: 'Red (Recommended)', description: '' }, { label: 'Blue' }], multiSelect: false },
  { question: 'Qaysi qo\'shimcha?', header: 'Qo\'shimcha', options: [{ label: 'Cheese' }, { label: 'Ham' }, { label: 'Olives' }], multiSelect: true },
]);

describe('validateAskAnswers', () => {
  it('to\'g\'ri javoblarni normallashtiradi (picks o\'sish tartibida, other trim)', () => {
    const r = validateAskAnswers(questions, [
      { q: 1, picks: [2, 0] },
      { q: 0, picks: [], other: '  Yashil  ' },
    ]);
    expect(r).toEqual({ ok: true, answers: [{ q: 0, picks: [], other: 'Yashil' }, { q: 1, picks: [0, 2] }] });
  });

  it('har savolga bittadan javob talab qiladi', () => {
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0] }]).ok).toBe(false);
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0] }, { q: 0, picks: [1] }]).ok).toBe(false);
  });

  it('chegaradan tashqari indeks, takroriy tanlov va bo\'sh javobni rad etadi', () => {
    expect(validateAskAnswers(questions, [{ q: 0, picks: [5] }, { q: 1, picks: [0] }]).ok).toBe(false);
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0] }, { q: 1, picks: [1, 1] }]).ok).toBe(false);
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0] }, { q: 1, picks: [] }]).ok).toBe(false);
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0] }, { q: 9, picks: [0] }]).ok).toBe(false);
  });

  it('bir tanlovli savolda ikkita tanlovni rad etadi (variant + erkin matn ham)', () => {
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0, 1] }, { q: 1, picks: [0] }]).ok).toBe(false);
    expect(validateAskAnswers(questions, [{ q: 0, picks: [0], other: 'x' }, { q: 1, picks: [0] }]).ok).toBe(false);
  });

  it('multiSelect variant va erkin matnni birga qabul qiladi', () => {
    expect(validateAskAnswers(questions, [{ q: 0, picks: [1] }, { q: 1, picks: [0], other: 'Pepperoni' }]).ok).toBe(true);
  });
});

describe('belgilar', () => {
  it('(Recommended) -> (tavsiya)', () => {
    expect(isRecommendedLabel('Red (Recommended)')).toBe(true);
    expect(isRecommendedLabel('Blue')).toBe(false);
    expect(displayOptionLabel('Red (Recommended)')).toBe('Red (tavsiya)');
  });
});

describe('approval sxemalari (question)', () => {
  const base = { approvalId: '11111111-1111-4111-8111-111111111111', claudeSessionId: 's', toolName: 'AskUserQuestion', toolInputRedacted: '', toolInputFullHash: 'a'.repeat(64), cwd: '/x', deadline: Date.now() + 1000 };

  it('kind=question uchun savollar majburiy, boshqa turda taqiqlangan', () => {
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base, kind: 'question' }).success).toBe(false);
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base, kind: 'question', questions }).success).toBe(true);
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base, kind: 'tool', questions }).success).toBe(false);
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base }).success).toBe(true);
  });

  it('qaror tanasi va xabari answers\'ni qabul qiladi, noma\'lum maydonni rad etadi', () => {
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'allow', answers: [{ q: 0, picks: [0] }] }).success).toBe(true);
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'allow', answers: [{ q: 0, picks: [0], extra: 1 }] }).success).toBe(false);
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'allow', answers: [] }).success).toBe(false);
    expect(ApprovalDecisionPayloadSchema.safeParse({ approvalId: base.approvalId, behavior: 'allow', answers: [{ q: 0, picks: [1] }], decidedAt: 1 }).success).toBe(true);
  });
});
