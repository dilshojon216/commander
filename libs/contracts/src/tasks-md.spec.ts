import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTasksMarkdown, summarizeTasks } from './tasks-md.js';

const REAL = readFileSync(new URL('./fixtures/commander-TASKS.md', import.meta.url), 'utf8');

describe('parseTasksMarkdown: commander real docs/TASKS.md (fixture nusxa)', () => {
  const rows = parseTasksMarkdown(REAL);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it('barcha # | Task jadvallari o\'qiladi, faqat ular', () => {
    // Faza 0 (0.1..0.6), Faza 1 (1.1, 1.1a-c, 1.2..1.9), Faza 2 (2.1..2.16), Faza 3 (3.1..3.6), Faza 4 (4.1..4.5)
    expect(byKey.has('0.1')).toBe(true);
    expect(byKey.has('1.1a')).toBe(true);
    expect(byKey.has('2.16')).toBe(true);
    expect(byKey.has('4.5')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(45);
    // "Birinchi 10 task" jadvalida `#` ustuni raqam, lekin `Task` ustuni yo'q: qo'shilmasligi kerak (kalitlar takrorlanmaydi)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('✅ = done, belgisiz = todo', () => {
    expect(byKey.get('1.4')?.status).toBe('done');
    expect(byKey.get('0.1')?.status).toBe('done');
    expect(byKey.get('2.1')?.status).toBe('todo');
    expect(byKey.get('2.9')?.status).toBe('todo');
    expect(byKey.get('1.4')?.rawStatus).toBe('✅');
    expect(byKey.get('2.1')?.rawStatus).toBeNull();
  });

  it('faza, tartib va hajm', () => {
    expect(byKey.get('1.4')?.phase).toMatch(/^Faza 1/);
    expect(byKey.get('2.9')?.phase).toMatch(/^Faza 2/);
    expect(byKey.get('2.9')?.size).toBe('M');
    expect(rows.map((r) => r.order)).toEqual(rows.map((_, i) => i));
    expect(rows.findIndex((r) => r.key === '0.1')).toBeLessThan(rows.findIndex((r) => r.key === '2.1'));
  });

  it('sarlavha toza: izoh va markdown belgilarsiz, 200 belgigacha', () => {
    for (const r of rows) {
      expect(r.title.length).toBeLessThanOrEqual(200);
      expect(r.title).not.toMatch(/\*\*/);
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(byKey.get('1.4')?.title).toMatch(/^Center/);
  });

  it('summary yig\'indisi jami songa teng', () => {
    const s = summarizeTasks(rows);
    expect(s.done + s.doing + s.todo + s.unknown).toBe(s.total);
    expect(s.total).toBe(rows.length);
    expect(s.done).toBeGreaterThan(20);
    expect(s.todo).toBeGreaterThan(5);
  });
});

describe('parseTasksMarkdown: variantlar', () => {
  it('⏳ / 🔄 / 🚧 = doing', () => {
    const md = '| # | Task |\n|---|---|\n| 1 | ⏳ A |\n| 2 | 🔄 B |\n| 3 | 🚧 C |\n| 4 | D |\n';
    expect(parseTasksMarkdown(md).map((r) => r.status)).toEqual(['doing', 'doing', 'doing', 'todo']);
  });

  it('alohida Holat ustuni; tanilmagan qiymat = unknown, bo\'sh = belgidan/todo', () => {
    const md = '| ID | Vazifa | Holat |\n|---|---|---|\n| T-1 | A | Bajarildi |\n| T-2 | B | Jarayonda |\n| T-3 | C | Qoldi |\n| T-4 | D | bloklangan |\n| T-5 | ✅ E |  |\n| T-6 | F |  |\n';
    const rows = parseTasksMarkdown(md);
    expect(rows.map((r) => r.status)).toEqual(['done', 'doing', 'todo', 'unknown', 'done', 'todo']);
    expect(rows[3]?.rawStatus).toBe('bloklangan');
    expect(rows[0]?.key).toBe('t-1');
  });

  it('[x] / [ ] ro\'yxatlari', () => {
    const md = '## Faza A\n\n- [x] 1.1 Birinchi\n- [ ] **1.2** Ikkinchi\n- [~] 1.3: Uchinchi\n- [ ] id yo\'q matn\n';
    const rows = parseTasksMarkdown(md);
    expect(rows.map((r) => [r.key, r.status, r.phase])).toEqual([
      ['1.1', 'done', 'Faza A'],
      ['1.2', 'todo', 'Faza A'],
      ['1.3', 'doing', 'Faza A'],
    ]);
    expect(rows[0]?.title).toBe('Birinchi');
  });

  it('ahamiyatsiz jadval va takroriy id e\'tiborga olinmaydi; CRLF', () => {
    const md = '| Nom | Qiymat |\r\n|---|---|\r\n| a | b |\r\n\r\n| # | Task |\r\n|---|---|\r\n| 1.1 | X |\r\n| 1.1 | Y |\r\n';
    const rows = parseTasksMarkdown(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('X');
  });

  it('katak ichidagi `|` va bo\'sh/yaroqsiz kirish', () => {
    expect(parseTasksMarkdown('')).toEqual([]);
    expect(parseTasksMarkdown('faqat matn\n\n# sarlavha\n')).toEqual([]);
    const md = '| # | Task |\n|---|---|\n| 5 | a \\| b `x|y` |\n';
    expect(parseTasksMarkdown(md)[0]?.title).toBe('a | b x|y');
  });
});
