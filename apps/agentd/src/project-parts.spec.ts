import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PART_LIMITS, SnapshotPartSchema } from '@commander/contracts';
import type { SnapshotPart } from '@commander/contracts';
import { collectParts, discoverParts, fitParts, readPart } from './project-parts.js';
import { buildSnapshot, snapshotHash } from './project-snapshot.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mk = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'agd-parts-')));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text = '### [x] 1. Bir\n### [ ] 2. Ikki\n'): void => {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
};

describe('discoverParts', () => {
  it('papka bo\'yicha qismlar, ildiz qism emas, fayl nomlari katta-kichik harfga befarq', () => {
    const r = mk();
    put(r, 'TASKS.md'); // ildiz: qism emas
    put(r, 'docs/TASKS.md'); // ildizniki
    put(r, 'backend-services/TODO.md');
    put(r, 'web-app/todo.md');
    put(r, 'landing-page/TODO.md');
    put(r, 'landing-page/PRODUCT_MARKET_TODO.md');
    put(r, 'landing-page/TODO_9.5.md');
    put(r, 'mobile-app/docs/TASKS.md');
    put(r, 'infrastructure/readme.md'); // reja fayli emas
    put(r, 'apps/center/Tasks.md'); // chuqurlik 2
    const found = discoverParts(r);
    expect(found.map((f) => f.path)).toEqual(['apps/center', 'backend-services', 'landing-page', 'mobile-app', 'web-app']);
    expect(found.find((f) => f.path === 'landing-page')).toMatchObject({ name: 'landing-page', planFiles: ['landing-page/TODO.md', 'landing-page/PRODUCT_MARKET_TODO.md', 'landing-page/TODO_9.5.md'] });
    expect(found.find((f) => f.path === 'mobile-app')!.planFiles).toEqual(['mobile-app/docs/TASKS.md']);
    expect(found.find((f) => f.path === 'apps/center')!.name).toBe('center');
  });

  it('docs papkasi o\'zi qism bo\'lmaydi (TASKS.md ota papkaniki), lekin docs/TODO.md qism', () => {
    const r = mk();
    put(r, 'docs/TASKS.md');
    expect(discoverParts(r)).toEqual([]);
    put(r, 'docs/TODO.md');
    expect(discoverParts(r).map((f) => f.path)).toEqual(['docs']);
  });

  it('o\'tkazib yuboriladi: node_modules, dist, nuqtali papka, chuqurlik 3, symlink papka/fayl', () => {
    const r = mk();
    put(r, 'node_modules/x/TODO.md');
    put(r, 'dist/TODO.md');
    put(r, '.hidden/TODO.md');
    put(r, 'a/b/c/TODO.md'); // chuqurlik 3
    put(r, 'ok/TODO.md');
    const outside = mk();
    put(outside, 'TODO.md');
    symlinkSync(outside, join(r, 'linked'));
    mkdirSync(join(r, 'real'));
    symlinkSync(join(outside, 'TODO.md'), join(r, 'real', 'TODO.md'));
    expect(discoverParts(r).map((f) => f.path)).toEqual(['ok']);
  });

  it('maxfiy papka ichidagi qism tashlanadi', () => {
    const r = mk();
    put(r, 'secret/TODO.md');
    put(r, 'open/TODO.md');
    expect(discoverParts(r, { sensitive: [join(r, 'secret')] }).map((f) => f.path)).toEqual(['open']);
  });

  it('yaroqsiz nomli papka (bo\'shliq) va bo\'sh fayl tashlanadi; ildiz yo\'q bo\'lsa []', () => {
    const r = mk();
    put(r, 'my app/TODO.md');
    put(r, 'empty/TODO.md', '');
    expect(discoverParts(r)).toEqual([]);
    expect(discoverParts(join(r, 'yoq'))).toEqual([]);
  });

  it('qismlar soni chegaralangan', () => {
    const r = mk();
    for (let i = 0; i < PART_LIMITS.maxParts + 5; i++) put(r, `p${String(i).padStart(2, '0')}/TODO.md`);
    expect(discoverParts(r)).toHaveLength(PART_LIMITS.maxParts);
  });
});

