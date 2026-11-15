import { describe, expect, it } from 'vitest';
import { ClientReportModelSchema } from '@commander/contracts';
import type { ClientReportModel } from '@commander/contracts';
import { renderClientReportHtml, visibleText, esc, CSP } from './html.js';
import { findLeaks } from './leak-check.js';
import { buildClientReportModel, weekStartOf } from './model.js';
import type { ClientReportInput } from './model.js';
import { renderClientReportPdf } from './pdf.js';

const NOW = new Date('2026-11-14T10:00:00Z');
const ctx = { forbidden: ['user-macbook', 'ubuntu-prod-1', '/Users/me/working/secret-client'] };
const SHA = '9fceb02d0ae598e95dc970b74767f19372d61af8';

function input(over: Partial<ClientReportInput> = {}): ClientReportInput {
  return {
    title: 'Acme Corp',
    from: '2026-11-02',
    to: '2026-11-14',
    now: NOW,
    groups: [
      {
        projectKey: 'github.com/o/a',
        name: 'alpha-app',
        tasks: [
          { taskKey: '1.1', title: 'Login sahifasi', status: 'done', order: 1 },
          { taskKey: '1.2', title: "To'lov integratsiyasi", status: 'doing', order: 2 },
          { taskKey: '1.3', title: 'Hisobotlar', status: 'todo', order: 3 },
          { taskKey: '1.4', title: 'Noma\'lum holat', status: 'unknown', order: 4 },
        ],
        closed: new Map([['1.1', Date.parse('2026-11-05T08:00:00Z')]]),
      },
    ],
    summaries: [{ day: '2026-11-05', text: '- Login tugadi\n- Dizayn kelishildi' }],
    showSummary: true,
    activeSeconds: null,
    ctx,
    ...over,
  };
}

describe('buildClientReportModel', () => {
  it('progress, guruhlash, unknown hisobga olinmaydi, sxemaga mos', () => {
    const m = buildClientReportModel(input());
    expect(ClientReportModelSchema.safeParse(m).success).toBe(true);
    expect(m.progress).toEqual({ done: 1, inProgress: 1, remaining: 1, total: 3, percentDone: 33 });
    expect(m.groups[0]!.done).toEqual([{ title: 'Login sahifasi' }]);
    expect(m.groups[0]!.closedInPeriod).toEqual([{ title: 'Login sahifasi' }]);
    expect(m.groups[0]!.remaining).toEqual([{ title: 'Hisobotlar' }]);
    expect(m.activeSeconds).toBeNull();
  });

  it('haftalar dushanbadan boshlanadi; bo\'sh haftalar ham bor; yopilish haftasiga yoziladi', () => {
    expect(weekStartOf('2026-11-14')).toBe('2026-11-09'); // shanba
    expect(weekStartOf('2026-11-15')).toBe('2026-11-09'); // yakshanba
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09');
    const m = buildClientReportModel(input());
    expect(m.weekly).toEqual([{ weekStart: '2026-11-02', closed: 1 }, { weekStart: '2026-11-09', closed: 0 }]);
  });

  it('Toshkent kun chegarasi haftaga ta\'sir qiladi: yakshanba 20:00Z = dushanba 01:00 Toshkent', () => {
    const m = buildClientReportModel(input({ groups: [{ projectKey: 'k', name: 'x', tasks: [{ taskKey: 'a', title: 'T', status: 'done', order: 1 }], closed: new Map([['a', Date.parse('2026-11-08T20:00:00Z')]]) }] }));
    expect(m.weekly.find((w) => w.weekStart === '2026-11-09')!.closed).toBe(1);
  });

  it('showSummary=false: xulosa yo\'q; soatlar faqat berilganda', () => {
    expect(buildClientReportModel(input({ showSummary: false })).summaries).toEqual([]);
    expect(buildClientReportModel(input({ activeSeconds: 3725.4 })).activeSeconds).toBe(3725);
    expect(buildClientReportModel(input()).summaries).toEqual([{ weekStart: '2026-11-02', lines: ['Login tugadi', 'Dizayn kelishildi'] }]);
  });

  it('sarlavha tozalanadi, bo\'sh qolsa zaxira matn; ro\'yxat chegarasi', () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({ taskKey: `t${i}`, title: i === 0 ? '/Users/x/y.ts' : `Vazifa ${i}`, status: 'todo' as const, order: i }));
    const m = buildClientReportModel(input({ groups: [{ projectKey: 'k', name: '~/secret/dir', tasks, closed: new Map() }] }));
    expect(m.groups[0]!.name).toBe('Loyiha 1');
    expect(m.groups[0]!.remaining[0]!.title).toBe('Vazifa');
    expect(m.groups[0]!.remaining).toHaveLength(150);
    expect(m.truncated).toBe(true);
  });

  it("vazifa yo'q = 0%", () => {
    expect(buildClientReportModel(input({ groups: [] })).progress).toEqual({ done: 0, inProgress: 0, remaining: 0, total: 0, percentDone: 0 });
  });
});

