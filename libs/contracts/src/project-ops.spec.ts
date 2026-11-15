import { describe, expect, it } from 'vitest';
import {
  AppendTasksPayloadSchema,
  MdRelPathSchema,
  SummarizeInputSchema,
  SummarizePayloadSchema,
  buildSummarizePrompt,
  parseSummarizeOutput,
} from './project-ops.js';
import { buildPlan, estimateHours } from './project-work.js';
import { CommandDispatchPayloadSchema } from './commands.js';

const input = {
  day: '2026-11-13',
  tasks: [{ key: '2.15', title: 'Loyiha ish maydoni', activeSeconds: 5400, totalTokens: 120000, sessions: 2, estimateHours: 16, doneThatDay: false }],
  commitSubjects: ['feat: doska'],
};

describe('estimateHours', () => {
  it('hajm xaritasi (default S=2 M=6 L=16 XL=40)', () => {
    expect(estimateHours('S')).toEqual({ hours: 2, source: 'size' });
    expect(estimateHours('m')).toEqual({ hours: 6, source: 'size' });
    expect(estimateHours('L')).toEqual({ hours: 16, source: 'size' });
    expect(estimateHours('XL')).toEqual({ hours: 40, source: 'size' });
  });
  it('aniq soat', () => {
    expect(estimateHours('3h')).toEqual({ hours: 3, source: 'explicit' });
    expect(estimateHours('1.5 soat')).toEqual({ hours: 1.5, source: 'explicit' });
    expect(estimateHours('0,5h')).toEqual({ hours: 0.5, source: 'explicit' });
  });
  it('oraliq: kattasi; sozlangan xarita; tanilmagan = null', () => {
    expect(estimateHours('S/M')).toEqual({ hours: 6, source: 'size' });
    expect(estimateHours('M-L')).toEqual({ hours: 16, source: 'size' });
    expect(estimateHours('M', { M: 10 })).toEqual({ hours: 10, source: 'size' });
    expect(estimateHours('?')).toBeNull();
    expect(estimateHours('')).toBeNull();
    expect(estimateHours(null)).toBeNull();
  });
  it('buildPlan: reja vs haqiqiy', () => {
    expect(buildPlan({ hours: 4, source: 'size' }, 7200)).toEqual({ estimateHours: 4, estimateSource: 'size', actualHours: 2, ratio: 0.5 });
    expect(buildPlan(null, 3600)).toEqual({ estimateHours: null, estimateSource: null, actualHours: 1, ratio: null });
  });
});

describe('summarize prompt', () => {
  it('faqat tuzilgan statistika: qo\'shimcha (kod/transcript) maydonlar prompt\'ga tushmaydi', () => {
    const dirty = {
      ...input,
      transcript: 'SECRET-TRANSCRIPT-TEXT',
      diff: 'SECRET-DIFF',
      code: 'function secret() {}',
      tasks: [{ ...input.tasks[0]!, prompt: 'SECRET-PROMPT', code: 'SECRET-CODE' }],
    } as unknown as typeof input;
    const p = buildSummarizePrompt(dirty);
    for (const leak of ['SECRET-TRANSCRIPT-TEXT', 'SECRET-DIFF', 'function secret', 'SECRET-PROMPT', 'SECRET-CODE']) expect(p).not.toContain(leak);
    expect(p).toContain('2.15');
    expect(p).toContain('feat: doska');
    expect(p).toContain('90 daqiqa');
  });
  it('payload sxemasi qat\'iy: qo\'shimcha maydon rad etiladi', () => {
    expect(SummarizeInputSchema.safeParse(input).success).toBe(true);
    expect(SummarizeInputSchema.safeParse({ ...input, transcript: 'x' }).success).toBe(false);
    expect(SummarizeInputSchema.safeParse({ ...input, tasks: [{ ...input.tasks[0], code: 'x' }] }).success).toBe(false);
    expect(SummarizePayloadSchema.safeParse({ root: '/r', input, extra: 1 }).success).toBe(false);
  });
  it('model javobini tekshiradi: fence, noma\'lum vazifa, ball chegarasi', () => {
    const txt = 'Mana:\n```json\n{"summary":"Yaxshi kun.","scores":[{"taskKey":"2.15","score":9,"reason":"zo\'r"},{"taskKey":"9.9","score":3,"reason":"x"},{"taskKey":"2.15","score":1,"reason":"dup"}]}\n```';
    const r = parseSummarizeOutput(txt, new Set(['2.15']), 'claude-haiku-5-5');
    expect(r).toEqual({ summary: 'Yaxshi kun.', scores: [{ taskKey: '2.15', score: 5, reason: 'zo\'r' }], model: 'claude-haiku-5-5' });
    expect(parseSummarizeOutput('hech narsa', new Set(), 'm')).toBeNull();
    expect(parseSummarizeOutput('{"summary":"  ","scores":[]}', new Set(), 'm')).toBeNull();
  });
});

describe('project payload sxemalari', () => {
  it('md yo\'li: ildiz ichida, nisbiy, .md', () => {
    for (const ok of ['README.md', 'docs/a/b.MD']) expect(MdRelPathSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['../x.md', '/etc/a.md', 'a/../b.md', 'C:/x.md', 'a\\b.md', 'a.txt', 'a//b.md', './a.md']) expect(MdRelPathSchema.safeParse(bad).success, bad).toBe(false);
  });
  it('append: id/sarlavha/hajm tekshiriladi', () => {
    const base = { root: '/r', tasksPath: 'docs/TASKS.md', baseHash: 'a'.repeat(64), phase: 'Faza 2', tasks: [{ key: '2.16', title: 'Yangi', size: 'M' }] };
    expect(AppendTasksPayloadSchema.safeParse(base).success).toBe(true);
    expect(AppendTasksPayloadSchema.safeParse({ ...base, tasksPath: '../x.md' }).success).toBe(false);
    expect(AppendTasksPayloadSchema.safeParse({ ...base, tasks: [{ key: 'A B', title: 'x' }] }).success).toBe(false);
    expect(AppendTasksPayloadSchema.safeParse({ ...base, tasks: [{ key: '1', title: 'a\nb' }] }).success).toBe(false);
    expect(AppendTasksPayloadSchema.safeParse({ ...base, tasks: [{ key: '1', title: 'a', size: '9' }] }).success).toBe(false);
  });
  it('dispatch union yangi turlarni biladi', () => {
    const base = { commandId: '00000000-0000-4000-8000-000000000000', nonce: 'n'.repeat(43), expiresAt: 1, sig: 's'.repeat(86) };
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'project.refresh', payload: { root: '/r' } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'project.read_md', payload: { root: '/r', path: 'a.md' } }).success).toBe(true);
  });
});
