import { describe, expect, it } from 'vitest';
import { extractCandidateTasks, suggestTaskKeys } from './md-tasks.js';
import { parseTasksMarkdown } from './tasks-md.js';

const SPEC = `---
title: Billing v2
---
# Billing v2 spec

## Overview
Bu hujjat umumiy tavsif.

## Invoice generation
Hisob-fakturalarni avtomatik yaratish.

## Payment gateway
- [ ] Stripe webhook'larini **qabul qilish**
- [x] Webhook imzosini tekshirish
- [ ] [Retry navbati](https://x.y/z) qo'shish.
  - [ ] ichma-ich band (e'tiborsiz)

## Rollout steps
1. Staging'da sinash
2. Feature flag yoqish
3. \`prod\`ga chiqarish

\`\`\`md
## Kod ichidagi sarlavha
- [ ] kod ichidagi band
\`\`\`

## Notes
Shunchaki izoh.
`;

describe('extractCandidateTasks', () => {
  const out = extractCandidateTasks(SPEC);
  const titles = out.map((c) => c.title);

  it('checklist, raqamli ro\'yxat va ro\'yxatsiz sarlavhalarni oladi', () => {
    expect(titles).toContain('Invoice generation');
    expect(titles).toContain('Stripe webhook\'larini qabul qilish');
    expect(titles).toContain('Retry navbati qo\'shish');
    expect(titles).toContain('Staging\'da sinash');
    expect(titles).toContain('prod ga chiqarish'.replace('prod ga', 'prodga'));
  });

  it('checked bayrog\'i va manba', () => {
    const c = out.find((x) => x.title.startsWith('Webhook imzosini'))!;
    expect(c.checked).toBe(true);
    expect(c.source).toBe('checklist');
    expect(out.find((x) => x.title === 'Invoice generation')!.source).toBe('heading');
    expect(out.find((x) => x.title === 'Feature flag yoqish')!.source).toBe('numbered');
  });

  it('umumiy sarlavhalar, ro\'yxatli sarlavhalar (guruh), kod to\'siqlari va ichma-ich bandlar tushmaydi', () => {
    expect(titles).not.toContain('Overview');
    expect(titles).not.toContain('Notes');
    expect(titles).not.toContain('Payment gateway'); // ro'yxati bor: guruh
    expect(titles).not.toContain('Rollout steps');
    expect(titles).not.toContain('Billing v2 spec'); // 1-daraja
    expect(titles.join('|')).not.toContain('Kod ichidagi');
    expect(titles.join('|')).not.toContain('ichma-ich');
  });

  it('guruh nomi eng yaqin sarlavha', () => {
    expect(out.find((x) => x.title.startsWith('Stripe'))!.group).toBe('Payment gateway');
  });

  it('mavjud vazifa sarlavhasi bilan mos kelsa alreadyInTasks', () => {
    const o = extractCandidateTasks(SPEC, [{ key: '3.2', title: 'staging\'da sinash!' }]);
    expect(o.find((x) => x.title === 'Staging\'da sinash')!.alreadyInTasks).toBe('3.2');
  });

  it('takroriy sarlavha bir marta, CRLF ishlaydi', () => {
    const o = extractCandidateTasks('## A task\r\n- [ ] Bir xil\r\n- [ ] bir xil\r\n');
    expect(o.filter((c) => c.title.toLowerCase() === 'bir xil')).toHaveLength(1);
  });

  it('bo\'sh matn', () => {
    expect(extractCandidateTasks('')).toEqual([]);
  });
});

describe('suggestTaskKeys', () => {
  const tasks = parseTasksMarkdown(`## Faza 1 — A

| # | Task | Hajm |
|---|---|---|
| 1.1 | a | S |
| 1.2 | b | M |

## Faza 2 — B

| # | Task | Hajm |
|---|---|---|
| 2.1 | c | S |
| 2.14 | d | M |
| 2.15 | e | L |
`);

  it('faza ichidagi oxirgi id dan davom etadi', () => {
    expect(suggestTaskKeys(tasks, 'Faza 2 — B', 2)).toEqual(['2.16', '2.17']);
    expect(suggestTaskKeys(tasks, 'Faza 1 — A', 1)).toEqual(['1.3']);
  });

  it('yangi faza: keyingi major', () => {
    expect(suggestTaskKeys(tasks, 'Faza 3 — Yangi', 2)).toEqual(['3.1', '3.2']);
  });

  it('prefiksli va butun id uslublari', () => {
    const p = [{ key: 'sw-10', phase: 'X' }, { key: 'sw-12', phase: 'X' }];
    expect(suggestTaskKeys(p, 'X', 2)).toEqual(['sw-13', 'sw-14']);
    expect(suggestTaskKeys([{ key: '7', phase: 'X' }], 'X', 1)).toEqual(['8']);
    expect(suggestTaskKeys([], null, 2)).toEqual(['1', '2']);
  });

  it('mavjud id bilan to\'qnashmaydi', () => {
    const t = [{ key: '2.1', phase: 'P' }, { key: '2.3', phase: 'Q' }];
    expect(suggestTaskKeys(t, 'P', 2)).toEqual(['2.2', '2.4']);
  });
});