describe('HTML: xavfsizlik', () => {
  const hostile = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'; DROP TABLE x;--", '<style>@import url(http://evil)</style>', '</title><script>x</script>', 'javascript:alert(1)', '&lt;b&gt;'];
  const html = renderClientReportHtml(
    buildClientReportModel(
      input({
        title: '<script>t</script>Acme "&" Co',
        groups: [{ projectKey: 'k', name: '<b>proj</b>', tasks: hostile.map((h, i) => ({ taskKey: `x${i}`, title: `Task ${h} end`, status: 'doing' as const, order: i })), closed: new Map() }],
        summaries: [{ day: '2026-11-05', text: hostile.map((h) => `- ok ${h} x`).join('\n') }],
      }),
    ),
  );

  it("skript, tashqi resurs, havola, forma, iframe yo'q", () => {
    for (const re of [/<script/i, /<link\b/i, /<img\b/i, /<iframe/i, /<form/i, /<object/i, /<embed/i, /\bon\w+\s*=/i, /\bhref\s*=/i, /\bsrc\s*=/i, /https?:\/\//i]) {
      expect(html, String(re)).not.toMatch(re);
    }
  });

  it("uslub bloki: tashqi resurs yo'q (url(), @import)", () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toMatch(/url\(|@import|expression\(/i);
  });

  it('CSP meta: default-src none, faqat inline uslub', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).not.toMatch(/script-src|connect-src|https?:/);
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it('dinamik matn escape qilingan', () => {
    expect(html).toContain('Acme &quot;&amp;&quot; Co');
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it("faqat bitta <style> bloki va hujjat bitta <html>", () => {
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<html/g)).toHaveLength(1);
  });
});

describe('Sizib chiqmasligi: model -> HTML -> leak-check (jadval)', () => {
  const dirty = [
    '/Users/me/working/secret-client/src/pay.ts tuzatildi',
    'user-macbook da sinov',
    `merge ${SHA} into main`,
    'ubuntu-prod-1 deploy, ssh root@100.101.102.103',
    'API_KEY=sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ',
    'C:\\Users\\Ali\\proj\\main.rs',
    'see https://internal.example.com/ticket/5',
    'mail me: owner@client-co.com',
    'libs/contracts/src/billing.ts refactor',
  ];
  it.each(dirty)('%s', (text) => {
    const m = buildClientReportModel(
      input({
        title: `Client ${text}`,
        groups: [{ projectKey: 'k', name: `proj ${text}`, tasks: [{ taskKey: 'a', title: `Do ${text} now`, status: 'todo', order: 1 }], closed: new Map() }],
        summaries: [{ day: '2026-11-05', text: `- ${text}` }],
      }),
    );
    const html = renderClientReportHtml(m);
    const lc = { names: ['user-macbook', 'ubuntu-prod-1'], paths: ['/Users/me/working/secret-client'], shas: [SHA] };
    expect(findLeaks(m, html, lc)).toEqual([]);
    const all = visibleText(html);
    for (const bad of ['/Users', 'user-macbook', SHA.slice(0, 7), 'ubuntu-prod-1', 'sk-ant', 'C:\\', 'internal.example', 'client-co.com', 'billing.ts', '100.101']) expect(all.toLowerCase()).not.toContain(bad.toLowerCase());
  });
});

describe('findLeaks (so\'nggi to\'siq o\'zi ishlaydi)', () => {
  const clean: ClientReportModel = buildClientReportModel(input());
  const lc = { names: ['user-macbook'], paths: ['/Users/me/working/secret-client'], shas: [SHA] };
  it('toza hujjat = bo\'sh', () => expect(findLeaks(clean, renderClientReportHtml(clean), lc)).toEqual([]));
  it("tozalashni chetlab o'tgan sizib chiqish topiladi", () => {
    const leaky = { ...clean, title: 'x', groups: [{ ...clean.groups[0]!, done: [{ title: `fix in /Users/me/working/secret-client on user-macbook ${SHA.slice(0, 9)}` }] }] };
    const kinds = findLeaks(leaky, renderClientReportHtml(leaky), lc);
    expect(kinds).toEqual(expect.arrayContaining(['path', 'machine_name', 'commit_hash']));
  });
  it('sir va havola', () => {
    const leaky = { ...clean, groups: [{ ...clean.groups[0]!, done: [{ title: 'key sk-ant-api03-ABCDEFGHIJKLMNOP1234 at https://x.io/a' }] }] };
    expect(findLeaks(leaky, renderClientReportHtml(leaky), lc)).toEqual(expect.arrayContaining(['secret', 'url']));
  });
});

describe('PDF', () => {
  it('to\'g\'ri PDF; soatlar bilan ham, bo\'sh model bilan ham', async () => {
    const a = await renderClientReportPdf(buildClientReportModel(input({ activeSeconds: 7200 })));
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.subarray(-6).toString()).toContain('%%EOF');
    const b = await renderClientReportPdf(buildClientReportModel(input({ groups: [], summaries: [] })));
    expect(b.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
