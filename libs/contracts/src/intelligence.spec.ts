import { describe, expect, it } from 'vitest';
import {
  ASK_LIMITS,
  AskResultSchema,
  CreateDecisionBodySchema,
  MailboxCallSchema,
  PatchDecisionBodySchema,
  SESSION_SUMMARY_SYSTEM_PROMPT,
  SUMMARY_LIMITS,
  SessionSummaryOutputSchema,
  buildAskPrompt,
  buildSessionSummaryPrompt,
  formatDecisionsContext,
  parseAskOutput,
  parseSessionSummaryOutput,
} from './index.js';

describe('parseSessionSummaryOutput', () => {
  const good = '```json\n{"summary":"Login tuzatildi.","done":["a","b"],"files":["src/a.ts"],"open_items":["test"],"decisions":[{"title":"T","decision":"D","reason":"R"}]}\n```';

  it('extracts JSON from a fenced answer and validates against the schema', () => {
    const r = parseSessionSummaryOutput(good);
    expect(r).not.toBeNull();
    expect(SessionSummaryOutputSchema.safeParse(r).success).toBe(true);
    expect(r?.decisions).toHaveLength(1);
  });

  it('redacts BEFORE capping and drops empty / non-string items', () => {
    const redact = (s: string): string => s.replace(/sk-[a-z0-9]+/g, '[REDACTED]');
    const r = parseSessionSummaryOutput('{"summary":"kalit sk-abcdef123 ishlatildi","done":["", 5, "x"],"files":[],"open_items":"yo\'q"}', redact);
    expect(r?.summary).toBe('kalit [REDACTED] ishlatildi');
    expect(r?.done).toEqual(['x']);
    expect(r?.open_items).toEqual([]);
  });

  it('caps lengths and item counts', () => {
    const many = Array.from({ length: 40 }, (_, i) => `item-${i}-${'x'.repeat(500)}`);
    const r = parseSessionSummaryOutput(JSON.stringify({ summary: 's'.repeat(9000), done: many, files: many, open_items: many }));
    expect(r?.summary.length).toBe(SUMMARY_LIMITS.summaryMaxChars);
    expect(r?.done).toHaveLength(SUMMARY_LIMITS.listMaxItems);
    expect(r?.files).toHaveLength(SUMMARY_LIMITS.filesMaxItems);
    expect(r?.done[0]?.length).toBe(SUMMARY_LIMITS.itemMaxChars);
  });

  it('returns null for garbage or an empty summary', () => {
    expect(parseSessionSummaryOutput('hech narsa')).toBeNull();
    expect(parseSessionSummaryOutput('{"summary":"  "}')).toBeNull();
    expect(parseSessionSummaryOutput('{not json}')).toBeNull();
  });

  it('keeps at most 3 complete decision proposals', () => {
    const d = { title: 'T', decision: 'D', reason: 'R' };
    const r = parseSessionSummaryOutput(JSON.stringify({ summary: 's', decisions: [d, d, d, d, { title: 'x' }] }));
    expect(r?.decisions).toHaveLength(3);
  });
});

describe('buildSessionSummaryPrompt', () => {
  it('contains only the structured fields and the Uzbek task text', () => {
    const p = buildSessionSummaryPrompt({ project: 'api', prompts: ['login xatosi'], tools: ['Edit: a.ts (+1 -0)'], files: ['a.ts'], lastAssistant: 'Tayyor', promptCount: 3 });
    expect(p).toContain('login xatosi');
    expect(p).toContain('Edit: a.ts');
    expect(p).toContain('"open_items"');
    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toMatch(/JSON/);
  });
});

describe('ask prompt and output', () => {
  it('buildAskPrompt wraps the context and question', () => {
    const p = buildAskPrompt({ question: 'Nima bo\'ldi?', context: '[S1] session x' });
    expect(p).toContain('[S1] session x');
    expect(p).toContain("SAVOL: Nima bo'ldi?");
  });

  it('parses JSON answers, keeps only well-formed source ids and dedupes', () => {
    const r = parseAskOutput('{"answer":"Javob","sources":["S1","S1","bad","S12"]}', 'haiku-5');
    expect(r).toEqual({ answer: 'Javob', sources: ['S1', 'S12'], model: 'haiku-5' });
    expect(AskResultSchema.safeParse(r).success).toBe(true);
  });

  it('falls back to the raw text when the model did not answer in JSON; empty = null', () => {
    expect(parseAskOutput('Oddiy matn javob', 'm')?.answer).toBe('Oddiy matn javob');
    expect(parseAskOutput('   ', 'm')).toBeNull();
  });

  it('redacts and caps the answer', () => {
    const r = parseAskOutput(JSON.stringify({ answer: `kalit sk-secret ${'x'.repeat(9000)}` }), 'm', (s) => s.replace(/sk-secret/g, '[REDACTED]'));
    expect(r?.answer.startsWith('kalit [REDACTED]')).toBe(true);
    expect(r?.answer.length).toBe(ASK_LIMITS.answerMaxChars);
  });
});

describe('decisions', () => {
  it('validates create/patch bodies', () => {
    expect(CreateDecisionBodySchema.safeParse({ title: 'T', decision: 'D', reason: 'R' }).success).toBe(true);
    expect(CreateDecisionBodySchema.safeParse({ title: '', decision: 'D', reason: 'R' }).success).toBe(false);
    expect(CreateDecisionBodySchema.safeParse({ title: 'T', decision: 'D', reason: 'R', extra: 1 }).success).toBe(false);
    expect(PatchDecisionBodySchema.safeParse({}).success).toBe(false);
    expect(PatchDecisionBodySchema.safeParse({ status: 'archived' }).success).toBe(true);
    expect(PatchDecisionBodySchema.safeParse({ status: 'proposed' }).success).toBe(false);
  });

  it('formatDecisionsContext frames the block and respects the size cap', () => {
    expect(formatDecisionsContext([])).toBeNull();
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `Q${i}`, decision: 'd'.repeat(300), reason: 'r'.repeat(300), createdAt: '2026-11-14T10:00:00.000Z' }));
    const out = formatDecisionsContext(items, 1500);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(1700);
    expect(out).toContain('foydalanuvchi buyrug');
    expect(out).toContain('ta eski qaror');
  });
});

describe('mailbox calls', () => {
  it('accepts the new ops and rejects malformed payloads', () => {
    expect(MailboxCallSchema.safeParse({ op: 'summary_check' }).success).toBe(true);
    expect(MailboxCallSchema.safeParse({ op: 'record_decision', title: 'T', decision: 'D', reason: 'R', alternatives: ['a'] }).success).toBe(true);
    expect(MailboxCallSchema.safeParse({ op: 'record_decision', title: 'T' }).success).toBe(false);
    expect(
      MailboxCallSchema.safeParse({
        op: 'session_summary',
        summary: { summary: 's', done: [], files: [], openItems: [], model: 'haiku', tokensUsed: 10, promptCount: 2, sourceTokens: 100, trigger: 'idle' },
      }).success,
    ).toBe(true);
    expect(MailboxCallSchema.safeParse({ op: 'session_summary', summary: { summary: '' } }).success).toBe(false);
  });
});
