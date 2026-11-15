import { describe, expect, it } from 'vitest';
import {
  PutStepUpExemptionBodySchema,
  StepUpExemptionResponseSchema,
  SummarizeDayBodySchema,
  SummarizeInputSchema,
  TaskScoreSchema,
} from './index.js';

describe('6.18: qism bo\'yicha kunlik xulosa kontrakti', () => {
  it('tana ixtiyoriy: bo\'sh, \'\' (butun loyiha) va qism yo\'li qabul qilinadi', () => {
    expect(SummarizeDayBodySchema.parse({})).toEqual({});
    expect(SummarizeDayBodySchema.parse({ part: '' })).toEqual({ part: '' });
    expect(SummarizeDayBodySchema.parse({ part: 'backend-services' })).toEqual({ part: 'backend-services' });
    expect(SummarizeDayBodySchema.parse({ part: 'apps/web' })).toEqual({ part: 'apps/web' });
  });

  it('noto\'g\'ri qism yo\'li va ortiqcha maydon rad etiladi', () => {
    expect(SummarizeDayBodySchema.safeParse({ part: '../etc' }).success).toBe(false);
    expect(SummarizeDayBodySchema.safeParse({ part: 'a/b/c' }).success).toBe(false);
    expect(SummarizeDayBodySchema.safeParse({ part: 'x', extra: 1 }).success).toBe(false);
  });

  it('xulosa kirishi va bahosi qism vazifa kalitini (<slug>:<kalit>) qabul qiladi, ildiz kalit o\'zgarmaydi', () => {
    const task = (key: string) => ({ key, title: 't', activeSeconds: 1, totalTokens: 1, sessions: 1, estimateHours: null, doneThatDay: false });
    for (const key of ['1.1', 'backend-services:1.2', 'apps~web:t-3']) {
      expect(SummarizeInputSchema.safeParse({ day: '2026-11-14', tasks: [task(key)], commitSubjects: [] }).success, key).toBe(true);
      expect(TaskScoreSchema.safeParse({ taskKey: key, score: 3, reason: 'r' }).success, key).toBe(true);
    }
    for (const key of ['', 'A', ':1', 'a:', 'a:b:c']) {
      expect(SummarizeInputSchema.safeParse({ day: '2026-11-14', tasks: [task(key)], commitSubjects: [] }).success, key).toBe(false);
    }
  });
});

describe('6.17b: step-up istisno kontrakti', () => {
  it('PUT tanasi faqat mantiqiy bayroq; qurilma id\'si yuborib bo\'lmaydi', () => {
    expect(PutStepUpExemptionBodySchema.parse({ exempt: true })).toEqual({ exempt: true });
    expect(PutStepUpExemptionBodySchema.safeParse({ exempt: 'yes' }).success).toBe(false);
    expect(PutStepUpExemptionBodySchema.safeParse({ exempt: true, deviceIds: ['x'] }).success).toBe(false);
    expect(PutStepUpExemptionBodySchema.safeParse({}).success).toBe(false);
  });

  it('javob sxemasi', () => {
    expect(StepUpExemptionResponseSchema.parse({ available: true, exempt: false, dashboardDevices: 1, otherExemptDevices: 0 })).toBeTruthy();
    expect(StepUpExemptionResponseSchema.safeParse({ available: true, exempt: false, dashboardDevices: -1, otherExemptDevices: 0 }).success).toBe(false);
  });
});
