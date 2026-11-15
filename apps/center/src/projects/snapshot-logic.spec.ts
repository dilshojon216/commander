import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clampTakenAt, sanitizeMd, tasksFromMd } from './snapshot-logic.js';

const REAL = readFileSync(new URL('../../../../libs/contracts/src/fixtures/commander-TASKS.md', import.meta.url), 'utf8');

describe('sanitizeMd (markaz xavfsizlik to\'ri)', () => {
  it('agentd redakt qilmagan sir ham maskalanadi; null saqlanadi; idempotent', () => {
    const out = sanitizeMd({ todosMd: 'API_TOKEN=S3cr3tV4lue99 ok', changelogMd: null, tasksMd: 'ghp_abcdefghijklmnopqrstuvwx1234' });
    expect(out.todosMd).not.toContain('S3cr3tV4lue99');
    expect(out.changelogMd).toBeNull();
    expect(out.tasksMd).not.toContain('ghp_abcdef');
    expect(sanitizeMd({ todosMd: out.todosMd, changelogMd: null, tasksMd: out.tasksMd })).toEqual(out);
  });
});

describe('tasksFromMd', () => {
  it('commander real TASKS.md: server tomonda parse; holatlar bo\'yicha sonlar', () => {
    const tasks = tasksFromMd(REAL);
    expect(tasks.length).toBeGreaterThanOrEqual(45);
    const by = (s: string) => tasks.filter((t) => t.status === s).length;
    expect(by('done')).toBeGreaterThan(20);
    expect(by('todo')).toBeGreaterThan(5);
    expect(new Set(tasks.map((t) => t.key)).size).toBe(tasks.length);
  });
  it('redakt qilingan matndan ham vazifa id/holatlar saqlanadi (sarlavhaning faqat sir-o\'xshash bo\'lagi o\'zgaradi)', () => {
    const plain = tasksFromMd(REAL);
    const redacted = tasksFromMd(sanitizeMd({ todosMd: null, changelogMd: null, tasksMd: REAL }).tasksMd);
    expect(redacted.map((t) => [t.key, t.status])).toEqual(plain.map((t) => [t.key, t.status]));
  });
  it('TASKS.md yo\'q: bo\'sh', () => {
    expect(tasksFromMd(null)).toEqual([]);
  });
});

describe('clampTakenAt', () => {
  it('kelajak vaqt hozirga tushiriladi', () => {
    const now = new Date(1_000_000);
    expect(clampTakenAt(5_000_000, now)).toEqual(now);
    expect(clampTakenAt(500, now).getTime()).toBe(500);
  });
});
