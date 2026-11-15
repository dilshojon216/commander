import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectsRoot, isInside, isValidSessionId, resolveTranscript } from './chat-path.js';

describe('isInside', () => {
  it('POSIX', () => {
    expect(isInside('/h/.claude/projects', '/h/.claude/projects/p/s.jsonl')).toBe(true);
    expect(isInside('/h/.claude/projects', '/h/.claude/projects')).toBe(false);
    expect(isInside('/h/.claude/projects', '/h/.claude/projects/../secrets')).toBe(false);
    expect(isInside('/h/.claude/projects', '/h/.claude/projects-evil/p/s.jsonl')).toBe(false);
    expect(isInside('/h/.claude/projects', '/etc/passwd')).toBe(false);
  });

  it('Windows yo\'llari (registrga befarq, disk harfi, UNC)', () => {
    const w = path.win32;
    const root = 'C:\\Users\\Me\\.claude\\projects';
    expect(isInside(root, 'C:\\Users\\Me\\.claude\\projects\\p\\s.jsonl', w)).toBe(true);
    expect(isInside(root, 'c:\\users\\me\\.claude\\projects\\p\\s.jsonl', w)).toBe(true);
    expect(isInside(root, 'C:\\Users\\Me\\.claude\\projects\\..\\..\\secret.txt', w)).toBe(false);
    expect(isInside(root, 'D:\\Users\\Me\\.claude\\projects\\p\\s.jsonl', w)).toBe(false);
    expect(isInside(root, '\\\\server\\share\\s.jsonl', w)).toBe(false);
  });
});

describe('claudeProjectsRoot', () => {
  it('CLAUDE_CONFIG_DIR ustun, aks holda ~/.claude/projects', () => {
    expect(claudeProjectsRoot({}, '/home/u')).toBe(join('/home/u', '.claude', 'projects'));
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe(join('/cfg', 'projects'));
  });
});

describe('isValidSessionId', () => {
  it('faqat xavfsiz belgilar', () => {
    expect(isValidSessionId('27c9bc46-29c7-4c53-b20c-24539af2ebc0')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a\\b', 'a.b', '-x', 'a b', 'x'.repeat(129)]) expect(isValidSessionId(bad)).toBe(false);
  });
});

describe('resolveTranscript', () => {
  let tmp: string;
  let root: string;
  const SID = 'sess-1234';
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'chatpath-')));
    root = join(tmp, '.claude', 'projects');
    mkdirSync(join(root, '-p-one'), { recursive: true });
    mkdirSync(join(root, '-p-two'), { recursive: true });
    writeFileSync(join(root, '-p-one', `${SID}.jsonl`), '{}\n');
    writeFileSync(join(tmp, 'outside.jsonl'), '{}\n');
    writeFileSync(join(root, '-p-two', 'other.jsonl'), '{}\n');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('hint ichkarida: qabul', async () => {
    const r = await resolveTranscript({ root, claudeSessionId: SID, hint: join(root, '-p-one', `${SID}.jsonl`) });
    expect(r).toEqual({ ok: true, path: join(root, '-p-one', `${SID}.jsonl`) });
  });

  it('hint yo\'q: loyihalar bo\'ylab qidiradi; yo\'q fayl = not_found', async () => {
    expect((await resolveTranscript({ root, claudeSessionId: SID })).ok).toBe(true);
    expect(await resolveTranscript({ root, claudeSessionId: 'nope' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('hint yo\'q fayl, lekin ichkarida: qidiruvga qaytadi', async () => {
    const r = await resolveTranscript({ root, claudeSessionId: SID, hint: join(root, '-gone', `${SID}.jsonl`) });
    expect(r.ok).toBe(true);
  });

  it('path traversal va tashqi yo\'l rad etiladi (forbidden_path)', async () => {
    for (const hint of [
      join(root, '..', '..', 'outside.jsonl'),
      join(tmp, 'outside.jsonl'),
      '/etc/passwd',
      join(root, '-p-one', '..', '..', '..', 'outside.jsonl'),
    ]) {
      expect(await resolveTranscript({ root, claudeSessionId: 'outside', hint })).toEqual({ ok: false, code: 'forbidden_path' });
    }
  });

  it('boshqa sessiya fayli (nom mos emas) rad etiladi', async () => {
    const r = await resolveTranscript({ root, claudeSessionId: SID, hint: join(root, '-p-two', 'other.jsonl') });
    expect(r).toEqual({ ok: false, code: 'forbidden_path' });
  });

  it('symlink orqali tashqariga chiqish rad etiladi', async () => {
    symlinkSync(join(tmp, 'outside.jsonl'), join(root, '-p-two', 'sess-link.jsonl'));
    const r = await resolveTranscript({ root, claudeSessionId: 'sess-link', hint: join(root, '-p-two', 'sess-link.jsonl') });
    expect(r).toEqual({ ok: false, code: 'forbidden_path' });
    // qidiruv ham symlink'ni qabul qilmaydi
    expect((await resolveTranscript({ root, claudeSessionId: 'sess-link' })).ok).toBe(false);
  });

  it('noto\'g\'ri sessiya id rad etiladi', async () => {
    expect(await resolveTranscript({ root, claudeSessionId: '../x' })).toEqual({ ok: false, code: 'forbidden_path' });
  });
});