describe('readPart', () => {
  it('parse, sanoq, redakt; sirlar sarlavhadan ketadi', () => {
    const r = mk();
    put(r, 'web-app/TODO.md', '## Faza\n### [x] 1. Deploy API_TOKEN=S3cr3tV4lue99 — BAJARILDI (2026-08-03)\n### [ ] 2. Test\n');
    const p = collectParts(r)[0]!;
    expect(SnapshotPartSchema.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ path: 'web-app', counts: { done: 1, todo: 1, total: 2 }, itemsTruncated: false, readTruncated: false });
    expect(JSON.stringify(p)).not.toContain('S3cr3tV4lue99');
    expect(p.items[0]).toMatchObject({ key: '1', status: 'done', doneOn: '2026-08-03', phase: 'Faza' });
  });

  it('bir nechta fayl: fayl nomi fazaga, takror kalit -2', () => {
    const r = mk();
    put(r, 'x/TODO.md', '### [x] 1. A\n### [ ] 2. B\n');
    put(r, 'x/PLAN_TODO.md', '### [ ] 1. C\n### [ ] 2. D\n');
    const p = collectParts(r)[0]!;
    expect(p.items.map((i) => i.key)).toEqual(['1', '2', '1-2', '2-2']);
    expect(p.items[2]!.phase).toBe('PLAN_TODO');
    expect(p.counts.total).toBe(4);
  });

  it('katta fayl kesiladi (bayt chegarasi), flag qo\'yiladi', () => {
    const r = mk();
    put(r, 'big/TODO.md', Array.from({ length: 2000 }, (_, i) => `### [ ] ${i + 1}. Band ${i}`).join('\n'));
    const [d] = discoverParts(r);
    const p = readPart(r, d!, { maxPlanFileBytes: 4096 });
    expect(p.readTruncated).toBe(true);
    expect(p.counts.total).toBeLessThan(2000);
    const full = readPart(r, d!);
    expect(full.readTruncated).toBe(false);
    expect(full.items).toHaveLength(1000);
    expect(full.counts.total).toBe(2000);
    expect(full.itemsTruncated).toBe(true);
  });
});

describe('fitParts', () => {
  const big = (n: number): SnapshotPart => ({
    path: 'big',
    name: 'big',
    planFiles: ['big/TODO.md'],
    counts: { todo: n / 2, doing: 0, done: n / 2, unknown: 0, total: n },
    items: Array.from({ length: n }, (_, i) => ({ key: String(i), title: `Sarlavha ${'x'.repeat(100)} ${i}`, phase: 'Faza '.repeat(10), status: i % 2 ? ('done' as const) : ('todo' as const) })),
    itemsTruncated: false,
    readTruncated: false,
  });

  it('byudjetga sig\'adi, sanoq o\'zgarmaydi, bajarilganlar birinchi tashlanadi', () => {
    const parts = [big(800)];
    const fitted = fitParts(parts, 50_000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(50_000);
    expect(fitted[0]!.counts).toEqual(parts[0]!.counts);
    expect(fitted[0]!.itemsTruncated).toBe(true);
    const todo = fitted[0]!.items.filter((i) => i.status === 'todo').length;
    const done = fitted[0]!.items.filter((i) => i.status === 'done').length;
    expect(todo).toBe(400); // ochiq bandlar saqlandi
    expect(done).toBeLessThan(400);
  });

  it('sig\'sa o\'zgarmaydi', () => {
    const parts = [big(3)];
    expect(fitParts(parts, 100_000)).toEqual(parts);
  });
});

describe('snapshot: qismlar', () => {
  it('buildSnapshot parts qo\'shadi, xesh band o\'zgarganda o\'zgaradi', async () => {
    const r = mk();
    put(r, 'web-app/TODO.md', '### [ ] 1. A\n### [ ] 2. B\n');
    const git = async (): Promise<string> => '';
    const a = await buildSnapshot(r, { git, skipStatus: true, now: () => 1000 });
    expect(a!.payload.parts).toHaveLength(1);
    expect(a!.payload.parts![0]!.counts.total).toBe(2);
    put(r, 'web-app/TODO.md', '### [x] 1. A\n### [ ] 2. B\n');
    const b = await buildSnapshot(r, { git, skipStatus: true, now: () => 2000 });
    expect(b!.payload.hash).not.toBe(a!.payload.hash);
    expect(snapshotHash({ ...a!.payload })).toBe(a!.payload.hash);
  });
});
