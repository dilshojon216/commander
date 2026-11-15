import { describe, expect, it } from 'vitest';
import { formatPartsOverview, progressBar } from './parts-telegram-format.js';

describe('formatPartsOverview', () => {
  it('qisqa progress, HTML-escape', () => {
    const t = formatPartsOverview(
      [{ id: 'x', name: 'agro <flow>', parts: [{ part: '', done: 0, total: 0 }, { part: 'backend-services', done: 340, total: 460 }, { part: 'web-app', done: 0, total: 14 }] }],
      null,
    );
    expect(t).toContain('📁 <b>agro &lt;flow&gt;</b>');
    expect(t).toContain('<code>backend-services</code> 340/460 (74%)');
    expect(t).toContain('<code>web-app</code> 0/14 (0%)');
    expect(t).toContain('<code>asosiy</code> 0/0');
    expect(t).not.toContain('0/0 (');
  });
  it('bo\'sh holatlar', () => {
    expect(formatPartsOverview([], null)).toContain("qismlarga bo'lingan loyiha yo'q");
    expect(formatPartsOverview([], 'a<b')).toContain('a&lt;b');
  });
  it('progressBar chegaralari', () => {
    expect(progressBar(0, 0)).toBe('░░░░░░░░');
    expect(progressBar(5, 10)).toBe('▓▓▓▓░░░░');
    expect(progressBar(10, 10)).toBe('▓▓▓▓▓▓▓▓');
  });
});
