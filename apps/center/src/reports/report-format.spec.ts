import { describe, expect, it } from 'vitest';
import type { ReportData, ReportSection } from '@commander/contracts';
import { splitHtml } from '../telegram/telegram-extensions.js';
import { fmtCost, fmtDuration, fmtTok, formatReportHtml } from './report-format.js';

const section = (name: string, over: Partial<ReportSection> = {}): ReportSection => ({
  projectId: null,
  name,
  tasksClosed: [{ key: '3.2', title: 'x' }],
  commits: 3,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, weighted: 2_500_000 },
  costUsd: 12.3456,
  activeSeconds: 5400,
  sessions: 4,
  topTasks: [{ key: '3.2', title: null, weighted: 1_200_000, costUsd: null }],
  planVsActual: { plannedHours: 6, actualHours: 7.5, tasks: 2 },
  limitShare: 0.4,
  models: [{ model: 'Opus', requests: 3, weighted: 1, outputTokens: 1, costUsd: null, share: 0.7 }],
  summaries: [],
  ...over,
});
const report = (projects: ReportSection[], over: Partial<ReportData> = {}): ReportData => ({
  kind: 'daily',
  from: '2026-11-13',
  to: '2026-11-13',
  total: section('Jami'),
  projects,
  recommendations: [],
  limits: null,
  ...over,
});

describe('formatlash yordamchilari', () => {
  it('son/narx/davomiylik', () => {
    expect(fmtTok(2_500_000)).toBe('2.5M');
    expect(fmtTok(12_400)).toBe('12k');
    expect(fmtTok(7)).toBe('7');
    expect(fmtCost(null)).toBe('—');
    expect(fmtCost(12.3456)).toBe('$12.35');
    expect(fmtDuration(5400)).toBe('1 s 30 daq');
    expect(fmtDuration(120)).toBe('2 daq');
  });
});

describe('Telegram hisobot matni', () => {
  it('qisqa hisobot bitta xabar; dinamik qiymat escape qilinadi; limit manbasi ko\'rsatiladi', () => {
    const parts = formatReportHtml(
      report([section('a<b>&c', { projectId: 'p' })], { recommendations: ['x < y & z'], limits: { fiveHourPct: 40, sevenDayPct: 12, source: 'estimate' } }),
    );
    expect(parts).toHaveLength(1);
    const t = parts[0]!;
    expect(t).toContain('📊 <b>Kunlik hisobot</b> · 2026-11-13');
    expect(t).toContain('a&lt;b&gt;&amp;c');
    expect(t).toContain('x &lt; y &amp; z');
    expect(t).toContain('taxmin');
    expect(t).toContain('40%');
    expect(t).toContain('Opus 70%');
    expect(t).toContain('API-ekv.');
  });

  it('haftalik sarlavha; faollik yo\'q bo\'lsa xabar', () => {
    const empty = section('Jami', { tasksClosed: [], commits: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, weighted: 0 }, models: [], topTasks: [], planVsActual: null });
    const t = formatReportHtml(report([], { kind: 'weekly', from: '2026-11-09', to: '2026-11-15', total: empty }))[0]!;
    expect(t).toContain('Haftalik hisobot');
    expect(t).toContain('2026-11-09 — 2026-11-15');
    expect(t).toContain('faollik bo\'lmadi');
  });

  it('juda ko\'p loyiha: har bo\'lak <= 4096, hech narsa yo\'qolmaydi, teglar muvozanatda', () => {
    const projects = Array.from({ length: 60 }, (_, i) => section(`loyiha-${i}-${'x'.repeat(40)}`, { projectId: `p${i}`, summaries: ['s'.repeat(280)] }));
    const parts = formatReportHtml(report(projects));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4096);
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length);
    }
    const joined = parts.join('\n');
    for (let i = 0; i < 60; i++) expect(joined).toContain(`loyiha-${i}-`);
  });
});

describe('splitHtml', () => {
  it('chegarada bo\'linmaydi', () => {
    expect(splitHtml('a'.repeat(4096))).toHaveLength(1);
    expect(splitHtml('a'.repeat(4097))).toHaveLength(2);
  });

  it('qator chegarasida bo\'ladi, ochiq teg yopilib keyingisida qayta ochiladi', () => {
    const text = `<b>${Array.from({ length: 30 }, (_, i) => `qator ${i}`).join('\n')}</b>`;
    const parts = splitHtml(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(100);
      expect(p.startsWith('<b>')).toBe(true);
      expect(p.endsWith('</b>')).toBe(true);
    }
    expect(parts.join('').replace(/<\/?b>/g, '').replace(/\n/g, '')).toBe(text.replace(/<\/?b>/g, '').replace(/\n/g, ''));
  });

  it('bitta juda uzun qator: entity (&amp;) o\'rtasida kesilmaydi', () => {
    const parts = splitHtml('&amp;'.repeat(100), 22);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(22);
      expect(p.replace(/&amp;/g, '')).toBe('');
    }
    expect(parts.join('')).toBe('&amp;'.repeat(100));
  });
});
