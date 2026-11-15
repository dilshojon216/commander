import { describe, expect, it } from 'vitest';
import { TG_LOGS, formatLogsReply, logsErrorTextUz, parseLogsArgs } from './logs-format.js';
import { resolveMachine } from './logs-telegram.js';

describe('parseLogsArgs', () => {
  it('mashina + konteyner [n]; default 30; 50 bilan cheklanadi', () => {
    expect(parseLogsArgs('mac web-1')).toEqual({ ok: true, cmd: { machineRef: 'mac', source: 'docker', name: 'web-1', lines: 30 } });
    expect(parseLogsArgs('mac web-1 10')).toMatchObject({ ok: true, cmd: { lines: 10 } });
    expect(parseLogsArgs('mac web-1 999')).toMatchObject({ ok: true, cmd: { lines: TG_LOGS.maxLines } });
    expect(parseLogsArgs('mac web-1 0')).toMatchObject({ ok: true, cmd: { lines: 1 } });
  });
  it('journal: prefiksi', () => {
    expect(parseLogsArgs('srv journal:nginx 20')).toEqual({ ok: true, cmd: { machineRef: 'srv', source: 'journal', name: 'nginx', lines: 20 } });
  });
  it('yomon kirish: bayroq, shell belgilari, ortiqcha argument, n harf', () => {
    for (const a of ['', 'mac', 'mac --follow', 'mac -f 5', 'mac web;id', 'mac web$(id)', 'mac a b c d', 'mac web abc', 'mac web -5', 'mac journal:--user']) {
      expect(parseLogsArgs(a).ok, a).toBe(false);
    }
  });
});

describe('formatLogsReply', () => {
  const base = { machine: 'mac<1>', source: 'docker' as const, name: 'web-1', requested: 30 };
  it('HTML-escape (mashina nomi ham, log qatorlari ham)', () => {
    const t = formatLogsReply({ ...base, lines: ['<script>alert(1)</script> & x', 'a < b'] });
    expect(t).not.toContain('<script>');
    expect(t).toContain('&lt;script&gt;');
    expect(t).toContain('mac&lt;1&gt;');
    expect(t).toContain('<pre>');
  });
  it('sirlar qayta redakt qilinadi (xavfsizlik to\'ri)', () => {
    const t = formatLogsReply({ ...base, lines: ['Authorization: Bearer abcdef0123456789abcdef', 'api_key=sk-' + 'q'.repeat(30)] });
    expect(t).not.toMatch(/abcdef0123456789|qqqqqqqqqq/);
  });
  it('uzun qator kesiladi; umumiy hajm < 4096; eng oxirgi qatorlar qoladi', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(190)}`);
    const t = formatLogsReply({ ...base, lines });
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t).toContain('49 xxx');
    expect(t).not.toContain('00 xxx');
    expect(t).toContain('sig\'madi');
  });
  it('bitta juda uzun qator', () => {
    const t = formatLogsReply({ ...base, lines: ['y'.repeat(100_000)] });
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t).toContain('…');
  });
  it('n dan ko\'p qator kelsa ham oxirgi 50 ta; bo\'sh; eslatmalar', () => {
    expect(formatLogsReply({ ...base, lines: [] })).toContain("bo'sh");
    const t = formatLogsReply({ ...base, lines: ['a'], truncated: true, dropped: 4 });
    expect(t).toContain('256 KB');
    expect(t).toContain('4 qator tashlandi');
  });
  it('escape qilingan bo\'lak teg/entity o\'rtasidan kesilmaydi (&amp; butun)', () => {
    const t = formatLogsReply({ ...base, lines: Array.from({ length: 40 }, () => '&'.repeat(150)) });
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(/&(?!amp;|lt;|gt;|quot;|#)/.test(t.replace(/<[^>]+>/g, ''))).toBe(false);
  });
});

describe('xato matnlari va mashina tanlash', () => {
  it('kodlar', () => {
    expect(logsErrorTextUz('logs_not_found')).toContain('topilmadi');
    expect(logsErrorTextUz('nomalum')).toBe('Loglarni olib bo\'lmadi');
  });
  it('resolveMachine: slug yoki nom, registrga befarq', () => {
    const rows = [{ id: '1', slug: 'mac-mini', name: 'Mac Mini' }, { id: '2', slug: 'srv', name: 'Server' }];
    expect(resolveMachine(rows, 'MAC-MINI')?.id).toBe('1');
    expect(resolveMachine(rows, 'server')?.id).toBe('2');
    expect(resolveMachine(rows, 'x')).toBeUndefined();
  });
});
