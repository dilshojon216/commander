import { describe, expect, it } from 'vitest';
import { AskQuestionsSchema } from '@commander/contracts';
import { answerSummaryLines, applyEvent, decodeOptionArg, encodeOptionArg, flowAnswers, newFlow, questionButtons } from './telegram-question.js';

const qs = AskQuestionsSchema.parse([
  { question: 'Which color?', header: 'Color', options: [{ label: 'Red (Recommended)' }, { label: 'Blue' }], multiSelect: false },
  { question: 'Toppings?', header: 'T', options: [{ label: 'Cheese' }, { label: 'Ham' }, { label: 'Olives' }], multiSelect: true },
]);

describe('telegram question flow', () => {
  it('bir tanlovli variant javobni yozadi va keyingi savolga o\'tadi; oxirgisida done', () => {
    let r = applyEvent(newFlow(2), qs, { kind: 'pick', q: 0, o: 1 });
    expect(r.status).toBe('next');
    expect(r.flow.current).toBe(1);
    r = applyEvent(r.flow, qs, { kind: 'pick', q: 1, o: 0 });
    expect(r.status).toBe('toggled');
    r = applyEvent(r.flow, qs, { kind: 'pick', q: 1, o: 2 });
    r = applyEvent(r.flow, qs, { kind: 'submit', q: 1 });
    expect(r.status).toBe('done');
    expect(flowAnswers(r.flow, qs)).toEqual([{ q: 0, picks: [1] }, { q: 1, picks: [0, 2] }]);
  });

  it('hech qachon avtomatik tanlamaydi: yangi holatda javob yo\'q', () => {
    expect(flowAnswers(newFlow(2), qs)).toBeNull();
    const f = newFlow(2);
    expect(f.answers).toEqual([null, null]);
    expect(f.toggled).toEqual([]);
  });

  it('multiSelect: qayta bosish belgini olib tashlaydi; bo\'sh yuborish empty', () => {
    let f = applyEvent(newFlow(2), qs, { kind: 'pick', q: 0, o: 0 }).flow;
    f = applyEvent(f, qs, { kind: 'pick', q: 1, o: 1 }).flow;
    expect(f.toggled).toEqual([1]);
    f = applyEvent(f, qs, { kind: 'pick', q: 1, o: 1 }).flow;
    expect(f.toggled).toEqual([]);
    expect(applyEvent(f, qs, { kind: 'submit', q: 1 }).status).toBe('empty');
  });

  it('eski tugma (boshqa savol) va noto\'g\'ri indeks e\'tiborsiz (stale)', () => {
    const f = newFlow(2);
    expect(applyEvent(f, qs, { kind: 'pick', q: 1, o: 0 }).status).toBe('stale');
    expect(applyEvent(f, qs, { kind: 'pick', q: 0, o: 9 }).status).toBe('stale');
    expect(applyEvent(f, qs, { kind: 'pick', q: 5, o: 0 }).status).toBe('stale');
    expect(applyEvent(f, qs, { kind: 'submit', q: 0 }).status).toBe('stale');
  });

  it('erkin matn: bir tanlovlida faqat matn; multiSelect\'da belgilangan variantlar bilan birga', () => {
    let r = applyEvent(newFlow(2), qs, { kind: 'other', q: 0, text: '  Yashil ' });
    expect(r.flow.answers[0]).toEqual({ picks: [], other: 'Yashil' });
    r = applyEvent(r.flow, qs, { kind: 'pick', q: 1, o: 2 });
    r = applyEvent(r.flow, qs, { kind: 'other', q: 1, text: 'Pepperoni' });
    expect(r.status).toBe('done');
    expect(flowAnswers(r.flow, qs)).toEqual([{ q: 0, picks: [], other: 'Yashil' }, { q: 1, picks: [2], other: 'Pepperoni' }]);
    expect(applyEvent(newFlow(2), qs, { kind: 'other', q: 0, text: '   ' }).status).toBe('stale');
  });

  it('tugmalar: har variantga bitta, "(tavsiya)", Boshqa, multiSelect Yuborish va Rad', () => {
    const rows = questionButtons(qs, newFlow(2));
    expect(rows.map((r) => r[0]!.text)).toEqual(['Red (tavsiya)', 'Blue', '✍️ Boshqa…', '❌ Rad']);
    const f = applyEvent(applyEvent(newFlow(2), qs, { kind: 'pick', q: 0, o: 0 }).flow, qs, { kind: 'pick', q: 1, o: 1 }).flow;
    const multi = questionButtons(qs, f).map((r) => r[0]!.text);
    expect(multi).toEqual(['☐ Cheese', '☑ Ham', '☐ Olives', '✍️ Boshqa…', '✅ Yuborish (1)', '❌ Rad']);
  });

  it('callback argumenti kodlash/dekodlash', () => {
    expect(decodeOptionArg(encodeOptionArg(1, 7))).toEqual({ q: 1, o: 7 });
    expect(decodeOptionArg('x')).toBeNull();
    expect(decodeOptionArg('1!')).toBeNull();
  });

  it('yakuniy xulosa', () => {
    const lines = answerSummaryLines(qs, [{ q: 0, picks: [0] }, { q: 1, picks: [0, 1], other: 'X' }]);
    expect(lines).toEqual([{ question: 'Color', answer: 'Red (tavsiya)' }, { question: 'T', answer: 'Cheese, Ham, X' }]);
  });
});
