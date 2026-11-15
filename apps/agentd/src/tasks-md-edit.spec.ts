import { describe, expect, it } from 'vitest';
import { parseTasksMarkdown } from '@commander/contracts';
import { appendTasksToMd } from './tasks-md-edit.js';

const BASE = `# Ish ro'yxati

Izoh matni.

## Faza 1 — Poydevor (≈1 hafta)

| # | Task | Nega shu tartibda | Hajm |
|---|---|---|---|
| 1.1 | ✅ **Spike** | birinchi | S |
| 1.2 | Ikkinchi | keyin | M |

Faza 1 oxiri.

## Faza 2 — Boshqaruv

| # | Task | Nega | Hajm |
|---|---|---|---|
| 2.1 | Birinchi | x | L |
`;

const t = (key: string, title: string, size?: string) => ({ key, title, ...(size ? { size } : {}) });

/** Kiritilgan qatorlarni olib tashlab, asl matnni qaytaradi: "baytma-bayt saqlanadi" isboti. */
function withoutInserted(out: string, inserted: string[]): string {
  let s = out;
  for (const row of inserted) {
    const i = s.indexOf(row);
    expect(i, row).toBeGreaterThanOrEqual(0);
    // qator va uning ajratgichi
    const m = /^(\r\n|\n)/.exec(s.slice(i + row.length));
    s = s.slice(0, i) + s.slice(i + row.length + (m ? m[1]!.length : 0));
  }
  return s;
}

describe('appendTasksToMd', () => {
  it('mavjud fazaning jadvali oxiriga qo\'shadi; qolgan mazmun baytma-bayt saqlanadi', () => {
    const r = appendTasksToMd(BASE, 'Faza 1 — Poydevor (≈1 hafta)', [t('1.3', 'Yangi vazifa', 'M'), t('1.4', 'Yana | bitta', 'S')]);
    expect(r.added).toBe(2);
    expect(r.createdPhase).toBe(false);
    const rows = ['| 1.3 | Yangi vazifa |  | M |', '| 1.4 | Yana \\| bitta |  | S |'];
    for (const row of rows) expect(r.content).toContain(row);
    expect(withoutInserted(r.content, rows)).toBe(BASE);
    // qatorlar 1.2 dan keyin, "Faza 1 oxiri" dan oldin
    expect(r.content.indexOf('| 1.3 |')).toBeGreaterThan(r.content.indexOf('| 1.2 |'));
    expect(r.content.indexOf('| 1.4 |')).toBeLessThan(r.content.indexOf('Faza 1 oxiri.'));
    // parser yangi vazifalarni to'g'ri faza va hajm bilan ko'radi
    const parsed = parseTasksMarkdown(r.content);
    expect(parsed.find((x) => x.key === '1.3')).toMatchObject({ phase: 'Faza 1 — Poydevor (≈1 hafta)', size: 'M', status: 'todo', title: 'Yangi vazifa' });
    expect(parsed.find((x) => x.key === '1.4')!.title).toBe('Yana | bitta');
    expect(parsed.find((x) => x.key === '2.1')!.phase).toBe('Faza 2 — Boshqaruv');
  });

  it('oxirgi fazaga (fayl oxiri) qo\'shadi', () => {
    const r = appendTasksToMd(BASE, 'Faza 2 — Boshqaruv', [t('2.2', 'Oxirgi')]);
    expect(r.content.endsWith('| 2.1 | Birinchi | x | L |\n| 2.2 | Oxirgi |  |  |\n')).toBe(true);
  });

  it('faza yo\'q: oxirida yangi bo\'lim, jadval sarlavhasi mavjud jadvaldan ko\'chiriladi', () => {
    const r = appendTasksToMd(BASE, 'Faza 3 — Yangi', [t('3.1', 'A', 'S'), t('3.2', 'B')]);
    expect(r.createdPhase).toBe(true);
    expect(r.content.startsWith(BASE)).toBe(true);
    const tail = r.content.slice(BASE.length);
    expect(tail).toBe('\n## Faza 3 — Yangi\n\n| # | Task | Nega shu tartibda | Hajm |\n|---|---|---|---|\n| 3.1 | A |  | S |\n| 3.2 | B |  |  |\n');
    expect(parseTasksMarkdown(r.content).filter((x) => x.phase === 'Faza 3 — Yangi').map((x) => x.key)).toEqual(['3.1', '3.2']);
  });

  it('jadvali umuman yo\'q fayl: standart sarlavha', () => {
    const r = appendTasksToMd('# Reja\n', 'Faza 1', [t('1.1', 'Birinchi', 'M')]);
    expect(r.content).toBe('# Reja\n\n## Faza 1\n\n| # | Task | Hajm |\n|---|---|---|\n| 1.1 | Birinchi | M |\n');
  });

  it('CRLF (Windows): yangi qatorlar ham CRLF, qolgani o\'zgarmaydi', () => {
    const crlf = BASE.replace(/\n/g, '\r\n');
    const r = appendTasksToMd(crlf, 'Faza 1 — Poydevor (≈1 hafta)', [t('1.3', 'Yangi', 'M')]);
    expect(r.content).toContain('| 1.3 | Yangi |  | M |\r\n');
    expect(r.content.replace(/\r\n/g, '').includes('\n')).toBe(false); // yolg'iz LF yo'q
    expect(withoutInserted(r.content, ['| 1.3 | Yangi |  | M |'])).toBe(crlf);
    const r2 = appendTasksToMd(crlf, 'Faza 9', [t('9.1', 'X')]);
    expect(r2.content.startsWith(crlf)).toBe(true);
    expect(r2.content.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('oxirgi qatorsiz tugagan fayl (EOF da yangi qator yo\'q)', () => {
    const noNl = BASE.trimEnd();
    const r = appendTasksToMd(noNl, 'Faza 2 — Boshqaruv', [t('2.2', 'Oxirgi')]);
    expect(r.content).toBe(`${noNl}\n| 2.2 | Oxirgi |  |  |`);
  });

  it('BOM saqlanadi', () => {
    const r = appendTasksToMd(`﻿${BASE}`, 'Faza 1 — Poydevor (≈1 hafta)', [t('1.3', 'Y')]);
    expect(r.content.startsWith('﻿# Ish')).toBe(true);
  });

  it('mavjud id qo\'shilmaydi (skippedKeys), hammasi mavjud bo\'lsa o\'zgarishsiz', () => {
    const r = appendTasksToMd(BASE, 'Faza 1 — Poydevor (≈1 hafta)', [t('1.2', 'Takror'), t('1.3', 'Yangi')]);
    expect(r.added).toBe(1);
    expect(r.skippedKeys).toEqual(['1.2']);
    const none = appendTasksToMd(BASE, 'Faza 1 — Poydevor (≈1 hafta)', [t('1.1', 'Takror')]);
    expect(none.added).toBe(0);
    expect(none.content).toBe(BASE);
  });

  it('status ustuni bor jadval: bo\'sh katak (todo)', () => {
    const md = '## Faza A\n\n| # | Task | Holat | Hajm |\n|---|---|---|---|\n| 1 | a | Qoldi | S |\n';
    const r = appendTasksToMd(md, 'Faza A', [t('2', 'b', 'L')]);
    expect(r.content).toBe(`${md}| 2 | b |  | L |\n`);
    expect(parseTasksMarkdown(r.content).find((x) => x.key === '2')!.status).toBe('todo');
  });
});
