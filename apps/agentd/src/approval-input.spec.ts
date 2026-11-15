import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APPROVAL_LIMITS } from '@commander/contracts';
import { prepareQuestionRequest, preparePlan, preparePlanRequest, prepareToolInput } from './approval-input.js';

describe('prepareToolInput', () => {
  it("hash XOM matndan, redakt matnda sir yo'q", () => {
    const input = { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" x', env: { API_TOKEN: 'S3cr3tV4lue99' } };
    const { redacted, hash } = prepareToolInput(input);
    expect(hash).toBe(createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    expect(redacted).not.toContain('abcdefghijklmnop1234');
    expect(redacted).not.toContain('S3cr3tV4lue99');
  });
  it("redakt AVVAL, kesish KEYIN: chegarada bo'linib qolgan sir sizmaydi; uzunlik <= 8192", () => {
    const secret = 'S3cr3tV4lue99S3cr3tV4lue99';
    const input = { command: 'a'.repeat(8185) + ' API_TOKEN=' + secret };
    const { redacted } = prepareToolInput(input);
    expect(redacted.length).toBeLessThanOrEqual(8192);
    expect(redacted).not.toContain('S3cr3t');
    expect(redacted.endsWith('[kesildi]')).toBe(true);
  });
  it('matn kiritma, null va aylanma obyekt xato bermaydi', () => {
    expect(prepareToolInput('echo hi').redacted).toBe('echo hi');
    expect(prepareToolInput(undefined).redacted).toBe('null');
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(prepareToolInput(a).hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('preparePlan / preparePlanRequest (2.14)', () => {
  it('reja redakt qilinadi va 16 KB gacha kesiladi (avval redakt)', () => {
    const secret = 'S3cr3tV4lue99S3cr3tV4lue99';
    const plan = 'x'.repeat(APPROVAL_LIMITS.planMaxChars - 10) + ' API_TOKEN=' + secret + ' tail';
    const out = preparePlan(plan)!;
    expect(out.length).toBeLessThanOrEqual(APPROVAL_LIMITS.planMaxChars);
    expect(out).not.toContain('S3cr3t');
    expect(out.endsWith('[kesildi]')).toBe(true);
  });
  it("kichik reja sirlardan tozalanadi, bo'sh/matn emas = null", () => {
    expect(preparePlan('1. Edit\n2. password=hunter2hunter2')).not.toContain('hunter2');
    expect(preparePlan('   ')).toBeNull();
    expect(preparePlan(undefined)).toBeNull();
    expect(preparePlan({ a: 1 })).toBeNull();
  });
  it("faqat ExitPlanMode reja so'rovi; kiritma nusxasida reja yo'q, hash esa to'liq xomdan", () => {
    const input = { plan: '# Reja\n1. qadam', planFilePath: '/tmp/p.md' };
    const r = preparePlanRequest('ExitPlanMode', input)!;
    expect(r.plan).toContain('# Reja');
    expect(JSON.stringify(r.restInput)).not.toContain('qadam');
    expect(prepareToolInput(r.restInput).redacted).toContain('planFilePath');
    expect(preparePlanRequest('Edit', input)).toBeNull();
    expect(preparePlanRequest('ExitPlanMode', { plan: '' })).toBeNull();
    expect(preparePlanRequest('ExitPlanMode', 'string')).toBeNull();
  });
});

describe('prepareQuestionRequest (AskUserQuestion, 6.13)', () => {
  const input = {
    questions: [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red (Recommended)', description: 'r', preview: '<b>x</b>' }, { label: 'Blue', description: 'b' }], multiSelect: false },
      { question: 'Toppings? API_TOKEN=S3cr3tV4lue99S3cr3tV4lue99', header: 'T', options: [{ label: 'Cheese' }, { label: 'Ham' }], multiSelect: true },
    ],
  };

  it('savollarni kontrakt shaklida qaytaradi, sirlarni redakt qiladi, ixtiyoriy maydonlarga default beradi', () => {
    const r = prepareQuestionRequest('AskUserQuestion', input)!;
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]!.options[0]).toEqual({ label: 'Red (Recommended)', description: 'r', preview: '<b>x</b>' });
    expect(r.questions[1]!.options[0]).toEqual({ label: 'Cheese', description: '' });
    expect(r.questions[1]!.multiSelect).toBe(true);
    expect(JSON.stringify(r)).not.toContain('S3cr3tV4lue99');
  });

  it("boshqa vosita yoki kutilmagan tuzilma = null (lokal dialog qoladi)", () => {
    expect(prepareQuestionRequest('Bash', input)).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', null)).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', { questions: [] })).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', { questions: 'x' })).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', { questions: [{ question: 'q', options: [{ label: 'A' }] }] })).toBeNull(); // 1 variant
    expect(prepareQuestionRequest('AskUserQuestion', { questions: [{ question: 'q', options: [{ label: 'A' }, { label: '' }] }] })).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', { questions: [{ options: [{ label: 'A' }, { label: 'B' }] }] })).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', { questions: [{ question: 'q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: 'yes' }] })).toBeNull();
    expect(prepareQuestionRequest('AskUserQuestion', { questions: Array.from({ length: 5 }, () => input.questions[0]) })).toBeNull();
  });

  it('uzun matnlar kesiladi (indekslar saqlanadi)', () => {
    const long = 'x'.repeat(5000);
    const r = prepareQuestionRequest('AskUserQuestion', { questions: [{ question: long, options: [{ label: long }, { label: 'B' }] }] })!;
    expect(r.questions[0]!.question.length).toBeLessThanOrEqual(500);
    expect(r.questions[0]!.options[0]!.label.length).toBeLessThanOrEqual(200);
    expect(r.questions[0]!.options).toHaveLength(2);
  });
});
