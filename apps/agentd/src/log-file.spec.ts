import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRotatingFileWriter } from './log-file.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('createRotatingFileWriter', () => {
  it("papkani yaratadi va qatorlarni qo'shadi", () => {
    const d = mkdtempSync(join(tmpdir(), 'lf-'));
    dirs.push(d);
    const file = join(d, 'sub', 'agentd.log');
    const w = createRotatingFileWriter(file, 1000);
    w('a');
    w('b');
    expect(readFileSync(file, 'utf8')).toBe('a\nb\n');
  });

  it("chegaradan oshganda .1 ga aylanadi va hajm chegaralanadi", () => {
    const d = mkdtempSync(join(tmpdir(), 'lf-'));
    dirs.push(d);
    const file = join(d, 'agentd.log');
    const w = createRotatingFileWriter(file, 100);
    for (let i = 0; i < 40; i++) w(`line-${i}-xxxxxxxxxx`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(100);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(100);
    expect(readFileSync(file, 'utf8')).toContain('line-39');
  });

  it("yozib bo'lmasa tashlamaydi", () => {
    const w = createRotatingFileWriter('/dev/null/yoq/agentd.log');
    expect(() => w('x')).not.toThrow();
  });
});
