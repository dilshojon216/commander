import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, parsePlanMarkdown, planPercent } from './plan-md.js';
import { PartPathSchema, partForCwd, partSlug, partTaskKey, splitPartTaskKey, TaskKeyAnySchema } from './project-parts.js';

/** Anonimlashtirilgan, qisqartirilgan namunalar (haqiqiy fayllar: sarlavha-band, checklist, commander jadvali). */
const HEADINGS = `# Servis — Bajarilishi kerak bo'lgan ishlar

> Belgilar: 🔴 Critical · 🟠 High

## 🔴 P0 — Critical (production'dan OLDIN majburiy)

### [x] 1. Broker autentifikatsiyasini yoqish — BAJARILDI (2026-08-03)
- **Real holat edi:** nimadir
- [x] ichki qabul mezoni (bu alohida vazifa emas)

### [ ] 2. \`Rate-limit\` tekshiruvi — hali OCHIQ

## 🟡 P2 — Medium

### [~] 3a. **Kafka** retry
#### [x] 39.1. Ichki band — TO'LIQ BAJARILDI (2026-09-01)
### [ ] Id'siz band sarlavhasi
### [ ] 2. Takror id
`;

const CHECKLIST = `# Reja

## Birinchi bosqich
- [x] Landing sahifa tayyor (2026-05-01)
- [ ] SEO meta teglar
  - [ ] ichma-ich band
  - [x] ichma-ich bajarilgan
\`\`\`
- [ ] kod to'sig'idagi band emas
\`\`\`

## Ikkinchi bosqich
* [~] Analitika
- [ ] SEO meta teglar
`;

const TABLE = `# Reja

## Faza 1

| # | Task | Hajm |
|---|------|------|
| 1.1 | ✅ **(2026-11-13 bajarildi)** Monorepo | M |
| 1.2 | 🚧 Hook ko'prigi | L |
| 1.3 | Token yig'ish | S |
`;

describe('parsePlanMarkdown: sarlavha bandlari', () => {
  const r = parsePlanMarkdown(HEADINGS);
  it('format va sanoq', () => {
    expect(r.format).toBe('headings');
    expect(r.items.map((i) => i.key.startsWith('t') ? 't*' : i.key)).toEqual(['1', '2', '3a', '39.1', 't*', '2-2']);
    expect(r.counts).toEqual({ done: 2, doing: 1, todo: 3, unknown: 0, total: 6 });
    expect(r.truncated).toBe(false);
  });
  it('sarlavha dumi kesiladi, sana ajratiladi, faza topiladi', () => {
    const [a, b] = r.items;
    expect(a).toMatchObject({ title: 'Broker autentifikatsiyasini yoqish', status: 'done', doneOn: '2026-08-03' });
    expect(a!.phase).toContain('P0');
    expect(b).toMatchObject({ title: 'Rate-limit tekshiruvi', status: 'todo', doneOn: null });
  });
  it('ichidagi checklist alohida vazifa emas; doing; ichma-ich sarlavha', () => {
    expect(r.items.find((i) => i.key === '3a')).toMatchObject({ status: 'doing', title: 'Kafka retry' });
    expect(r.items.find((i) => i.key === '39.1')).toMatchObject({ status: 'done', doneOn: '2026-09-01', title: 'Ichki band' });
    expect(r.items.some((i) => /qabul mezoni/.test(i.title))).toBe(false);
  });
  it('id\'siz band: barqaror xesh kalit', () => {
    const k1 = parsePlanMarkdown(HEADINGS).items[4]!.key;
    const k2 = parsePlanMarkdown(`### [ ] boshqa\n### [x] Id'siz band sarlavhasi\n`).items[1]!.key;
    expect(k1).toBe(k2);
  });
});

describe('parsePlanMarkdown: checklist', () => {
  const r = parsePlanMarkdown(CHECKLIST);
  it('ichma-ich bandlar, kod to\'sig\'i tashlanadi, takror sarlavha -2', () => {
    expect(r.format).toBe('checklist');
    expect(r.items.map((i) => i.title)).toEqual(['Landing sahifa tayyor (2026-05-01)', 'SEO meta teglar', 'ichma-ich band', 'ichma-ich bajarilgan', 'Analitika', 'SEO meta teglar']);
    expect(r.items[5]!.key.endsWith('-2')).toBe(true);
    expect(r.counts).toMatchObject({ done: 2, doing: 1, todo: 3, total: 6 });
  });
  it('faza = eng yaqin sarlavha; sana', () => {
    expect(r.items[0]).toMatchObject({ phase: 'Birinchi bosqich', doneOn: '2026-05-01' });
    expect(r.items[4]!.phase).toBe('Ikkinchi bosqich');
  });
  it('id\'li checklist parseTasksMarkdown orqali', () => {
    const x = parsePlanMarkdown('- [x] 1.4 Bir\n- [ ] 1.5 Ikki\n');
    expect(x.format).toBe('checklist');
    expect(x.items.map((i) => [i.key, i.status])).toEqual([['1.4', 'done'], ['1.5', 'todo']]);
  });
});

