import { describe, expect, it } from 'vitest';
import type { SnapshotPart } from '@commander/contracts';
import { buildDoneSummary, chooseTaskKey, diffTaskGroups, partTaskRows } from './part-logic.js';

const part = (path: string, items: Array<[string, 'todo' | 'doing' | 'done', string?]>): SnapshotPart => ({
  path,
  name: path,
  planFiles: [`${path}/TODO.md`],
  counts: { todo: 0, doing: 0, done: 0, unknown: 0, total: items.length },
  items: items.map(([key, status, doneOn]) => ({ key, title: `T ${key}`, status, ...(doneOn ? { doneOn } : {}) })),
  itemsTruncated: false,
  readTruncated: false,
});

describe('partTaskRows', () => {
  it('kalit nomlar maydonida, qismlar orasida to\'qnashmaydi, sir redakt qilinadi', () => {
    const a = part('web-app', [['1', 'done', '2026-01-02'], ['2', 'todo']]);
    const b = part('apps/Center', [['1', 'todo']]);
    a.items[1]!.title = 'Deploy API_TOKEN=S3cr3tV4lue99';
    const rows = partTaskRows([a, b]);
    expect(rows.map((r) => r.taskKey)).toEqual(['web-app:1', 'web-app:2', 'apps~center:1']);
    expect(rows.map((r) => r.part)).toEqual(['web-app', 'web-app', 'apps/Center']);
    expect(rows[0]).toMatchObject({ doneOn: '2026-01-02', order: 0 });
    expect(rows[1]!.title).not.toContain('S3cr3tV4lue99');
  });
});

describe('diffTaskGroups', () => {
  const rootNext = [{ key: '1.1', status: 'done' as const }];
  it('yangi paydo bo\'lgan qism: baseline (bajarilganlar "bugun yopildi" bo\'lmaydi)', () => {
    const prev = [{ task_key: '1.1', status: 'todo', part: '' }];
    const next = partTaskRows([part('web-app', [['1', 'done'], ['2', 'todo']])]);
    const ch = diffTaskGroups(prev, rootNext, next);
    expect(ch).toEqual([{ taskKey: '1.1', from: 'todo', to: 'done' }]);
  });
  it('mavjud qismda o\'zgarish yoziladi (nomlar maydonli kalit bilan)', () => {
    const prev = [
      { task_key: '1.1', status: 'done', part: '' },
      { task_key: 'web-app:1', status: 'todo', part: 'web-app' },
      { task_key: 'web-app:2', status: 'todo', part: 'web-app' },
    ];
    const next = partTaskRows([part('web-app', [['1', 'done'], ['2', 'todo'], ['3', 'todo']])]);
    expect(diffTaskGroups(prev, rootNext, next)).toEqual([{ taskKey: 'web-app:1', from: 'todo', to: 'done' }]);
  });
  it('partNext = null (eski agentd): qismlarga tegilmaydi', () => {
    const prev = [{ task_key: 'web-app:1', status: 'todo', part: 'web-app' }];
    expect(diffTaskGroups(prev, [], null)).toEqual([]);
  });
  it('ildiz vazifalari yo\'q edi, qism bor: ildiz birinchi marta baseline', () => {
    const prev = [{ task_key: 'web-app:1', status: 'todo', part: 'web-app' }];
    expect(diffTaskGroups(prev, [{ key: '1.1', status: 'done' }], partTaskRows([part('web-app', [['1', 'todo']])]))).toEqual([]);
  });
});

describe('buildDoneSummary', () => {
  const row = (taskKey: string, status: 'todo' | 'done', order: number, doneOn: string | null, eventDay: string | null = null, phase: string | null = 'F1') => ({
    taskKey,
    title: `T ${taskKey}`,
    phase,
    order,
    status,
    doneOn,
    eventDay,
  });
  it('oxirgi bajarilganlar: sanalilar sana kamayishida, keyin sanasizlar fayl oxiridan; fayl sanasi hodisadan ustun', () => {
    const rows = [
      row('p:1', 'done', 0, '2026-01-01'),
      row('p:2', 'done', 1, null, '2026-03-01'),
      row('p:3', 'done', 2, '2026-02-01'),
      row('p:4', 'done', 3, null),
      row('p:5', 'done', 4, null),
      row('p:6', 'todo', 5, null),
    ];
    const s = buildDoneSummary(rows, 4);
    expect(s.recentDone.map((r) => [r.key, r.doneOn])).toEqual([['2', '2026-03-01'], ['3', '2026-02-01'], ['1', '2026-01-01'], ['5', null]]);
  });
  it('faza bo\'yicha done/total', () => {
    const s = buildDoneSummary([row('1', 'done', 0, null, null, 'A'), row('2', 'todo', 1, null, null, 'A'), row('3', 'done', 2, null, null, null)]);
    expect(s.byPhase).toEqual([{ phase: 'A', done: 1, total: 2 }, { phase: null, done: 1, total: 1 }]);
  });
  it('bo\'sh', () => {
    expect(buildDoneSummary([])).toEqual({ recentDone: [], byPhase: [] });
  });
});

describe('chooseTaskKey', () => {
  it('ildiz sessiyasi o\'zgarmaydi', () => expect(chooseTaskKey('', '1.2', new Set(['web-app:1.2']))).toBe('1.2'));
  it('qism vazifasi bor: nomlar maydoni', () => expect(chooseTaskKey('web-app', '1.2', new Set(['web-app:1.2', '1.2']))).toBe('web-app:1.2'));
  it('faqat ildizda bor: ildiz kaliti', () => expect(chooseTaskKey('web-app', '1.2', new Set(['1.2']))).toBe('1.2'));
  it('hech qayerda yo\'q: qismniki', () => expect(chooseTaskKey('apps/x', '9', new Set())).toBe('apps~x:9'));
});
