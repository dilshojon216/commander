import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TASK_COMMAND_MARKER, TASK_COMMAND_TEXT, ensureTaskCommand } from './task-command.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agd-tc-'));
  dirs.push(d);
  return d;
};

describe('ensureTaskCommand', () => {
  it('yo\'q bo\'lsa yaratadi, keyin tegmaydi', () => {
    const d = mk();
    expect(ensureTaskCommand(d)).toBe('created');
    expect(readFileSync(join(d, 'commands', 'task.md'), 'utf8')).toBe(TASK_COMMAND_TEXT);
    expect(ensureTaskCommand(d)).toBe('kept');
  });
  it('foydalanuvchining o\'z task.md\'iga tegmaydi', () => {
    const d = mk();
    mkdirSync(join(d, 'commands'));
    writeFileSync(join(d, 'commands', 'task.md'), 'mening buyrug\'im');
    expect(ensureTaskCommand(d)).toBe('kept');
    expect(readFileSync(join(d, 'commands', 'task.md'), 'utf8')).toBe("mening buyrug'im");
  });
  it('eski managed versiyani yangilaydi', () => {
    const d = mk();
    mkdirSync(join(d, 'commands'));
    writeFileSync(join(d, 'commands', 'task.md'), `<!-- ${TASK_COMMAND_MARKER} v0 -->\neski`);
    expect(ensureTaskCommand(d)).toBe('updated');
    expect(readFileSync(join(d, 'commands', 'task.md'), 'utf8')).toBe(TASK_COMMAND_TEXT);
  });
});