describe('parsePlanMarkdown: commander jadvali', () => {
  it('jadval qatorlari', () => {
    const r = parsePlanMarkdown(TABLE);
    expect(r.format).toBe('table');
    expect(r.items.map((i) => [i.key, i.status, i.size])).toEqual([['1.1', 'done', 'M'], ['1.2', 'doing', 'L'], ['1.3', 'todo', 'S']]);
    expect(planPercent(r.counts)).toBe(33);
  });
});

describe('parsePlanMarkdown: chegaralar va bo\'sh fayl', () => {
  it('bo\'sh/bandsiz', () => {
    expect(parsePlanMarkdown('').format).toBe('none');
    expect(parsePlanMarkdown('# Faqat matn\n\nHech narsa').items).toEqual([]);
    expect(planPercent({ done: 0, total: 0 })).toBeNull();
  });
  it('katta fayl: maxItems kesadi, sanoq to\'liq', () => {
    const md = Array.from({ length: 1500 }, (_, i) => `### [${i % 3 === 0 ? 'x' : ' '}] ${i + 1}. Band ${i}`).join('\n');
    const r = parsePlanMarkdown(md);
    expect(r.items).toHaveLength(PLAN_LIMITS.maxItems);
    expect(r.truncated).toBe(true);
    expect(r.counts.total).toBe(1500);
    expect(r.counts.done).toBe(500);
  });
  it('uzun sarlavha va faza kesiladi', () => {
    const r = parsePlanMarkdown(`## ${'F'.repeat(300)}\n### [ ] 1. ${'x'.repeat(500)}\n### [ ] 2. ikki\n`);
    expect(r.items[0]!.title.length).toBeLessThanOrEqual(PLAN_LIMITS.maxTitle);
    expect(r.items[0]!.phase!.length).toBeLessThanOrEqual(PLAN_LIMITS.maxPhase);
  });
  it('CRLF', () => {
    expect(parsePlanMarkdown('### [x] 1. A\r\n### [ ] 2. B\r\n').counts.total).toBe(2);
  });
});

describe('qism yordamchilari', () => {
  it('kalit nomlar maydoni', () => {
    expect(partTaskKey('', '1.2')).toBe('1.2');
    expect(partTaskKey('Web-App', '1.2')).toBe('web-app:1.2');
    expect(partTaskKey('apps/Center', 't1')).toBe('apps~center:t1');
    expect(splitPartTaskKey('web-app:1.2')).toEqual({ slug: 'web-app', key: '1.2' });
    expect(splitPartTaskKey('1.2')).toEqual({ slug: '', key: '1.2' });
    expect(partSlug('A/B')).toBe('a~b');
  });
  it('REST kalit sxemasi', () => {
    for (const k of ['1.2', 'web-app:1.2', 'apps~center:t1x2']) expect(TaskKeyAnySchema.safeParse(k).success).toBe(true);
    for (const k of ['', ':1', 'a:b:c', 'A', 'a b']) expect(TaskKeyAnySchema.safeParse(k).success).toBe(false);
  });
  it('qism yo\'li sxemasi', () => {
    for (const p of ['web-app', 'apps/center', 'a.b_c']) expect(PartPathSchema.safeParse(p).success).toBe(true);
    for (const p of ['', '/abs', '../x', 'a/b/c', 'a b', 'a//b', '.git']) expect(PartPathSchema.safeParse(p).success).toBe(false);
  });
  it('partForCwd: eng uzun prefiks, papka chegarasi, ildiz', () => {
    const parts = ['apps', 'apps/center', 'web-app'];
    expect(partForCwd('/r/p/apps/center/src', '/r/p', parts)).toBe('apps/center');
    expect(partForCwd('/r/p/apps/dashboard', '/r/p', parts)).toBe('apps');
    expect(partForCwd('/r/p/web-app2', '/r/p', parts)).toBe('');
    expect(partForCwd('/r/p', '/r/p', parts)).toBe('');
    expect(partForCwd('/r/p/', '/r/p/', parts)).toBe('');
    expect(partForCwd('/other/web-app', '/r/p', parts)).toBe('');
    expect(partForCwd('/r/p/web-app', '/r/p', [])).toBe('');
  });
});
