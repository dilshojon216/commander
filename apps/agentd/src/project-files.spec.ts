import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readMdFile, readProjectMd, readTasksMd } from './project-files.js';
import { sensitiveDirs } from './policy.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agd-md-'));
  dirs.push(d);
  return d;
};

describe('readProjectMd', () => {
  it('oddiy fayl o\'qiladi va redakt qiladi (sirlar md ichida maskalanadi)', () => {
    const d = mk();
    writeFileSync(join(d, 'TODOS.md'), '# Todo\n- deploy\nAPI_TOKEN=S3cr3tV4lue99\nghp_abcdefghijklmnopqrstuvwx1234\n-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n');
    const t = readProjectMd(d, 'TODOS.md')!;
    expect(t).toContain('# Todo');
    expect(t).not.toContain('S3cr3tV4lue99');
    expect(t).not.toContain('ghp_abcdef');
    expect(t).not.toContain('MIIabc');
    expect(t).toContain('REDACTED');
  });

  it('64 KB dan katta fayl kesiladi (bayt), UTF-8 yarim belgi qoldirilmaydi', () => {
    const d = mk();
    writeFileSync(join(d, 'CHANGELOG.md'), 'я'.repeat(100_000)); // 2 bayt/belgi
    const t = readProjectMd(d, 'CHANGELOG.md')!;
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(64 * 1024);
    expect(t).not.toContain('�');
  });

  it('yo\'q fayl, papka -> null', () => {
    const d = mk();
    mkdirSync(join(d, 'TODOS.md'));
    expect(readProjectMd(d, 'TODOS.md')).toBeNull();
    expect(readProjectMd(d, 'CHANGELOG.md')).toBeNull();
  });

  it('ILDIZDAN TASHQARIGA CHIQMAYDI: fayl symlink bo\'lsa ham, docs/ symlink bo\'lsa ham', () => {
    const outside = mk();
    writeFileSync(join(outside, 'secret.md'), 'TASHQI SIR');
    mkdirSync(join(outside, 'docs'));
    writeFileSync(join(outside, 'docs', 'TASKS.md'), '| # | Task |\n|---|---|\n| 9.9 | tashqi |\n');
    const root = mk();
    symlinkSync(join(outside, 'secret.md'), join(root, 'TODOS.md'));
    symlinkSync(join(outside, 'docs'), join(root, 'docs'));
    expect(readProjectMd(root, 'TODOS.md')).toBeNull();
    expect(readProjectMd(root, 'docs/TASKS.md')).toBeNull();
    expect(readTasksMd(root)).toBeNull();
  });

  it('readTasksMd: docs/TASKS.md TASKS.md dan ustun', () => {
    const d = mk();
    mkdirSync(join(d, 'docs'));
    writeFileSync(join(d, 'docs', 'TASKS.md'), 'docs');
    writeFileSync(join(d, 'TASKS.md'), 'root');
    expect(readTasksMd(d)).toEqual({ path: 'docs/TASKS.md', content: 'docs' });
    rmSync(join(d, 'docs'), { recursive: true });
    expect(readTasksMd(d)).toEqual({ path: 'TASKS.md', content: 'root' });
  });

  it('Windows uslubidagi (oldingi tasdiqlangan) yo\'l normalizatsiyasi bilan ishlashga xalaqit bermaydi: bo\'sh fayl', () => {
    const d = mk();
    writeFileSync(join(d, 'TODOS.md'), '');
    expect(readProjectMd(d, 'TODOS.md')).toBe('');
  });
});

describe('readMdFile: ildiz $HOME bo\'lganda maxfiy papkalar (allow-home)', () => {
  it('~/.ssh, ~/.claude, ~/.commander, ~/.aws, ~/.gnupg ichidagi md o\'qilmaydi; oddiy md o\'qiladi', () => {
    const home = realpathSync(mk());
    for (const d of ['.ssh', '.claude', '.commander', '.aws', '.gnupg', '.config/commander', 'docs']) {
      mkdirSync(join(home, d), { recursive: true });
      writeFileSync(join(home, d, 'note.md'), '# sir\n');
    }
    writeFileSync(join(home, 'README.md'), '# ok\n');
    const sens = sensitiveDirs(home);
    for (const d of ['.ssh', '.claude', '.commander', '.aws', '.gnupg', '.config/commander']) {
      expect(readMdFile(home, `${d}/note.md`, undefined, sens), d).toBe('path_invalid');
    }
    expect(readMdFile(home, 'README.md', undefined, sens)).toMatchObject({ path: 'README.md' });
    expect(readMdFile(home, 'docs/note.md', undefined, sens)).toMatchObject({ path: 'docs/note.md' });
  });
});
